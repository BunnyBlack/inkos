import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, open, readFile, readdir, rename, rm, lstat, link } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";

interface Entry { path: string; hash: string }
interface Journal {
  version: 1;
  operationId: string;
  phase: "prepared" | "publishing" | "committed" | "rolling-back" | "recovery-pending";
  entries: Entry[];
}

const roots = ["story", "chapters", "book.json"];
const publishingContext = new AsyncLocalStorage<string>();
const commitEffects = new AsyncLocalStorage<Array<() => Promise<void>>>();

/** Completion messages must never escape a transaction which may still roll back. */
export async function afterBookCommit(bookDir: string, effect: () => Promise<void>): Promise<void> {
  const pending = commitEffects.getStore();
  if (isBookTransactionActive(bookDir) && pending) { pending.push(effect); return; }
  await effect();
}
const reservationContext = new AsyncLocalStorage<string>();
const retiredTokens = new Set<string>();
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const journalPath = (bookDir: string) => join(bookDir, "story", "recovery", "transaction.json");
const reservationPath = (bookDir: string) => join(bookDir, "story", "recovery", "transaction-owner.json");
const cacheFile = (path: string) => /^story\/memory\.db(?:-wal|-shm|-journal)?$/.test(path);

function transactionError(code: string, message = code, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code, reasonCode: code });
}

/** Read-only classification; only recovery under the write lock may reclaim ownership. */
export async function inspectTransactionOwnership(bookDir: string): Promise<"none" | "recoverable" | "busy"> {
  if (isBookTransactionActive(bookDir)) return "none";
  const raw = await readOptional(reservationPath(bookDir));
  if (raw === null) return "none";
  let owner: { token?: string; pid?: number; host?: string };
  try { owner = JSON.parse(raw); } catch { return "busy"; }
  if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid! < 1) return "busy";
  if (owner.pid === process.pid && owner.token && retiredTokens.has(owner.token)) return "recoverable";
  try { process.kill(owner.pid!, 0); return "busy"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "recoverable" : "busy"; }
}

async function safePath(bookDir: string, target: string): Promise<void> {
  const rel = relative(resolve(bookDir), resolve(target));
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe recovery path");
  let path = resolve(bookDir);
  for (const part of ["", ...rel.split(/[\\/]/).filter(Boolean)]) {
    if (part) path = join(path, part);
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`Recovery does not follow links: ${path}`); }
    catch (error) { if (missing(error)) return; throw error; }
  }
}

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch (error) { if (missing(error)) return null; throw error; }
}

