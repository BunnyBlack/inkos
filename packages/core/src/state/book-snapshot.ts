import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chapterNumberFromFilename } from "../utils/chapter-filename.js";

export const SNAPSHOT_REQUIRED_FILES = ["current_state.md", "pending_hooks.md"];
export const SNAPSHOT_OPTIONAL_FILES = ["particle_ledger.md", "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md"];
export interface SnapshotManifest {
  schemaVersion: 1;
  chapter: number;
  baseline: number | null;
  bodyHash: string | null;
  files: Record<string, string>;
  optionalAbsent: string[];
}
export interface BookSnapshot {
  files: Map<string, Buffer>;
  manifest?: SnapshotManifest;
}
const hash = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
async function move(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; } catch (error) {
      if (attempt >= 3 || !["EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await delay(20 * (attempt + 1));
    }
  }
}
function checkChapter(chapter: number): void {
  if (!Number.isSafeInteger(chapter) || chapter < 0) throw new Error("Invalid snapshot chapter");
}
async function optionalRead(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); } catch (error) { if (!missing(error)) throw error; }
}
async function names(path: string): Promise<string[]> {
  try { return await readdir(path); } catch (error) { if (!missing(error)) throw error; return []; }
}
async function collect(directory: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const name of SNAPSHOT_REQUIRED_FILES) files.set(name, await readFile(join(directory, name)));
  for (const name of SNAPSHOT_OPTIONAL_FILES) {
    const data = await optionalRead(join(directory, name));
    if (data !== undefined) files.set(name, data);
  }
  for (const name of await names(join(directory, "state"))) {
    files.set(`state/${name}`, await readFile(join(directory, "state", name)));
  }
  return files;
}
export async function snapshotChapterBodyHash(bookDir: string, chapter: number): Promise<string | null> {
  if (chapter === 0) return null;
  const matches = (await names(join(bookDir, "chapters"))).filter(name => chapterNumberFromFilename(name) === chapter);
  if (matches.length > 1) throw new Error(`Ambiguous snapshot chapter body: ${chapter}`);
  return matches.length === 0 ? null : hash(await readFile(join(bookDir, "chapters", matches[0]!)));
}
/** Read and validate everything before admitting a snapshot as a restore source. */
export class SnapshotValidationError extends Error {
  readonly code = "SNAPSHOT_INVALID";
}

export async function readBookSnapshot(bookDir: string, chapter: number): Promise<BookSnapshot | null> {
  try { return await readSnapshotUnchecked(bookDir, chapter); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code) throw error;
    throw new SnapshotValidationError(String(error), { cause: error });
  }
}

async function readSnapshotUnchecked(bookDir: string, chapter: number): Promise<BookSnapshot | null> {
  checkChapter(chapter);
  const directory = join(bookDir, "story", "snapshots", String(chapter));
  const rawManifest = await optionalRead(join(directory, "snapshot-manifest.json"));
  let files: Map<string, Buffer>;
  try { files = await collect(directory); } catch (error) {
    if (missing(error) && rawManifest === undefined) return null;
    throw error;
  }
  if (rawManifest === undefined) return { files };
  const manifest = JSON.parse(rawManifest.toString("utf8")) as SnapshotManifest;
  if (manifest.schemaVersion !== 1 || manifest.chapter !== chapter
    || manifest.baseline !== (chapter === 0 ? null : chapter - 1)
    || (manifest.bodyHash !== null && !/^[a-f0-9]{64}$/.test(manifest.bodyHash))
    || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)
    || !Array.isArray(manifest.optionalAbsent)) throw new Error("Invalid snapshot manifest");
  if (Object.keys(manifest.files).length !== files.size) throw new Error("Incomplete snapshot manifest");
  for (const [name, data] of files) {
    if (manifest.files[name] !== hash(data)) throw new Error(`Snapshot hash mismatch: ${name}`);
  }
  const absent = SNAPSHOT_OPTIONAL_FILES.filter(name => !files.has(name));
  if (new Set(manifest.optionalAbsent).size !== manifest.optionalAbsent.length
    || absent.length !== manifest.optionalAbsent.length
    || absent.some(name => !manifest.optionalAbsent.includes(name))) throw new Error("Invalid snapshot optional absence");
  if (chapter === 0 && manifest.bodyHash !== null) throw new Error("Invalid initial snapshot body hash");
  if (manifest.bodyHash !== null && manifest.bodyHash !== await snapshotChapterBodyHash(bookDir, chapter)) {
    throw new Error("Snapshot chapter body hash mismatch");
  }
  return { files, manifest };
}
/** Publish a prepared directory. Callers must hold the book's mutation lock. */
export async function createBookSnapshot(bookDir: string, chapter: number): Promise<void> {
  checkChapter(chapter);
  const files = await collect(join(bookDir, "story"));
  const manifest: SnapshotManifest = {
    schemaVersion: 1, chapter, baseline: chapter === 0 ? null : chapter - 1,
    bodyHash: await snapshotChapterBodyHash(bookDir, chapter),
    files: Object.fromEntries([...files].map(([name, data]) => [name, hash(data)])),
    optionalAbsent: SNAPSHOT_OPTIONAL_FILES.filter(name => !files.has(name)),
  };
  const temp = join(dirname(dirname(bookDir)), "temp");
  await mkdir(temp, { recursive: true });
  const workspace = await mkdtemp(join(temp, "snapshot-"));
  const staging = join(workspace, "prepared");
  const target = join(bookDir, "story", "snapshots", String(chapter));
  const backup = join(workspace, "previous");
  let previousMoved = false;
  let published = false;
  try {
    await mkdir(staging);
    for (const [name, data] of files) {
      await mkdir(dirname(join(staging, name)), { recursive: true });
      await writeFile(join(staging, name), data);
    }
    await writeFile(join(staging, "snapshot-manifest.json"), JSON.stringify(manifest, null, 2) + "\r\n", "utf8");
    await mkdir(dirname(target), { recursive: true });
    try { await move(target, backup); previousMoved = true; } catch (error) { if (!missing(error)) throw error; }
    try { await move(staging, target); published = true; } catch (error) {
      if (previousMoved) { await move(backup, target); previousMoved = false; }
      throw error;
    }
  } finally {
    // A failed rollback must retain the old snapshot and staging for recovery.
    if (!previousMoved || published) await rm(workspace, { recursive: true, force: true });
  }
}
/** Caller supplies the durable multi-file transaction and lock around this helper. */
export async function restoreBookSnapshot(bookDir: string, chapter: number): Promise<boolean> {
  const snapshot = await readBookSnapshot(bookDir, chapter);
  if (!snapshot) return false;
  const story = join(bookDir, "story");
  const staleStructured = (await names(join(story, "state"))).filter(name => !snapshot.files.has(`state/${name}`));
  for (const [name, data] of snapshot.files) {
    await mkdir(dirname(join(story, name)), { recursive: true });
    await writeFile(join(story, name), data);
  }
  for (const name of SNAPSHOT_OPTIONAL_FILES.filter(name => !snapshot.files.has(name))) await rm(join(story, name), { force: true });
  for (const name of staleStructured) await rm(join(story, "state", name), { force: true });
  if (![...snapshot.files.keys()].some(name => name.startsWith("state/"))) await rm(join(story, "state"), { recursive: true, force: true });
  return true;
}
