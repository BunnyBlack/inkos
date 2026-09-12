import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const run = vi.hoisted(() => vi.fn(async () => ({ responseText: "Recovery available", messages: [] })));
vi.mock("@actalk/inkos-core", async importOriginal => ({
  ...await importOriginal<typeof import("@actalk/inkos-core")>(), runAgentSession: run,
}));
import { createStudioServer } from "./server.js";
import { withBookTransaction } from "../../../core/dist/state/book-transaction.js";
import { createAndPersistBookSession } from "@actalk/inkos-core";
let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it("reaches a restricted recovery agent session with a real interrupted publication", async () => {
  root = await mkdtemp(join(tmpdir(), "recovery-session-"));
  const book = join(root, "books/sample");
  await mkdir(join(book, "story"), { recursive: true });
  await writeFile(join(book, "book.json"), JSON.stringify({ id: "sample", title: "Sample", language: "en" }), "utf8");
  await expect(withBookTransaction(book, async () => { await writeFile(join(book, "book.json"), "partial", "utf8"); throw new Error("crash"); }, { leavePendingOnError: true })).rejects.toThrow();
  const config = { name: "test", version: "0.1.0", language: "zh", llm: { provider: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "test", model: "gpt-5.4", temperature: 0.7, maxTokens: 4096, stream: false } };
  await writeFile(join(root, "inkos.json"), JSON.stringify(config), "utf8");
  const session = await createAndPersistBookSession(root, "sample");
  const app = createStudioServer(config as never, root);
  const response = await app.request("/api/v1/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instruction: "recover transaction", activeBookId: "sample", sessionId: session.sessionId }) });
  expect(response.status, await response.text()).toBe(200);
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ bookId: "sample", recoveryOnly: true, language: "zh" }), "recover transaction");
});
