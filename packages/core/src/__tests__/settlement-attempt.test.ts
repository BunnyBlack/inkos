import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WriteChapterOutput } from "../agents/writer.js";
import { withBookTransaction } from "../state/book-transaction.js";
import { createBookSnapshot, readBookSnapshot } from "../state/book-snapshot.js";
import { createSettlementAttempt, loadSettlementAttempt, listSettlementAttempts, appendSettlementEvent, readSettlementEvents, markSettlementApplied } from "../pipeline/settlement-attempt.js";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link), open: vi.fn(actual.open) };
});
let book: string;
const output: WriteChapterOutput = {
  chapterNumber: 1, title: "Synthetic chapter", content: "Unchanged prose", wordCount: 2,
  preWriteCheck: "checked", postSettlement: "settled", updatedState: "candidate state", updatedLedger: "ledger",
  updatedHooks: "hooks", chapterSummary: "summary", updatedChapterSummaries: "summaries", updatedSubplots: "subplots",
  updatedEmotionalArcs: "arcs", updatedCharacterMatrix: "matrix", postWriteErrors: [], postWriteWarnings: [],
  runtimeStateSnapshot: { manifest: { schemaVersion: 2, language: "en", lastAppliedChapter: 1, projectionVersion: 1, migrationWarnings: [] }, currentState: { chapter: 1, facts: [] }, hooks: { hooks: [] }, chapterSummaries: { rows: [] } },
  tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
};
const params = () => ({ chapter: 1, inputs: { sourceHash: "source", baselineHash: "baseline", controlHash: "control" }, output, context: { baselineChapter: 0, settlementGuidance: "Retain evidence" } });
beforeEach(async () => {
  const temp = resolve(import.meta.dirname, "../../../../temp");
  await fs.mkdir(temp, { recursive: true });
  book = await fs.mkdtemp(join(temp, "settlement-attempt-"));
  await fs.mkdir(join(book, "story"));
  await fs.writeFile(join(book, "story", "current_state.md"), "published\r\n", "utf8");
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(book, { recursive: true, force: true }); });

it("retains the complete rejected candidate and immutable events without publishing state", async () => {
  const attempt = await createSettlementAttempt(book, params());
  await appendSettlementEvent(book, attempt.attemptId, { type: "validation-input", data: { prompt: "synthetic evidence" } });
  await appendSettlementEvent(book, attempt.attemptId, { type: "rejected", data: { reasonCode: "SEMANTIC_REJECTION", issues: ["first", "second"] } });
  expect(await loadSettlementAttempt(book, attempt.attemptId)).toMatchObject({ output, status: "rejected", reasonCode: "SEMANTIC_REJECTION" });
  expect((await readSettlementEvents(book, attempt.attemptId)).map(event => event.type)).toEqual(["validation-input", "rejected"]);
  expect(await fs.readFile(join(book, "story", "current_state.md"), "utf8")).toBe("published\r\n");
  expect(await listSettlementAttempts(book)).toEqual([expect.objectContaining({ attemptId: attempt.attemptId, status: "rejected" })]);
  expect((await listSettlementAttempts(book))[0]).not.toHaveProperty("output");
});

it("never exposes an interrupted candidate publication as resumable", async () => {
  vi.mocked(fs.link).mockRejectedValueOnce(Object.assign(new Error("disk failed"), { code: "EIO" }));
  await expect(createSettlementAttempt(book, params())).rejects.toMatchObject({ reasonCode: "SETTLEMENT_EVIDENCE_WRITE_FAILED", cause: { code: "EIO" } });
  expect(await listSettlementAttempts(book)).toEqual([]);
});

it("retains the prior candidate and events when writing the next event fails after partial bytes", async () => {
  const attempt = await createSettlementAttempt(book, params());
  await appendSettlementEvent(book, attempt.attemptId, { type: "validated" });
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    const write = handle.writeFile.bind(handle);
    vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
      await write("{partial", "utf8");
      throw Object.assign(new Error("partial write"), { code: "EIO" });
    });
    return handle;
  });
  await expect(appendSettlementEvent(book, attempt.attemptId, { type: "rejected" })).rejects.toMatchObject({ reasonCode: "SETTLEMENT_EVIDENCE_WRITE_FAILED" });
  expect((await loadSettlementAttempt(book, attempt.attemptId)).status).toBe("validated");
  expect((await readSettlementEvents(book, attempt.attemptId)).map(event => event.type)).toEqual(["validated"]);
  expect((await loadSettlementAttempt(book, attempt.attemptId)).output).toEqual(output);
});

it("does not publish metadata when fsync fails", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    vi.spyOn(handle, "sync").mockRejectedValueOnce(Object.assign(new Error("sync failed"), { code: "EIO" }));
    return handle;
  });
  await expect(createSettlementAttempt(book, params())).rejects.toMatchObject({ reasonCode: "SETTLEMENT_EVIDENCE_WRITE_FAILED" });
  expect(await listSettlementAttempts(book)).toEqual([]);
});

it("ignores partial staged events and fails closed on malformed runtime output", async () => {
  const attempt = await createSettlementAttempt(book, params());
  await fs.writeFile(join(book, "story", "recovery", "settlements", attempt.attemptId, "events", "partial.pending"), "{", "utf8");
  expect(await readSettlementEvents(book, attempt.attemptId)).toEqual([]);
  await expect(createSettlementAttempt(book, { ...params(), output: { ...output, runtimeStateSnapshot: { ...output.runtimeStateSnapshot!, currentState: { chapter: 1, facts: [{ object: 42 }] } } } as unknown as WriteChapterOutput })).rejects.toThrow();
});

