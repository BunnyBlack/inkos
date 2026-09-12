import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { isSafeBookId } from "../utils/book-id.js";

export const AGENT_OPERATION_STATUSES = [
  "applied",
  "unchanged",
  "failed",
  "blocked",
  "cancelled",
] as const;

export type AgentOperationStatus = (typeof AGENT_OPERATION_STATUSES)[number];

export interface AgentOperationOutcome {
  bookId: string;
  chapterNumber?: number;
  toolCallId: string;
  status: AgentOperationStatus;
  attemptId?: string;
  reasonCode?: string;
  resourceKey?: string;
}

export interface OperationResultExtension {
  operationOutcomes?: AgentOperationOutcome[];
}

interface OperationDetails {
  readonly [key: string]: unknown;
}

interface OutcomeInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: Record<string, unknown>;
  readonly result?: unknown;
  readonly details?: unknown;
  readonly isError?: boolean;
  readonly activeBookId?: string | null;
}

const READ_TOOLS = new Set(["read", "ls", "grep"]);
const INSPECTION_KINDS = new Set(["settlement_inspection", "recovery_status", "file_read"]);
const OPERATION_TOOLS = new Set([
  "sub_agent",
  "recover_chapters",
  "resume_revision_candidate",
  "resume_settlement_attempt",
  "resync_chapter_state",
]);
const MUTATING_TOOLS = new Set([
  "write_truth_file",
  "rename_entity",
  "patch_chapter_text",
  "replace_chapter_text",
  "delete_latest_chapter",
  "import_chapters",
  "continuation_import",
  "write",
  "edit",
]);
const OPERATION_KINDS = new Set([
  "chapter_revision",
  "chapter_recovery",
  "chapter_state_resynced",
  "chapter_written",
  "chapters_written",
  "settlement_recovery",
]);

const SUB_AGENT_OPERATION_AGENTS = new Set(["writer", "reviser"]);

function record(value: unknown): OperationDetails | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as OperationDetails
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function status(value: unknown): AgentOperationStatus | undefined {
  return typeof value === "string" && (AGENT_OPERATION_STATUSES as readonly string[]).includes(value)
    ? value as AgentOperationStatus
    : undefined;
}

function detailsFrom(input: OutcomeInput): OperationDetails | undefined {
  return record(input.details) ?? record(record(input.result)?.details);
}

function isProductionTool(input: OutcomeInput, details?: OperationDetails): boolean {
  if (input.toolName === "sub_agent") {
    const agent = string(input.args?.agent);
    return agent ? SUB_AGENT_OPERATION_AGENTS.has(agent)
      : OPERATION_KINDS.has(string(details?.kind) ?? "");
  }
  return OPERATION_TOOLS.has(input.toolName) || MUTATING_TOOLS.has(input.toolName);
}

function bookIdFromConstrainedPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const path = value.replaceAll("\\", "/").trim();
  if (path.startsWith("/") || /^[A-Za-z]:\//u.test(path) || path.split("/").some((part) => part === "..")) return undefined;
  const first = path.split("/").find((part) => part && part !== ".");
  return first && isSafeBookId(first) ? first : undefined;
}

function bookIdFromInput(input: OutcomeInput): string | undefined {
  if (input.toolName === "write" || input.toolName === "edit") {
    return bookIdFromConstrainedPath(input.args?.path) ?? string(input.activeBookId);
  }
  return string(input.activeBookId) ?? string(input.args?.bookId);
}

function normalizedStatus(details: OperationDetails, isError: boolean | undefined): AgentOperationStatus | undefined {
  const nested = record(details.outcome);
  const explicit = status(nested?.status) ?? status(details.status);
  if (explicit) return explicit;
  if (details.applied === true) return "applied";
  if (details.applied === false) return "failed";
  return isError ? "failed" : undefined;
}

function chapterFrom(details: OperationDetails, args: Record<string, unknown> | undefined): number | undefined {
  return number(details.failedChapter)
    ?? number(details.chapterNumber)
    ?? number(args?.failedChapter)
    ?? number(args?.chapterNumber)
    ?? number(args?.targetChapter);
}

