import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateValidatorAgent } from "../agents/state-validator.js";

let root: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }); });
it("retains every request and malformed reply with a final diagnostic path", async () => {
  root = await mkdtemp(join(tmpdir(), "validator-diagnostic-"));
  const agent = new StateValidatorAgent({ projectRoot: root, bookId: "sample", model: "test", client: {} as never });
  vi.spyOn(agent as never as { chat: () => Promise<unknown> }, "chat").mockResolvedValue({ content: "invalid protocol reply" });
  let caught: any;
  try { await agent.validate("A lantern was lit.", 1, "old", "new", "hooks", "updated hooks", "en"); }
  catch (error) { caught = error; }
  expect(caught.reasonCode).toBe("VALIDATOR_PROTOCOL_INVALID");
  const raw = await readFile(caught.diagnosticPath, "utf8");
  expect(raw).toContain("invalid protocol reply");
  expect(raw).not.toContain("A lantern was lit.");
  const directory = join(root, "books", "sample", "story", "recovery", "validator");
  const events = await Promise.all((await readdir(directory)).map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8"))));
  expect(events).toHaveLength(4);
  expect(events.filter((event) => event.phase === "request")).toHaveLength(2);
  expect(events.find((event) => event.phase === "request" && event.attempt === 1).messages[1].content).toContain("A lantern was lit.");
});
it("retains raw successful replies as well as grounded rejections", async () => {
  root = await mkdtemp(join(tmpdir(), "validator-diagnostic-"));
  const agent = new StateValidatorAgent({ projectRoot: root, bookId: "sample", model: "test", client: {} as never });
  vi.spyOn(agent as never as { chat: () => Promise<unknown> }, "chat").mockResolvedValue({ content: "PASS" });
  await agent.validate("A lantern was lit.", 1, "old", "new", "", "", "en");
  const directory = join(root, "books", "sample", "story", "recovery", "validator");
  const events = await Promise.all((await readdir(directory)).map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8"))));
  expect(events).toHaveLength(2);
  expect(events.find((event) => event.phase === "response").response).toBe("PASS");
});