it("applied receipts participate in rollback and override stale rejection events after commit", async () => {
  const attempt = await createSettlementAttempt(book, params());
  await expect(markSettlementApplied(book, attempt.attemptId)).rejects.toThrow("SETTLEMENT_TRANSACTION_REQUIRED");
  await expect(withBookTransaction(book, async () => { await markSettlementApplied(book, attempt.attemptId); throw new Error("rollback"); })).rejects.toThrow("rollback");
  expect((await loadSettlementAttempt(book, attempt.attemptId)).status).toBe("pending");
  await withBookTransaction(book, () => markSettlementApplied(book, attempt.attemptId));
  await appendSettlementEvent(book, attempt.attemptId, { type: "rejected", data: { reasonCode: "STALE_FAILURE" } });
  expect((await loadSettlementAttempt(book, attempt.attemptId)).status).toBe("applied");
  expect((await listSettlementAttempts(book))[0]).toMatchObject({ status: "applied" });
  expect((await listSettlementAttempts(book))[0]?.reasonCode).toBeUndefined();
  expect(JSON.parse(await fs.readFile(join(book, "chapters", ".settlement-receipts", `${attempt.attemptId}.json`), "utf8"))).toMatchObject({ attemptId: attempt.attemptId, version: 1 });
});

it("allows real chapter snapshots after an applied receipt is committed", async () => {
  await fs.writeFile(join(book, "story", "pending_hooks.md"), "hooks\r\n", "utf8");
  const attempt = await createSettlementAttempt(book, params());
  await withBookTransaction(book, () => markSettlementApplied(book, attempt.attemptId));
  await createBookSnapshot(book, 1);
  expect(await readBookSnapshot(book, 1)).not.toBeNull();
  expect((await loadSettlementAttempt(book, attempt.attemptId)).status).toBe("applied");
});

it("rejects unsafe IDs and symlink storage roots", async () => {
  await expect(loadSettlementAttempt(book, "../escape")).rejects.toThrow("INVALID_SETTLEMENT_ATTEMPT_ID");
  const target = join(book, "elsewhere");
  await fs.mkdir(target);
  await fs.symlink(target, join(book, "story", "recovery"), "junction");
  await expect(createSettlementAttempt(book, params())).rejects.toMatchObject({ reasonCode: "SETTLEMENT_EVIDENCE_WRITE_FAILED" });
  expect(await fs.readdir(target)).toEqual([]);
});

it("keeps discarded attempts terminal and rejects credential fields", async () => {
  const first = await createSettlementAttempt(book, params());
  const child = await createSettlementAttempt(book, { ...params(), parentAttemptId: first.attemptId, resumable: false });
  await appendSettlementEvent(book, child.attemptId, { type: "discarded" });
  await appendSettlementEvent(book, child.attemptId, { type: "validated" });
  expect(await loadSettlementAttempt(book, child.attemptId)).toMatchObject({ status: "discarded", resumable: false, parentAttemptId: first.attemptId });
  await expect(appendSettlementEvent(book, first.attemptId, { type: "input", data: { apiKey: "synthetic credential" } })).rejects.toMatchObject({ cause: { message: "SETTLEMENT_CREDENTIALS_FORBIDDEN" } });
  expect(await readSettlementEvents(book, first.attemptId)).toEqual([]);
});

it("retains raw runtime chapter drift for diagnostics but rejects it for resumable attempts", async () => {
  const rawOutput: WriteChapterOutput = { ...output, runtimeStateDelta: { chapter: 0, hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [], subplotOps: [], emotionalArcOps: [], characterMatrixOps: [], notes: [] }, runtimeStateSnapshot: { ...output.runtimeStateSnapshot!, currentState: { chapter: 2, facts: [] }, manifest: { ...output.runtimeStateSnapshot!.manifest, lastAppliedChapter: 2 } } };
  const diagnostic = await createSettlementAttempt(book, { ...params(), output: rawOutput, resumable: false });
  expect((await loadSettlementAttempt(book, diagnostic.attemptId)).output).toEqual(rawOutput);
  await expect(createSettlementAttempt(book, { ...params(), output: rawOutput, resumable: true })).rejects.toMatchObject({ reasonCode: "SETTLEMENT_EVIDENCE_WRITE_FAILED" });
});

it("reports corrupt committed records without hiding healthy attempts or changing evidence", async () => {
  const corrupt = await createSettlementAttempt(book, params());
  const good = await createSettlementAttempt(book, params());
  const recordPath = join(book, "story", "recovery", "settlements", corrupt.attemptId, "attempt.json");
  const damaged = "{partial committed record\r\n";
  await fs.writeFile(recordPath, damaged, "utf8");
  expect(await listSettlementAttempts(book)).toEqual(expect.arrayContaining([
    expect.objectContaining({ attemptId: corrupt.attemptId, status: "invalid", reasonCode: "SETTLEMENT_RECORD_INVALID", chapter: 0, resumable: false }),
    expect.objectContaining({ attemptId: good.attemptId, status: "pending", chapter: 1 }),
  ]));
  expect(await fs.readFile(recordPath, "utf8")).toBe(damaged);
});
