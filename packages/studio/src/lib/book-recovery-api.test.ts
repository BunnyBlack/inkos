import { afterEach, expect, it, vi } from "vitest";
import { requestBookRecovery, recoveryChapterTargets, mergeRecoveryResult } from "./book-recovery-api";
afterEach(() => vi.unstubAllGlobals());
it("clears rejected-operation diagnostics after successful settlement while preserving status options", () => {
  const next = mergeRecoveryResult({ status: "failed", reasonCode: "SETTLEMENT_NO_PROGRESS", error: "old error", stage: "validation", issues: ["old issue"], nextActions: ["inspect"], completed: [1], attemptId: "old", candidates: [], settlementAttempts: [] }, {}, { status: "applied", attemptId: "new" });
  expect(next).toEqual({ status: "applied", attemptId: "new", candidates: [], settlementAttempts: [] });
});
it("offers diagnosed orphan chapters alongside indexed chapters", () => {
  expect(recoveryChapterTargets([1], [2])).toEqual([1, 2]);
  expect(recoveryChapterTargets([], [3, 1, 2, 2, 0, -1, 1.5])).toEqual([1, 2, 3]);
});
it("preserves candidate and failure details from a rejected settlement", async () => {
  const result = { applied: false, candidateId: "retained-1", reasonCode: "SETTLEMENT_FAILED" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(result), { status: 422 })));
  expect(await requestBookRecovery("/books/fixture/resume-candidate/retained-1", {})).toEqual(result);
});
it("keeps a blocked dry-run plan reviewable", async () => {
  const result = { plan: { baseline: null, steps: [], preservesBodies: true, blockedReason: "BASELINE_MISSING" } };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(result), { status: 409 })));
  expect(await requestBookRecovery("/books/fixture/recover/2", { dryRun: true })).toEqual(result);
});
it("does not mistake an unstructured HTTP failure for a successful result", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
  await expect(requestBookRecovery("/books/fixture/recovery-status")).rejects.toThrow("503");
});
