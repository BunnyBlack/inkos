import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEditTool, createLsTool, createReadTool, createWriteFileTool, createWriteTruthFileTool } from "../agent/agent-tools.js";
import { SessionLoopGuard } from "../agent/session-loop-guard.js";
import { operationResultFailed } from "../agent/operation-policy.js";
import { StateManager } from "../state/manager.js";
import { createInteractionToolsFromDeps } from "../interaction/project-tools.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inkos-policy-"));
  await mkdir(join(root, "books", "sample", "story", "state"), { recursive: true });
  await writeFile(join(root, "books", "sample", "story", "pending_hooks.md"), "original", "utf8");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it.each(["pending_hooks.md", "CURRENT_STATE.md", "chapter_summaries.md", "state/live.json", "snapshots/1/a.md", "recovery/op.json"])("blocks generic derived writes: %s", async (file) => {
  await expect(createWriteFileTool(root).execute("w", { path: `sample/story/${file}`, content: "replacement" })).rejects.toThrow(/derived|recovery/i);
});
it("blocks edit and truth-file replacement before changing bytes", async () => {
  await expect(createEditTool(root).execute("e", { path: "sample/story/pending_hooks.md", old_string: "original", new_string: "replacement" })).rejects.toThrow(/derived/i);
  await expect(createWriteTruthFileTool({} as any, root, "sample").execute("t", { fileName: "pending_hooks.md", content: "replacement" })).rejects.toThrow(/derived/i);
  expect(await readFile(join(root, "books", "sample", "story", "pending_hooks.md"), "utf8")).toBe("original");
});
it("blocks generic numbered chapter replacement and index mutation", async () => {
  await mkdir(join(root, "books", "sample", "chapters"), { recursive: true });
  const chapter = join(root, "books", "sample", "chapters", "0001_One.md");
  await writeFile(chapter, "original", "utf8");
  await expect(createWriteFileTool(root).execute("w", { path: "sample/chapters/0001_One.md", content: "bypass" })).rejects.toThrow(/chapter|derived/i);
  await expect(createEditTool(root).execute("e", { path: "sample/chapters/0001_One.md", old_string: "original", new_string: "bypass" })).rejects.toThrow(/chapter|derived/i);
  await expect(createWriteFileTool(root).execute("i", { path: "sample/chapters/index.json", content: "[]" })).rejects.toThrow(/chapter|derived/i);
  expect(await readFile(chapter, "utf8")).toBe("original");
});
it("checks junction targets and preserves ordinary canon writes", async () => {
  await createWriteFileTool(root).execute("c", { path: "sample/story/story_bible.md", content: "author canon" });
  expect(await readFile(join(root, "books", "sample", "story", "story_bible.md"), "utf8")).toBe("author canon");
  await symlink(join(root, "books", "sample", "story", "state"), join(root, "books", "sample", "notes"), "junction");
  await expect(createWriteFileTool(root).execute("w", { path: "sample/notes/live.json", content: "replacement" })).rejects.toThrow(/derived/i);
});

it("deterministic interaction rejects derived state before opening a transaction", async () => {
  const tools = createInteractionToolsFromDeps({} as any, new StateManager(root));
  await expect(tools.writeTruthFile("sample", "pending_hooks.md", "bypass")).rejects.toThrow(/derived/i);
  await expect(readFile(join(root, "books", "sample", "story", "recovery", "transaction.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it("marks chapter state stale after canon changes but preserves future guidance", async () => {
  const state = new StateManager(root);
  await state.saveChapterIndex("sample", [{ number: 1, title: "One", wordCount: 10, status: "ready-for-review", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", auditIssues: [], lengthWarnings: [] }]);
  await createWriteFileTool(root).execute("focus", { path: "sample/story/current_focus.md", content: "Future guidance" });
  expect((await state.loadChapterIndex("sample"))[0].reviewNote).toBeUndefined();
  await createWriteFileTool(root).execute("canon", { path: "sample/story/story_bible.md", content: "Changed canon" });
  expect((await state.loadChapterIndex("sample"))[0].reviewNote).toMatch(/state-degraded/);
});

it("blocks read and ls while a journal is recovery pending", async () => {
  await mkdir(join(root, "books", "sample", "story", "recovery"), { recursive: true });
  await writeFile(join(root, "books", "sample", "story", "recovery", "transaction.json"), JSON.stringify({ version: 1, operationId: "11111111-1111-1111-1111-111111111111", phase: "recovery-pending", entries: [] }), "utf8");
  await expect(createReadTool(root).execute("r", { path: "sample/story/pending_hooks.md" })).rejects.toThrow("TRANSACTION_RECOVERY_REQUIRED");
  await expect(createLsTool(root).execute("l", { bookId: "sample" })).rejects.toThrow("TRANSACTION_RECOVERY_REQUIRED");
});
it("counts unapplied revisions with reworded instructions despite successful canon tools", () => {
  const guard = new SessionLoopGuard();
  for (let i = 0; i < 2; i++) {
    guard.observe({ type: "tool_execution_start", toolCallId: String(i), toolName: "sub_agent", args: { agent: "reviser", bookId: "sample", chapterNumber: 1, instruction: `wording ${i}` } } as any);
    guard.observe({ type: "tool_execution_end", toolCallId: String(i), toolName: "sub_agent", isError: false, result: { details: { kind: "chapter_revision", bookId: "sample", chapterNumber: 1, applied: false } } } as any);
    guard.observe({ type: "tool_execution_start", toolCallId: `canon${i}`, toolName: "write_truth_file", args: { fileName: "story_bible.md" } } as any);
    guard.observe({ type: "tool_execution_end", toolCallId: `canon${i}`, toolName: "write_truth_file", isError: false, result: {} } as any);
  }
  expect(() => guard.beforeModelCall()).toThrow(/loop guard.*2/i);
});

it("counts recovery and settlement resume against the actual failed chapter", () => {
  const guard = new SessionLoopGuard();
  for (const [i, name] of ["recover_chapters", "resume_settlement_attempt"].entries()) {
    guard.observe({ type: "tool_execution_start", toolCallId: String(i), toolName: name, args: { bookId: "sample", targetChapter: i + 2 } } as any);
    guard.observe({ type: "tool_execution_end", toolCallId: String(i), toolName: name, isError: false,
      result: { details: { status: "failed", bookId: "sample", chapterNumber: i + 2, failedChapter: 1, stage: "validation", attemptId: `attempt-${i}` } } } as any);
  }
  expect(() => guard.beforeModelCall()).toThrow(/loop guard/);
  guard.reset();
  expect(() => guard.beforeModelCall()).not.toThrow();
});

it.each([
  [{ applied: false, status: "unchanged" }, true],
  [{ applied: true, auditPassed: false }, false],
  [{ applied: false, outcome: { status: "unchanged" } }, false],
  [{ applied: false, outcome: { status: "cancelled" } }, false],
  [{ outcome: { status: "blocked" } }, true],
  [{ outcome: { status: "failed" } }, true],
])("distinguishes business rejection from no-op/cancel/applied audit failure (%j)", (details, failed) => {
  expect(operationResultFailed({ details })).toBe(failed);
});
