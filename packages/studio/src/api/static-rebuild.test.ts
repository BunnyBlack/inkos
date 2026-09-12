import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const listener = vi.hoisted(() => ({ fetch: undefined as undefined | ((request: Request) => Response | Promise<Response>) }));
vi.mock("@hono/node-server", () => ({ serve: vi.fn((options) => { listener.fetch = options.fetch; }) }));
vi.mock("@actalk/inkos-core", async (importOriginal) => ({
  ...await importOriginal<object>(),
  loadProjectConfig: vi.fn(async () => ({})),
}));
import { startStudioServer } from "./server.js";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it("serves the rebuilt entry document without restarting the server", async () => {
  root = await mkdtemp(join(tmpdir(), "studio-static-rebuild-"));
  const index = join(root, "index.html");
  await writeFile(index, '<script src="/assets/old.js"></script>', "utf8");
  await startStudioServer(root, 0, { staticDir: root });
  const request = () => listener.fetch!(new Request("http://localhost/"));
  expect(await (await request()).text()).toContain("old.js");
  await writeFile(index, '<script src="/assets/new.js"></script>', "utf8");
  const rebuilt = await request();
  expect(await rebuilt.text()).toContain("new.js");
  expect(rebuilt.headers.get("cache-control")).toBe("no-store");
  await rm(index);
  expect((await request()).status).toBe(503);
  await writeFile(index, '<script src="/assets/newest.js"></script>', "utf8");
  expect(await (await request()).text()).toContain("newest.js");
});
