import type { AuditIssue } from "../agents/continuity.js";
import type {
  ValidationResult,
  ValidationWarning,
} from "../agents/state-validator.js";
import { groundedValidationIssueSchema } from "../agents/state-validation-evidence.js";
import type { StateValidatorAgent } from "../agents/state-validator.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { WriterAgent } from "../agents/writer.js";
import type { Logger } from "../utils/logger.js";
import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthLanguage } from "../utils/length-metrics.js";
import { captureCandidateInputs, type CandidateInputs } from "./recovery-candidate.js";
import { createSettlementAttempt, appendSettlementEvent, type SettlementAttempt } from "./settlement-attempt.js";

export interface SettlementRecording {
  inputs: CandidateInputs;
  resumable: boolean;
  context: SettlementAttempt["context"];
}

export async function captureSettlementRecording(bookDir: string, chapter: number, content: string,
  context: SettlementAttempt["context"], resumable = false): Promise<SettlementRecording> {
  if (resumable) return { inputs: await captureCandidateInputs(bookDir, chapter, context.settlementGuidance), context, resumable };
  // Non-published prose can be diagnosed but must resume through its original
  // write/revision workflow, never through the persisted-body recovery endpoint.
  return { inputs: await captureCandidateInputs(bookDir, chapter, context.settlementGuidance, Buffer.from(content, "utf8")), context, resumable };
}

export type SettlementFailureKind = "protocol" | "evidence" | "content";

function classifySettlementFailure(reasonCode: string, stage: string): SettlementFailureKind {
  if (["VALIDATOR_EVIDENCE_INVALID", "SETTLEMENT_EVIDENCE_WRITE_FAILED"].includes(reasonCode)
    || stage === "evidence") return "evidence";
  if (["VALIDATOR_PROTOCOL_INVALID", "VALIDATOR_FEEDBACK_UNVERIFIED", "STATE_VALIDATION_FAILED"].includes(reasonCode)) return "protocol";
  return "content";
}

export function settlementFailure(error: unknown): {
  reasonCode: string; stage: string; attemptId?: string; issues?: unknown;
  failureKind: SettlementFailureKind; diagnosticPath?: string; nextActions: string[];
} {
  const failure = error as {
    reasonCode?: string; stage?: string; attemptId?: string; issues?: unknown; diagnosticPath?: unknown;
  };
  const reasonCode = failure?.reasonCode ?? "CHAPTER_RECOVERY_FAILED";
  const stage = failure?.stage ?? "settlement";
  const failureKind = classifySettlementFailure(reasonCode, stage);
  const diagnosticPath = typeof failure?.diagnosticPath === "string" ? failure.diagnosticPath : undefined;
  const protocolFailure = ["VALIDATOR_PROTOCOL_INVALID", "VALIDATOR_EVIDENCE_INVALID", "VALIDATOR_FEEDBACK_UNVERIFIED"]
    .includes(reasonCode);
  return { reasonCode, stage, attemptId: failure?.attemptId, issues: failure?.issues, failureKind,
    ...(diagnosticPath ? { diagnosticPath } : {}),
    nextActions: failure?.attemptId
      ? protocolFailure ? ["inspect-settlement", "revalidate"] : ["inspect-settlement", "revalidate", "repair"]
      : ["inspect-recovery"] };
}

/** Keep user-visible failures readable while preserving the original cause chain. */
export function settlementErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}

/** Only grounded, complete feedback may be passed to a repair writer. */
export function hasCompleteRepairFeedbackShape(value: unknown): value is ValidationResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<ValidationResult>;
  const warnings = result.warnings;
  if (result.passed !== false || result.repairRequired !== true || !warnings || !Array.isArray(warnings)) return false;
  if (warnings.some((warning) => !warning || typeof warning.category !== "string" || typeof warning.description !== "string")) return false;
  const issues = result.issues;
  if (!issues || !Array.isArray(issues) || issues.length === 0) return false;
  return groundedValidationIssueSchema.array().safeParse(issues).success;
}

/** Reuse only an already committed PASS; malformed or blocking cached data is revalidated. */
export function isReusablePassValidation(value: unknown): value is ValidationResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<ValidationResult>;
  const warnings = result.warnings;
  if (result.passed !== true || result.repairRequired === true || !warnings || !Array.isArray(warnings)
    || warnings.some((warning) => !warning || typeof warning.category !== "string" || typeof warning.description !== "string")) return false;
  const issues = result.issues;
  return issues === undefined || (Array.isArray(issues) && issues.every((issue) => issue && typeof issue === "object" && issue.blocking !== true));
}

