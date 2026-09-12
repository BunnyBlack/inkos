import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ReviseMode, ReviseOutput } from "../agents/reviser.js";
import { readRecoveryBody } from "../state/recovery-index.js";

export interface CandidateInputs { sourceHash: string; baselineHash: string; controlHash: string }
const publicationPolicySchema = z.object({ revisionGate: z.enum(["strict", "lenient", "always"]) });
export type CandidatePublicationPolicy = z.infer<typeof publicationPolicySchema>;
export interface ResumeCandidateOptions { legacyRevisionGate?: CandidatePublicationPolicy["revisionGate"] }
function policyError(reasonCode: string): Error { return Object.assign(new Error(reasonCode), { reasonCode }); }
const baseSchema = z.object({
  candidateId: z.string().uuid(), operationId: z.string().uuid(),
  chapter: z.number().int().positive(), mode: z.enum(["auto", "polish", "rewrite", "rework", "anti-detect", "spot-fix"]),
  externalContext: z.string().optional(), createdAt: z.string(),
  inputs: z.object({ sourceHash: z.string(), baselineHash: z.string(), controlHash: z.string() }),
  output: z.object({ revisedContent: z.string().min(1), wordCount: z.number(), fixedIssues: z.array(z.string()) }),
});
const schema = z.discriminatedUnion("version", [
  baseSchema.extend({ version: z.literal(1) }),
  baseSchema.extend({ version: z.literal(2), publicationPolicy: publicationPolicySchema }),
]);
export type RecoveryCandidate = z.infer<typeof schema>;
function candidateDir(bookDir: string, candidateId: string): string {
  if (!z.string().uuid().safeParse(candidateId).success) throw new Error("INVALID_CANDIDATE_ID");
  return join(bookDir, "story", "recovery", "candidates", candidateId);
}
async function optionalRead(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const derived = new Set(["current_state.md", "pending_hooks.md", "particle_ledger.md", "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md", "audit_drift_guidance.md"]);
async function treeFiles(root: string, controls = false): Promise<Array<[string, string]>> {
  const result: Array<[string, string]> = [];
  async function visit(relative: string) {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (controls && ((!relative && (derived.has(entry.name) || /^memory\.db(?:-wal|-shm|-journal)?$/.test(entry.name))) || ["state", "snapshots", "runtime", "recovery"].includes(entry.name))) continue;
      if (entry.isSymbolicLink()) throw new Error("CANDIDATE_INPUT_SYMLINK_UNSUPPORTED");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push([path, digest(await readFile(join(root, path)))]);
    }
  }
  await visit("");
  return result;
}

/** Capture exact published bytes (including heading) and all retained baseline files. */
export async function captureCandidateInputs(bookDir: string, chapter: number, effectiveInstructions?: string, unpublishedBody?: Buffer): Promise<CandidateInputs> {
  const source = unpublishedBody ?? (await readRecoveryBody(bookDir, chapter)).bytes;
  const baseline = await treeFiles(join(bookDir, "story", "snapshots", String(chapter - 1)));
  const controls = await treeFiles(join(bookDir, "story"), true);
  const bookConfig = await optionalRead(join(bookDir, "book.json"));
  return {
    sourceHash: digest(source),
    baselineHash: digest(JSON.stringify(baseline)),
    controlHash: digest(JSON.stringify({ controls, bookConfig: bookConfig ? digest(bookConfig) : null, effectiveInstructions: effectiveInstructions ?? "" })),
  };
}

export function assertCandidateInputs(candidate: RecoveryCandidate, current: CandidateInputs): void {
  if (candidate.inputs.sourceHash !== current.sourceHash || candidate.inputs.baselineHash !== current.baselineHash || candidate.inputs.controlHash !== current.controlHash) {
    throw new Error(`CANDIDATE_INPUTS_CHANGED: ${candidate.candidateId}; inspect recovery status before creating a new candidate.`);
  }
}

async function writeDurable(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx");
  try { await file.writeFile(JSON.stringify(value, null, 2).replace(/\n/g, "\r\n"), "utf8"); await file.sync(); }
  finally { await file.close(); }
}

/** Expose only a complete synced record; link publishes exclusively without replacing evidence. */
async function publishDurablePolicy(path: string, value: unknown): Promise<void> {
  const staged = `${path}.${randomUUID()}.pending`;
  try {
    await writeDurable(staged, value);
    await link(staged, path);
  } finally {
    // A crash may retain an ignored staged file, but never a partial final policy.
    await rm(staged, { force: true }).catch(() => undefined);
  }
}

export async function createRecoveryCandidate(bookDir: string, params: { chapter: number; mode: ReviseMode; externalContext?: string; inputs: CandidateInputs; output: ReviseOutput; publicationPolicy: CandidatePublicationPolicy }): Promise<RecoveryCandidate> {
  const candidate = schema.parse({ version: 2, candidateId: randomUUID(), operationId: randomUUID(), createdAt: new Date().toISOString(), ...params });
  const dir = candidateDir(bookDir, candidate.candidateId);
  await mkdir(dir, { recursive: true });
  await writeDurable(join(dir, "candidate.json"), candidate);
  return candidate;
}

export async function loadRecoveryCandidate(bookDir: string, candidateId: string): Promise<RecoveryCandidate> {
  const dir = candidateDir(bookDir, candidateId);
  if (await optionalRead(join(dir, "discarded.json"))) throw new Error("CANDIDATE_DISCARDED");
  if (await optionalRead(join(dir, "applied.json"))) throw new Error("CANDIDATE_ALREADY_APPLIED");
  const result = schema.parse(JSON.parse(await readFile(join(dir, "candidate.json"), "utf8")));
  if (result.candidateId !== candidateId) throw new Error("INVALID_CANDIDATE_ID");
  return result;
}