function outcome(
  input: OutcomeInput,
  details: OperationDetails,
  statusValue: AgentOperationStatus,
  chapterNumber: number | undefined = chapterFrom(details, input.args),
): AgentOperationOutcome | undefined {
  const nested = record(details.outcome);
  const bookId = string(details.bookId) ?? string(nested?.bookId) ?? string(input.args?.bookId) ?? string(input.activeBookId);
  if (!bookId) return undefined;
  const attemptId = string(details.attemptId) ?? string(nested?.attemptId);
  const reasonCode = string(details.reasonCode) ?? string(nested?.reasonCode);
  const resourceKey = resourceKeyFor(input);
  return {
    bookId,
    ...(chapterNumber !== undefined ? { chapterNumber } : {}),
    toolCallId: input.toolCallId,
    status: statusValue,
    ...(attemptId ? { attemptId } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    ...(resourceKey ? { resourceKey } : {}),
  };
}

function resourceKeyFor(input: OutcomeInput): string | undefined {
  if (!MUTATING_TOOLS.has(input.toolName)) return undefined;
  const chapter = chapterFrom({}, input.args);
  if ((input.toolName === "patch_chapter_text" || input.toolName === "replace_chapter_text") && chapter !== undefined) {
    return `chapter:${chapter}`;
  }
  const path = input.toolName === "write" || input.toolName === "edit"
    ? string(input.args?.path)
    : input.toolName === "write_truth_file" ? string(input.args?.fileName) : undefined;
  if (path) {
    const canonicalPath = path.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".").join("/");
    return `${input.toolName}:${canonicalPath}`;
  }
  return `mutation:${input.toolName}`;
}

function statusForWrittenChapter(details: OperationDetails, kind: string): AgentOperationStatus | undefined {
  const nestedStatus = status(record(details.outcome)?.status);
  if (nestedStatus) return nestedStatus;
  const value = details.status;
  if (value === "applied" || value === "unchanged" || value === "failed" || value === "blocked" || value === "cancelled") {
    return value;
  }
  if (kind === "chapter_state_resynced" && value === "audit-failed") return "applied";
  if (value === "ready-for-review" || value === "active") return "applied";
  if (value !== undefined) return "failed";
  return undefined;
}

/**
 * Convert one structured tool result into business outcomes. Transport
 * success is deliberately independent from the operation status: a tool may
 * return `isError=false` while settlement still reports `failed`.
 */
export function operationOutcomesFromToolResult(input: OutcomeInput): AgentOperationOutcome[] {
  if (READ_TOOLS.has(input.toolName) || input.toolName === "inspect_settlement_attempt") return [];
  const details = detailsFrom(input);
  if (!details) {
    if (!isProductionTool(input)) return [];
    if (!input.isError && !MUTATING_TOOLS.has(input.toolName)) return [];
    const bookId = bookIdFromInput(input);
    if (!bookId) return [];
    const chapterNumber = chapterFrom({}, input.args);
    const statusValue: AgentOperationStatus = input.isError ? "failed" : "applied";
    const item = outcome(input, { bookId }, statusValue, chapterNumber);
    return item ? [item] : [];
  }
  if (INSPECTION_KINDS.has(String(details.kind)) || !isProductionTool(input, details)) return [];
  if (!MUTATING_TOOLS.has(input.toolName) && !OPERATION_TOOLS.has(input.toolName)
    && !OPERATION_KINDS.has(String(details.kind))) return [];
  const kind = string(details.kind) ?? "";
  const results: AgentOperationOutcome[] = [];

  if (kind === "chapters_written" && Array.isArray(details.chapters)) {
    for (const chapter of details.chapters) {
      const item = record(chapter);
      const chapterNumber = number(item?.chapterNumber);
      const itemStatus = item ? statusForWrittenChapter(item, kind) : undefined;
      if (item && chapterNumber !== undefined && itemStatus) {
        const itemDetails = { ...details, ...item };
        if (item.outcome === undefined) itemDetails.outcome = undefined;
        if (itemStatus === "applied" || itemStatus === "unchanged") {
          itemDetails.attemptId = undefined;
          itemDetails.reasonCode = undefined;
        }
        const itemOutcome = outcome(input, itemDetails, itemStatus, chapterNumber);
        if (itemOutcome) results.push(itemOutcome);
      }
    }
    return results;
  }

  if (kind === "chapter_recovery") {
    const completed = Array.isArray(details.completed)
      ? details.completed.map(number).filter((value): value is number => value !== undefined)
      : [];
    for (const chapterNumber of completed) {
      const item = outcome(input, { bookId: details.bookId }, "applied", chapterNumber);
      if (item) results.push(item);
    }
    const failedChapter = number(details.failedChapter);
    if (failedChapter !== undefined) {
      const item = outcome(input, details, status(details.status) ?? "failed", failedChapter);
      if (item) results.push(item);
    }
    if (results.length > 0) return results;
  }

  if (kind === "chapter_written" || kind === "chapter_state_resynced") {
    const writtenStatus = statusForWrittenChapter(details, kind);
    if (writtenStatus) {
      const item = outcome(input, details, writtenStatus);
      if (item) return [item];
    }
  }

  const normalized = normalizedStatus(details, input.isError);
  if (!normalized) return [];
  const item = outcome(input, details, normalized);
  return item ? [item] : [];
}

