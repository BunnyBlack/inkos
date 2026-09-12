import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import type { AssistantMessage } from "@mariozechner/pi-ai";

const transport = vi.hoisted(() => ({
  calls: 0,
  reply: (_index: number): any[] => [{ type: "text", text: "Done." }],
}));

// Only replace the model boundary: use the real Pi loop, validation, tools,
// context transform, cache, and persisted transcript.
vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<any>("@mariozechner/pi-ai");
  return {
    ...actual,
    streamSimple: (model: any) => {
      const content = transport.reply(transport.calls++);
      const message: AssistantMessage = {
        role: "assistant", content, api: model.api, provider: model.provider,
        model: model.id, stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      };
      const stream = actual.createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    },
  };
});

import { createLsTool, createReadTool } from "../agent/agent-tools.js";
import { evictAgentCache, runAgentSession } from "../agent/agent-session.js";
import { readTranscriptEvents } from "../interaction/session-transcript.js";

const model = {
  provider: "openai", id: "file-test-model", name: "File Test", api: "openai-completions",
  baseUrl: "http://localhost.invalid/v1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000, maxTokens: 4096,
} as any;

function call(index: number, name: string, args: Record<string, unknown>) {
  return [{ type: "toolCall", id: `call-${index}`, name, arguments: args }];
}

