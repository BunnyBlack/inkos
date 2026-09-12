import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "@actalk/inkos-core";
import { withBookTransaction } from "../../../core/dist/state/book-transaction.js";
import { createSettlementAttempt, appendSettlementEvent } from "../../../core/dist/pipeline/settlement-attempt.js";
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

it("rejects invalid settlement actions before constructing model configuration", async () => {
  const app = createStudioServer({} as never, root);
  const response = await app.request("/api/v1/books/sample/settlements/11111111-1111-4111-8111-111111111111/resume", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rewrite-body" }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ reasonCode: "INVALID_SETTLEMENT_ACTION" });
});

it("rejects unsafe settlement IDs without a model call", async () => {
  const app = createStudioServer({} as never, root);
  const response = await app.request("/api/v1/books/sample/settlements/not-an-id");
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ reasonCode: "INVALID_SETTLEMENT_ATTEMPT_ID" });
});

it("reads complete persisted settlement evidence and lists summaries without model configuration", async () => {
  const attempt = await createSettlementAttempt(book, {
    chapter: 1, inputs: { sourceHash: "source", baselineHash: "baseline", controlHash: "control" }, context: { baselineChapter: 0 },
    output: { chapterNumber: 1, title: "One", content: "Mira reads a letter.", wordCount: 5, preWriteCheck: "", postSettlement: "notes", updatedState: "candidate", updatedLedger: "", updatedHooks: "hooks", chapterSummary: "summary", updatedSubplots: "subplots", updatedEmotionalArcs: "arcs", updatedCharacterMatrix: "matrix", postWriteErrors: [], postWriteWarnings: [] },
  });
  await appendSettlementEvent(book, attempt.attemptId, { type: "rejected", data: { reasonCode: "SEMANTIC_REJECTION", issues: ["Unproven consent", "Missing evidence"] } });
  const before = await readFile(join(book, "book.json"));
  const app = createStudioServer({} as never, root);
  const detail = await app.request(`/api/v1/books/sample/settlements/${attempt.attemptId}`);
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ attempt: { output: attempt.output, status: "rejected" }, events: [{ type: "rejected", data: { issues: ["Unproven consent", "Missing evidence"] } }] });
  const status = await app.request("/api/v1/books/sample/recovery-status");
  expect(await status.json()).toMatchObject({ settlementAttempts: [{ attemptId: attempt.attemptId, status: "rejected" }] });
  expect(await readFile(join(book, "book.json"))).toEqual(before);
});

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