/** Every reclaim guard is itself a complete, reclaimable owner record. */
async function claimOwnerFile(bookDir: string, path: string, staged: string, metadata: string): Promise<void> {
  await safePath(bookDir, path);
  try { await link(staged, path); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const raw = await readOptional(path);
  if (raw === null) {
    // The prior owner released between link and read. Exclusive link still decides.
    try { await link(staged, path); return; }
    catch { throw new Error("TRANSACTION_RECOVERY_REQUIRED: owner changed"); }
  }
  let owner: { token: string; pid: number; host: string };
  try { owner = JSON.parse(raw); } catch { throw new Error("TRANSACTION_RECOVERY_REQUIRED: invalid owner record"); }
  let dead = owner.pid === process.pid && owner.host === hostname() && retiredTokens.has(owner.token);
  if (owner.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
    try { process.kill(owner.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }
  if (!dead) throw transactionError("BOOK_BUSY", "BOOK_BUSY: transaction owner is alive or ambiguous");
  // Recursion allows a process killed while reclaiming a dead process to recover
  // by the same protocol. Hashing keeps repeated guard filenames bounded.
  const claim = join(dirname(path), `reclaim-${digest(Buffer.from(path))}.json`);
  await claimOwnerFile(bookDir, claim, staged, metadata);
  try {
    if (await readOptional(path) !== raw) throw new Error("TRANSACTION_RECOVERY_REQUIRED: owner changed");
    await rm(path);
    try { await link(staged, path); }
    catch { throw new Error("TRANSACTION_RECOVERY_REQUIRED: owner changed"); }
  } finally { if (await readOptional(claim) === metadata) await rm(claim); }
}

async function reserve(bookDir: string): Promise<() => Promise<void>> {
  const path = reservationPath(bookDir);
  await safePath(bookDir, path);
  await mkdir(dirname(path), { recursive: true });
  const token = randomUUID();
  const metadata = JSON.stringify({ token, pid: process.pid, host: hostname() });
  const staged = join(dirname(path), `owner-${token}.json`);
  // Linking a complete owner record avoids a visible empty reservation on a crash.
  await durableWrite(staged, metadata);
  try {
    await claimOwnerFile(bookDir, path, staged, metadata);
  } catch (error) {
    retiredTokens.add(token);
    throw error;
  } finally {
    try { await rm(staged, { force: true }); }
    catch (error) { retiredTokens.add(token); throw error; }
  }
  return async () => {
    // This callback runs only after publication/recovery settled. Retire its
    // capability before unlink so a failed release cannot orphan a live PID.
    retiredTokens.add(token);
    for (let attempt = 0; ; attempt++) {
      try {
        if (await readOptional(path) === metadata) await rm(path);
        retiredTokens.delete(token);
        return;
      } catch (error) {
        if (attempt >= 2 || !["EACCES", "EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  };
}

function resolveEntry(bookDir: string, path: string): string {
  const target = resolve(bookDir, path);
  const rel = relative(resolve(bookDir), target).replaceAll("\\", "/");
  if (isAbsolute(path) || rel.startsWith("../") || !roots.some(root => rel === root || rel.startsWith(`${root}/`))
    || rel === "story/recovery" || rel.startsWith("story/recovery/")) {
    throw new Error("Invalid book transaction path");
  }
  return target;
}

async function files(bookDir: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(path: string): Promise<void> {
    if (path === "story/recovery") return;
    const absolute = resolveEntry(bookDir, path);
    let info;
    try { info = await lstat(absolute); } catch (error) { if (missing(error)) return; throw error; }
    if (info.isSymbolicLink()) throw new Error(`Book transaction does not follow links: ${path}`);
    if (info.isDirectory()) {
      for (const name of await readdir(absolute)) await visit(`${path}/${name}`);
    } else if (info.isFile()) result.push(path);
    else throw new Error(`Unsupported book artifact: ${path}`);
  }
  for (const root of roots) await visit(root);
  return result.sort();
}

async function durableWrite(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "w");
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}

async function saveJournal(bookDir: string, journal: Journal): Promise<void> {
  await safePath(bookDir, journalPath(bookDir));
  const staging = join(dirname(dirname(bookDir)), "temp", "book-transactions", journal.operationId);
  await mkdir(staging, { recursive: true });
  const staged = join(staging, randomUUID() + ".json");
  try {
    await durableWrite(staged, JSON.stringify(journal));
    await mkdir(dirname(journalPath(bookDir)), { recursive: true });
    for (let attempt = 0; ; attempt++) {
      try { await rename(staged, journalPath(bookDir)); break; }
      catch (error) {
        if (attempt >= 3 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  } finally { await rm(staged, { force: true }); }
}

async function loadJournal(bookDir: string): Promise<Journal | undefined> {
  await safePath(bookDir, journalPath(bookDir));
  let raw: string;
  try { raw = await readFile(journalPath(bookDir), "utf8"); } catch (error) { if (missing(error)) return; throw error; }
  const parsed = JSON.parse(raw) as Journal;
  if (parsed.version !== 1 || !/^[a-f0-9-]{36}$/.test(parsed.operationId)
    || !["prepared", "publishing", "committed", "rolling-back", "recovery-pending"].includes(parsed.phase)
    || !Array.isArray(parsed.entries)) throw new Error("Invalid book recovery journal");
  for (const entry of parsed.entries) {
    resolveEntry(bookDir, entry.path);
    if (!/^[a-f0-9]{64}$/.test(entry.hash)) throw new Error("Invalid recovery checksum");
  }
  return parsed;
}

export async function assertBookReadable(bookDir: string): Promise<void> {
  if (publishingContext.getStore() === resolve(bookDir)) return;
  if (await readOptional(reservationPath(bookDir))) throw new Error("TRANSACTION_RECOVERY_REQUIRED");
  const journal = await loadJournal(bookDir);
  if (journal && journal.phase !== "committed") throw new Error("TRANSACTION_RECOVERY_REQUIRED");
}

/** Discard an overlapping read instead of returning a mixed committed view. */
export async function readBookConsistently<T>(bookDir: string, read: () => Promise<T>): Promise<T> {
  if (publishingContext.getStore() === resolve(bookDir)) return read();
  await assertBookReadable(bookDir);
  const before = await readOptional(journalPath(bookDir));
  const result = await read();
  await assertBookReadable(bookDir);
  if (await readOptional(journalPath(bookDir)) !== before) throw new Error("BOOK_VIEW_CHANGED");
  return result;
}

export function isBookTransactionActive(bookDir: string): boolean {
  return publishingContext.getStore() === resolve(bookDir);
}

/** Must be called while the book write lock is owned. Recovery never calls a model. */
export interface TransactionRecoveryResult { status: "applied" | "unchanged"; operationId?: string }

export async function recoverBookTransaction(bookDir: string): Promise<TransactionRecoveryResult> {
  if (reservationContext.getStore() !== resolve(bookDir)) {
    const release = await reserve(bookDir);
    try { return await reservationContext.run(resolve(bookDir), () => recoverBookTransaction(bookDir)); }
    finally { await release(); }
  }
  const journal = await loadJournal(bookDir);
  if (!journal || journal.phase === "committed") return { status: "unchanged" };
  const backupDir = join(bookDir, "story", "recovery", journal.operationId, "before");
  // Verify every backup before replacing anything. Keep evidence if storage is broken.
  const originals = new Map<string, Buffer>();
  try {
    for (const entry of journal.entries) {
      if (cacheFile(entry.path)) continue;
      await safePath(bookDir, join(backupDir, entry.path));
      await safePath(bookDir, resolveEntry(bookDir, entry.path));
      const data = await readFile(join(backupDir, entry.path));
      if (digest(data) !== entry.hash) throw new Error(`RECOVERY_BACKUP_CORRUPT: ${entry.path}`);
      originals.set(entry.path, data);
    }
    await saveJournal(bookDir, { ...journal, phase: "rolling-back" });
    for (const path of await files(bookDir)) {
      if (!originals.has(path)) await rm(resolveEntry(bookDir, path));
    }
    for (const [path, data] of originals) {
      await safePath(bookDir, resolveEntry(bookDir, path));
      await durableWrite(resolveEntry(bookDir, path), data);
    }
    await saveJournal(bookDir, { ...journal, phase: "committed" });
    return { status: "applied", operationId: journal.operationId };
  } catch (error) {
    await saveJournal(bookDir, { ...journal, phase: "recovery-pending" }).catch(() => undefined);
    throw transactionError("TRANSACTION_RECOVERY_REQUIRED", `TRANSACTION_RECOVERY_REQUIRED: ${String(error)}`, error);
  }
}

/**
 * Compatibility transaction for existing multi-file publishers. Readers must reject
 * noncommitted journals. Generation belongs before this short publication callback.
 * Backups are durable recovery artifacts, not disposable temporary files.
 */
export async function withBookTransaction<T>(
  bookDir: string,
  publish: () => Promise<T>,
  options: { assertOwner?: () => Promise<void>; leavePendingOnError?: boolean } = {},
): Promise<T> {
  if (reservationContext.getStore() === resolve(bookDir)) throw new Error("TRANSACTION_RECOVERY_REQUIRED: nested publication");
  const releaseReservation = await reserve(bookDir);
  try {
    return await reservationContext.run(resolve(bookDir), () => publishReserved(bookDir, publish, options));
  } finally { await releaseReservation(); }
}

async function publishReserved<T>(
  bookDir: string,
  publish: () => Promise<T>,
  options: { assertOwner?: () => Promise<void>; leavePendingOnError?: boolean },
): Promise<T> {
  await options.assertOwner?.();
  const previous = await loadJournal(bookDir);
  if (previous && previous.phase !== "committed") throw new Error("TRANSACTION_RECOVERY_REQUIRED");
  const operationId = randomUUID();
  const entries: Entry[] = [];
  const backupDir = join(bookDir, "story", "recovery", operationId, "before");
  for (const path of await files(bookDir)) {
    if (cacheFile(path)) continue;
    const data = await readFile(resolveEntry(bookDir, path));
    await durableWrite(join(backupDir, path), data);
    entries.push({ path, hash: digest(data) });
  }
  const journal: Journal = { version: 1, operationId, phase: "prepared", entries };
  await saveJournal(bookDir, journal);
  try {
    await options.assertOwner?.();
    await saveJournal(bookDir, { ...journal, phase: "publishing" });
    const effects: Array<() => Promise<void>> = [];
    const result = await commitEffects.run(effects, () => publishingContext.run(resolve(bookDir), publish));
    await options.assertOwner?.();
    await saveJournal(bookDir, { ...journal, phase: "committed" });
    for (const effect of effects) {
      try { await effect(); }
      catch { console.warn("[inkos] Post-commit notification failed; committed book state was preserved."); }
    }
    return result;
  } catch (error) {
    if (!options.leavePendingOnError) {
      try {
        await options.assertOwner?.();
        await recoverBookTransaction(bookDir);
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], `TRANSACTION_RECOVERY_REQUIRED: ${String(error)}`, { cause: error });
      }
    }
    throw error;
  }
}
