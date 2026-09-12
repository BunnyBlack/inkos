import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { z } from "zod";
import type { WriteChapterOutput } from "../agents/writer.js";
import { ContextPackageSchema, RuleStackSchema, type ContextPackage, type RuleStack } from "../models/input-governance.js";
import { RuntimeStateDeltaSchema, StateManifestSchema, CurrentStateStateSchema, HooksStateSchema, ChapterSummariesStateSchema } from "../models/runtime-state.js";
import { isBookTransactionActive } from "../state/book-transaction.js";
import type { CandidateInputs } from "./recovery-candidate.js";

const uuid = z.string().uuid();
const chapterNumber = z.number().int().positive().safe();
const violation = z.object({ rule: z.string(), severity: z.enum(["error", "warning"]), description: z.string(), suggestion: z.string() }).strict();
const outputSchema = z.object({
  chapterNumber, title: z.string(), content: z.string(), wordCount: z.number().finite().nonnegative(),
  preWriteCheck: z.string(), postSettlement: z.string(), updatedState: z.string(), updatedLedger: z.string(), updatedHooks: z.string(),
  chapterSummary: z.string(), updatedChapterSummaries: z.string().optional(), updatedSubplots: z.string(), updatedEmotionalArcs: z.string(), updatedCharacterMatrix: z.string(),
  postWriteErrors: z.array(violation), postWriteWarnings: z.array(violation),
  runtimeStateDelta: RuntimeStateDeltaSchema.extend({ chapter: z.number().int().nonnegative().safe() }).optional(),
  runtimeStateSnapshot: z.object({ manifest: StateManifestSchema, currentState: CurrentStateStateSchema, hooks: HooksStateSchema, chapterSummaries: ChapterSummariesStateSchema }).strict().optional(),
  hookHealthIssues: z.array(z.object({ severity: z.enum(["critical", "warning", "info"]), category: z.string(), description: z.string(), suggestion: z.string() }).strict()).optional(),
  tokenUsage: z.object({ promptTokens: z.number().finite().nonnegative(), completionTokens: z.number().finite().nonnegative(), totalTokens: z.number().finite().nonnegative() }).strict().optional(),
}).strict();
const contextSchema = z.object({ baselineChapter: z.number().int().nonnegative().safe(), settlementGuidance: z.string().optional(), allowNewHooks: z.boolean().optional(), chapterIntent: z.string().optional(), contextPackage: ContextPackageSchema.optional(), ruleStack: RuleStackSchema.optional() }).strict();
const attemptSchema = z.object({
  version: z.literal(1), attemptId: uuid, createdAt: z.string().datetime(), chapter: chapterNumber,
  inputs: z.object({ sourceHash: z.string().min(1), baselineHash: z.string().min(1), controlHash: z.string().min(1) }).strict(),
  output: outputSchema, context: contextSchema, parentAttemptId: uuid.optional(), resumable: z.boolean(),
}).strict().superRefine((record, ctx) => {
  if (record.output.chapterNumber !== record.chapter || record.context.baselineChapter !== record.chapter - 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Settlement chapter/baseline mismatch" });
  // Diagnostic write/revision attempts retain raw output before normal persistence
  // repairs chapter drift. Persisted-body resume must already be chapter-aligned.
  if (record.resumable && record.output.runtimeStateDelta && record.output.runtimeStateDelta.chapter !== record.chapter) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Settlement delta chapter mismatch" });
  if (record.resumable && record.output.runtimeStateSnapshot && (record.output.runtimeStateSnapshot.currentState.chapter !== record.chapter || record.output.runtimeStateSnapshot.manifest.lastAppliedChapter !== record.chapter)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Settlement snapshot chapter mismatch" });
});
const eventSchema = z.object({ version: z.literal(1), attemptId: uuid, eventId: uuid, sequence: z.number().int().positive().safe(), recordedAt: z.string().datetime(), type: z.string().min(1), data: z.unknown().optional() }).strict();
const receiptSchema = z.object({ version: z.literal(1), attemptId: uuid, chapter: chapterNumber, appliedAt: z.string().datetime() }).strict();
export type SettlementEvent = z.infer<typeof eventSchema>;
export type SettlementAttemptStatus = "pending" | "rejected" | "validated" | "applied" | "discarded";
export type SettlementAttempt = z.infer<typeof attemptSchema> & { status: SettlementAttemptStatus; reasonCode?: string };
export interface SettlementAttemptSummary {
  attemptId: string; chapter: number; createdAt: string; status: SettlementAttemptStatus | "invalid";
  parentAttemptId?: string; reasonCode?: string; resumable: boolean;
}
export interface CreateSettlementAttemptParams {
  chapter: number; inputs: CandidateInputs; output: WriteChapterOutput;
  context: { baselineChapter: number; settlementGuidance?: string; allowNewHooks?: boolean; chapterIntent?: string; contextPackage?: ContextPackage; ruleStack?: RuleStack };
  parentAttemptId?: string; resumable?: boolean;
}
function validId(id: string): void { if (!uuid.safeParse(id).success) throw new Error("INVALID_SETTLEMENT_ATTEMPT_ID"); }
function evidenceFailure(cause: unknown): Error { return Object.assign(new Error("SETTLEMENT_EVIDENCE_WRITE_FAILED", { cause }), { reasonCode: "SETTLEMENT_EVIDENCE_WRITE_FAILED" }); }
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

/** Reject credential-shaped data and values that JSON cannot preserve. */
function assertEvidence(value: unknown, ancestors = new Set<object>()): void {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("INVALID_SETTLEMENT_EVIDENCE");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("INVALID_SETTLEMENT_EVIDENCE");
  ancestors.add(value);
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:api[-_]?key|authorization|proxy[-_]?authorization|headers|password|secret|access[-_]?token|refresh[-_]?token)$/i.test(key)) throw new Error("SETTLEMENT_CREDENTIALS_FORBIDDEN");
    assertEvidence(entry, ancestors);
  }
  ancestors.delete(value);
}

