import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "@actalk/inkos-core";
import { withBookTransaction } from "../../../core/dist/state/book-transaction.js";
import { createStudioServer } from "./server.js";

let root: string;
let book: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studio-recovery-entry-"));
  book = join(root, "books/sample");
  await mkdir(join(book, "chapters"), { recursive: true });
  await writeFile(join(book, "book.json"), JSON.stringify({ id: "sample", title: "Sample", language: "en" }), "utf8");
  await writeFile(join(book, "chapters/index.json"), "[]", "utf8");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("classifies an interrupted book and restores it with no model configuration", async () => {
  await expect(withBookTransaction(book, async () => {
    await writeFile(join(book, "book.json"), "partial", "utf8");
    throw new Error("interrupted");
  }, { leavePendingOnError: true })).rejects.toThrow();
  const app = createStudioServer({} as never, root);
  const detail = await app.request("/api/v1/books/sample");
  expect(detail.status).toBe(409);
  expect(await detail.json()).toMatchObject({ reasonCode: "TRANSACTION_RECOVERY_REQUIRED" });
  const listed = await app.request("/api/v1/books");
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({ books: [{ id: "sample", recoveryRequired: true, reasonCode: "TRANSACTION_RECOVERY_REQUIRED" }] });
  const result = await app.request("/api/v1/books/sample/recover-transaction", { method: "POST" });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ status: "applied" });
  expect((await app.request("/api/v1/books/sample")).status).toBe(200);
  expect(await (await app.request("/api/v1/books/sample/recover-transaction", { method: "POST" })).json()).toMatchObject({ status: "unchanged" });
});

it("keeps live ownership and classifies a genuinely absent book as missing", async () => {
  const app = createStudioServer({} as never, root);
  const state = new StateManager(root);
  const original = await readFile(join(book, "book.json"));
  const release = await state.acquireBookLock("sample");
  try {
    const result = await app.request("/api/v1/books/sample/recover-transaction", { method: "POST" });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ reasonCode: "BOOK_BUSY" });
  } finally { await release(); }
  expect(await readFile(join(book, "book.json"))).toEqual(original);
  expect((await app.request("/api/v1/books/missing")).status).toBe(404);
});
