import { expect, it } from "vitest";
import { planBookRecovery } from "../pipeline/book-recovery.js";
const health = { stateFrontier: 0, verifiedBaselines: [0], pendingChapters: [1, 2], issues: [] };
it("repairs ordered retained bodies without expanding target", () => {
  expect(planBookRecovery(health, 2)).toEqual({ baseline: 0, steps: [{ chapter: 1, action: "settle-persisted-body" }, { chapter: 2, action: "settle-persisted-body" }], preservesBodies: true });
  expect(planBookRecovery(health, 1).steps.map(step => step.chapter)).toEqual([1]);
});
it("blocks missing baseline and pending transactions", () => {
  expect(planBookRecovery({ ...health, stateFrontier: null, verifiedBaselines: [] }, 2).blockedReason).toBe("BASELINE_MISSING");
  expect(planBookRecovery({ ...health, pendingOperationId: "op" }, 2).blockedReason).toBe("TRANSACTION_RECOVERY_REQUIRED");
});
it("blocks missing bodies and invalid targets", () => {
  expect(planBookRecovery({ ...health, pendingChapters: [2] }, 2).blockedReason).toBe("CHAPTER_BODY_MISSING");
  expect(planBookRecovery(health, 0).blockedReason).toBe("INVALID_RECOVERY_TARGET");
});
it("starts retry at the latest contiguous frontier", () => {
  expect(planBookRecovery({ ...health, stateFrontier: 1, verifiedBaselines: [0, 1], pendingChapters: [2] }, 2).steps).toEqual([{ chapter: 2, action: "settle-persisted-body" }]);
});
