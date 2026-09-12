import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEditTool, createLsTool, createReadTool, createWriteFileTool, createWriteTruthFileTool } from "../agent/agent-tools.js";
import { SessionLoopGuard } from "../agent/session-loop-guard.js";
import { mutationBookId, operationResultFailed } from "../agent/operation-policy.js";
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

it("identifies mutation books from constrained tools and paths", () => {
  expect(mutationBookId("patch_chapter_text", { bookId: "forged" }, "active")).toBe("active");
  expect(mutationBookId("write_truth_file", {}, "active")).toBe("active");
  expect(mutationBookId("sub_agent", { agent: "writer", bookId: "forged" }, "active")).toBe("active");
  expect(mutationBookId("write", { path: "other/story/notes.md" }, "active")).toBe("other");
  expect(mutationBookId("write", { path: "./other/story/notes.md" }, "active")).toBe("other");
  expect(mutationBookId("edit", { path: ".\\other\\story\\notes.md" }, "active")).toBe("other");
  expect(mutationBookId("edit", { path: "active/chapters/0001.md" }, "active")).toBe("active");
  expect(mutationBookId("write", { path: "../outside.md" }, "active")).toBeUndefined();
  expect(mutationBookId("sub_agent", { agent: "architect", title: "new book" }, "active")).toBeUndefined();
});

it("serializes same-book tool execution without delaying different books", async () => {
  const guard = new SessionLoopGuard();
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const entered: string[] = [];
  const barriers = new Map<string, { promise: Promise<void>; release: () => void }>();
  for (const id of ["same-1", "same-2", "other-1"]) {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    barriers.set(id, { promise, release });
  }
  const run = (id: string, bookId: string) => guard.executeTool(
    "patch_chapter_text",
    id,
    { bookId },
    async () => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      entered.push(id);
      await barriers.get(id)!.promise;
      activeWrites -= 1;
      return id;
    },
  );
  const first = run("same-1", "same");
  const second = run("same-2", "same");
  const other = run("other-1", "other");
  await Promise.resolve();
  await Promise.resolve();
  expect(entered).toEqual(["same-1", "other-1"]);
  expect(maxActiveWrites).toBe(2);
  barriers.get("other-1")!.release();
  await other;
  expect(entered).toEqual(["same-1", "other-1"]);
  barriers.get("same-1")!.release();
  await first;
  await Promise.resolve();
  expect(entered).toEqual(["same-1", "other-1", "same-2"]);
  barriers.get("same-2")!.release();
  await second;
  expect(maxActiveWrites).toBe(2);
});

it.each([
  ["sub_agent", { agent: "writer" }],
  ["sub_agent", { agent: "auditor" }],
  ["import_chapters", {}],
  ["continuation_import", {}],
])("shares the same queue between a patch and %s %j", async (toolName, toolArgs) => {
  const guard = new SessionLoopGuard("active");
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const entered: string[] = [];
  const patch = guard.executeTool(
    "patch_chapter_text",
    "patch",
    { bookId: "forged" },
    async () => {
      entered.push("patch");
      await firstGate;
      return "patched";
    },
  );
  const production = guard.executeTool(
    toolName,
    "production",
    { ...toolArgs, bookId: "forged" },
    async () => {
      entered.push("production");
      return "produced";
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(entered).toEqual(["patch"]);
  releaseFirst();
  await expect(patch).resolves.toBe("patched");
  await expect(production).resolves.toBe("produced");
  expect(entered).toEqual(["patch", "production"]);
});

it("continues the same-book queue after a patch failure", async () => {
  const guard = new SessionLoopGuard();
  const first = guard.executeTool("patch_chapter_text", "failed", { bookId: "same" }, async () => {
    throw new Error("target not found");
  });
  const second = guard.executeTool("patch_chapter_text", "next", { bookId: "same" }, async () => "next result");
  await expect(first).rejects.toThrow("target not found");
  await expect(second).resolves.toBe("next result");
  expect(() => guard.beforeModelCall()).not.toThrow();
});

it("keeps patch failures out of the chapter production budget", async () => {
  const guard = new SessionLoopGuard("same");
  const failedPatch = guard.executeTool("patch_chapter_text", "patch", {}, async () => {
    throw new Error("target not found");
  });
  await expect(failedPatch).rejects.toThrow("target not found");
  expect(() => guard.beforeToolExecution("sub_agent", { agent: "writer" })).not.toThrow();
});

it("does not execute a queued mutation after cancellation", async () => {
  const guard = new SessionLoopGuard();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let executions = 0;
  const first = guard.executeTool("patch_chapter_text", "first", { bookId: "same" }, async () => {
    executions += 1;
    await firstGate;
    return "first";
  });
  const controller = new AbortController();
  const cancelled = guard.executeTool("patch_chapter_text", "cancelled", { bookId: "same" }, async () => {
    executions += 1;
    return "cancelled";
  }, controller.signal);
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  releaseFirst();
  await expect(first).resolves.toBe("first");
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  expect(executions).toBe(1);
});

it("cleans production tracking when a queued call is rejected by the budget", async () => {
  const guard = new SessionLoopGuard("same");
  const failedResult = { details: { bookId: "same", chapterNumber: 1, status: "failed", stage: "validation" } };
  for (const id of ["failed-1", "failed-2"]) {
    guard.observe({ type: "tool_execution_start", toolCallId: id, toolName: "sub_agent", args: { agent: "writer", bookId: "same" } } as any);
    guard.observe({ type: "tool_execution_end", toolCallId: id, toolName: "sub_agent", isError: false, result: failedResult } as any);
  }
  guard.observe({ type: "tool_execution_start", toolCallId: "blocked", toolName: "sub_agent", args: { agent: "writer", bookId: "same" } } as any);
  await expect(guard.executeTool("sub_agent", "blocked", { agent: "writer", bookId: "same" }, async () => "unreachable"))
    .rejects.toThrow(/failed 2 times/);

  // A late event for the rejected call must not add a third failure.
  guard.observe({ type: "tool_execution_end", toolCallId: "blocked", toolName: "sub_agent", isError: false, result: failedResult } as any);
  expect(() => guard.beforeToolExecution("sub_agent", { agent: "writer", bookId: "same" }))
    .toThrow(/failed 2 times/);
});

it("cleans production tracking when an unbooked production call is cancelled", async () => {
  const guard = new SessionLoopGuard();
  const failedResult = { details: { chapterNumber: 1, status: "failed", stage: "validation" } };
  guard.observe({ type: "tool_execution_start", toolCallId: "failed", toolName: "sub_agent", args: { agent: "writer" } } as any);
  guard.observe({ type: "tool_execution_end", toolCallId: "failed", toolName: "sub_agent", isError: false, result: failedResult } as any);
  const controller = new AbortController();
  controller.abort();
  guard.observe({ type: "tool_execution_start", toolCallId: "cancelled", toolName: "sub_agent", args: { agent: "writer" } } as any);
  await expect(guard.executeTool("sub_agent", "cancelled", { agent: "writer" }, async () => "unreachable", controller.signal))
    .rejects.toMatchObject({ name: "AbortError" });

  // A late failure event for the cancelled call must not consume the second budget slot.
  guard.observe({ type: "tool_execution_end", toolCallId: "cancelled", toolName: "sub_agent", isError: false, result: failedResult } as any);
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
