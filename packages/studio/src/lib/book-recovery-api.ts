export interface RecoveryView {
  settlementAttempts?: Array<{ attemptId: string; chapter: number; status: string; reasonCode?: string; resumable: boolean }>;
  attempt?: { attemptId: string; chapter: number; status: string; [key: string]: unknown };
  events?: Array<{ type: string; [key: string]: unknown }>;
  attemptId?: string;
  stage?: string;
  issues?: unknown[];
  nextActions?: unknown[];
  candidates?: Array<{ candidateId: string; chapter?: number | null; status?: string; policySource?: "candidate" | "legacy-selection" | "missing"; publicationPolicy?: { revisionGate: "strict" | "lenient" | "always" } }>;
  availableBaselineBackup?: { backupId: string; chapter: 0 } | null;
  health?: { stateFrontier: number | null; pendingChapters: number[]; pendingOperationId?: string; issues: Array<{ code: string }> };
  plan?: { baseline: number | null; steps: Array<{ chapter: number }>; preservesBodies: true; blockedReason?: string };
  status?: string;
  applied?: boolean;
  candidateId?: string;
  completed?: number[];
  reasonCode?: string;
  error?: string;
  auditResult?: { passed: boolean };
}

export function recoveryChapterTargets(indexed: readonly number[], pending: readonly number[] = []): number[] {
  return [...new Set([...indexed, ...pending])].filter(chapter => Number.isSafeInteger(chapter) && chapter > 0).sort((a, b) => a - b);
}

/** Retain inspection context, but never carry a previous operation's failure into a new result. */
export function mergeRecoveryResult(current: RecoveryView | null, latest: RecoveryView, result: RecoveryView): RecoveryView {
  const context: RecoveryView = { ...current };
  for (const key of ["status", "applied", "candidateId", "attemptId", "completed", "reasonCode", "error", "stage", "issues", "nextActions", "auditResult"] as const) delete context[key];
  return { ...context, ...latest, ...result };
}

/** Business rejection bodies remain available to show recovery and candidate details. */
export async function requestBookRecovery(path: string, body?: unknown): Promise<RecoveryView> {
  const response = await fetch(`/api/v1${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let result: RecoveryView;
  try { result = await response.json() as RecoveryView; }
  catch { throw new Error(`Recovery request failed: HTTP ${response.status}`); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(`Invalid recovery response: HTTP ${response.status}`);
  if (!response.ok && !result.plan && !result.status && result.applied === undefined && !result.reasonCode) {
    throw new Error(result.error ?? `Recovery request failed: HTTP ${response.status}`);
  }
  return result;
}