export function settlementMadeNoProgress(previous: WriteChapterOutput, next: WriteChapterOutput,
  previousValidation: ValidationResult, nextValidation: ValidationResult): boolean {
  const projection = (output: WriteChapterOutput) => JSON.stringify({ state: output.updatedState, hooks: output.updatedHooks,
    ledger: output.updatedLedger, summaries: output.updatedChapterSummaries, summary: output.chapterSummary,
    subplots: output.updatedSubplots, emotionalArcs: output.updatedEmotionalArcs, characterMatrix: output.updatedCharacterMatrix,
    delta: output.runtimeStateDelta, snapshot: output.runtimeStateSnapshot });
  const verdict = (validation: ValidationResult) => JSON.stringify({ passed: validation.passed,
    repairRequired: Boolean(validation.repairRequired), warnings: validation.warnings, issues: validation.issues });
  return projection(previous) === projection(next) && verdict(previousValidation) === verdict(nextValidation);
}

export async function validateRecordedSettlement(params: {
  validator: Pick<StateValidatorAgent, "validate">; bookDir: string; chapterNumber: number;
  content: string; output: WriteChapterOutput; oldState: string; oldHooks: string;
  language: LengthLanguage; recording: SettlementRecording; parentAttemptId?: string;
  authorityContext?: import("../agents/state-validator.js").StateValidationAuthorityContext;
}): Promise<{ attempt: SettlementAttempt; validation: ValidationResult }> {
  const attempt = await createSettlementAttempt(params.bookDir, { chapter: params.chapterNumber,
    inputs: params.recording.inputs, context: params.recording.context, output: params.output,
    resumable: params.recording.resumable, parentAttemptId: params.parentAttemptId });
  try {
    await appendSettlementEvent(params.bookDir, attempt.attemptId, { type: "validation-input", data: {
      content: params.content, oldState: params.oldState, oldHooks: params.oldHooks, language: params.language,
      authorityContext: params.authorityContext,
    } });
    const validation = await params.validator.validate(params.content, params.chapterNumber, params.oldState,
      params.output.updatedState, params.oldHooks, params.output.updatedHooks, params.language, params.authorityContext,
      { onDiagnostic: async event => { await appendSettlementEvent(params.bookDir, attempt.attemptId, { type: `validator-${event.phase}`, data: event }); } });
    await appendSettlementEvent(params.bookDir, attempt.attemptId, {
      type: validation.passed && !validation.repairRequired ? "validated" : "rejected", data: validation,
    });
    return { attempt, validation };
  } catch (error) {
    const reasonCode = (error as { reasonCode?: string }).reasonCode ?? "STATE_VALIDATION_FAILED";
    const stage = reasonCode === "SETTLEMENT_EVIDENCE_WRITE_FAILED" ? "evidence" : "validation";
    const diagnosticPath = (error as { diagnosticPath?: unknown }).diagnosticPath;
    const failureKind = classifySettlementFailure(reasonCode, stage);
    try {
      await appendSettlementEvent(params.bookDir, attempt.attemptId, { type: "rejected", data: {
        reasonCode, error: settlementErrorMessage(error), failureKind,
        ...(typeof diagnosticPath === "string" ? { diagnosticPath } : {}),
      } });
    } catch (evidenceCause) {
      // The candidate already exists. Keep its identifier and both failures even
      // when the disk cannot accept the rejection event; never return validation.
      throw Object.assign(new Error("SETTLEMENT_EVIDENCE_WRITE_FAILED", { cause: error }), {
        reasonCode: "SETTLEMENT_EVIDENCE_WRITE_FAILED", stage: "evidence", failureKind: "evidence",
        attemptId: attempt.attemptId, evidenceCause,
      });
    }
    throw Object.assign(new Error(settlementErrorMessage(error), { cause: error }), {
      reasonCode, stage, failureKind, attemptId: attempt.attemptId,
      ...(typeof diagnosticPath === "string" ? { diagnosticPath } : {}),
    });
  }
}