describe("file tools and conversational loop recovery", () => {
  let root: string;
  const sessionId = "file-loop-test";
  const config = () => ({
    sessionId, projectRoot: root, bookId: "sample", language: "en",
    model, apiKey: "test", pipeline: {} as any,
  });

  beforeEach(async () => {
    const fixtureRoot = fileURLToPath(new URL("../../../../temp/", import.meta.url));
    await mkdir(fixtureRoot, { recursive: true });
    root = await mkdtemp(join(fixtureRoot, "inkos-file-loop-"));
    await mkdir(join(root, "books", "sample", "chapters", ".versions"), { recursive: true });
    await writeFile(join(root, "books", "sample", "chapters", "notes.md"), "Ordinary notes.\r\n", "utf8");
    transport.calls = 0;
    transport.reply = () => [{ type: "text", text: "Done." }];
  });

  afterEach(async () => {
    evictAgentCache(sessionId);
    await rm(root, { recursive: true, force: true });
  });

  it("returns unambiguous paths that round-trip from ls to read", async () => {
    const filename = "\u666e\u901a\u7b14\u8bb0.md";
    await writeFile(join(root, "books", "sample", "chapters", filename), "Unicode filename.\r\n", "utf8");
    const result = await createLsTool(root).execute("list", { bookId: "sample", subdir: "chapters" });
    const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    expect(text).toContain("sample/chapters/.versions/");
    const fileLine = text.split("\n").find((line) => line.includes(filename))!;
    const path = fileLine.replace(/ \(\d+ bytes\)$/, "");
    expect(path).toBe(`sample/chapters/${filename}`);
    const read = await createReadTool(root).execute("read", { path });
    expect(read.content).toEqual([{ type: "text", text: "Unicode filename.\r\n" }]);
  });

  it("throws read and list failures so Pi marks them as errors", async () => {
    await expect(createReadTool(root).execute("read", { path: "sample/missing.md" })).rejects.toThrow("Failed to read");
    await expect(createLsTool(root).execute("list", { bookId: "sample", subdir: "missing" })).rejects.toThrow("Failed to list");
    await expect(createLsTool(root).execute("escape", { bookId: "sample", subdir: "../../" })).rejects.toThrow("Path traversal blocked");
  });

  it("allows a corrected call to recover from a missing file", async () => {
    transport.reply = (i) => i < 2
      ? call(i, "read", { path: i === 0 ? "sample/missing.md" : "sample/chapters/notes.md" })
      : [{ type: "text", text: "Recovered." }];
    const result = await runAgentSession(config(), "Read the notes.");
    const results = result.messages.filter((m) => m.role === "toolResult");
    expect(results.map((m: any) => m.isError)).toEqual([true, false]);
    expect(result.responseText).toBe("Recovered.");
    expect(result.errorMessage).toBeUndefined();
  });

  it("blocks rejected-revision fallback writes in the same model response", async () => {
    await mkdir(join(root, "books", "sample", "story"), { recursive: true });
    const hooks = join(root, "books", "sample", "story", "pending_hooks.md");
    await writeFile(hooks, "original", "utf8");
    const reviseDraft = vi.fn(async () => ({ applied: false, status: "unchanged", chapterNumber: 1, fixedIssues: [], wordCount: 10 }));
    const pipeline = { reviseDraft, runWithAgentContext: (_context: unknown, task: () => unknown) => task() } as any;
    transport.reply = (i) => i === 0 ? [
      ...call(0, "sub_agent", { agent: "reviser", chapterNumber: 1, instruction: "Revise the scene." }),
      ...call(1, "write_truth_file", { fileName: "pending_hooks.md", content: "bypass" }),
    ] : [{ type: "text", text: "Recovery required." }];
    const result = await runAgentSession({ ...config(), pipeline }, "Revise chapter one.");
    expect(reviseDraft).toHaveBeenCalledTimes(1);
    expect(await readFile(hooks, "utf8")).toBe("original");
    expect(result.messages.some((m: any) => m.role === "toolResult" && m.toolName === "write_truth_file" && m.isError)).toBe(true);
  });

  it("stops a third reworded production call at execute within one response", async () => {
    const reviseDraft = vi.fn(async () => ({ applied: false, status: "unchanged", chapterNumber: 1, fixedIssues: [], wordCount: 10 }));
    const pipeline = { reviseDraft, runWithAgentContext: (_context: unknown, task: () => unknown) => task() } as any;
    transport.reply = () => [0, 1, 2].flatMap((i) => call(i, "sub_agent", { agent: "reviser", chapterNumber: 1, instruction: `New wording ${i}.` }));
    const result = await runAgentSession({ ...config(), pipeline }, "Revise chapter one.");
    expect(reviseDraft).toHaveBeenCalledTimes(2);
    expect(result.errorMessage).toMatch(/loop guard/i);
  });

  it("shares the failed-production budget with recovery and candidate-resume tools", async () => {
    const reviseDraft = vi.fn(async () => ({ applied: false, status: "unchanged", chapterNumber: 1, candidateId: "candidate-one", fixedIssues: [], wordCount: 10 }));
    const recoverChapters = vi.fn(async () => ({ status: "failed", completed: [], plan: { preservesBodies: true } }));
    const resumeRevisionCandidate = vi.fn(async () => ({ applied: true, chapterNumber: 1 }));
    const pipeline = { reviseDraft, recoverChapters, resumeRevisionCandidate, runWithAgentContext: (_context: unknown, task: () => unknown) => task() } as any;
    transport.reply = () => [
      ...call(0, "sub_agent", { agent: "reviser", chapterNumber: 1, instruction: "Revise." }),
      ...call(1, "recover_chapters", { targetChapter: 1 }),
      ...call(2, "resume_revision_candidate", { candidateId: "candidate-one" }),
    ];
    const result = await runAgentSession({ ...config(), pipeline }, "Repair chapter one.");
    expect(reviseDraft).toHaveBeenCalledTimes(1);
    expect(recoverChapters).toHaveBeenCalledTimes(1);
    expect(resumeRevisionCandidate).not.toHaveBeenCalled();
    expect(result.errorMessage).toMatch(/loop guard/i);
  });

  it("stops repeated schema failures before another model request", async () => {
    transport.reply = (i) => i < 12 ? call(i, "ls", { subdir: "chapters" }) : [{ type: "text", text: "Fallback." }];
    const result = await runAgentSession(config(), "List the directory.");
    expect(transport.calls).toBe(3);
    expect(result.errorMessage).toMatch(/loop guard.*ls/i);
    const events = await readTranscriptEvents(root, sessionId);
    expect(events.some((e) => e.type === "request_failed")).toBe(true);
    expect(events.some((e) => e.type === "request_committed")).toBe(false);
    const failedCalls = result.messages.filter((m: any) => m.role === "toolResult" && m.isError);
    expect(failedCalls).toHaveLength(3);
  });

  it("detects repeated read failures even when successful ls calls alternate", async () => {
    transport.reply = (i) => i >= 12 ? [{ type: "text", text: "Fallback." }]
      : i % 2 === 0 ? call(i, "read", { path: "sample/missing.md" })
        : call(i, "ls", { bookId: "sample", subdir: "chapters" });
    const result = await runAgentSession(config(), "Find the file.");
    expect(transport.calls).toBe(5);
    expect(result.errorMessage).toMatch(/loop guard.*read/i);
  });

  it("stops repeatedly reading identical results without progress", async () => {
    transport.reply = (i) => i < 12 ? call(i, "read", { path: "sample/chapters/notes.md" }) : [{ type: "text", text: "Fallback." }];
    const result = await runAgentSession(config(), "Read the file.");
    expect(transport.calls).toBe(4);
    expect(result.errorMessage).toMatch(/loop guard.*unchanged/i);
  });

  it("allows repeated reads when the file actually changes", async () => {
    transport.reply = (i) => {
      writeFileSync(join(root, "books", "sample", "chapters", "notes.md"), `Version ${i}.\r\n`, "utf8");
      return i < 6 ? call(i, "read", { path: "sample/chapters/notes.md" }) : [{ type: "text", text: "Done." }];
    };
    const result = await runAgentSession(config(), "Check changing notes.");
    expect(result.errorMessage).toBeUndefined();
    expect(result.responseText).toBe("Done.");
  });

  it("bounds a turn even when every tool request is different", async () => {
    transport.reply = (i) => i < 40 ? call(i, "read", { path: `sample/missing-${i}.md` }) : [{ type: "text", text: "Fallback." }];
    const result = await runAgentSession(config(), "Find a file.");
    expect(transport.calls).toBe(32);
    expect(result.errorMessage).toMatch(/loop guard.*32/i);
  });

  it("resets progress tracking between user turns on a cached session", async () => {
    transport.reply = (i) => i % 3 < 2 ? call(i, "read", { path: "sample/chapters/notes.md" }) : [{ type: "text", text: "Done." }];
    for (let i = 0; i < 3; i++) {
      const result = await runAgentSession(config(), "Read twice and report.");
      expect(result.errorMessage).toBeUndefined();
      expect(result.responseText).toBe("Done.");
    }
  });

  it("does not commit an empty thinking-only completion", async () => {
    transport.reply = () => [{ type: "thinking", thinking: "Repeating a thought." }, { type: "text", text: " \n " }];
    const result = await runAgentSession(config(), "Summarize the notes.");
    expect(result.errorMessage).toMatch(/no visible response/i);
    const events = await readTranscriptEvents(root, sessionId);
    expect(events.some((e) => e.type === "request_failed")).toBe(true);
    expect(events.some((e) => e.type === "request_committed")).toBe(false);
    transport.reply = () => [{ type: "text", text: "Recovered." }];
    const next = await runAgentSession(config(), "Try again.");
    expect(next.responseText).toBe("Recovered.");
    expect(JSON.stringify(next.messages)).not.toContain("Repeating a thought.");
  });
});