function outcomeKey(item: AgentOperationOutcome): string {
  return `${outcomeBaseKey(item)}\u0000${item.resourceKey ?? "*"}`;
}

function outcomeBaseKey(item: AgentOperationOutcome): string {
  return `${item.bookId}\u0000${item.chapterNumber ?? "*"}`;
}

function isSuccess(statusValue: AgentOperationStatus): boolean {
  return statusValue === "applied" || statusValue === "unchanged";
}

/** Merge outcomes while retaining failures until that exact chapter succeeds. */
export function mergeOperationOutcomes(
  existing: ReadonlyArray<AgentOperationOutcome>,
  incoming: ReadonlyArray<AgentOperationOutcome>,
): AgentOperationOutcome[] {
  const merged = new Map<string, AgentOperationOutcome>();
  for (const item of existing) merged.set(outcomeKey(item), item);
  for (const item of incoming) {
    const key = outcomeKey(item);
    if (isSuccess(item.status)) {
      if (item.resourceKey) {
        merged.delete(key);
      } else {
        for (const existingKey of merged.keys()) {
          if (existingKey.startsWith(`${outcomeBaseKey(item)}\u0000`)) merged.delete(existingKey);
        }
      }
    }
    if (item.status === "cancelled") {
      const previous = merged.get(key);
      if (previous?.status === "failed" || previous?.status === "blocked") continue;
    }
    merged.set(key, item);
  }
  return [...merged.values()];
}

export function hasFailedOperationOutcomes(
  outcomes: ReadonlyArray<AgentOperationOutcome> | undefined,
): boolean {
  return outcomes?.some((item) => item.status === "failed" || item.status === "blocked") ?? false;
}

export class OperationOutcomeCollector {
  private readonly activeBookId: string | null;
  private readonly pending = new Map<string, { toolName: string; args: Record<string, unknown> }>();
  private outcomes: AgentOperationOutcome[] = [];

  constructor(activeBookId: string | null = null) {
    this.activeBookId = activeBookId;
  }

  observeToolStart(toolCallId: string, toolName: string, args: Record<string, unknown> = {}): void {
    this.pending.set(toolCallId, { toolName, args });
  }

  observeToolEnd(toolCallId: string, toolName: string, result: unknown, isError = false, details?: unknown): void {
    const start = this.pending.get(toolCallId);
    this.pending.delete(toolCallId);
    const next = operationOutcomesFromToolResult({
      toolCallId,
      toolName: start?.toolName ?? toolName,
      args: start?.args,
      result,
      details,
      isError,
      activeBookId: this.activeBookId,
    });
    this.outcomes = mergeOperationOutcomes(this.outcomes, next);
  }

  observe(event: AgentEvent): void {
    if (event.type === "tool_execution_start") {
      this.observeToolStart(event.toolCallId, event.toolName, event.args as Record<string, unknown>);
    } else if (event.type === "tool_execution_end") {
      this.observeToolEnd(event.toolCallId, event.toolName, event.result, event.isError);
    }
  }

  getOutcomes(): AgentOperationOutcome[] {
    return this.outcomes.slice();
  }
}

export function createOperationOutcomeCollector(activeBookId: string | null = null): OperationOutcomeCollector {
  return new OperationOutcomeCollector(activeBookId);
}