export interface SettlementRetryParams {
  readonly writer: Pick<WriterAgent, "settleChapterState">;
  readonly validator: Pick<StateValidatorAgent, "validate">;
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly baselineChapter?: number;
  readonly settlementGuidance?: string;
  readonly allowNewHooks?: boolean;
  readonly title: string;
  readonly content: string;
  readonly reducedControlInput?: {
    chapterIntent?: string;
    contextPackage?: ContextPackage;
    ruleStack?: RuleStack;
  };
  readonly oldState: string;
  readonly oldHooks: string;
  readonly originalValidation: ValidationResult;
  /** Set by recovery after the saved candidate has been revalidated. */
  readonly verifiedFeedback?: boolean;
  readonly previousSettlement?: WriteChapterOutput;
  readonly recording?: SettlementRecording;
  readonly parentAttemptId?: string;
  readonly authorityContext?: import("../agents/state-validator.js").StateValidationAuthorityContext;
  readonly language: LengthLanguage;
  readonly logWarn?: (message: { zh: string; en: string }) => void;
  readonly logger?: Pick<Logger, "warn">;
}

export type SettlementRetryResult =
  | {
    readonly kind: "recovered";
    readonly output: WriteChapterOutput;
    readonly validation: ValidationResult;
    readonly attemptId?: string;
  }
  | {
    readonly kind: "degraded";
    readonly issues: ReadonlyArray<AuditIssue>;
    readonly attemptId?: string;
    readonly reasonCode?: string;
    readonly validation?: ValidationResult;
  };

export async function retrySettlementAfterValidationFailure(
  params: SettlementRetryParams,
): Promise<SettlementRetryResult> {
  params.logWarn?.({
    zh: `状态校验失败，正在仅重试结算层（第${params.chapterNumber}章）`,
    en: `State validation failed; retrying settlement only for chapter ${params.chapterNumber}`,
  });

  if (params.originalValidation.repairRequired === false && !params.originalValidation.passed) {
    return {
      kind: "degraded",
      issues: buildStateDegradedIssues(params.originalValidation.warnings, params.language),
      attemptId: params.parentAttemptId,
      reasonCode: "SETTLEMENT_REJECTED",
      validation: params.originalValidation,
    };
  }
  if (params.verifiedFeedback && !hasCompleteRepairFeedbackShape(params.originalValidation)) {
    throw Object.assign(new Error("VALIDATOR_FEEDBACK_UNVERIFIED"), {
      reasonCode: "VALIDATOR_FEEDBACK_UNVERIFIED", stage: "validation", failureKind: "protocol", attemptId: params.parentAttemptId,
    });
  }

  let retryOutput: WriteChapterOutput;
  if (params.parentAttemptId) await appendSettlementEvent(params.bookDir, params.parentAttemptId, { type: "settlement-request", data: {
    chapter: params.chapterNumber, baselineChapter: params.baselineChapter, content: params.content,
    validation: params.originalValidation, guidance: params.settlementGuidance,
  } });
  try { retryOutput = await params.writer.settleChapterState({
    book: params.book,
    bookDir: params.bookDir,
    chapterNumber: params.chapterNumber,
    title: params.title,
    content: params.content,
    allowReapply: true,
    baselineChapter: params.baselineChapter,
    settlementGuidance: params.settlementGuidance,
    allowNewHooks: params.allowNewHooks,
    chapterIntent: params.reducedControlInput?.chapterIntent,
    contextPackage: params.reducedControlInput?.contextPackage,
    ruleStack: params.reducedControlInput?.ruleStack,
    validationFeedback: buildStateValidationFeedback(params.originalValidation, params.language),
    previousSettlement: params.previousSettlement,
  }); } catch (error) {
    throw Object.assign(new Error(settlementErrorMessage(error), { cause: error }), {
      reasonCode: (error as { reasonCode?: string }).reasonCode ?? "SETTLEMENT_GENERATION_FAILED",
      stage: "settlement", attemptId: params.parentAttemptId,
    });
  }

  let retryValidation: ValidationResult;
  let attemptId: string | undefined;
  try {
    if (params.recording) {
      const recorded = await validateRecordedSettlement({ validator: params.validator, bookDir: params.bookDir,
        chapterNumber: params.chapterNumber, content: params.content, output: retryOutput,
        oldState: params.oldState, oldHooks: params.oldHooks, language: params.language,
        recording: params.recording, parentAttemptId: params.parentAttemptId, authorityContext: params.authorityContext });
      retryValidation = recorded.validation;
      attemptId = recorded.attempt.attemptId;
    } else retryValidation = await params.validator.validate(
      params.content,
      params.chapterNumber,
      params.oldState,
      retryOutput.updatedState,
      params.oldHooks,
      retryOutput.updatedHooks,
      params.language,
      params.authorityContext,
    );
  } catch (error) {
    throw Object.assign(new Error(`State validation retry failed for chapter ${params.chapterNumber}: ${settlementErrorMessage(error)}`, { cause: error }), settlementFailure(error));
  }

  if (retryValidation.warnings.length > 0) {
    params.logWarn?.({
      zh: `状态校验重试后，第${params.chapterNumber}章仍有 ${retryValidation.warnings.length} 条警告`,
      en: `State validation retry still reports ${retryValidation.warnings.length} warning(s) for chapter ${params.chapterNumber}`,
    });
    for (const warning of retryValidation.warnings) {
      params.logger?.warn(`  [${warning.category}] ${warning.description}`);
    }
  }

  if (retryValidation.passed && !retryValidation.repairRequired) {
    return {
      kind: "recovered",
      output: retryOutput,
      validation: retryValidation,
      attemptId,
    };
  }

  const reasonCode = params.previousSettlement && settlementMadeNoProgress(params.previousSettlement, retryOutput,
    params.originalValidation, retryValidation) ? "SETTLEMENT_NO_PROGRESS" : "SETTLEMENT_REJECTED";
  if (attemptId) await appendSettlementEvent(params.bookDir, attemptId, { type: "rejected", data: { ...retryValidation, reasonCode } });
  return {
    kind: "degraded",
    issues: buildStateDegradedIssues(retryValidation.warnings, params.language),
    attemptId,
    reasonCode,
    validation: retryValidation,
  };
}

