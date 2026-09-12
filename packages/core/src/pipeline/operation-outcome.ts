export type OperationStatus = "applied" | "unchanged" | "blocked" | "failed" | "cancelled";
export type FailureStage = "preflight" | "generation" | "settlement" | "validation" | "commit" | "audit";

/** Audit rejection after publication remains applied; status describes mutation. */
export interface OperationOutcome {
  operationId: string;
  status: OperationStatus;
  stage: FailureStage;
  reasonCode?: string;
  retryable: boolean;
  changedFiles: string[];
  candidateId?: string;
}

export function isProductionFailure(outcome: OperationOutcome): boolean {
  return outcome.status === "failed" || outcome.status === "blocked";
}
