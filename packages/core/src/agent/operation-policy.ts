import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const DERIVED_FILES = new Set([
  "current_state.md", "pending_hooks.md", "chapter_summaries.md",
  "particle_ledger.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
]);
const DERIVED_DIRECTORIES = new Set(["state", "snapshots", "recovery"]);

export class DerivedStateMutationError extends Error {
  readonly code = "DERIVED_STATE_WRITE_BLOCKED";
  constructor() {
    super("Derived state cannot be changed by generic write/edit tools. Use a validated chapter state recovery operation; preserve any rejected candidate and retry settlement instead of replacing truth files.");
  }
}

/** Shared by generic Agent tools and deterministic interaction/CLI/Studio truth writes. */
export async function assertAuthorDocumentPath(booksRoot: string, target: string): Promise<void> {
  const root = resolve(booksRoot);
  const path = resolve(target);
  const local = relative(root, path);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error("Path traversal blocked for author document write.");
  }
  const parts = local.split(/[\\/]/u);
  if (parts.some((part) => /[:\0]/u.test(part) || /[. ]$/u.test(part))) {
    throw new Error("Ambiguous author document path blocked.");
  }
  const normalized = parts.map((part) => part.toLowerCase());
  if ((normalized[1] === "story" && (DERIVED_FILES.has(normalized[2]) || DERIVED_DIRECTORIES.has(normalized[2])))
    || normalized.slice(1).some((part) => part === ".write.lock")
    || (normalized[1] === "chapters" && (normalized[2] === "index.json" || /^\d+.*\.md$/u.test(normalized[2])
      || [".versions", ".trash"].includes(normalized[2])))) {
    throw new DerivedStateMutationError();
  }
  // Resolve the configured root once; reject links below it, including dangling
  // symlinks and Windows junctions. A lexical canon alias must not target state.
  let current: string;
  try { current = await realpath(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    current = root;
  }
  for (const part of parts) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new DerivedStateMutationError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

export function productionOperation(name: string, args: Record<string, unknown>): string | undefined {
  if (name === "sub_agent" && ["writer", "reviser"].includes(String(args.agent))) return "chapter-production";
  if (["resync_chapter_state", "recover_chapters", "recover_transaction", "resume_revision_candidate", "resume_settlement_attempt"].includes(name)) return "chapter-production";
  return undefined;
}

export function canonChangeAffectsState(bookRelativePath: string): boolean {
  const path = bookRelativePath.replaceAll("\\", "/").toLowerCase();
  return /^story\/(roles\/|outline\/|(?:story_bible|book_rules|volume_outline|parent_canon|fanfic_canon)\.md$)/u.test(path);
}

export function operationResultFailed(result: unknown): boolean {
  const details = (result as any)?.details;
  const outcome = details?.outcome;
  const status = outcome?.status ?? details?.status;
  if (["applied", "unchanged", "cancelled"].includes(outcome?.status)) return false;
  if (status === "cancelled") return false;
  return details?.applied === false || status === "blocked" || status === "failed";
}