export function buildStateValidationFeedback(
  validationOrWarnings: ValidationResult | ReadonlyArray<ValidationWarning>,
  language: LengthLanguage,
): string {
  const isWarnings = (value: ValidationResult | ReadonlyArray<ValidationWarning>): value is ReadonlyArray<ValidationWarning> => Array.isArray(value);
  const validation = isWarnings(validationOrWarnings) ? undefined : validationOrWarnings;
  const warnings: ReadonlyArray<ValidationWarning> = validation
    ? validation.warnings
    : validationOrWarnings as ReadonlyArray<ValidationWarning>;
  const issues = validation?.issues ?? [];
  if (issues.length > 0) {
    const rendered = issues.map((issue) => {
      const evidence = issue.evidence.length > 0
        ? issue.evidence.map((item) => `${item.source}: ${item.quote}`).join(language === "en" ? " | " : "；")
        : language === "en" ? "(no source quote)" : "（无原文引文）";
      const status = issue.blocking
        ? language === "en" ? "blocking" : "阻断"
        : language === "en" ? "observation; do not invent facts" : "观察；不得臆造事实";
      return language === "en"
        ? `- [${issue.category}] ${status} (${issue.kind}/${issue.basis}): ${issue.description}\n  Rationale: ${issue.rationale}\n  Target: ${issue.target ?? "none"}\n  Evidence: ${evidence}`
        : `- [${issue.category}] ${status}（${issue.kind}/${issue.basis}）：${issue.description}\n  理由：${issue.rationale}\n  目标：${issue.target ?? "无"}\n  证据：${evidence}`;
    });
    return [
      language === "en"
        ? "The previous settlement failed validation. Address only the grounded feedback below against the unchanged chapter body:"
        : "上一次状态结算未通过校验。请仅依据以下有原文依据的反馈，对照未改变的正文处理：",
      ...rendered,
    ].join("\n");
  }
  if (warnings.length === 0) return "";

  if (language === "en") {
    return [
      "The previous settlement failed validation. Fix these contradictions against the chapter body:",
      ...warnings.map((warning) => `- [${warning.category}] ${warning.description}`),
    ].join("\n");
  }

  return [
    "上一次状态结算未通过校验。请对照正文修正以下矛盾：",
    ...warnings.map((warning) => `- [${warning.category}] ${warning.description}`),
  ].join("\n");
}