/** Read-only diagnostics omit candidate prose and author instructions. */
export interface RecoveryCandidateSummary {
  candidateId: string;
  chapter: number | null;
  createdAt: string | null;
  status: "pending" | "applied" | "discarded" | "invalid";
  issue?: string;
  errorCode?: string;
  publicationPolicy?: CandidatePublicationPolicy;
  policySource?: "candidate" | "legacy-selection" | "missing";
}

const selectedPolicySchema = z.object({ version: z.literal(1), candidateId: z.string().uuid(), publicationPolicy: publicationPolicySchema, selectedAt: z.string() });
async function readCandidatePolicy(bookDir: string, candidate: RecoveryCandidate): Promise<{ publicationPolicy?: CandidatePublicationPolicy; policySource: "candidate" | "legacy-selection" | "missing" }> {
  if (candidate.version === 2) return { publicationPolicy: candidate.publicationPolicy, policySource: "candidate" };
  const bytes = await optionalRead(join(candidateDir(bookDir, candidate.candidateId), "publication-policy.json"));
  if (!bytes) return { policySource: "missing" };
  let record: z.infer<typeof selectedPolicySchema>;
  try { record = selectedPolicySchema.parse(JSON.parse(bytes.toString("utf8"))); }
  catch { throw policyError("CANDIDATE_POLICY_INVALID"); }
  if (record.candidateId !== candidate.candidateId) throw new Error("CANDIDATE_POLICY_ID_MISMATCH");
  return { publicationPolicy: record.publicationPolicy, policySource: "legacy-selection" };
}

/** Caller holds the book lock. Persist explicit legacy selection before model work. */
export async function resolveCandidatePublicationPolicy(bookDir: string, candidate: RecoveryCandidate, options: ResumeCandidateOptions = {}): Promise<CandidatePublicationPolicy> {
  if (candidate.version === 2 && options.legacyRevisionGate !== undefined) throw policyError("CANDIDATE_POLICY_OVERRIDE_FORBIDDEN");
  const existing = await readCandidatePolicy(bookDir, candidate);
  if (existing.publicationPolicy) {
    if (options.legacyRevisionGate !== undefined && options.legacyRevisionGate !== existing.publicationPolicy.revisionGate) throw policyError("CANDIDATE_POLICY_CONFLICT");
    return existing.publicationPolicy;
  }
  if (options.legacyRevisionGate === undefined) throw policyError("CANDIDATE_POLICY_REQUIRED");
  const publicationPolicy = publicationPolicySchema.parse({ revisionGate: options.legacyRevisionGate });
  await publishDurablePolicy(join(candidateDir(bookDir, candidate.candidateId), "publication-policy.json"), {
    version: 1, candidateId: candidate.candidateId, publicationPolicy, selectedAt: new Date().toISOString(),
  });
  return publicationPolicy;
}

export async function listRecoveryCandidates(bookDir: string): Promise<RecoveryCandidateSummary[]> {
  const root = join(bookDir, "story", "recovery", "candidates");
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const result: RecoveryCandidateSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const dir = candidateDir(bookDir, entry.name);
      const candidate = schema.parse(JSON.parse(await readFile(join(dir, "candidate.json"), "utf8")));
      if (candidate.candidateId !== entry.name) throw new Error("INVALID_CANDIDATE_ID");
      const status = await optionalRead(join(dir, "discarded.json")) ? "discarded"
        : await optionalRead(join(dir, "applied.json")) ? "applied" : "pending";
      const policy = await readCandidatePolicy(bookDir, candidate);
      result.push({ candidateId: candidate.candidateId, chapter: candidate.chapter, createdAt: candidate.createdAt, status, ...policy,
        ...(policy.policySource === "missing" && status === "pending" ? { issue: "CANDIDATE_POLICY_REQUIRED" } : {}),
      });
    } catch (error) {
      // Interrupted creation and per-record I/O failures must not hide other
      // candidates or book health. Leave every artifact untouched for diagnosis.
      const errorCode = (error as NodeJS.ErrnoException).code;
      const issue = errorCode && errorCode !== "ENOENT" ? "CANDIDATE_UNREADABLE"
        : (error as Error).message === "INVALID_CANDIDATE_ID" ? "CANDIDATE_INVALID_ID" : "CANDIDATE_CORRUPT";
      result.push({ candidateId: entry.name, chapter: null, createdAt: null, status: "invalid", issue, ...(errorCode ? { errorCode } : {}) });
    }
  }
  return result.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.candidateId.localeCompare(b.candidateId));
}

/** Caller owns the book mutation lock. Candidate evidence is retained on discard. */
export async function discardRecoveryCandidate(bookDir: string, candidateId: string): Promise<void> {
  await loadRecoveryCandidate(bookDir, candidateId);
  await writeDurable(join(candidateDir(bookDir, candidateId), "discarded.json"), { discardedAt: new Date().toISOString() });
}

export async function recordCandidateAttempt(bookDir: string, candidateId: string, stage: string, details: unknown): Promise<void> {
  await writeDurable(join(candidateDir(bookDir, candidateId), `attempt-${Date.now()}-${randomUUID()}.json`), { stage, details, recordedAt: new Date().toISOString() });
}

export async function markCandidateApplied(bookDir: string, candidateId: string): Promise<void> {
  await writeDurable(join(candidateDir(bookDir, candidateId), "applied.json"), { appliedAt: new Date().toISOString() });
}