/** Walk every existing ancestor; never traverse links, including book roots. */
async function safePath(path: string, createDirectories = false): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!absent(error) || !createDirectories) throw error;
      try { await mkdir(current); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure; }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("SETTLEMENT_UNSAFE_PATH");
  }
}
function storageRoot(bookDir: string): string { return join(bookDir, "story", "recovery", "settlements"); }
function attemptDir(bookDir: string, id: string): string { validId(id); return join(storageRoot(bookDir), id); }
async function readJson(path: string): Promise<unknown> {
  await safePath(parse(path).dir);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("SETTLEMENT_UNSAFE_PATH");
  return JSON.parse(await readFile(path, "utf8"));
}
async function durablePublish(path: string, value: unknown): Promise<void> {
  const dir = parse(path).dir;
  await safePath(dir, true);
  const staged = join(dir, `.${randomUUID()}.pending`);
  try {
    const handle = await open(staged, "wx");
    try { await handle.writeFile(JSON.stringify(value, null, 2).replace(/\n/g, "\r\n"), "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    // An exclusive hard link exposes only complete fsynced bytes, never replaces evidence.
    await safePath(dir);
    await link(staged, path);
  } finally { await rm(staged, { force: true }).catch(() => undefined); }
}

export async function createSettlementAttempt(bookDir: string, params: CreateSettlementAttemptParams): Promise<SettlementAttempt> {
  try {
    assertEvidence(params);
    const record = attemptSchema.parse({ ...params, version: 1, attemptId: randomUUID(), createdAt: new Date().toISOString(), resumable: params.resumable ?? true });
    const dir = attemptDir(bookDir, record.attemptId);
    await safePath(join(dir, "events"), true);
    await durablePublish(join(dir, "attempt.json"), record);
    return { ...record, status: "pending" };
  } catch (error) { throw evidenceFailure(error); }
}

export async function readSettlementEvents(bookDir: string, id: string): Promise<SettlementEvent[]> {
  const dir = join(attemptDir(bookDir, id), "events");
  await safePath(dir);
  const files = (await readdir(dir)).filter(name => /^\d{12}-[a-f0-9-]+\.json$/i.test(name)).sort();
  const events: SettlementEvent[] = [];
  for (const filename of files) {
    const event = eventSchema.parse(await readJson(join(dir, filename)));
    assertEvidence(event);
    if (event.attemptId !== id || filename !== `${String(event.sequence).padStart(12, "0")}-${event.eventId}.json` || event.sequence !== events.length + 1) throw new Error("INVALID_SETTLEMENT_EVENT");
    events.push(event);
  }
  return events;
}

export async function loadSettlementAttempt(bookDir: string, id: string): Promise<SettlementAttempt> {
  const record = attemptSchema.parse(await readJson(join(attemptDir(bookDir, id), "attempt.json")));
  assertEvidence(record);
  if (record.attemptId !== id) throw new Error("INVALID_SETTLEMENT_ATTEMPT_ID");
  try {
    const receipt = receiptSchema.parse(await readJson(join(bookDir, "chapters", ".settlement-receipts", `${id}.json`)));
    if (receipt.attemptId !== id || receipt.chapter !== record.chapter) throw new Error("INVALID_SETTLEMENT_RECEIPT");
    return { ...record, status: "applied" };
  } catch (error) { if (!absent(error)) throw error; }
  let status: SettlementAttemptStatus = "pending";
  let reasonCode: string | undefined;
  for (const event of await readSettlementEvents(bookDir, id)) {
    if (status === "discarded") break;
    if (["rejected", "validation-rejected"].includes(event.type)) status = "rejected";
    else if (["validated", "validation-passed"].includes(event.type)) { status = "validated"; reasonCode = undefined; }
    else if (event.type === "discarded") status = "discarded";
    const code = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>).reasonCode : undefined;
    if (typeof code === "string" && status !== "validated") reasonCode = code;
  }
  return { ...record, status, ...(reasonCode ? { reasonCode } : {}) };
}

/** Caller holds the book lock; immutable sequence records detect concurrent appenders. */
export async function appendSettlementEvent(bookDir: string, id: string, event: { type: string; data?: unknown }): Promise<void> {
  try {
    await loadSettlementAttempt(bookDir, id);
    assertEvidence(event);
    const previous = await readSettlementEvents(bookDir, id);
    const record = eventSchema.parse({ ...event, version: 1, attemptId: id, eventId: randomUUID(), sequence: previous.length + 1, recordedAt: new Date().toISOString() });
    await durablePublish(join(attemptDir(bookDir, id), "events", `${String(record.sequence).padStart(12, "0")}-${record.eventId}.json`), record);
  } catch (error) {
    // The append target is the current candidate, which may differ from the
    // caller's original resume ID. Preserve it even when the final log fails.
    throw Object.assign(evidenceFailure(error), { stage: "evidence", attemptId: id });
  }
}

export async function listSettlementAttempts(bookDir: string): Promise<SettlementAttemptSummary[]> {
  const root = storageRoot(bookDir);
  try { await safePath(root); } catch (error) { if (absent(error)) return []; throw error; }
  const summaries: SettlementAttemptSummary[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!uuid.safeParse(entry.name).success) continue;
    let attempt: SettlementAttempt;
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("SETTLEMENT_UNSAFE_PATH");
      // An interrupted atomic create has no committed record and is not an attempt.
      try { await lstat(join(root, entry.name, "attempt.json")); }
      catch (error) { if (absent(error)) continue; throw error; }
      attempt = await loadSettlementAttempt(bookDir, entry.name);
    } catch {
      // A corrupt record must remain diagnosable without hiding healthy siblings.
      summaries.push({ attemptId: entry.name, chapter: 0, createdAt: "", status: "invalid", reasonCode: "SETTLEMENT_RECORD_INVALID", resumable: false });
      continue;
    }
    const { attemptId, chapter, createdAt, parentAttemptId, status, reasonCode, resumable } = attempt;
    summaries.push({ attemptId, chapter, createdAt, status, resumable, ...(parentAttemptId ? { parentAttemptId } : {}), ...(reasonCode ? { reasonCode } : {}) });
  }
  return summaries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.attemptId.localeCompare(b.attemptId));
}

/** Transaction-covered receipt stays outside story snapshots and author-control hashes. */
export async function markSettlementApplied(bookDir: string, id: string): Promise<void> {
  if (!isBookTransactionActive(bookDir)) throw new Error("SETTLEMENT_TRANSACTION_REQUIRED");
  try {
    const attempt = await loadSettlementAttempt(bookDir, id);
    if (attempt.status === "applied") return;
    if (attempt.status === "discarded") throw new Error("SETTLEMENT_DISCARDED");
    await durablePublish(join(bookDir, "chapters", ".settlement-receipts", `${id}.json`), receiptSchema.parse({ version: 1, attemptId: id, chapter: attempt.chapter, appliedAt: new Date().toISOString() }));
  } catch (error) { throw evidenceFailure(error); }
}
