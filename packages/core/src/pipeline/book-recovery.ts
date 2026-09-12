import type { BookHealth } from "../state/book-health.js";

export interface RecoveryPlan {
  baseline: number | null;
  steps: Array<{ chapter: number; action: "settle-persisted-body" }>;
  preservesBodies: true;
  blockedReason?: string;
}

/** Pure planning never invents bodies, a historical baseline or authorization. */
export function planBookRecovery(health: BookHealth, target: number): RecoveryPlan {
  const baseline = health.stateFrontier;
  const plan: RecoveryPlan = { baseline, steps: [], preservesBodies: true };
  const block = (blockedReason: string): RecoveryPlan => ({ ...plan, blockedReason });
  if (!Number.isSafeInteger(target) || target < 1) return block("INVALID_RECOVERY_TARGET");
  if (health.pendingOperationId || health.issues.some(issue => issue.code === "TRANSACTION_RECOVERY_REQUIRED")) return block("TRANSACTION_RECOVERY_REQUIRED");
  if (health.issues.some(issue => issue.code === "BOOK_BUSY")) return block("BOOK_BUSY");
  const invalidIndex = health.issues.find(issue => issue.code.startsWith("CHAPTER_INDEX_"));
  if (invalidIndex) return block(invalidIndex.code);
  if (baseline === null || !health.verifiedBaselines.includes(baseline)) return block("BASELINE_MISSING");
  if (target <= baseline) return plan;
  const available = new Set(health.pendingChapters);
  for (let chapter = baseline + 1; chapter <= target; chapter++) {
    const bodyIssue = health.issues.find(issue => issue.chapter === chapter && ["CHAPTER_BODY_MISSING", "CHAPTER_BODY_AMBIGUOUS", "CHAPTER_BODY_UNREADABLE"].includes(issue.code));
    if (bodyIssue) return block(bodyIssue.code);
    if (!available.has(chapter)) return block("CHAPTER_BODY_MISSING");
  }
  for (let chapter = baseline + 1; chapter <= target; chapter++) plan.steps.push({ chapter, action: "settle-persisted-body" });
  return plan;
}
