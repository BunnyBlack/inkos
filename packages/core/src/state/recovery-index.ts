import { readFile, readdir, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChapterMetaSchema, type ChapterMeta } from "../models/chapter.js";
import { buildStateDegradedReviewNote } from "../pipeline/chapter-state-recovery.js";
import { countChapterLength, resolveLengthCountingMode } from "../utils/length-metrics.js";
import { chapterNumberFromFilename } from "../utils/chapter-filename.js";

export class RecoveryIndexError extends Error {
  constructor(readonly code: string, readonly chapter?: number, options?: ErrorOptions) {
    super(`${code}${chapter === undefined ? "" : `: chapter ${chapter}`}`, options);
  }
}

export async function scanRecoveryBodies(bookDir: string): Promise<Map<number, string[]>> {
  let files: string[];
  try { files = await readdir(join(bookDir, "chapters")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map(); throw error; }
  const bodies = new Map<number, string[]>();
  for (const file of files.sort()) {
    const chapter = chapterNumberFromFilename(file);
    if (chapter === undefined) continue;
    bodies.set(chapter, [...(bodies.get(chapter) ?? []), file]);
  }
  return bodies;
}

/** Keep legacy optional fields and unknown extensions intact; never rebuild malformed rows. */
export async function readRecoveryIndex(bookDir: string): Promise<ChapterMeta[]> {
  let raw: string;
  try { raw = await readFile(join(bookDir, "chapters", "index.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new RecoveryIndexError("CHAPTER_INDEX_UNREADABLE", undefined, { cause: error });
  }
  try {
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error("Expected array");
    const seen = new Set<number>();
    for (const row of rows) {
      const parsed = ChapterMetaSchema.partial().required({ number: true }).safeParse(row);
      if (!parsed.success || !Number.isSafeInteger(parsed.data.number) || seen.has(parsed.data.number)) throw new Error("Invalid or duplicate chapter row");
      seen.add(parsed.data.number);
    }
    return rows as ChapterMeta[];
  } catch (error) { throw new RecoveryIndexError("CHAPTER_INDEX_INVALID", undefined, { cause: error }); }
}

export async function readRecoveryBody(bookDir: string, chapter: number, bodies?: Map<number, string[]>) {
  const files = (bodies ?? await scanRecoveryBodies(bookDir)).get(chapter) ?? [];
  if (!files.length) throw new RecoveryIndexError("CHAPTER_BODY_MISSING", chapter);
  if (files.length !== 1) throw new RecoveryIndexError("CHAPTER_BODY_AMBIGUOUS", chapter);
  const file = files[0]!;
  try {
    const path = join(bookDir, "chapters", file);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Expected regular retained body");
    return { file, bytes: await readFile(path), info };
  } catch (error) { throw new RecoveryIndexError("CHAPTER_BODY_UNREADABLE", chapter, { cause: error }); }
}

/** The caller owns the book lock and a short publication transaction. */
export async function reconcileRecoveryIndex(bookDir: string, throughChapter: number): Promise<{ addedChapters: number[] }> {
  if (!Number.isSafeInteger(throughChapter) || throughChapter < 1) throw new RecoveryIndexError("INVALID_RECOVERY_TARGET");
  const rows = await readRecoveryIndex(bookDir);
  const bodies = await scanRecoveryBodies(bookDir);
  const additions: ChapterMeta[] = [];
  let language: "zh" | "en" = "zh";
  try { language = JSON.parse(await readFile(join(bookDir, "book.json"), "utf8")).language === "en" ? "en" : "zh"; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (let chapter = 1; chapter <= throughChapter; chapter++) {
    const body = await readRecoveryBody(bookDir, chapter, bodies);
    if (rows.some(row => row.number === chapter)) continue;
    const text = body.bytes.toString("utf8");
    const filenameTitle = body.file.replace(/^\d+[_-]?/, "").replace(/\.md$/, "").replace(/_/g, " ").trim();
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || filenameTitle || `Chapter ${chapter}`;
    additions.push({ number: chapter, title, status: "state-degraded", stateIntegrity: { status: "stale" },
      wordCount: countChapterLength(text, resolveLengthCountingMode(language)),
      createdAt: body.info.birthtime.toISOString(), updatedAt: body.info.mtime.toISOString(),
      auditIssues: [], lengthWarnings: [], reviewNote: buildStateDegradedReviewNote("audit-failed", []) });
  }
  if (additions.length) await writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify([...rows, ...additions].sort((a, b) => a.number - b.number), null, 2).replace(/\n/g, "\r\n"), "utf8");
  return { addedChapters: additions.map(row => row.number) };
}
