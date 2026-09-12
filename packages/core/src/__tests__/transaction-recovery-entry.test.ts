import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../state/manager.js";
import { withBookTransaction } from "../state/book-transaction.js";
import * as agentTools from "../agent/agent-tools.js";

let root: string;
let book: string;
let state: StateManager;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "recovery-entry-"));
  state = new StateManager(root);
  book = state.bookDir("sample");
  await mkdir(join(book, "chapters"), { recursive: true });
  await writeFile(join(book, "book.json"), '{"id":"sample"}', "utf8");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("recovers without reading guarded config and is idempotent", async () => {
  await expect(withBookTransaction(book, async () => {
    await writeFile(join(book, "book.json"), "partial", "utf8");
    throw new Error("interrupted");
  }, { leavePendingOnError: true })).rejects.toThrow("interrupted");
  await expect(state.loadBookConfig("sample")).rejects.toThrow("TRANSACTION_RECOVERY_REQUIRED");
  expect(await state.recoverPendingTransaction("sample")).toMatchObject({ status: "applied", operationId: expect.any(String) });
  expect(await readFile(join(book, "book.json"), "utf8")).toBe('{"id":"sample"}');
  expect(await state.recoverPendingTransaction("sample")).toEqual({ status: "unchanged" });
});

it("exposes model-free recovery to the Agent", async () => {
  const tool = agentTools.createRecoverTransactionTool(root, "sample");
  expect((await tool.execute("recover", {})).details).toMatchObject({ status: "unchanged", bookId: "sample" });
});

it("refuses live ownership and never creates an unknown book", async () => {
  const release = await state.acquireBookLock("sample");
  try { await expect(state.recoverPendingTransaction("sample")).rejects.toMatchObject({ code: "BOOK_BUSY" }); }
  finally { await release(); }
  await expect(state.recoverPendingTransaction("missing")).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains corrupt backup evidence and does not restore partially", async () => {
  await expect(withBookTransaction(book, async () => {
    await writeFile(join(book, "book.json"), "partial", "utf8");
    throw new Error("interrupted");
  }, { leavePendingOnError: true })).rejects.toThrow();
  const journal = JSON.parse(await readFile(join(book, "story/recovery/transaction.json"), "utf8"));
  await writeFile(join(book, "story/recovery", journal.operationId, "before/book.json"), "corrupt", "utf8");
  await expect(state.recoverPendingTransaction("sample")).rejects.toThrow("RECOVERY_BACKUP_CORRUPT");
  expect(await readFile(join(book, "book.json"), "utf8")).toBe("partial");
});
