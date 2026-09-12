import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { isChapterStateDegraded } from "../pipeline/chapter-state-recovery.js";
import type { ChapterMeta } from "../models/chapter.js";
import { isBookTransactionActive, inspectTransactionOwnership } from "./book-transaction.js";
import { readRecoveryIndex, scanRecoveryBodies, readRecoveryBody, RecoveryIndexError } from "./recovery-index.js";

export interface BookHealth {
  stateFrontier: number | null;
  pendingChapters: number[];
  verifiedBaselines: number[];
  pendingOperationId?: string;
  issues: Array<{ code: string; path?: string; chapter?: number }>;
}

const required = ["current_state.md", "pending_hooks.md"];
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
async function optionalRead(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function optionalList(path: string): Promise<string[]> {
  try { return await readdir(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Read-only: never bootstraps state, repairs metadata or clears a journal. */
export async function inspectBookHealth(bookDir: string): Promise<BookHealth> {
  const health: BookHealth = { stateFrontier: null, pendingChapters: [], verifiedBaselines: [], issues: [] };
  const journalPath = join(bookDir, "story", "recovery", "transaction.json");
  const ownership = await inspectTransactionOwnership(bookDir);
  if (ownership !== "none") {
    health.issues.push({ code: "TRANSACTION_RECOVERY_REQUIRED" });
    if (ownership === "busy") health.issues.push({ code: "BOOK_BUSY" });
    return health;
  }
  const journalBytes = await optionalRead(journalPath);
  if (journalBytes) {
    let journal: { operationId?: string; phase?: string };
    try { journal = JSON.parse(journalBytes.toString("utf8")); }
    catch { health.issues.push({ code: "TRANSACTION_RECOVERY_REQUIRED", path: journalPath }); return health; }
    if (journal.phase !== "committed" && !isBookTransactionActive(bookDir)) {
      health.pendingOperationId = journal.operationId;
      health.issues.push({ code: "TRANSACTION_RECOVERY_REQUIRED" });
      return health;
    }
  }
  const chaptersDir = join(bookDir, "chapters");
  const bodyFiles = await scanRecoveryBodies(bookDir);
  const metadata = new Map<number, ChapterMeta>();
  try { for (const row of await readRecoveryIndex(bookDir)) metadata.set(row.number, row); }
  catch (error) {
    if (!(error instanceof RecoveryIndexError)) throw error;
    health.issues.push({ code: error.code, path: join(chaptersDir, "index.json") });
  }
  const numbers = [...new Set([...bodyFiles.keys(), ...metadata.keys()])].sort((a, b) => a - b);
  for (const chapter of numbers) {
    if (!bodyFiles.has(chapter)) health.issues.push({ code: "CHAPTER_BODY_MISSING", chapter });
    if ((bodyFiles.get(chapter)?.length ?? 0) > 1) health.issues.push({ code: "CHAPTER_BODY_AMBIGUOUS", chapter });
    if (bodyFiles.has(chapter) && !metadata.has(chapter)) health.issues.push({ code: "CHAPTER_METADATA_MISSING", chapter });
    if (bodyFiles.get(chapter)?.length === 1) {
      try { await readRecoveryBody(bookDir, chapter, bodyFiles); }
      catch (error) { if (!(error instanceof RecoveryIndexError)) throw error; health.issues.push({ code: error.code, chapter }); }
    }
  }
  const snapshotRoot = join(bookDir, "story", "snapshots");
  const candidates = (await optionalList(snapshotRoot)).filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b);
  const valid = new Set<number>();
  for (const chapter of candidates) {
    const snapshotDir = join(snapshotRoot, String(chapter));
    const issue = (code: string, path?: string) => health.issues.push({ code, chapter, ...(path ? { path } : {}) });
    let complete = true;
    for (const file of required) {
      if (!await optionalRead(join(snapshotDir, file))) { issue("SNAPSHOT_REQUIRED_FILE_MISSING", join(snapshotDir, file)); complete = false; }
    }
    if (!complete) continue;
    const meta = metadata.get(chapter);
    if (chapter > 0 && health.issues.some(entry => entry.code.startsWith("CHAPTER_INDEX_") || (entry.chapter === chapter && entry.code === "CHAPTER_BODY_UNREADABLE"))) continue;
    const integrity = (meta as (ChapterMeta & { stateIntegrity?: { status: string } }) | undefined)?.stateIntegrity;
    if (meta && (isChapterStateDegraded(meta) || (integrity && integrity.status !== "valid"))) { issue("CHAPTER_STATE_DEGRADED"); continue; }
    const manifestBytes = await optionalRead(join(snapshotDir, "snapshot-manifest.json"));
    if (!manifestBytes) {
      issue("SNAPSHOT_PROVENANCE_LEGACY");
    } else {
      let manifest: { schemaVersion: number; chapter: number; baseline: number | null; bodyHash: string | null; files: Record<string, string>; optionalAbsent: string[] };
      try {
        manifest = JSON.parse(manifestBytes.toString("utf8"));
        if (manifest.schemaVersion !== 1 || manifest.chapter !== chapter || manifest.baseline !== (chapter === 0 ? null : chapter - 1) || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files) || !Array.isArray(manifest.optionalAbsent) || required.some(file => !manifest.files[file])) throw new Error("Invalid manifest");
        const paths = [...Object.keys(manifest.files), ...manifest.optionalAbsent];
        if (paths.some(path => typeof path !== "string" || isAbsolute(path) || path.includes("\\") || path.split("/").some(part => part === ".." || part === "." || part === ""))) throw new Error("Unsafe manifest path");
      } catch { issue("SNAPSHOT_MANIFEST_INVALID"); continue; }
      for (const [file, expected] of Object.entries(manifest.files)) {
        const data = await optionalRead(join(snapshotDir, file));
        if (!data || hash(data) !== expected) { issue("SNAPSHOT_FILE_HASH_MISMATCH", join(snapshotDir, file)); complete = false; }
      }
      for (const file of manifest.optionalAbsent) {
        if (required.includes(file) || manifest.files[file] || await optionalRead(join(snapshotDir, file))) { issue("SNAPSHOT_OPTIONAL_ABSENCE_MISMATCH", join(snapshotDir, file)); complete = false; }
      }
      if (chapter > 0) {
        const files = bodyFiles.get(chapter);
        const body = files?.length === 1 ? await optionalRead(join(chaptersDir, files[0]!)) : null;
        if (!body || !manifest.bodyHash || hash(body) !== manifest.bodyHash) { issue("SNAPSHOT_BODY_HASH_MISMATCH"); complete = false; }
      }
    }
    if (complete && (chapter === 0 || (metadata.has(chapter) && bodyFiles.get(chapter)?.length === 1))) valid.add(chapter);
  }
  if (valid.has(0)) {
    health.stateFrontier = 0;
    health.verifiedBaselines.push(0);
    while (valid.has(health.stateFrontier + 1)) {
      health.stateFrontier++;
      health.verifiedBaselines.push(health.stateFrontier);
    }
  } else health.issues.push({ code: "BASELINE_MISSING", path: join(snapshotRoot, "0") });
  health.pendingChapters = numbers.filter(chapter => chapter > (health.stateFrontier ?? -1));
  // A transaction beginning during inspection invalidates the entire sampled view.
  const after = await optionalRead(journalPath);
  if ((after?.toString("utf8") ?? null) !== (journalBytes?.toString("utf8") ?? null)) {
    return { stateFrontier: null, pendingChapters: [], verifiedBaselines: [], issues: [{ code: "TRANSACTION_RECOVERY_REQUIRED" }] };
  }
  return health;
}
