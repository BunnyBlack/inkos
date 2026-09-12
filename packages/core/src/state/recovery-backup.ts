import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readBookSnapshot, SnapshotValidationError, type BookSnapshot } from "./book-snapshot.js";

export interface RecoveryBaseline { backupId: string; chapter: 0 }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
class InvalidBackupError extends Error {}
async function checkedDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new InvalidBackupError("Unsafe recovery backup directory");
}
async function readBaseline(bookDir: string, backupId: string): Promise<BookSnapshot> {
  if (!uuid.test(backupId)) throw new InvalidBackupError("Invalid recovery backup ID");
  let path = bookDir;
  for (const part of ["story", "recovery", backupId, "before", "story", "snapshots", "0"]) {
    path = join(path, part);
    await checkedDirectory(path);
  }
  async function checkFiles(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const entry = join(directory, name);
      const info = await lstat(entry);
      if (info.isSymbolicLink()) throw new InvalidBackupError("Recovery backup contains a symbolic link");
      if (info.isDirectory()) await checkFiles(entry);
      else if (!info.isFile()) throw new InvalidBackupError("Unsupported recovery backup artifact");
    }
  }
  await checkFiles(path);
  let snapshot: BookSnapshot | null;
  try { snapshot = await readBookSnapshot(join(bookDir, "story", "recovery", backupId, "before"), 0); }
  catch (error) {
    if (error instanceof SnapshotValidationError) throw new InvalidBackupError(`Invalid recovery backup: ${error.message}`);
    if ((error as NodeJS.ErrnoException).code) throw error;
    throw new InvalidBackupError(`Invalid recovery backup: ${String(error)}`);
  }
  if (!snapshot?.manifest) throw new InvalidBackupError("Recovery baseline requires a verified snapshot manifest");
  return snapshot;
}

/** Read-only discovery; never infers historical initial state from live files. */
export async function findRecoveryBaseline(bookDir: string): Promise<RecoveryBaseline | null> {
  let ids: string[];
  try { await checkedDirectory(join(bookDir, "story", "recovery")); ids = await readdir(join(bookDir, "story", "recovery")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  for (const backupId of ids.filter(id => uuid.test(id)).sort()) {
    try { await readBaseline(bookDir, backupId); return { backupId, chapter: 0 }; }
    catch (error) {
      if (error instanceof InvalidBackupError || (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return null;
}

/** Caller must own the book lock and durable publication transaction. */
export async function restoreRecoveryBaseline(bookDir: string, backupId: string): Promise<void> {
  const snapshot = await readBaseline(bookDir, backupId);
  const target = join(bookDir, "story", "snapshots", "0");
  await rm(target, { recursive: true, force: true });
  for (const [name, data] of snapshot.files) {
    await mkdir(dirname(join(target, name)), { recursive: true });
    await writeFile(join(target, name), data);
  }
  await writeFile(join(target, "snapshot-manifest.json"), JSON.stringify(snapshot.manifest, null, 2) + "\r\n", "utf8");
}
