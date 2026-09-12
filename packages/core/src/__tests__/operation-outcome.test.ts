import { expect, it } from "vitest";
import { isProductionFailure, type OperationOutcome } from "../pipeline/operation-outcome.js";
it("distinguishes unapplied rejection from applied audit failure, cancellation and no-op", () => {
  const base: OperationOutcome = { operationId: "op", status: "applied", stage: "audit", reasonCode: "AUDIT_REJECTED", retryable: false, changedFiles: ["chapters/body.md"] };
  expect(isProductionFailure(base)).toBe(false);
  expect(isProductionFailure({ ...base, status: "failed", stage: "settlement", changedFiles: [] })).toBe(true);
  expect(isProductionFailure({ ...base, status: "blocked", stage: "preflight", changedFiles: [] })).toBe(true);
  expect(isProductionFailure({ ...base, status: "cancelled", changedFiles: [] })).toBe(false);
  expect(isProductionFailure({ ...base, status: "unchanged", changedFiles: [] })).toBe(false);
});