export function buildStateDegradedIssues(
  warnings: ReadonlyArray<ValidationWarning>,
  language: LengthLanguage,
): ReadonlyArray<AuditIssue> {
  if (warnings.length > 0) {
    return warnings.map((warning) => ({
      severity: "warning" as const,
      category: "state-validation",
      description: warning.description,
      suggestion: language === "en"
        ? "Repair chapter state from the persisted body before continuing."
        : "请先基于已保存正文修复本章 state，再继续后续章节。",
    }));
  }

  return [{
    severity: "warning",
    category: "state-validation",
    description: language === "en"
      ? "State validation still failed after settlement retry."
      : "状态结算重试后仍未通过校验。",
    suggestion: language === "en"
      ? "Repair chapter state from the persisted body before continuing."
      : "请先基于已保存正文修复本章 state，再继续后续章节。",
  }];
}

export function buildStateDegradedPersistenceOutput(params: {
  readonly output: WriteChapterOutput;
  readonly oldState: string;
  readonly oldHooks: string;
  readonly oldLedger: string;
}): WriteChapterOutput {
  return {
    ...params.output,
    runtimeStateDelta: undefined,
    runtimeStateSnapshot: undefined,
    updatedState: params.oldState,
    updatedLedger: params.oldLedger,
    updatedHooks: params.oldHooks,
    updatedChapterSummaries: undefined,
  };
}

export interface StateDegradedReviewNote {
  readonly kind: "state-degraded";
  readonly baseStatus: "ready-for-review" | "audit-failed";
  readonly injectedIssues: ReadonlyArray<string>;
}

/** Older audits could overwrite status while leaving the settlement failure in reviewNote. */
export function isChapterStateDegraded(chapter: Pick<ChapterMeta, "status" | "reviewNote" | "stateIntegrity">): boolean {
  return chapter.stateIntegrity?.status === "stale" || chapter.stateIntegrity?.status === "degraded"
    || chapter.status === "state-degraded" || parseStateDegradedReviewNote(chapter.reviewNote) !== null;
}

export function markChapterStateDegraded(chapter: ChapterMeta): ChapterMeta {
  const metadata = parseStateDegradedReviewNote(chapter.reviewNote);
  return {
    ...chapter,
    status: "state-degraded",
    stateIntegrity: { status: "stale" },
    updatedAt: new Date().toISOString(),
    reviewNote: isChapterStateDegraded(chapter)
      ? JSON.stringify({
        kind: "state-degraded",
        baseStatus: resolveStateDegradedBaseStatus(chapter),
        injectedIssues: metadata?.injectedIssues ?? [],
      } satisfies StateDegradedReviewNote)
      : buildStateDegradedReviewNote("audit-failed", []),
  };
}

export function buildStateDegradedReviewNote(
  baseStatus: "ready-for-review" | "audit-failed",
  issues: ReadonlyArray<AuditIssue>,
): string {
  return JSON.stringify({
    kind: "state-degraded",
    baseStatus,
    injectedIssues: issues.map((issue) => `[${issue.severity}] ${issue.description}`),
  } satisfies StateDegradedReviewNote);
}

export function parseStateDegradedReviewNote(
  reviewNote?: string,
): StateDegradedReviewNote | null {
  if (!reviewNote) {
    return null;
  }

  try {
    const parsed = JSON.parse(reviewNote) as {
      kind?: unknown;
      baseStatus?: unknown;
      injectedIssues?: unknown;
    };
    if (
      parsed.kind !== "state-degraded"
      || (parsed.baseStatus !== "ready-for-review" && parsed.baseStatus !== "audit-failed")
      || !Array.isArray(parsed.injectedIssues)
    ) {
      return null;
    }

    return {
      kind: "state-degraded",
      baseStatus: parsed.baseStatus,
      injectedIssues: parsed.injectedIssues.filter((issue): issue is string => typeof issue === "string"),
    };
  } catch {
    return null;
  }
}

export function resolveStateDegradedBaseStatus(
  chapter: Pick<ChapterMeta, "status" | "reviewNote" | "auditIssues">,
): "ready-for-review" | "audit-failed" {
  const metadata = parseStateDegradedReviewNote(chapter.reviewNote);
  const injected = new Set(metadata?.injectedIssues ?? []);
  const hasAuditCritical = chapter.auditIssues.some(
    (issue) => issue.startsWith("[critical]") && !injected.has(issue),
  );
  if (chapter.status === "audit-failed" || hasAuditCritical) {
    return "audit-failed";
  }
  if (chapter.status === "ready-for-review") {
    return "ready-for-review";
  }

  return metadata?.baseStatus ?? "ready-for-review";
}
