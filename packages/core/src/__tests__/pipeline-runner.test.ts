import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImportFoundationSource, PipelineRunner } from "../pipeline/runner.js";
import * as llmProvider from "../llm/provider.js";
import { StateManager } from "../state/manager.js";
import { ArchitectAgent } from "../agents/architect.js";
import { PlannerAgent } from "../agents/planner.js";
import * as ComposerModule from "../agents/composer.js";
import { WriterAgent, type SettleChapterStateInput, type WriteChapterOutput } from "../agents/writer.js";
import { ContinuityAuditor, type AuditIssue, type AuditResult } from "../agents/continuity.js";
import { ReviserAgent, type ReviseOutput } from "../agents/reviser.js";
import { ChapterAnalyzerAgent } from "../agents/chapter-analyzer.js";
import { StateValidatorAgent } from "../agents/state-validator.js";
import type { ValidationResult } from "../agents/state-validator.js";
import {
  FoundationReviewerAgent,
  FoundationReviewParseError,
} from "../agents/foundation-reviewer.js";
import { PolisherAgent } from "../agents/polisher.js";
import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import { MemoryDB } from "../state/memory-db.js";
import * as memoryDbModule from "../state/memory-db.js";
import { countChapterLength } from "../utils/length-metrics.js";
import {
  listChapterVersions,
  readChapterVersion,
  saveChapterUserBrief,
} from "../state/chapter-workspace.js";
import { appendSettlementEvent, createSettlementAttempt } from "../pipeline/settlement-attempt.js";
import { captureCandidateInputs } from "../pipeline/recovery-candidate.js";

const require = createRequire(import.meta.url);
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link) };
});
const hasNodeSqlite = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

const sqliteIt = hasNodeSqlite ? it : it.skip;
const SLOW_PIPELINE_TEST_TIMEOUT_MS = 15_000;

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

describe("buildImportFoundationSource", () => {
  it("selects complete opening, middle, and ending chapters without truncating their text", () => {
    const chapters = Array.from({ length: 36 }, (_, index) => {
      const n = index + 1;
      return {
        title: `第${n}章 标题${n}`,
        content: `OPEN-${n}\n${"正文".repeat(3000)}\nTAIL-${n}`,
      };
    });
    const fullText = chapters.map((chapter, index) => `第${index + 1}章 ${chapter.title}\n\n${chapter.content}`).join("\n\n---\n\n");

    const source = buildImportFoundationSource(chapters, "zh", {
      maxFullTextChars: 20_000,
    });

    expect(source.length).toBeLessThan(fullText.length / 2);
    expect(source).toContain("导入基础设定压缩资料包");
    expect(source).toContain("未选章节将在后续顺序回放");
    expect(source).toContain("完整章节标题目录");
    expect(source).toContain("第1章 第1章 标题1");
    expect(source).toContain("第36章 第36章 标题36");
    expect(source).toContain("OPEN-1");
    expect(source).toContain("TAIL-36");
    expect(source).toContain("正文".repeat(3000));
    expect(source).not.toContain("OPEN-5");
  });
});

const CRITICAL_ISSUE: AuditIssue = {
  severity: "critical",
  category: "continuity",
  description: "Fix the chapter state",
  suggestion: "Repair the contradiction",
};

function createAuditResult(overrides: Partial<AuditResult>): AuditResult {
  return {
    passed: true,
    issues: [],
    summary: "ok",
    overallScore: 90,
    tokenUsage: ZERO_USAGE,
    ...overrides,
  };
}

function createWriterOutput(overrides: Partial<WriteChapterOutput> = {}): WriteChapterOutput {
  return {
    chapterNumber: 1,
    title: "Test Chapter",
    content: "Original chapter body.",
    wordCount: "Original chapter body.".length,
    preWriteCheck: "check",
    postSettlement: "settled",
    updatedState: "writer state",
    updatedLedger: "writer ledger",
    updatedHooks: "writer hooks",
    chapterSummary: "| 1 | Original summary |",
    updatedSubplots: "writer subplots",
    updatedEmotionalArcs: "writer emotions",
    updatedCharacterMatrix: "writer matrix",
    postWriteErrors: [],
    postWriteWarnings: [],
    tokenUsage: ZERO_USAGE,
    ...overrides,
  };
}

function createReviseOutput(overrides: Partial<ReviseOutput> = {}): ReviseOutput {
  return {
    revisedContent: "Revised chapter body.",
    wordCount: "Revised chapter body.".length,
    fixedIssues: ["fixed"],
    tokenUsage: ZERO_USAGE,
    ...overrides,
  };
}

function createAnalyzedOutput(overrides: Partial<WriteChapterOutput> = {}): WriteChapterOutput {
  return createWriterOutput({
    content: "Analyzed final chapter body.",
    wordCount: "Analyzed final chapter body.".length,
    updatedState: "analyzed state",
    updatedLedger: "analyzed ledger",
    updatedHooks: "analyzed hooks",
    chapterSummary: "| 1 | Revised summary |",
    updatedSubplots: "analyzed subplots",
    updatedEmotionalArcs: "analyzed emotions",
    updatedCharacterMatrix: "analyzed matrix",
    ...overrides,
  });
}

function createSettledRevisionOutput(
  input: SettleChapterStateInput,
  overrides: Partial<WriteChapterOutput> = {},
): WriteChapterOutput {
  const updatedState = createStateCard({
    chapter: input.chapterNumber,
    location: "Revision test location",
    protagonistState: "Revision state settled from the new body.",
    goal: "Continue the revised chapter direction.",
    conflict: "Revision state remains internally consistent.",
  });
  const summaryRow = {
    chapter: input.chapterNumber,
    title: input.title,
    characters: "Test protagonist",
    events: "Revised chapter settled",
    stateChanges: "State updated",
    hookActivity: "No hook changes",
    mood: "tense",
    chapterType: "mainline",
  };
  return createWriterOutput({
    chapterNumber: input.chapterNumber,
    title: input.title,
    content: input.content,
    wordCount: input.content.length,
    runtimeStateDelta: {
      chapter: input.chapterNumber,
      hookOps: { upsert: [], mention: [], resolve: [], defer: [] },
      newHookCandidates: [],
      chapterSummary: summaryRow,
      subplotOps: [],
      emotionalArcOps: [],
      characterMatrixOps: [],
      notes: [],
    },
    runtimeStateSnapshot: {
      manifest: {
        schemaVersion: 2,
        language: input.book.language ?? "zh",
        lastAppliedChapter: input.chapterNumber,
        projectionVersion: 1,
        migrationWarnings: [],
      },
      currentState: {
        chapter: input.chapterNumber,
        facts: [],
      },
      hooks: { hooks: [] },
      chapterSummaries: { rows: [summaryRow] },
    },
    updatedState,
    updatedHooks: "# Pending Hooks\n",
    chapterSummary: `| ${input.chapterNumber} | ${input.title} | Test protagonist | Revised chapter settled | State updated | No hook changes | tense | mainline |`,
    updatedChapterSummaries: `# Chapter Summaries\n\n| Chapter | Title | Characters | Key Events | State Changes | Hook Activity | Mood | Chapter Type |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| ${input.chapterNumber} | ${input.title} | Test protagonist | Revised chapter settled | State updated | No hook changes | tense | mainline |\n`,
    ...overrides,
  });
}

async function snapshotRevisionBaseline(
  state: StateManager,
  bookId: string,
  chapterNumber: number,
): Promise<void> {
  const storyDir = join(state.bookDir(bookId), "story");
  await readFile(join(storyDir, "current_state.md"), "utf-8").catch(() =>
    writeFile(join(storyDir, "current_state.md"), createStateCard({
      chapter: chapterNumber,
      location: "Baseline location",
      protagonistState: "Baseline protagonist state.",
      goal: "Baseline goal.",
      conflict: "Baseline conflict.",
    }), "utf-8"));
  await readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() =>
    writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"));
  await state.snapshotState(bookId, chapterNumber);
}

function createStateCard(params: {
  readonly chapter: number;
  readonly location: string;
  readonly protagonistState: string;
  readonly goal: string;
  readonly conflict: string;
}): string {
  return [
    "# Current State",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Current Chapter | ${params.chapter} |`,
    `| Current Location | ${params.location} |`,
    `| Protagonist State | ${params.protagonistState} |`,
    `| Current Goal | ${params.goal} |`,
    "| Current Constraint | The city gates are watched. |",
    "| Current Alliances | Mentor allies are scattered. |",
    `| Current Conflict | ${params.conflict} |`,
    "",
  ].join("\n");
}

async function snapshotPersistedTestPrefix(state: StateManager, bookId: string): Promise<void> {
  const path = join(state.bookDir(bookId), "story", "current_state.md");
  const original = await readFile(path, "utf-8");
  try {
    for (const chapter of await state.loadChapterIndex(bookId)) {
      await writeFile(path, original.replace(/\| Current Chapter \| \d+ \|/, `| Current Chapter | ${chapter.number} |`), "utf-8");
      await state.snapshotState(bookId, chapter.number);
    }
  } finally { await writeFile(path, original, "utf-8"); }
}

function createCaptureLogger() {
  const infos: string[] = [];
  const warnings: string[] = [];

  const logger = {
    debug() {},
    info(message: string) {
      infos.push(message);
    },
    warn(message: string) {
      warnings.push(message);
    },
    error() {},
    child() {
      return logger;
    },
  };

  return { logger, infos, warnings };
}

async function createRunnerFixture(
  configOverrides: Partial<ConstructorParameters<typeof PipelineRunner>[0]> = {},
): Promise<{
  root: string;
  runner: PipelineRunner;
  state: StateManager;
  bookId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "inkos-runner-test-"));
  const state = new StateManager(root);
  const bookId = "test-book";
  const now = "2026-03-19T00:00:00.000Z";
  const book: BookConfig = {
    id: bookId,
    title: "Test Book",
    platform: "tomato",
    genre: "xuanhuan",
    status: "active",
    targetChapters: 10,
    chapterWordCount: 3000,
    createdAt: now,
    updatedAt: now,
  };

  await state.saveBookConfig(bookId, book);
  await mkdir(join(state.bookDir(bookId), "story"), { recursive: true });
  await mkdir(join(state.bookDir(bookId), "chapters"), { recursive: true });
  // Match initialized production books: even chapter one requires snapshot zero.
  await snapshotRevisionBaseline(state, bookId, 0);

  const runner = new PipelineRunner({
    client: {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      defaults: {
        temperature: 0.7,
        maxTokens: 4096,
        thinkingBudget: 0,
      },
    } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
    model: "test-model",
    projectRoot: root,
    ...configOverrides,
  });

  return { root, runner, state, bookId };
}

describe("PipelineRunner", () => {
  beforeEach(() => {
    vi.spyOn(PlannerAgent.prototype, "planChapter").mockImplementation(async (input) => {
      const chapterNumber = input.chapterNumber;
      const goal = input.externalContext ?? "test goal";
      const memo = {
        chapter: chapterNumber,
        goal,
        isGoldenOpening: false,
        body: "",
        threadRefs: [] as string[],
      };
      const intentMarkdown = [
        "# Chapter Intent",
        "",
        "## Goal",
        goal,
        "",
        "## Outline Node",
        "(not found)",
        "",
        "## Must Keep",
        "- none",
        "",
        "## Must Avoid",
        "- none",
        "",
        "## Style Emphasis",
        "- none",
        "",
      ].join("\n");
      const runtimeDir = join(input.bookDir, "story", "runtime");
      const { mkdir: mkdirFs, writeFile: writeFileFs } = await import("node:fs/promises");
      await mkdirFs(runtimeDir, { recursive: true });
      const runtimePath = join(runtimeDir, `chapter-${String(chapterNumber).padStart(4, "0")}.intent.md`);
      await writeFileFs(runtimePath, intentMarkdown, "utf-8");
      return {
        intent: {
          chapter: chapterNumber,
          goal,
          mustKeep: [],
          mustAvoid: [],
          styleEmphasis: [],
        },
        memo,
        intentMarkdown,
        plannerInputs: [runtimePath],
        runtimePath,
      };
    });
    vi.spyOn(FoundationReviewerAgent.prototype, "review").mockResolvedValue({
      passed: true,
      totalScore: 85,
      dimensions: [],
      overallFeedback: "auto-pass for test",
    });
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({
      warnings: [],
      passed: true,
    });
    vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(
      async (input) => createSettledRevisionOutput(input),
    );
    // Default reviser mock: return input content unchanged so the review cycle's
    // repair loop exits immediately when triggered by length-out-of-range content.
    // Tests that need specific revision behavior override this mock explicitly.
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockImplementation(
      async (_bookDir, chapterContent, _chapterNumber, _issues, _mode, _genre, _options) =>
        createReviseOutput({
          revisedContent: chapterContent,
          wordCount: chapterContent.length,
        }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not reuse override clients when credential sources differ", () => {
    const previousKeyA = process.env.TEST_KEY_A;
    const previousKeyB = process.env.TEST_KEY_B;
    process.env.TEST_KEY_A = "key-a";
    process.env.TEST_KEY_B = "key-b";

    try {
      const runner = new PipelineRunner({
        client: {
          provider: "openai",
          apiFormat: "chat",
          stream: false,
          defaults: {
            temperature: 0.7,
            maxTokens: 4096,
            thinkingBudget: 0,
          },
        } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
        model: "base-model",
        projectRoot: process.cwd(),
        defaultLLMConfig: {
          provider: "custom",
          service: "custom",
          configSource: "env",
          baseUrl: "https://base.example/v1",
          apiKey: "base-key",
          model: "base-model",
          temperature: 0.7,
          thinkingBudget: 0,
          apiFormat: "chat",
          stream: false,
        },
        modelOverrides: {
          writer: {
            model: "writer-model",
            provider: "custom",
            baseUrl: "https://shared.example/v1",
            apiKeyEnv: "TEST_KEY_A",
          },
          auditor: {
            model: "auditor-model",
            provider: "custom",
            baseUrl: "https://shared.example/v1",
            apiKeyEnv: "TEST_KEY_B",
          },
        },
      });

      const resolveOverride = (
        runner as unknown as {
          resolveOverride: (agent: string) => { model: string; client: unknown };
        }
      ).resolveOverride.bind(runner);

      const writerOverride = resolveOverride("writer");
      const auditorOverride = resolveOverride("auditor");

      expect(writerOverride.client).not.toBe(auditorOverride.client);
    } finally {
      if (previousKeyA === undefined) delete process.env.TEST_KEY_A;
      else process.env.TEST_KEY_A = previousKeyA;

      if (previousKeyB === undefined) delete process.env.TEST_KEY_B;
      else process.env.TEST_KEY_B = previousKeyB;
    }
  });

  it("initializes control documents during book creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-init-book-test-"));
    const bookId = "bootstrap-book";
    const brief = "# Author Intent\n\nKeep the narrative centered on mentor conflict.\n";
    const now = "2026-03-22T00:00:00.000Z";
    const book: BookConfig = {
      id: bookId,
      title: "Bootstrap Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "outlining",
      targetChapters: 10,
      chapterWordCount: 3000,
      createdAt: now,
      updatedAt: now,
    };

    const runner = new PipelineRunner({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          thinkingBudget: 0,
        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
      externalContext: brief,
    });

    vi.spyOn(ArchitectAgent.prototype, "generateFoundation").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: "# Current State\n",
      pendingHooks: "# Pending Hooks\n",
    });

    try {
      await runner.initBook(book);

      const storyDir = join(root, "books", bookId, "story");
      const authorIntent = await readFile(join(storyDir, "author_intent.md"), "utf-8");
      const currentFocus = await readFile(join(storyDir, "current_focus.md"), "utf-8");
      const runtimeDir = await stat(join(storyDir, "runtime"));

      expect(authorIntent).toContain("mentor conflict");
      expect(currentFocus).toContain("当前聚焦");
      expect(runtimeDir.isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies creation-draft overrides while initializing a book", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-init-book-overrides-"));
    const bookId = "override-book";
    const book: BookConfig = {
      id: bookId,
      title: "Override Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "outlining",
      targetChapters: 20,
      chapterWordCount: 2800,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };

    const runner = new PipelineRunner({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          thinkingBudget: 0,
        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
    });

    const generateFoundationSpy = vi.spyOn(ArchitectAgent.prototype, "generateFoundation").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: "# Current State\n",
      pendingHooks: "# Pending Hooks\n",
    });

    try {
      await runner.initBook(book, {
        externalContext: "世界观重点：近未来港口城，账本与旧案牵出多方势力。",
        authorIntent: "# 作者意图\n\n写成冷硬、克制、利益驱动的商战悬疑。\n",
        currentFocus: "# 当前聚焦\n\n先把旧账线和港口势力网立住。\n",
      });

      expect(generateFoundationSpy).toHaveBeenCalledWith(
        book,
        expect.stringContaining("近未来港口城"),
        undefined,
      );

      const storyDir = join(root, "books", bookId, "story");
      await expect(readFile(join(storyDir, "author_intent.md"), "utf-8"))
        .resolves.toContain("冷硬、克制、利益驱动");
      await expect(readFile(join(storyDir, "current_focus.md"), "utf-8"))
        .resolves.toContain("旧账线和港口势力网");
      await expect(readFile(join(storyDir, "brief.md"), "utf-8"))
        .resolves.toContain("近未来港口城");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("feeds foundation review feedback into the regeneration call after a rejection", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const reviewer = new FoundationReviewerAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          thinkingBudget: 0,
        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
      bookId,
    });
    const foundation = {
      storyBible: "# Story Bible",
      volumeOutline: "# Volume Outline",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules",
      currentState: "# Current State",
      pendingHooks: "# Pending Hooks",
    };
    const generate = vi.fn(async (_reviewFeedback?: string) => foundation);
    const reviewMock = vi.mocked(FoundationReviewerAgent.prototype.review);

    reviewMock.mockReset();
    reviewMock
      .mockResolvedValueOnce({
        passed: false,
        totalScore: 68,
        dimensions: [
          {
            name: "核心冲突",
            score: 58,
            feedback: "核心冲突不够集中，主线悬念没有站稳。",
          },
          {
            name: "开篇节奏",
            score: 76,
            feedback: "前五章起势偏慢，爆点不够前置。",
          },
        ],
        overallFeedback: "请把冲突收紧，并在更早的位置建立爆点。",
      })
      .mockResolvedValueOnce({
        passed: true,
        totalScore: 88,
        dimensions: [],
        overallFeedback: "通过",
      });

    try {
      const result = await (runner as unknown as {
        generateAndReviewFoundation: (params: {
          readonly generate: (reviewFeedback?: string) => Promise<typeof foundation>;
          readonly reviewer: FoundationReviewerAgent;
          readonly mode: "original";
          readonly language: "zh";
          readonly stageLanguage: "zh";
          readonly maxRetries: number;
        }) => Promise<typeof foundation>;
      }).generateAndReviewFoundation({
        generate,
        reviewer,
        mode: "original",
        language: "zh",
        stageLanguage: "zh",
        maxRetries: 2,
      });

      expect(result).toEqual(foundation);
      expect(generate).toHaveBeenCalledTimes(2);
      expect(generate.mock.calls[0]?.[0]).toBeUndefined();
      expect(generate.mock.calls[1]?.[0]).toContain("请把冲突收紧，并在更早的位置建立爆点。");
      expect(generate.mock.calls[1]?.[0]).toContain("核心冲突");
      expect(generate.mock.calls[1]?.[0]).toContain("核心冲突不够集中");
      expect(generate.mock.calls[1]?.[0]).toContain("开篇节奏");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the current foundation when review formatting cannot be parsed", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const reviewer = new FoundationReviewerAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
      bookId,
    });
    const foundation = {
      storyBible: "# Story Bible",
      volumeOutline: "# Volume Outline",
      bookRules: "# Book Rules",
      currentState: "# Current State",
      pendingHooks: "# Pending Hooks",
    };
    const generate = vi.fn(async () => foundation);
    const reviewMock = vi.mocked(FoundationReviewerAgent.prototype.review);
    reviewMock.mockReset();
    reviewMock.mockRejectedValue(new FoundationReviewParseError([2, 3, 4, 5]));

    try {
      const result = await (runner as unknown as {
        generateAndReviewFoundation: (params: {
          readonly generate: () => Promise<typeof foundation>;
          readonly reviewer: FoundationReviewerAgent;
          readonly mode: "original";
          readonly language: "zh";
          readonly stageLanguage: "zh";
        }) => Promise<typeof foundation>;
      }).generateAndReviewFoundation({
        generate,
        reviewer,
        mode: "original",
        language: "zh",
        stageLanguage: "zh",
      });

      expect(result).toBe(foundation);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(reviewMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors configured foundation review retry count before accepting a rejected foundation", async () => {
    const { root, runner, bookId } = await createRunnerFixture({
      foundationReviewRetries: 4,
    } as Partial<ConstructorParameters<typeof PipelineRunner>[0]>);
    const reviewer = new FoundationReviewerAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          thinkingBudget: 0,
        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
      bookId,
    });
    const foundation = {
      storyBible: "# Story Bible",
      volumeOutline: "# Volume Outline",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules",
      currentState: "# Current State",
      pendingHooks: "# Pending Hooks",
    };
    const generate = vi.fn(async (_reviewFeedback?: string) => foundation);
    const reviewMock = vi.mocked(FoundationReviewerAgent.prototype.review);

    reviewMock.mockReset();
    reviewMock.mockResolvedValue({
      passed: false,
      totalScore: 72,
      dimensions: [],
      overallFeedback: "仍未达到可开写标准。",
    });

    try {
      await (runner as unknown as {
        generateAndReviewFoundation: (params: {
          readonly generate: (reviewFeedback?: string) => Promise<typeof foundation>;
          readonly reviewer: FoundationReviewerAgent;
          readonly mode: "original";
          readonly language: "zh";
          readonly stageLanguage: "zh";
        }) => Promise<typeof foundation>;
      }).generateAndReviewFoundation({
        generate,
        reviewer,
        mode: "original",
        language: "zh",
        stageLanguage: "zh",
      });

      expect(generate).toHaveBeenCalledTimes(5);
      expect(reviewMock).toHaveBeenCalledTimes(5);
      expect(generate.mock.calls[1]?.[0]).toContain("仍未达到可开写标准");
      expect(generate.mock.calls[4]?.[0]).toContain("仍未达到可开写标准");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bootstraps missing control documents for legacy books before writing", async () => {
    const { root, runner, bookId } = await createRunnerFixture();

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Legacy chapter body.",
        wordCount: "Legacy chapter body.".length,
      }),
    );

    try {
      await runner.writeDraft(bookId);

      const storyDir = join(root, "books", bookId, "story");
      const authorIntent = await readFile(join(storyDir, "author_intent.md"), "utf-8");
      const currentFocus = await readFile(join(storyDir, "current_focus.md"), "utf-8");
      const runtimeDir = await stat(join(storyDir, "runtime"));

      expect(authorIntent).toContain("Author Intent");
      expect(currentFocus).toContain("Current Focus");
      expect(runtimeDir.isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("cleans staged files when initBook fails before foundation is complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-init-rollback-"));
    const runner = new PipelineRunner({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          thinkingBudget: 0,
        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
    });

    const now = "2026-03-29T00:00:00.000Z";
    const book: BookConfig = {
      id: "atomic-book",
      title: "Atomic Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "outlining",
      targetChapters: 12,
      chapterWordCount: 2200,
      createdAt: now,
      updatedAt: now,
    };

    vi.spyOn(ArchitectAgent.prototype, "generateFoundation").mockRejectedValue(
      new Error("missing book_rules section"),
    );

    try {
      await expect(runner.initBook(book)).rejects.toThrow("missing book_rules section");
      await expect(stat(join(root, "books", "atomic-book"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes writeDraft through planner and composer on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
    ]);

    const planChapter = vi.spyOn(PlannerAgent.prototype, "planChapter").mockImplementation(async (input) => {
      const runtimeDir = join(input.bookDir, "story", "runtime");
      await mkdir(runtimeDir, { recursive: true });
      const goal = "Ignore the guild chase and bring focus back to mentor conflict.";
      const memo = {
        chapter: input.chapterNumber,
        goal,
        isGoldenOpening: true,
        body: "",
        threadRefs: [] as string[],
      };
      const intentMarkdown = [
        "# Chapter Intent",
        "",
        "## Goal",
        goal,
        "",
        "## Outline Node",
        "Track the merchant guild trail.",
        "",
        "## Must Keep",
        "- Lin Yue still hides the broken oath token.",
        "",
        "## Must Avoid",
        "- none",
        "",
        "## Style Emphasis",
        "- none",
        "",
        "## Conflicts",
        "- outline_vs_request: allow local outline deferral",
        "",
        "## Chapter Brief",
        "- chapterType: confrontation",
        "- isGoldenOpening: true",
        "",
        "### Beat Outline",
        "- opening: Open on the conflict.",
        "",
        "### Hook Plan",
        "- none",
        "",
        "### Props And Setting",
        "- broken oath token",
        "",
      ].join("\n");
      const runtimePath = join(runtimeDir, `chapter-${String(input.chapterNumber).padStart(4, "0")}.intent.md`);
      await writeFile(runtimePath, intentMarkdown, "utf-8");
      return {
        intent: {
          chapter: input.chapterNumber,
          goal,
          outlineNode: "Track the merchant guild trail.",
          mustKeep: ["Lin Yue still hides the broken oath token."],
          mustAvoid: [],
          styleEmphasis: [],
        },
        memo,
        intentMarkdown,
        plannerInputs: [runtimePath],
        runtimePath,
      };
    });
    const composeChapter = vi.spyOn(ComposerModule, "composeGovernedChapter");
    const writeChapter = vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Governed draft body.",
        wordCount: "Governed draft body.".length,
      }),
    );

    try {
      const chapterContext = "Ignore the guild chase and bring focus back to mentor conflict.";
      await runner.writeDraft(bookId, chapterContext);

      expect(planChapter).toHaveBeenCalledTimes(1);
      expect(composeChapter).toHaveBeenCalledTimes(1);

      const writeInput = writeChapter.mock.calls[0]?.[0];
      expect(writeInput?.externalContext).toBe(chapterContext);
      expect(writeInput?.chapterIntent).toContain("# Chapter Intent");
      expect(writeInput?.chapterMemo).toEqual(expect.objectContaining({
        chapter: 1,
      }));
      expect(writeInput?.contextPackage?.selectedContext.length).toBeGreaterThan(0);

      const runtimeDir = join(state.bookDir(bookId), "story", "runtime");
      await expect(stat(join(runtimeDir, "chapter-0001.intent.md"))).resolves.toBeTruthy();
      await expect(stat(join(runtimeDir, "chapter-0001.context.json"))).resolves.toBeTruthy();
      await expect(stat(join(runtimeDir, "chapter-0001.rule-stack.yaml"))).resolves.toBeTruthy();
      await expect(stat(join(runtimeDir, "chapter-0001.trace.json"))).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses an existing planned intent for draft when no new context is provided on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });

    await Promise.all([
      mkdir(join(state.bookDir(bookId), "story", "runtime"), { recursive: true }),
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
      writeFile(
        join(state.bookDir(bookId), "story", "runtime", "chapter-0001.intent.md"),
        [
          "# Chapter Intent",
          "",
          "## Goal",
          "Bring the focus back to the mentor conflict.",
          "",
          "## Outline Node",
          "Track the merchant guild trail.",
          "",
          "## Must Keep",
          "- Lin Yue still hides the broken oath token.",
          "",
          "## Must Avoid",
          "- Do not reveal the mastermind",
          "",
          "## Style Emphasis",
          "- Keep the narrative emotionally close to the mentor conflict.",
          "",
          "## Conflicts",
          "- outline_vs_request: allow local outline deferral",
          "",
          "## Chapter Brief",
          "- chapterType: confrontation",
          "- isGoldenOpening: true",
          "",
          "### Beat Outline",
          "- opening: Open on the conflict.",
          "",
          "### Hook Plan",
          "- none",
          "",
          "### Props And Setting",
          "- broken oath token",
          "",
          "## Pending Hooks Snapshot",
          "- none",
          "",
          "## Chapter Summaries Snapshot",
          "- none",
          "",
        ].join("\n"),
        "utf-8",
      ),
    ]);

    const planChapter = vi.spyOn(PlannerAgent.prototype, "planChapter");
    const writeChapter = vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Governed draft body.",
        wordCount: "Governed draft body.".length,
      }),
    );

    try {
      await runner.writeDraft(bookId);

      expect(planChapter).toHaveBeenCalledTimes(0);
      const writeInput = writeChapter.mock.calls[0]?.[0];
      expect(writeInput?.chapterIntent).toBeDefined();
      expect(writeInput?.chapterIntent).toContain("Bring the focus back to the mentor conflict.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  sqliteIt("syncs current-state facts into memory.db after drafting a chapter", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const chapterOneState = createStateCard({
      chapter: 1,
      location: "Ashen ferry crossing",
      protagonistState: "Lin Yue hides the broken oath token.",
      goal: "Find the vanished mentor before dawn.",
      conflict: "Mentor debt blocks every choice.",
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(
        join(state.bookDir(bookId), "story", "current_state.md"),
        createStateCard({
          chapter: 0,
          location: "Shrine outskirts",
          protagonistState: "Lin Yue begins with the oath token hidden.",
          goal: "Reach the trial city.",
          conflict: "The trial deadline is closing in.",
        }),
        "utf-8",
      ),
    ]);
    await state.snapshotState(bookId, 0);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Draft body.",
        wordCount: "Draft body.".length,
        updatedState: chapterOneState,
        updatedHooks: [
          "# Pending Hooks",
          "",
          "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| mentor-debt | 1 | relationship | open | 1 | 6 | The mentor debt remains unresolved |",
          "",
        ].join("\n"),
        chapterSummary: [
          "| 1 | Ferry Debt | Lin Yue | Lin Yue crosses the ferry and recommits to the mentor trail | The debt hardens into the core conflict | mentor-debt advanced | tense | mainline |",
        ].join("\n"),
      }),
    );

    try {
      await runner.writeDraft(bookId);

      const memoryDb = new MemoryDB(state.bookDir(bookId));
      try {
        expect(memoryDb.getCurrentFacts()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              predicate: "Current Conflict",
              object: "Mentor debt blocks every choice.",
              validFromChapter: 1,
              sourceChapter: 1,
            }),
          ]),
        );
        expect(memoryDb.getChapterCount()).toBe(1);
        expect(memoryDb.getActiveHooks()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              hookId: "mentor-debt",
              status: "open",
            }),
          ]),
        );
      } finally {
        memoryDb.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  sqliteIt("syncs narrative memory from structured runtime state instead of stale markdown projections", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const stateDir = join(storyDir, "state");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(chaptersDir, "index.json"),
      JSON.stringify([
        { number: 1, title: "Ch1", status: "approved" },
        { number: 2, title: "Ch2", status: "approved" },
        { number: 3, title: "Ch3", status: "approved" },
      ]),
      "utf-8",
    );

    await Promise.all([
      writeFile(
        join(storyDir, "chapter_summaries.md"),
        [
          "| chapter | title | characters | events | stateChanges | hookActivity | mood | chapterType |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| 1 | Markdown Summary | Lin Yue | Old markdown event | Old markdown state | markdown-hook advanced | tense | fallback |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "| hook_id | start_chapter | type | status | last_advanced | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| markdown-hook | 1 | mystery | open | 1 | 4 | Old markdown hook |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(stateDir, "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "en",
        lastAppliedChapter: 3,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "current_state.json"), JSON.stringify({
        chapter: 3,
        facts: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "hooks.json"), JSON.stringify({
        hooks: [
          {
            hookId: "structured-hook",
            startChapter: 2,
            type: "relationship",
            status: "progressing",
            lastAdvancedChapter: 3,
            expectedPayoff: "Reveal the mentor ledger.",
            notes: "Structured hook should win.",
          },
        ],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "chapter_summaries.json"), JSON.stringify({
        rows: [
          {
            chapter: 3,
            title: "Structured Summary",
            characters: "Lin Yue",
            events: "Structured runtime state event.",
            stateChanges: "Structured runtime state shift.",
            hookActivity: "structured-hook advanced",
            mood: "grim",
            chapterType: "mainline",
          },
        ],
      }, null, 2), "utf-8"),
    ]);

    try {
      await (runner as unknown as {
        syncNarrativeMemoryIndex: (targetBookId: string) => Promise<void>;
      }).syncNarrativeMemoryIndex(bookId);

      const memoryDb = new MemoryDB(state.bookDir(bookId));
      try {
        expect(memoryDb.getSummaries(1, 10)).toEqual([
          expect.objectContaining({
            chapter: 3,
            title: "Structured Summary",
            events: "Structured runtime state event.",
          }),
        ]);
        expect(memoryDb.getActiveHooks()).toEqual([
          expect.objectContaining({
            hookId: "structured-hook",
            status: "progressing",
          }),
        ]);
      } finally {
        memoryDb.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  sqliteIt("retries transient sqlite busy errors during narrative memory sync", async () => {
    const { logger, warnings } = createCaptureLogger();
    const { root, runner, state, bookId } = await createRunnerFixture({
      logger,
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(
        join(state.bookDir(bookId), "story", "current_state.md"),
        createStateCard({
          chapter: 0,
          location: "Shrine outskirts",
          protagonistState: "Lin Yue begins with the oath token hidden.",
          goal: "Reach the trial city.",
          conflict: "The trial deadline is closing in.",
        }),
        "utf-8",
      ),
    ]);

    const RealMemoryDB = memoryDbModule.MemoryDB;
    let constructorCalls = 0;
    vi.spyOn(memoryDbModule, "MemoryDB").mockImplementation((...args: ConstructorParameters<typeof memoryDbModule.MemoryDB>) => {
      if (constructorCalls === 1) {
        constructorCalls += 1;
        const error = new Error("database is locked");
        (error as Error & { code?: string }).code = "SQLITE_BUSY";
        throw error;
      }
      constructorCalls += 1;
      return new RealMemoryDB(...args);
    });
    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Draft body.",
        wordCount: "Draft body.".length,
        chapterSummary: "| 1 | Draft summary | Lin Yue | Draft event | Draft shift | hook advanced | tense | transition |",
        updatedHooks: [
          "# Pending Hooks",
          "",
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| mentor-debt | 1 | relationship | open | 1 | 3 | Draft hook |",
        ].join("\n"),
      }),
    );

    try {
      const result = await runner.writeDraft(bookId);

      expect(result.chapterNumber).toBe(1);
      expect(warnings.join("\n")).not.toContain("当前 Node 运行时不支持 SQLite 记忆索引");
      expect(warnings.join("\n")).not.toContain("叙事记忆同步已跳过");

      const memoryDb = new MemoryDB(state.bookDir(bookId));
      try {
        expect(memoryDb.getChapterCount()).toBe(1);
        expect(memoryDb.getActiveHooks()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              hookId: "mentor-debt",
              status: "open",
            }),
          ]),
        );
      } finally {
        memoryDb.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs explicit stage messages during book initialization", async () => {
    const { logger, infos } = createCaptureLogger();
    const { root, runner, state, bookId } = await createRunnerFixture({ logger });
    const book = await state.loadBookConfig(bookId);

    vi.spyOn(ArchitectAgent.prototype, "generateFoundation").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }),
      pendingHooks: "# Pending Hooks\n",
    });

    try {
      await runner.initBook(book);

      expect(infos).toEqual(expect.arrayContaining([
        "阶段：保存书籍配置",
        "阶段：生成基础设定",
        "阶段：写入基础设定文件",
        "阶段：初始化控制文档",
        "阶段：创建初始快照",
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks an outlining book as active after drafting the first chapter", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const book = await state.loadBookConfig(bookId);
    await state.saveBookConfig(bookId, { ...book, status: "outlining" });

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Draft body.",
        wordCount: "Draft body.".length,
      }),
    );

    try {
      await runner.writeDraft(bookId);

      const book = await state.loadBookConfig(bookId);
      expect(book.status).toBe("active");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes writeNextChapter through planner and composer on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
    ]);

    const originalPlanChapter = PlannerAgent.prototype.planChapter;
    const planChapter = vi.spyOn(PlannerAgent.prototype, "planChapter").mockImplementation(async function (this: PlannerAgent, input) {
      const result = await originalPlanChapter.call(this, input);
      return {
        ...result,
        memo: {
          chapter: input.chapterNumber,
          goal: result.intent.goal,
          isGoldenOpening: true,
          body: "",
          threadRefs: [],
        },
      };
    });
    const composeChapter = vi.spyOn(ComposerModule, "composeGovernedChapter");
    const writeChapter = vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Governed pipeline draft.",
        wordCount: "Governed pipeline draft.".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(planChapter).toHaveBeenCalledTimes(1);
      expect(composeChapter).toHaveBeenCalledTimes(1);
      const writeInput = writeChapter.mock.calls[0]?.[0];
      expect(writeInput?.chapterIntent).toContain("# Chapter Intent");
      expect(writeInput?.externalContext).toBeUndefined();
      expect(writeInput?.chapterMemo).toEqual(expect.objectContaining({
        chapter: 1,
      }));
      expect(writeInput?.contextPackage?.selectedContext.length).toBeGreaterThan(0);
      const run = JSON.parse(await readFile(
        join(state.bookDir(bookId), "story", "runtime", "chapter-0001.run.json"),
        "utf-8",
      ));
      expect(run).toMatchObject({
        kind: "long-fiction",
        status: "needs-review",
        stage: "chapter-1",
        skillIds: ["inkos-long-writing"],
      });
      expect(run.artifacts).toEqual(expect.arrayContaining([
        expect.stringMatching(/^chapters\/0001_/),
        "chapters/index.json",
        "story/current_state.md",
        "story/pending_hooks.md",
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes configured writeNextChapter context through planner and governed writer input", async () => {
    const chapterContext = "本章标题：雨夜账本\n必须围绕账本失窃后的当面对质展开。";
    const { root, runner, state, bookId } = await createRunnerFixture({
      externalContext: chapterContext,
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
    ]);

    const planChapter = vi.spyOn(PlannerAgent.prototype, "planChapter");
    vi.spyOn(ComposerModule, "composeGovernedChapter");
    const writeChapter = vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        title: "雨夜账本",
        content: "Governed pipeline draft.",
        wordCount: "Governed pipeline draft.".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(planChapter.mock.calls[0]?.[0].externalContext).toBe(chapterContext);
      const writeInput = writeChapter.mock.calls[0]?.[0];
      expect(writeInput?.externalContext).toBe(chapterContext);
      expect(writeInput?.chapterMemo?.goal).toBe(chapterContext);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-plans instead of reusing a persisted invalid intent artifact on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const storyDir = join(state.bookDir(bookId), "story");
    const runtimeDir = join(storyDir, "runtime");
    await mkdir(runtimeDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(
        join(storyDir, "volume_outline.md"),
        [
          "# Volume Outline",
          "",
          "### Golden First Three Chapters Rule",
          "",
          "**Chapter 1:**",
          "Track the merchant guild trail.",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
      writeFile(
        join(runtimeDir, "chapter-0001.intent.md"),
        [
          "# Chapter Intent",
          "",
          "## Goal",
          "**",
          "",
          "## Outline Node",
          "**",
          "",
          "## Must Keep",
          "- none",
          "",
          "## Must Avoid",
          "- none",
          "",
          "## Style Emphasis",
          "- none",
          "",
          "## Conflicts",
          "- none",
          "",
        ].join("\n"),
        "utf-8",
      ),
    ]);

    const planChapter = vi.spyOn(PlannerAgent.prototype, "planChapter").mockImplementation(async (input) => {
      const rDir = join(input.bookDir, "story", "runtime");
      await mkdir(rDir, { recursive: true });
      const goal = "Track the merchant guild trail.";
      const intentMd = [
        "# Chapter Intent",
        "",
        "## Goal",
        goal,
        "",
        "## Outline Node",
        "(not found)",
        "",
        "## Must Keep",
        "- none",
        "",
        "## Must Avoid",
        "- none",
        "",
        "## Style Emphasis",
        "- none",
        "",
        "## Conflicts",
        "- none",
        "",
        "## Chapter Brief",
        "- chapterType: 推进",
        "- isGoldenOpening: false",
        "",
        "### Beat Outline",
        "- opening: test",
        "",
        "### Hook Plan",
        "- none",
        "",
        "### Props And Setting",
        "- none",
        "",
      ].join("\n");
      const runtimePath = join(rDir, `chapter-${String(input.chapterNumber).padStart(4, "0")}.intent.md`);
      await writeFile(runtimePath, intentMd, "utf-8");
      return {
        intent: {
          chapter: input.chapterNumber,
          goal,
          mustKeep: [],
          mustAvoid: [],
          styleEmphasis: [],
        },
        memo: {
          chapter: input.chapterNumber,
          goal,
          isGoldenOpening: false,
          body: "",
          threadRefs: [],
        },
        intentMarkdown: intentMd,
        plannerInputs: [runtimePath],
        runtimePath,
      };
    });
    const writeChapter = vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Governed pipeline draft.",
        wordCount: "Governed pipeline draft.".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(planChapter).toHaveBeenCalledTimes(1);
      const writeInput = writeChapter.mock.calls[0]?.[0];
      expect(writeInput?.chapterIntent).toContain("Track the merchant guild trail.");
      expect(writeInput?.chapterIntent).not.toContain("\n**\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs explicit stage messages during writeNextChapter", async () => {
    const { logger, infos } = createCaptureLogger();
    const { root, runner, state, bookId } = await createRunnerFixture({
      logger,
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Governed pipeline draft.",
        wordCount: "Governed pipeline draft.".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(infos).toEqual(expect.arrayContaining([
        "阶段：准备章节输入",
        "阶段：撰写章节草稿",
        "阶段：审计草稿",
        "阶段：落盘最终章节",
        "阶段：生成最终真相文件",
        "阶段：校验真相文件变更",
        "阶段：同步记忆索引",
        "阶段：更新章节索引与快照",
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs English stage messages during writeNextChapter for English books", async () => {
    const { logger, infos } = createCaptureLogger();
    const { root, runner, state, bookId } = await createRunnerFixture({
      logger,
    });
    const englishBook = {
      ...(await state.loadBookConfig(bookId)),
      genre: "other",
      language: "en" as const,
      chapterWordCount: 220,
    };

    await state.saveBookConfig(bookId, englishBook);
    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Governed pipeline draft.",
        wordCount: countChapterLength("Governed pipeline draft.", "en_words"),
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(infos).toEqual(expect.arrayContaining([
        "Stage: preparing chapter inputs",
        "Stage: writing chapter draft",
        "Stage: auditing draft",
        "Stage: persisting final chapter",
        "Stage: rebuilding final truth files",
        "Stage: validating truth file updates",
        "Stage: syncing memory indexes",
        "Stage: updating chapter index and snapshots",
      ]));
      expect(infos.join("\n")).not.toContain("阶段：");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes English audit drift guidance into a dedicated file without polluting current_state", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const englishBook = {
      ...(await state.loadBookConfig(bookId)),
      genre: "other",
      language: "en" as const,
      chapterWordCount: 220,
    };

    await state.saveBookConfig(bookId, englishBook);
    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nKeep the pressure on the harbor debt.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), createStateCard({
        chapter: 0,
        location: "Harbor gate",
        protagonistState: "Lin Yue is tracking the vanished mentor.",
        goal: "Reach the sealed berth.",
        conflict: "The harbor debt keeps pulling him sideways.",
      }), "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The harbor seal cannot be forged.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- The vanished mentor still owes a debt.\n", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Lin Yue reached the sealed berth before dawn.",
        wordCount: countChapterLength("Lin Yue reached the sealed berth before dawn.", "en_words"),
        updatedState: createStateCard({
          chapter: 1,
          location: "Sealed berth",
          protagonistState: "Lin Yue is winded but focused.",
          goal: "Inspect the berth before the guild arrives.",
          conflict: "The harbor debt is still active.",
        }),
        updatedHooks: "# Pending Hooks\n\n- The vanished mentor still owes a debt.\n",
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [{
          severity: "warning",
          category: "continuity",
          description: "Keep the berth timing precise in the next chapter.",
          suggestion: "Avoid skipping the dawn transition.",
        }],
        summary: "warning only",
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      const driftFile = await readFile(join(state.bookDir(bookId), "story", "audit_drift.md"), "utf-8");
      const currentState = await readFile(join(state.bookDir(bookId), "story", "current_state.md"), "utf-8");
      expect(driftFile).toContain("## Audit Drift Correction");
      expect(driftFile).toContain("> Chapter 1 audit found the following issues");
      expect(driftFile).not.toContain("## 审计纠偏");
      expect(driftFile).not.toContain("下一章写作前参照");
      expect(currentState).not.toContain("Audit Drift Correction");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes reduced control inputs into auditor and reviser on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Needs governed revision.",
        wordCount: "Needs governed revision.".length,
      }),
    );
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: false,
        issues: [CRITICAL_ISSUE],
        summary: "needs revision",
      }),
    );
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: "Governed revised content.",
        wordCount: "Governed revised content.".length,
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: "Governed revised content.",
        wordCount: "Governed revised content.".length,
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(auditChapter.mock.calls[0]?.[4]).toMatchObject({
        chapterIntent: expect.stringContaining("# Chapter Intent"),
        contextPackage: expect.objectContaining({
          selectedContext: expect.any(Array),
        }),
        ruleStack: expect.objectContaining({
          activeOverrides: expect.any(Array),
        }),
      });
      expect(reviseChapter.mock.calls[0]?.[6]).toMatchObject({
        chapterIntent: expect.stringContaining("# Chapter Intent"),
        contextPackage: expect.objectContaining({
          selectedContext: expect.any(Array),
        }),
        ruleStack: expect.objectContaining({
          activeOverrides: expect.any(Array),
        }),
        lengthSpec: expect.objectContaining({
          target: 220,
          softMin: 190,
          softMax: 250,
        }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes governed control inputs into final truth rebuild on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });

    await Promise.all([
      writeFile(join(state.bookDir(bookId), "story", "current_focus.md"), "# Current Focus\n\nBring focus back to the mentor conflict.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "story", "pending_hooks.md"), "# Pending Hooks\n\n- Why the mentor vanished after the trial.\n", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: "Original draft body.",
        wordCount: "Original draft body.".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [CRITICAL_ISSUE],
          summary: "needs revision",
          overallScore: 40,
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
          overallScore: 95,
        }),
      );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: "Governed revised body.",
        wordCount: "Governed revised body.".length,
      }),
    );
    const analyzeChapter = vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: "Governed revised body.",
        wordCount: "Governed revised body.".length,
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(analyzeChapter.mock.calls[0]?.[0]).toMatchObject({
        chapterIntent: expect.stringContaining("# Chapter Intent"),
        contextPackage: expect.objectContaining({
          selectedContext: expect.any(Array),
        }),
        ruleStack: expect.objectContaining({
          activeOverrides: expect.any(Array),
        }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs hard-range drift through the reviser instead of a second whole-chapter normalizer", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const overlongDraft = "修订后正文。".repeat(60);
    const normalizedDraft = "归一正文。".repeat(40);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: overlongDraft,
        wordCount: overlongDraft.length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: normalizedDraft,
        wordCount: normalizedDraft.length,
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: normalizedDraft,
        wordCount: normalizedDraft.length,
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(reviseChapter).toHaveBeenCalled();
      expect(reviseChapter.mock.calls[0]?.[3]).toEqual(expect.arrayContaining([
        expect.objectContaining({ category: "length-budget" }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("audits overlong writer output without silently rewriting it first", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const overlongDraft = "冗余句子。".repeat(60);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: overlongDraft,
        wordCount: overlongDraft.length,
      }),
    );
    const auditChapter = vi.spyOn(
      ContinuityAuditor.prototype,
      "auditChapter",
    ).mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: overlongDraft,
        wordCount: overlongDraft.length,
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(auditChapter.mock.calls[0]?.[1]).toBe(overlongDraft);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves minor soft-range drift to the normal audit path", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const nearTargetDraft = "近".repeat(260);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: nearTargetDraft,
        wordCount: nearTargetDraft.length,
      }),
    );
    const auditChapter = vi.spyOn(
      ContinuityAuditor.prototype,
      "auditChapter",
    ).mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(auditChapter.mock.calls[0]?.[1]).toBe(nearTargetDraft);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs an undersized draft through a measured length-budget issue", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const shortDraft = "短句。".repeat(20);
    const normalizedDraft = "补足后的正文。".repeat(30);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: shortDraft,
        wordCount: shortDraft.length,
      }),
    );
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: normalizedDraft,
        wordCount: normalizedDraft.length,
      }),
    );
    const auditChapter = vi.spyOn(
      ContinuityAuditor.prototype,
      "auditChapter",
    ).mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: normalizedDraft,
        wordCount: normalizedDraft.length,
      }),
    );

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(reviseChapter.mock.calls[0]?.[3]).toEqual(expect.arrayContaining([
        expect.objectContaining({ category: "length-budget" }),
      ]));
      expect(auditChapter.mock.calls[1]?.[1]).toBe(normalizedDraft);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records a length warning when repair still misses the hard range", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const overlongDraft = "冗余句子。".repeat(60);
    const stillOverHard = "仍然过长。".repeat(70);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        content: overlongDraft,
        wordCount: overlongDraft.length,
      }),
    );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: stillOverHard,
        wordCount: stillOverHard.length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: stillOverHard,
        wordCount: stillOverHard.length,
      }),
    );

    try {
      const result = await runner.writeNextChapter(bookId, 220);
      const chapterIndex = await state.loadChapterIndex(bookId);
      const chapterMeta = chapterIndex.find((entry) => entry.number === 1);

      expect((result as { lengthWarnings?: ReadonlyArray<string> }).lengthWarnings?.[0]).toContain(
        "未达到篇幅预算",
      );
      expect((result as { lengthTelemetry?: { finalCount: number } }).lengthTelemetry?.finalCount).toBe(
        overlongDraft.length,
      );
      expect(chapterMeta?.lengthWarnings?.[0]).toContain("未达到篇幅预算");
      expect(chapterMeta?.lengthTelemetry?.lengthWarning).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the last actionable audit issues when re-audit returns failed with no issues", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const storyDir = join(state.bookDir(bookId), "story");
    const draftBody = "甲".repeat(210);
    const revisedBody = "乙".repeat(215);

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: draftBody,
        wordCount: draftBody.length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [CRITICAL_ISSUE],
          summary: "needs revision",
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [],
          summary: "",
        }),
      );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: revisedBody.length,
        fixedIssues: ["- tightened continuity."],
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: revisedBody,
        wordCount: revisedBody.length,
      }),
    );

    try {
      const result = await runner.writeNextChapter(bookId, 220);
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(result.status).toBe("audit-failed");
      expect(result.auditResult.summary).toBe("needs revision");
      expect(result.auditResult.issues).toEqual([CRITICAL_ISSUE]);
      expect(savedIndex[0]?.auditIssues).toEqual([
        `[critical] ${CRITICAL_ISSUE.description}`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("feeds postWriteErrors into the scoring loop as extra issues", async () => {
    const { root, runner, bookId } = await createRunnerFixture();

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Original draft body.",
        wordCount: "Original draft body.".length,
        postWriteErrors: [
          {
            severity: "error",
            rule: "post-write",
            description: "Needs a deterministic fix",
            suggestion: "Repair the line",
          },
        ],
      }),
    );
    // First audit: postWriteErrors make it fail even though LLM says passed
    // Second audit (after repair): clean
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 88,
        issues: [],
        summary: "LLM thinks clean but postWriteErrors will override",
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 92,
        issues: [],
        summary: "clean after fix",
      }));
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter")
      .mockResolvedValueOnce(createReviseOutput({
        revisedContent: "After auto fix.",
        wordCount: "After auto fix.".length,
      }));
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: "After auto fix.",
        wordCount: "After auto fix.".length,
      }),
    );

    await runner.writeNextChapter(bookId);

    // Reviser called via scoring loop (auto mode), not pre-audit spot-fix
    expect(reviseChapter).toHaveBeenCalled();
    expect(reviseChapter.mock.calls[0]?.[4]).toBe("auto");

    await rm(root, { recursive: true, force: true });
  });

  it("runs at most one automatic repair iteration during writeNextChapter", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const draftBody = "甲".repeat(220);
    const revisedBody = "乙".repeat(220);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: draftBody,
        wordCount: draftBody.length,
      }),
    );
    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 40,
        issues: [CRITICAL_ISSUE],
        summary: "needs repair",
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 50,
        issues: [CRITICAL_ISSUE],
        summary: "still weak",
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 60,
        issues: [CRITICAL_ISSUE],
        summary: "should not be reached",
      }));
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: revisedBody.length,
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: revisedBody,
        wordCount: revisedBody.length,
      }),
    );

    try {
      const result = await runner.writeNextChapter(bookId, 220);

      expect(result.status).toBe("audit-failed");
      expect(auditChapter).toHaveBeenCalledTimes(2);
      expect(reviseChapter).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not run the prose polisher automatically after a passing write", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const draftBody = "林".repeat(220);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: draftBody,
        wordCount: draftBody.length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
        overallScore: 90,
      }),
    );
    const polishChapter = vi.spyOn(PolisherAgent.prototype, "polishChapter");

    try {
      await runner.writeNextChapter(bookId, 220);

      expect(polishChapter).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists truth files derived from the final revised chapter", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Original draft body.",
        wordCount: "Original draft body.".length,
        updatedState: "original state",
        updatedLedger: "original ledger",
        updatedHooks: "original hooks",
        chapterSummary: "| 1 | Original summary |",
        updatedSubplots: "original subplots",
        updatedEmotionalArcs: "original emotions",
        updatedCharacterMatrix: "original matrix",
        postWriteErrors: [
          {
            severity: "error",
            rule: "post-write",
            description: "Needs a deterministic fix",
            suggestion: "Repair the line",
          },
        ],
      }),
    );
    // First audit: postWriteErrors force passed=false, score 40 triggers loop
    // Second audit: after repair, passes
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 40,
        issues: [],
        summary: "postWriteErrors will override passed",
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 95,
        issues: [],
        summary: "clean after fix",
      }));
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: "Final revised body.",
        wordCount: "Final revised body.".length,
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: "Final revised body.",
        wordCount: "Final revised body.".length,
        updatedState: "final analyzed state",
        updatedLedger: "final analyzed ledger",
        updatedHooks: "final analyzed hooks",
        chapterSummary: "| 1 | Final analyzed summary |",
        updatedSubplots: "final analyzed subplots",
        updatedEmotionalArcs: "final analyzed emotions",
        updatedCharacterMatrix: "final analyzed matrix",
      }),
    );

    await runner.writeNextChapter(bookId);

    const storyDir = join(state.bookDir(bookId), "story");
    await expect(readFile(join(storyDir, "current_state.md"), "utf-8"))
      .resolves.toContain("final analyzed state");
    await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8"))
      .resolves.toContain("final analyzed hooks");
    await expect(readFile(join(storyDir, "particle_ledger.md"), "utf-8"))
      .resolves.toContain("final analyzed ledger");
    await expect(readFile(join(storyDir, "chapter_summaries.md"), "utf-8"))
      .resolves.toContain("Final analyzed summary");
    await expect(readFile(join(storyDir, "subplot_board.md"), "utf-8"))
      .resolves.toContain("final analyzed subplots");
    await expect(readFile(join(storyDir, "emotional_arcs.md"), "utf-8"))
      .resolves.toContain("final analyzed emotions");
    await expect(readFile(join(storyDir, "character_matrix.md"), "utf-8"))
      .resolves.toContain("final analyzed matrix");

    await rm(root, { recursive: true, force: true });
  });

  it("persists structured runtime state and rendered projections from writer delta output", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Lin Yue follows the debt into the river-port ledger.",
        wordCount: countChapterLength("Lin Yue follows the debt into the river-port ledger.", "en_words"),
        postWriteErrors: [],
        postWriteWarnings: [],
        runtimeStateDelta: {
          chapter: 1,
          currentStatePatch: {
            currentGoal: "Follow the debt through the river-port ledger.",
            currentConflict: "Guild pressure keeps pulling against the debt trail.",
          },
          hookOps: {
            upsert: [
              {
                hookId: "mentor-debt",
                startChapter: 1,
                type: "relationship",
                status: "open",
                lastAdvancedChapter: 1,
                expectedPayoff: "Reveal why the mentor vanished.",
                notes: "The river-port ledger sharpens the debt line.",
              },
            ],
            mention: [],
            resolve: [],
            defer: [],
          },
          newHookCandidates: [],
          chapterSummary: {
            chapter: 1,
            title: "River Ledger",
            characters: "Lin Yue",
            events: "Lin Yue follows the debt into the river-port ledger.",
            stateChanges: "The debt line sharpens.",
            hookActivity: "mentor-debt advanced",
            mood: "tense",
            chapterType: "investigation",
          },
          subplotOps: [],
          emotionalArcOps: [],
          characterMatrixOps: [],
          notes: [],
        },
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    await runner.writeNextChapter(bookId);

    const storyDir = join(state.bookDir(bookId), "story");
    const currentState = await readFile(join(storyDir, "current_state.md"), "utf-8");
    const hooks = await readFile(join(storyDir, "pending_hooks.md"), "utf-8");
    const summaries = await readFile(join(storyDir, "chapter_summaries.md"), "utf-8");
    const manifest = JSON.parse(await readFile(join(storyDir, "state", "manifest.json"), "utf-8"));
    const stateCurrent = JSON.parse(await readFile(join(storyDir, "state", "current_state.json"), "utf-8"));
    const stateHooks = JSON.parse(await readFile(join(storyDir, "state", "hooks.json"), "utf-8"));
    const stateSummaries = JSON.parse(await readFile(join(storyDir, "state", "chapter_summaries.json"), "utf-8"));

    expect(currentState).toContain("Follow the debt through the river-port ledger.");
    expect(hooks).toContain("mentor-debt");
    expect(summaries).toContain("River Ledger");
    expect(manifest.lastAppliedChapter).toBe(1);
    expect(stateCurrent.chapter).toBe(1);
    expect(stateHooks.hooks[0]?.hookId).toBe("mentor-debt");
    expect(stateSummaries.rows[0]?.title).toBe("River Ledger");

    await rm(root, { recursive: true, force: true });
  });

  it("repairs chapter-number drift in writer delta before persisting runtime state", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const storyDir = join(state.bookDir(bookId), "story");
    await mkdir(join(storyDir, "state"), { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(storyDir, "state", "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "en",
        lastAppliedChapter: 0,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8"),
      writeFile(join(storyDir, "state", "current_state.json"), JSON.stringify({
        chapter: 0,
        facts: [],
      }, null, 2), "utf-8"),
      writeFile(join(storyDir, "state", "hooks.json"), JSON.stringify({
        hooks: [],
      }, null, 2), "utf-8"),
      writeFile(join(storyDir, "state", "chapter_summaries.json"), JSON.stringify({
        rows: [],
      }, null, 2), "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Broken chapter body.",
        wordCount: countChapterLength("Broken chapter body.", "en_words"),
        postWriteErrors: [],
        postWriteWarnings: [],
        runtimeStateDelta: {
          chapter: 0,
          hookOps: {
            upsert: [],
            resolve: [],
            defer: [],
          },
          notes: [],
        } as unknown as NonNullable<ReturnType<typeof createWriterOutput>["runtimeStateDelta"]>,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    const result = await runner.writeNextChapter(bookId, "Broken chapter body.".length);

    expect(result.status).toBe("ready-for-review");
    await expect(readFile(join(storyDir, "current_state.md"), "utf-8"))
      .resolves.toMatch(/\|\s*(Current Chapter|当前章节)\s*\|\s*1\s*\|/);
    await expect(readFile(join(storyDir, "state", "manifest.json"), "utf-8"))
      .resolves.toContain("\"lastAppliedChapter\": 1");

    await rm(root, { recursive: true, force: true });
  });

  it("rolls back persisted runtime state when writer delta contains natural-language numeric drift", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const storyDir = join(state.bookDir(bookId), "story");
    await mkdir(join(storyDir, "state"), { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(storyDir, "state", "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "en",
        lastAppliedChapter: 0,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8"),
      writeFile(join(storyDir, "state", "current_state.json"), JSON.stringify({
        chapter: 0,
        facts: [],
      }, null, 2), "utf-8"),
      writeFile(join(storyDir, "state", "hooks.json"), JSON.stringify({
        hooks: [],
      }, null, 2), "utf-8"),
      writeFile(join(storyDir, "state", "chapter_summaries.json"), JSON.stringify({
        rows: [],
      }, null, 2), "utf-8"),
    ]);

    const beforeState = await readFile(join(storyDir, "current_state.md"), "utf-8");
    const beforeManifest = await readFile(join(storyDir, "state", "manifest.json"), "utf-8");

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Broken chapter body.",
        wordCount: countChapterLength("Broken chapter body.", "en_words"),
        postWriteErrors: [],
        postWriteWarnings: [],
        runtimeStateDelta: {
          chapter: 1,
          hookOps: {
            upsert: [
              {
                hookId: "mentor-debt",
                startChapter: 1,
                type: "relationship",
                status: "open",
                lastAdvancedChapter: "chapter one",
                expectedPayoff: "Reveal the debt.",
                notes: "Bad numeric drift.",
              },
            ],
            resolve: [],
            defer: [],
          },
          notes: [],
        } as unknown as NonNullable<ReturnType<typeof createWriterOutput>["runtimeStateDelta"]>,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    await expect(runner.writeNextChapter(bookId)).rejects.toThrow();

    await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe(beforeState);
    await expect(readFile(join(storyDir, "state", "manifest.json"), "utf-8")).resolves.toBe(beforeManifest);

    await rm(root, { recursive: true, force: true });
  });

  it("degrades to state-degraded when state validation errors instead of aborting", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Healthy chapter body.",
        wordCount: "Healthy chapter body.".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockRejectedValue(
      new Error("LLM returned empty response"),
    );

    const result = await runner.writeNextChapter(bookId);
    expect(result.status).toBe("state-degraded");

    // Chapter should be saved (content is fine, only truth files are degraded)
    const index = await state.loadChapterIndex(bookId);
    expect(index).toHaveLength(1);
    expect(index[0]!.status).toBe("state-degraded");

    await rm(root, { recursive: true, force: true });
  });

  it("retries settlement after state contradictions without rewriting the chapter body", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const storyDir = join(state.bookDir(bookId), "story");

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "stable state", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "stable hooks", "utf-8"),
      writeFile(join(storyDir, "particle_ledger.md"), "stable ledger", "utf-8"),
    ]);

    const writeSpy = vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Healthy chapter body with the copper token in his coat.",
        wordCount: "Healthy chapter body with the copper token in his coat.".length,
        updatedState: "broken state",
        updatedHooks: "broken hooks",
        updatedLedger: "broken ledger",
      }),
    );
    const settleSpy = vi.spyOn(
      WriterAgent.prototype as unknown as {
        settleChapterState: (input: Record<string, unknown>) => Promise<WriteChapterOutput>;
      },
      "settleChapterState",
    ).mockResolvedValue(
      createWriterOutput({
        content: "Healthy chapter body with the copper token in his coat.",
        wordCount: "Healthy chapter body with the copper token in his coat.".length,
        updatedState: "fixed state",
        updatedHooks: "fixed hooks",
        updatedLedger: "fixed ledger",
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    vi.spyOn(StateValidatorAgent.prototype, "validate")
      .mockResolvedValueOnce({
        passed: false,
        warnings: [{
          category: "unsupported_change",
          description: "状态写成铜牌未带在身上，但正文明确写了怀里的铜牌。",
        }],
      })
      .mockResolvedValueOnce({
        passed: true,
        warnings: [],
      });

    const result = await runner.writeNextChapter(
      bookId,
      countChapterLength("Healthy chapter body with the copper token in his coat.", "zh_chars"),
    );

    expect(result.status).toBe("ready-for-review");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(settleSpy).toHaveBeenCalledWith(expect.objectContaining({
      chapterNumber: 1,
      title: "Test Chapter",
      content: "Healthy chapter body with the copper token in his coat.",
      validationFeedback: expect.stringContaining("怀里的铜牌"),
    }));
    await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe("fixed state");
    await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8")).resolves.toBe("fixed hooks");

    await rm(root, { recursive: true, force: true });
  });

  it("persists a state-degraded chapter without advancing truth files when settlement retry still contradicts the body", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const chaptersDir = join(bookDir, "chapters");

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "stable state", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "stable hooks", "utf-8"),
      writeFile(join(storyDir, "particle_ledger.md"), "stable ledger", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Healthy chapter body with the copper token in his coat.",
        wordCount: "Healthy chapter body with the copper token in his coat.".length,
        updatedState: "broken state",
        updatedHooks: "broken hooks",
        updatedLedger: "broken ledger",
      }),
    );
    vi.spyOn(
      WriterAgent.prototype as unknown as {
        settleChapterState: (input: Record<string, unknown>) => Promise<WriteChapterOutput>;
      },
      "settleChapterState",
    ).mockResolvedValue(
      createWriterOutput({
        content: "Healthy chapter body with the copper token in his coat.",
        wordCount: "Healthy chapter body with the copper token in his coat.".length,
        updatedState: "still broken state",
        updatedHooks: "still broken hooks",
        updatedLedger: "still broken ledger",
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    vi.spyOn(StateValidatorAgent.prototype, "validate")
      .mockResolvedValueOnce({
        passed: false,
        warnings: [{
          category: "unsupported_change",
          description: "settler 把铜牌写没了，但正文仍然明确带在身上。",
        }],
      })
      .mockResolvedValueOnce({
        passed: false,
        warnings: [{
          category: "unsupported_change",
          description: "重试后仍然把铜牌写没了。",
        }],
      });

    const result = await runner.writeNextChapter(bookId);
    const savedIndex = await state.loadChapterIndex(bookId);

    expect(result.status).toBe("state-degraded");
    expect(savedIndex[0]?.status).toBe("state-degraded");
    expect(savedIndex[0]?.auditIssues).toContain("[warning] 重试后仍然把铜牌写没了。");
    await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe("stable state");
    await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8")).resolves.toBe("stable hooks");
    await expect(readFile(join(storyDir, "particle_ledger.md"), "utf-8")).resolves.toBe("stable ledger");
    await expect(readdir(chaptersDir)).resolves.toContain("0001_Test_Chapter.md");
    await expect(stat(join(storyDir, "snapshots", "1"))).rejects.toThrow();

    await rm(root, { recursive: true, force: true });
  });

  it("blocks writing a new chapter when the latest persisted chapter is state-degraded", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const now = "2026-03-19T00:00:00.000Z";
    const storyDir = join(state.bookDir(bookId), "story");

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "stable state", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "stable hooks", "utf-8"),
      state.saveChapterIndex(bookId, [{
        number: 1,
        title: "Broken Persistence",
        status: "state-degraded" as ChapterMeta["status"],
        wordCount: 1234,
        createdAt: now,
        updatedAt: now,
        auditIssues: ["[warning] state validation degraded"],
        lengthWarnings: [],
      }]),
      writeFile(join(state.bookDir(bookId), "chapters", "0001_Broken_Persistence.md"), "# 第1章 Broken Persistence\n\nbody", "utf-8"),
    ]);

    await expect(runner.writeNextChapter(bookId)).rejects.toThrow(/state-degraded/i);

    await rm(root, { recursive: true, force: true });
  });

  it.each([true, false])("keeps legacy state degradation after an audit (passed=%s)", async (passed) => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const now = new Date().toISOString();
      await state.saveChapterIndex(bookId, [{
        number: 1, title: "Broken", status: "audit-failed", wordCount: 10,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [],
        reviewNote: JSON.stringify({ kind: "state-degraded", baseStatus: "audit-failed", injectedIssues: [] }),
      }]);
      await writeFile(join(state.bookDir(bookId), "chapters", "0001_Broken.md"), "Body", "utf-8");
      vi.spyOn(runner as any, "evaluateMergedAudit").mockResolvedValue({ auditResult: createAuditResult({ passed }) });
      await runner.auditDraft(bookId, 1);
      const [chapter] = await state.loadChapterIndex(bookId);
      expect(chapter?.status).toBe("state-degraded");
      expect(JSON.parse(chapter!.reviewNote!).baseStatus).toBe(passed ? "ready-for-review" : "audit-failed");
      await expect(runner.writeNextChapter(bookId)).rejects.toThrow(/state-degraded/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])("ordered recovery reconciles a partial index and preserves retained prose, settlement failure=%s", async fail => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const bookDir = state.bookDir(bookId);
      const now = new Date().toISOString();
      await state.saveChapterIndex(bookId, [{ number: 1, title: "First", status: "ready-for-review", wordCount: 2,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] }]);
      await writeFile(join(bookDir, "chapters", "0001_First.md"), "First body", "utf8");
      await state.snapshotState(bookId, 1);
      const path = join(bookDir, "chapters", "2-retained.md");
      const prose = "# Retained\r\n\r\nExact retained body.\r\n";
      await writeFile(path, prose, "utf8");
      const settle = vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(async input => {
        if (fail) throw new Error("injected settlement failure");
        return createWriterOutput({ chapterNumber: input.chapterNumber, title: input.title, content: input.content,
          updatedState: "settled second chapter", updatedHooks: "settled hooks" });
      });
      const result = await runner.recoverChapters(bookId, 2);
      expect(result.plan.steps.map(step => step.chapter)).toEqual([2]);
      expect(result.addedChapters).toEqual([2]);
      expect(result.status).toBe(fail ? "failed" : "applied");
      expect(await readFile(path, "utf8")).toBe(prose);
      const rows = await state.loadChapterIndex(bookId);
      expect(rows[1]?.stateIntegrity?.status).toBe(fail ? "stale" : "valid");
      if (!fail) {
        expect(await readFile(join(bookDir, "story", "snapshots", "2", "current_state.md"), "utf8")).toBe("settled second chapter");
        expect((await runner.recoverChapters(bookId, 2)).status).toBe("unchanged");
        expect(settle).toHaveBeenCalledTimes(1);
      } else {
        settle.mockImplementation(async input => createWriterOutput({ chapterNumber: input.chapterNumber,
          title: input.title, content: input.content, updatedState: "retry second chapter", updatedHooks: "settled hooks" }));
        const retry = await runner.recoverChapters(bookId, 2);
        expect(retry.status).toBe("applied");
        expect(retry.addedChapters).toEqual([]);
        expect(retry.completed).toEqual([2]);
        expect(await readFile(path, "utf8")).toBe(prose);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("blocks continuation when an older chapter only has a legacy degraded review note", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const now = new Date().toISOString();
      await state.saveChapterIndex(bookId, [1, 2].map((number) => ({
        number, title: "Chapter", status: "ready-for-review", wordCount: 10,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [],
        reviewNote: number === 1 ? JSON.stringify({ kind: "state-degraded", baseStatus: "audit-failed", injectedIssues: [] }) : undefined,
      })));
      await expect(runner.writeNextChapter(bookId)).rejects.toThrow(/chapter 1.*state-degraded/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["repair", "sync"])("%s rebuilds a middle chapter and invalidates later state without deleting bodies", async (operation) => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const now = new Date().toISOString();
      const bookDir = state.bookDir(bookId);
      const storyDir = join(bookDir, "story");
      await writeFile(join(storyDir, "current_state.md"), "baseline state", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "baseline hooks", "utf-8");
      await state.snapshotState(bookId, 0);
      await state.snapshotState(bookId, 2);
      await state.saveChapterIndex(bookId, [1, 2].map((number) => ({
        number, title: `Chapter ${number}`, status: number === 1 ? "audit-failed" : "ready-for-review", wordCount: 10,
        createdAt: now, updatedAt: now, auditIssues: number === 1 ? ["[critical] unresolved body contradiction"] : [], lengthWarnings: [],
        reviewNote: number === 1 ? JSON.stringify({ kind: "state-degraded", baseStatus: "ready-for-review", injectedIssues: [] }) : undefined,
      })));
      for (const number of [1, 2]) {
        await writeFile(join(bookDir, "chapters", `000${number}_Chapter.md`), `Body ${number}`, "utf-8");
      }
      vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(async (input) => createWriterOutput({
        chapterNumber: input.chapterNumber, title: input.title, content: input.content,
        updatedState: `fixed state ${input.chapterNumber}`, updatedHooks: "fixed hooks",
      }));
      vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ passed: true, warnings: [] });

      if (operation === "repair") await runner.repairChapterState(bookId, 1);
      else await runner.resyncChapterArtifacts(bookId, 1);

      const index = await state.loadChapterIndex(bookId);
      expect(index[0]?.status).toBe("audit-failed");
      expect(index[0]?.auditIssues).toEqual(["[critical] unresolved body contradiction"]);
      expect(index[0]?.reviewNote).toBeUndefined();
      expect(index[1]?.status).toBe("state-degraded");
      await expect(readFile(join(bookDir, "chapters", "0002_Chapter.md"), "utf-8")).resolves.toBe("Body 2");
      await expect(stat(join(storyDir, "snapshots", "2"))).rejects.toThrow();
      await expect(readFile(join(storyDir, "snapshots", "1", "current_state.md"), "utf-8")).resolves.toBe("fixed state 1");
      expect(JSON.parse(await readFile(join(storyDir, "snapshots", "1", "state", "manifest.json"), "utf-8")).lastAppliedChapter).toBe(1);
      await expect(runner.writeNextChapter(bookId)).rejects.toThrow(/state-degraded/i);

      await runner.repairChapterState(bookId, 2);
      await expect(readFile(join(storyDir, "snapshots", "2", "current_state.md"), "utf-8")).resolves.toBe("fixed state 2");
      expect((await state.loadChapterIndex(bookId))[1]?.reviewNote).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])("middle sync preserves explicit guidance and baseline through retry=%s", async (retry) => {
    const guidance = "Keep the token in the coat";
    const { root, runner, state, bookId } = await createRunnerFixture({ externalContext: guidance });
    try {
      const bookDir = state.bookDir(bookId);
      const storyDir = join(bookDir, "story");
      const now = new Date().toISOString();
      await writeFile(join(storyDir, "current_state.md"), "baseline zero", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "baseline hooks", "utf-8");
      await state.snapshotState(bookId, 0);
      await writeFile(join(storyDir, "current_state.md"), "FUTURE_ONLY_MARKER", "utf-8");
      await state.saveChapterIndex(bookId, [1, 2].map(number => ({
        number, title: `Chapter ${number}`, status: "ready-for-review", wordCount: 10,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [],
      })));
      for (const number of [1, 2]) await writeFile(join(bookDir, "chapters", `000${number}_Chapter.md`), `Body ${number}`, "utf-8");
      const settle = vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(async input => createWriterOutput({
        chapterNumber: input.chapterNumber, title: input.title, content: input.content,
      }));
      const validate = vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ passed: true, warnings: [] });
      if (retry) validate.mockResolvedValueOnce({ passed: false, warnings: [] });
      await runner.resyncChapterArtifacts(bookId, 1);
      expect(settle).toHaveBeenCalledTimes(retry ? 2 : 1);
      for (const [input] of settle.mock.calls) {
        expect(input).toMatchObject({ settlementGuidance: guidance, baselineChapter: 0 });
        expect(input.contextPackage).toBeUndefined();
      }
      for (const call of validate.mock.calls) expect(call[2]).toBe("baseline zero");
      await expect(readFile(join(bookDir, "chapters", "0002_Chapter.md"), "utf-8")).resolves.toBe("Body 2");
      expect((await state.loadChapterIndex(bookId))[1]?.status).toBe("state-degraded");
      await expect(readFile(join(bookDir, "chapters", "0001_Chapter.md"), "utf8")).resolves.toBe("Body 1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["repair", "sync"])("%s retains legacy audit failure after an interrupted save and retry", async operation => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const bookDir = state.bookDir(bookId);
      const storyDir = join(bookDir, "story");
      const now = new Date().toISOString();
      await writeFile(join(storyDir, "current_state.md"), "baseline zero", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "baseline hooks", "utf-8");
      await state.snapshotState(bookId, 0);
      await writeFile(join(bookDir, "chapters", "0001_Chapter.md"), "Body 1", "utf-8");
      await state.saveChapterIndex(bookId, [{
        number: 1, title: "Chapter", status: "audit-failed", wordCount: 10,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [],
        reviewNote: JSON.stringify({ kind: "state-degraded", baseStatus: "ready-for-review", injectedIssues: [] }),
      }]);
      vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(async input => createWriterOutput({
        chapterNumber: input.chapterNumber, title: input.title, content: input.content,
      }));
      vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ passed: true, warnings: [] });
      const save = vi.spyOn(WriterAgent.prototype, "saveChapter").mockRejectedValueOnce(new Error("simulated persistence failure"));
      const run = () => operation === "repair" ? runner.repairChapterState(bookId, 1) : runner.resyncChapterArtifacts(bookId, 1);
      await expect(run()).rejects.toThrow("simulated persistence failure");
      const [pending] = await state.loadChapterIndex(bookId);
      // Transaction rollback restores the exact legacy metadata; explicit audit
      // failure still takes precedence when the operation is retried.
      expect(pending!.status).toBe("audit-failed");
      expect(JSON.parse(pending!.reviewNote!).baseStatus).toBe("ready-for-review");
      save.mockRestore();
      const result = await run();
      expect(result.status).toBe("audit-failed");
      expect(result.auditResult.passed).toBe(false);
      expect((await state.loadChapterIndex(bookId))[0]?.reviewNote).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays real runtime deltas through retained chapters without advancing the baseline early", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const now = new Date().toISOString();
      const bookDir = state.bookDir(bookId);
      const storyDir = join(bookDir, "story");
      await writeFile(join(storyDir, "current_state.md"), "Initial state", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "No hooks", "utf-8");
      await state.snapshotState(bookId, 0);
      await state.saveChapterIndex(bookId, [1, 2, 3].map((number) => ({
        number, title: `Chapter ${number}`, status: "state-degraded", wordCount: 10,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [],
      })));
      for (const number of [1, 2, 3]) await writeFile(join(bookDir, "chapters", `000${number}_Chapter.md`), `Body ${number}`, "utf-8");
      const { buildRuntimeStateArtifactsFromSnapshot, loadRuntimeStateSnapshotAtChapter } = await import("../state/runtime-state-store.js");
      vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(async (input) => {
        const output = createSettledRevisionOutput(input);
        const snapshot = await loadRuntimeStateSnapshotAtChapter({ bookDir, chapterNumber: input.baselineChapter!, language: "en" });
        const artifacts = buildRuntimeStateArtifactsFromSnapshot({
          snapshot, delta: output.runtimeStateDelta!, language: "en", allowReapply: true,
        });
        return { ...output, runtimeStateSnapshot: artifacts.snapshot };
      });
      vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ passed: true, warnings: [] });
      await expect(runner.repairChapterState(bookId, 2)).rejects.toThrow(/chapter 1.*state-degraded/i);
      for (const number of [1, 2, 3]) {
        await runner.repairChapterState(bookId, number);
        const manifest = JSON.parse(await readFile(join(storyDir, "snapshots", String(number), "state", "manifest.json"), "utf-8"));
        expect(manifest.lastAppliedChapter).toBe(number);
        expect(await state.getNextChapterNumber(bookId)).toBe(4);
        const liveManifest = JSON.parse(await readFile(join(storyDir, "state", "manifest.json"), "utf-8"));
        expect(liveManifest.lastAppliedChapter).toBe(number);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["repair", "sync"])("%s leaves state unchanged when validation still requires repair", async (operation) => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const now = new Date().toISOString();
      const bookDir = state.bookDir(bookId);
      const storyDir = join(bookDir, "story");
      await writeFile(join(storyDir, "current_state.md"), "original state", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "original hooks", "utf-8");
      await state.snapshotState(bookId, 0);
      await state.saveChapterIndex(bookId, [{
        number: 1, title: "Broken", status: "state-degraded", wordCount: 10,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [],
      }]);
      await writeFile(join(bookDir, "chapters", "0001_Broken.md"), "Original body", "utf-8");
      vi.spyOn(WriterAgent.prototype, "settleChapterState").mockResolvedValue(createWriterOutput());
      vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ passed: true, repairRequired: true, warnings: [] });
      const result = operation === "repair" ? runner.repairChapterState(bookId, 1) : runner.resyncChapterArtifacts(bookId, 1);
      await expect(result).rejects.toThrow();
      await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe("original state");
      await expect(readFile(join(bookDir, "chapters", "0001_Broken.md"), "utf-8")).resolves.toBe("Original body");
      expect((await state.loadChapterIndex(bookId))[0]?.status).toBe("state-degraded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains rejected settlements and revalidates the same candidate without regenerating prose", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const bookDir = state.bookDir(bookId);
      const now = new Date().toISOString();
      await state.snapshotState(bookId, 0);
      await state.saveChapterIndex(bookId, [{ number: 1, title: "Broken", status: "state-degraded", wordCount: 13,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] }]);
      const bodyPath = join(bookDir, "chapters", "0001_Broken.md");
      await writeFile(bodyPath, "Original body", "utf8");
      const settle = vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(async input => createSettledRevisionOutput(input));
      const validate = vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ passed: false, repairRequired: true,
        warnings: [{ category: "missing", description: "first issue" }, { category: "missing", description: "second issue" }] });
      const failure = await runner.recoverChapters(bookId, 1) as any;
      expect(failure).toMatchObject({ status: "failed", stage: "validation", reasonCode: "SETTLEMENT_NO_PROGRESS", failedChapter: 1 });
      expect(failure.issues).toHaveLength(2);
      expect(failure.attemptId).toEqual(expect.any(String));
      expect(settle).toHaveBeenCalledTimes(2);
      expect(settle.mock.calls[1][0].previousSettlement).toMatchObject({ content: "Original body" });
      expect(await runner.resumeSettlementAttempt(bookId, failure.attemptId, "revalidate")).toMatchObject({
        status: "failed", reasonCode: "SETTLEMENT_REPAIR_REQUIRED", failedChapter: 1,
      });
      validate.mockResolvedValue({ passed: true, warnings: [] });
      const resumed = await (runner as any).resumeSettlementAttempt(bookId, failure.attemptId, "revalidate");
      expect(resumed.status).toBe("applied");
      expect(settle).toHaveBeenCalledTimes(2);
      expect(await readFile(bodyPath, "utf8")).toBe("Original body");
      expect((await (runner as any).resumeSettlementAttempt(bookId, failure.attemptId, "revalidate")).status).toBe("unchanged");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("revalidates an old rejected candidate before repair and publishes PASS without calling the writer", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const bookDir = state.bookDir(bookId);
      const now = new Date().toISOString();
      const body = "# Chapter 1: Broken\n\nOriginal body";
      await state.saveChapterIndex(bookId, [{ number: 1, title: "Broken", status: "state-degraded", wordCount: 2,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] }]);
      const bodyPath = join(bookDir, "chapters", "0001_Broken.md");
      await writeFile(bodyPath, body, "utf8");
      const candidateContent = "Original body";
      const candidate = createWriterOutput({ chapterNumber: 1, title: "Broken", content: candidateContent, wordCount: candidateContent.length });
      const inputs = await captureCandidateInputs(bookDir, 1);
      const prior = await createSettlementAttempt(bookDir, {
        chapter: 1,
        inputs,
        output: candidate,
        context: { baselineChapter: 0 },
      });
      await appendSettlementEvent(bookDir, prior.attemptId, {
        type: "rejected",
        data: { reasonCode: "VALIDATOR_PROTOCOL_INVALID", error: "State validator returned invalid response" },
      });

      const settle = vi.mocked(WriterAgent.prototype.settleChapterState);
      const validate = vi.mocked(StateValidatorAgent.prototype.validate).mockResolvedValue({ passed: true, warnings: [] });
      const result = await runner.resumeSettlementAttempt(bookId, prior.attemptId, "repair");

      expect(result).toMatchObject({ status: "applied", chapterNumber: 1 });
      expect(validate).toHaveBeenCalledTimes(1);
      expect(settle).not.toHaveBeenCalled();
      expect(await readFile(bodyPath, "utf8")).toBe(body);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes complete verified REPAIR feedback to one writer call after revalidation", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const bookDir = state.bookDir(bookId);
      const now = new Date().toISOString();
      const body = "# Chapter 1: Broken\n\nOriginal body";
      await state.saveChapterIndex(bookId, [{ number: 1, title: "Broken", status: "state-degraded", wordCount: 2,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] }]);
      const bodyPath = join(bookDir, "chapters", "0001_Broken.md");
      await writeFile(bodyPath, body, "utf8");
      const candidateContent = "Original body";
      const candidate = createWriterOutput({ chapterNumber: 1, title: "Broken", content: candidateContent, wordCount: candidateContent.length });
      const prior = await createSettlementAttempt(bookDir, {
        chapter: 1, inputs: await captureCandidateInputs(bookDir, 1, "saved guidance"), output: candidate, context: {
          baselineChapter: 0,
          settlementGuidance: "saved guidance",
          allowNewHooks: false,
          chapterIntent: "saved chapter intent",
          contextPackage: { chapter: 1, selectedContext: [{ source: "saved source", reason: "saved reason" }] },
          ruleStack: { layers: [{ id: "saved-layer", name: "Saved layer", precedence: 1, scope: "book" }],
            sections: { hard: ["saved hard rule"], soft: [], diagnostic: [] }, overrideEdges: [], activeOverrides: [] },
        },
      });
      await appendSettlementEvent(bookDir, prior.attemptId, {
        type: "rejected", data: { reasonCode: "VALIDATOR_PROTOCOL_INVALID", error: "old diagnostic only" },
      });

      const feedback: ValidationResult = {
        passed: false,
        repairRequired: true,
        warnings: [{ category: "missing_state_update", description: "Add the explicit state change." }],
        issues: [{
          category: "missing_state_update", description: "Add the explicit state change.", blocking: true,
          kind: "omission", basis: "explicit", rationale: "The chapter states the change.", target: "candidate-state",
          evidence: [{ source: "chapter", quote: "Original body" }],
        }],
      };
      const settle = vi.mocked(WriterAgent.prototype.settleChapterState).mockImplementation(async input =>
        createWriterOutput({ chapterNumber: input.chapterNumber, title: input.title, content: input.content }),
      );
      const validate = vi.mocked(StateValidatorAgent.prototype.validate)
        .mockResolvedValueOnce(feedback)
        .mockResolvedValueOnce({ passed: true, warnings: [] });
      const result = await runner.resumeSettlementAttempt(bookId, prior.attemptId, "repair");

      expect(result).toMatchObject({ status: "applied", chapterNumber: 1 });
      expect(validate).toHaveBeenCalledTimes(2);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(settle.mock.calls[0]?.[0]).toMatchObject({
        content: "Original body",
        settlementGuidance: "saved guidance",
        allowNewHooks: false,
        chapterIntent: "saved chapter intent",
        contextPackage: { chapter: 1, selectedContext: [{ source: "saved source", reason: "saved reason" }] },
        ruleStack: { layers: [{ id: "saved-layer" }] },
        validationFeedback: expect.stringContaining("Add the explicit state change."),
      });
      expect(settle.mock.calls[0]?.[0].validationFeedback).toContain("chapter: Original body");
      expect(await readFile(bodyPath, "utf8")).toBe(body);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revalidates a cached PASS that contains a blocking issue instead of trusting the cache", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const bookDir = state.bookDir(bookId);
      const now = new Date().toISOString();
      const body = "# Chapter 1: Broken\n\nOriginal body";
      await state.saveChapterIndex(bookId, [{ number: 1, title: "Broken", status: "state-degraded", wordCount: 2,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] }]);
      await writeFile(join(bookDir, "chapters", "0001_Broken.md"), body, "utf8");
      const candidateContent = "Original body";
      const candidate = createWriterOutput({ chapterNumber: 1, title: "Broken", content: candidateContent, wordCount: candidateContent.length });
      const prior = await createSettlementAttempt(bookDir, {
        chapter: 1, inputs: await captureCandidateInputs(bookDir, 1), output: candidate, context: { baselineChapter: 0 },
      });
      await appendSettlementEvent(bookDir, prior.attemptId, {
        type: "validated",
        data: { passed: true, warnings: [], issues: [{ category: "conflict", description: "blocking cached issue", blocking: true,
          kind: "conflict", basis: "explicit", rationale: "cached data must be checked", evidence: [] }] },
      });
      const validate = vi.mocked(StateValidatorAgent.prototype.validate).mockResolvedValue({ passed: true, warnings: [] });
      const settle = vi.mocked(WriterAgent.prototype.settleChapterState);

      const result = await runner.resumeSettlementAttempt(bookId, prior.attemptId, "revalidate");
      expect(result).toMatchObject({ status: "applied", chapterNumber: 1 });
      expect(validate).toHaveBeenCalledTimes(1);
      expect(settle).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops an old rejected candidate on verified FAIL without calling the writer", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const bookDir = state.bookDir(bookId);
      const now = new Date().toISOString();
      const body = "# Chapter 1: Broken\n\nOriginal body";
      await state.saveChapterIndex(bookId, [{ number: 1, title: "Broken", status: "state-degraded", wordCount: 2,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] }]);
      const bodyPath = join(bookDir, "chapters", "0001_Broken.md");
      await writeFile(bodyPath, body, "utf8");
      const candidateContent = "Original body";
      const candidate = createWriterOutput({ chapterNumber: 1, title: "Broken", content: candidateContent, wordCount: candidateContent.length });
      const prior = await createSettlementAttempt(bookDir, {
        chapter: 1, inputs: await captureCandidateInputs(bookDir, 1), output: candidate, context: { baselineChapter: 0 },
      });
      await appendSettlementEvent(bookDir, prior.attemptId, { type: "rejected", data: { reasonCode: "OLD_FAIL", error: "old diagnostic" } });
      const settle = vi.mocked(WriterAgent.prototype.settleChapterState);
      const validate = vi.mocked(StateValidatorAgent.prototype.validate).mockResolvedValue({
        passed: false, repairRequired: false, warnings: [{ category: "conflict", description: "Hard contradiction." }],
        issues: [{ category: "conflict", description: "Hard contradiction.", blocking: true, kind: "conflict", basis: "explicit",
          rationale: "The candidate conflicts with the chapter.", evidence: [{ source: "candidate-state", quote: "candidate" }, { source: "chapter", quote: "Original body" }] }],
      });

      const result = await runner.resumeSettlementAttempt(bookId, prior.attemptId, "repair");
      expect(result).toMatchObject({ status: "failed", reasonCode: "SETTLEMENT_REJECTED", stage: "validation" });
      expect(validate).toHaveBeenCalledTimes(1);
      expect(settle).not.toHaveBeenCalled();
      expect(await readFile(bodyPath, "utf8")).toBe(body);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not call the writer when revalidation protocol fails for an old rejected candidate", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const bookDir = state.bookDir(bookId);
      const now = new Date().toISOString();
      const body = "# Chapter 1: Broken\n\nOriginal body";
      await state.saveChapterIndex(bookId, [{ number: 1, title: "Broken", status: "state-degraded", wordCount: 2,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] }]);
      const bodyPath = join(bookDir, "chapters", "0001_Broken.md");
      await writeFile(bodyPath, body, "utf8");
      const candidateContent = "Original body";
      const candidate = createWriterOutput({ chapterNumber: 1, title: "Broken", content: candidateContent, wordCount: candidateContent.length });
      const prior = await createSettlementAttempt(bookDir, {
        chapter: 1, inputs: await captureCandidateInputs(bookDir, 1), output: candidate, context: { baselineChapter: 0 },
      });
      await appendSettlementEvent(bookDir, prior.attemptId, { type: "rejected", data: { reasonCode: "OLD_PROTOCOL", error: "old diagnostic" } });
      const settle = vi.mocked(WriterAgent.prototype.settleChapterState);
      const validate = vi.mocked(StateValidatorAgent.prototype.validate).mockRejectedValue(
        Object.assign(new Error("State validator returned invalid response"), { reasonCode: "VALIDATOR_PROTOCOL_INVALID" }),
      );

      const result = await runner.resumeSettlementAttempt(bookId, prior.attemptId, "repair");
      expect(result).toMatchObject({ status: "failed", reasonCode: "VALIDATOR_PROTOCOL_INVALID", stage: "validation" });
      expect(validate).toHaveBeenCalledTimes(1);
      expect(settle).not.toHaveBeenCalled();
      expect(result.error).toBe("State validator returned invalid response");
      expect(await readFile(bodyPath, "utf8")).toBe(body);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects changed inputs before validating or repairing an old candidate", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const bookDir = state.bookDir(bookId);
      const now = new Date().toISOString();
      const body = "# Chapter 1: Broken\n\nOriginal body";
      await state.saveChapterIndex(bookId, [{ number: 1, title: "Broken", status: "state-degraded", wordCount: 2,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] }]);
      const bodyPath = join(bookDir, "chapters", "0001_Broken.md");
      await writeFile(bodyPath, body, "utf8");
      const candidateContent = "Original body";
      const candidate = createWriterOutput({ chapterNumber: 1, title: "Broken", content: candidateContent, wordCount: candidateContent.length });
      const prior = await createSettlementAttempt(bookDir, {
        chapter: 1, inputs: await captureCandidateInputs(bookDir, 1), output: candidate, context: { baselineChapter: 0 },
      });
      await appendSettlementEvent(bookDir, prior.attemptId, { type: "rejected", data: { reasonCode: "OLD_REJECTED", error: "old diagnostic" } });
      await writeFile(bodyPath, "# Chapter 1: Broken\n\nChanged body", "utf8");
      const settle = vi.mocked(WriterAgent.prototype.settleChapterState);
      const validate = vi.mocked(StateValidatorAgent.prototype.validate);

      const result = await runner.resumeSettlementAttempt(bookId, prior.attemptId, "repair");
      expect(result).toMatchObject({ status: "failed", reasonCode: "SETTLEMENT_INPUTS_CHANGED", stage: "preflight" });
      expect(validate).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports the new resume candidate when its final rejection log fails and releases the lock", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    try {
      const bookDir = state.bookDir(bookId);
      const now = new Date().toISOString();
      await state.saveChapterIndex(bookId, [{ number: 1, title: "First", status: "state-degraded", wordCount: 4,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] }]);
      const bodyPath = join(bookDir, "chapters", "0001_First.md");
      await writeFile(bodyPath, "Original body", "utf8");
      vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(async input => createSettledRevisionOutput(input));
      vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ passed: false, repairRequired: true,
        warnings: [{ category: "missing", description: "Missing state fact" }],
        issues: [{ category: "missing", description: "Missing state fact", blocking: true, kind: "omission", basis: "explicit",
          rationale: "The chapter contains the missing fact.", target: "candidate-state",
          evidence: [{ source: "chapter", quote: "Original body" }] }],
      });
      const parent = await runner.recoverChapters(bookId, 1);
      expect(parent.attemptId).toEqual(expect.any(String));
      const beforeState = await readFile(join(bookDir, "story/current_state.md"));
      vi.mocked(fsPromises.link).mockImplementation(async (...args) => {
        if (String(args[1]).replaceAll("\\", "/").includes("/events/000000000003-")) {
          throw Object.assign(new Error("final rejection disk failure"), { code: "ENOSPC" });
        }
        return actual.link(...args);
      });
      const result = await runner.resumeSettlementAttempt(bookId, parent.attemptId!, "repair");
      expect(result).toMatchObject({ status: "failed", reasonCode: "SETTLEMENT_EVIDENCE_WRITE_FAILED", stage: "evidence", failedChapter: 1 });
      expect(result.attemptId).toEqual(expect.any(String));
      expect(result.attemptId).not.toBe(parent.attemptId);
      expect((await runner.inspectSettlementAttempt(bookId, result.attemptId!)).attempt).toMatchObject({ parentAttemptId: parent.attemptId, status: "rejected" });
      expect(await readFile(bodyPath, "utf8")).toBe("Original body");
      expect(await readFile(join(bookDir, "story/current_state.md"))).toEqual(beforeState);
      const release = await state.acquireBookLock(bookId); await release();
    } finally { vi.mocked(fsPromises.link).mockImplementation(actual.link); await rm(root, { recursive: true, force: true }); }
  });

  it("resumes a validated settlement after cancellation without repeating the model phases", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const bookDir = state.bookDir(bookId);
      await state.snapshotState(bookId, 0);
      const now = new Date().toISOString();
      await state.saveChapterIndex(bookId, [{ number: 1, title: "First", status: "state-degraded", wordCount: 4,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] }]);
      const bodyPath = join(bookDir, "chapters", "0001_First.md");
      await writeFile(bodyPath, "Original body", "utf8");
      const beforeState = await readFile(join(bookDir, "story/current_state.md"));
      const controller = new AbortController();
      const settle = vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(async input => createSettledRevisionOutput(input));
      const validate = vi.spyOn(StateValidatorAgent.prototype, "validate").mockImplementation(async () => {
        controller.abort(new Error("Cancelled after validation"));
        return { passed: true, warnings: [] };
      });
      const result = await runner.runWithAbortSignal(controller.signal, () => runner.recoverChapters(bookId, 1)) as any;
      expect(result).toMatchObject({ status: "cancelled", reasonCode: "SETTLEMENT_CANCELLED", stage: "commit", attemptId: expect.any(String) });
      expect(await readFile(join(bookDir, "story/current_state.md"))).toEqual(beforeState);
      const release = await state.acquireBookLock(bookId); await release();
      expect((await runner.inspectSettlementAttempt(bookId, result.attemptId)).attempt.status).toBe("validated");
      expect(await runner.resumeSettlementAttempt(bookId, result.attemptId, "revalidate")).toMatchObject({ status: "applied" });
      expect(settle).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledTimes(1);
      expect(await readFile(bodyPath, "utf8")).toBe("Original body");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects stale settlement inputs changed during validation and keeps the new body", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const bookDir = state.bookDir(bookId);
      await state.snapshotState(bookId, 0);
      const now = new Date().toISOString();
      await state.saveChapterIndex(bookId, [{ number: 1, title: "First", status: "state-degraded", wordCount: 4,
        createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] }]);
      const bodyPath = join(bookDir, "chapters", "0001_First.md");
      await writeFile(bodyPath, "Old body", "utf8");
      const beforeState = await readFile(join(bookDir, "story/current_state.md"));
      vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(async input => createSettledRevisionOutput(input));
      vi.spyOn(StateValidatorAgent.prototype, "validate").mockImplementation(async () => {
        await writeFile(bodyPath, "Externally edited body", "utf8");
        return { passed: true, warnings: [] };
      });
      expect(await runner.recoverChapters(bookId, 1)).toMatchObject({ status: "failed", reasonCode: "SETTLEMENT_INPUTS_CHANGED", attemptId: expect.any(String) });
      expect(await readFile(bodyPath, "utf8")).toBe("Externally edited body");
      expect(await readFile(join(bookDir, "story/current_state.md"))).toEqual(beforeState);
      const release = await state.acquireBookLock(bookId); await release();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps a completed recovery prefix and diagnoses the failing second chapter", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    try {
      const bookDir = state.bookDir(bookId);
      await state.snapshotState(bookId, 0);
      const now = new Date().toISOString();
      await state.saveChapterIndex(bookId, [1, 2].map(number => ({ number, title: "Part", status: "state-degraded" as const,
        wordCount: 4, createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] })));
      for (const n of [1, 2]) await writeFile(join(bookDir, "chapters", `000${n}_Part.md`), `Part ${n}`, "utf8");
      vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(async input => createSettledRevisionOutput(input));
      const validate = vi.spyOn(StateValidatorAgent.prototype, "validate").mockImplementation(async (_body, chapter) => ({
        passed: chapter === 1, warnings: chapter === 1 ? [] : [{ category: "conflict", description: "Second state rejected" }],
      }));
      expect(await runner.recoverChapters(bookId, 2)).toMatchObject({ status: "failed", failedChapter: 2, completed: [1], attemptId: expect.any(String) });
      expect((await runner.getRecoveryStatus(bookId)).health.stateFrontier).toBe(1);
      validate.mockResolvedValue({ passed: true, warnings: [] });
      expect(await runner.recoverChapters(bookId, 2)).toMatchObject({ status: "applied", completed: [2] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("repairs the latest state-degraded chapter from persisted body without rewriting it", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const now = "2026-03-19T00:00:00.000Z";
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const baselineDir = join(storyDir, "snapshots", "0");
    await mkdir(baselineDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "stable state", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "stable hooks", "utf-8"),
      writeFile(join(storyDir, "particle_ledger.md"), "stable ledger", "utf-8"),
      writeFile(
        join(bookDir, "chapters", "0001_Broken_Persistence.md"),
        "# 第1章 Broken Persistence\n\nHealthy chapter body with the copper token in his coat.",
        "utf-8",
      ),
      state.saveChapterIndex(bookId, [{
        number: 1,
        title: "Broken Persistence",
        status: "state-degraded" as ChapterMeta["status"],
        wordCount: 55,
        createdAt: now,
        updatedAt: now,
        auditIssues: ["[warning] 重试后仍然把铜牌写没了。"],
        lengthWarnings: [],
        reviewNote: JSON.stringify({
          kind: "state-degraded",
          baseStatus: "ready-for-review",
          injectedIssues: ["[warning] 重试后仍然把铜牌写没了。"],
        }),
      }]),
    ]);

    const settleSpy = vi.spyOn(
      WriterAgent.prototype as unknown as {
        settleChapterState: (input: Record<string, unknown>) => Promise<WriteChapterOutput>;
      },
      "settleChapterState",
    ).mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        title: "Broken Persistence",
        content: "Healthy chapter body with the copper token in his coat.",
        wordCount: "Healthy chapter body with the copper token in his coat.".length,
        updatedState: "fixed state",
        updatedHooks: "fixed hooks",
        updatedLedger: "fixed ledger",
      }),
    );
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({
      passed: true,
      warnings: [],
    });

    const result = await (
      runner as unknown as {
        repairChapterState: (bookId: string, chapterNumber?: number) => Promise<{
          status: string;
          chapterNumber: number;
        }>;
      }
    ).repairChapterState(bookId, 1);
    const savedIndex = await state.loadChapterIndex(bookId);

    expect(result.status).toBe("ready-for-review");
    expect(result.chapterNumber).toBe(1);
    expect(settleSpy).toHaveBeenCalledWith(expect.objectContaining({
      allowReapply: true,
      baselineChapter: 0,
    }));
    await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe("fixed state");
    await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8")).resolves.toBe("fixed hooks");
    expect(savedIndex[0]?.status).toBe("ready-for-review");
    expect(savedIndex[0]?.auditIssues).toEqual([]);
    expect(savedIndex[0]?.reviewNote).toBeUndefined();

    await rm(root, { recursive: true, force: true });
  });

  it("syncs the latest edited chapter body back into truth files without requiring state-degraded status", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
      externalContext: "把注意力收回师债主线。",
    });
    const now = "2026-03-19T00:00:00.000Z";
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const baselineDir = join(storyDir, "snapshots", "0");
    await mkdir(baselineDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_focus.md"), "# 当前聚焦\n\n## 当前重点\n\n商会路线优先。\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# 卷纲\n\n## 第1章\n先处理商会路线噪音。\n", "utf-8"),
      writeFile(join(storyDir, "story_bible.md"), "# 世界观设定\n\n- 誓令碎片不可伪造。\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "stable state", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "stable hooks", "utf-8"),
      writeFile(join(storyDir, "particle_ledger.md"), "stable ledger", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), [
        "# 章节摘要",
        "",
        "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| 1 | 夜灯 | 林越 | 林越继续追查师债 | 追查意图更强 | 师债推进 | 压抑 | 主线推进 |",
        "",
      ].join("\n"), "utf-8"),
      writeFile(
        join(bookDir, "chapters", "0001_夜灯.md"),
        "# 第1章 夜灯\n\n林越推门进去，先停在门槛外听了一息，再去看柜台后那盏没关的灯。",
        "utf-8",
      ),
      state.saveChapterIndex(bookId, [{
        number: 1,
        title: "夜灯",
        status: "approved" as ChapterMeta["status"],
        wordCount: 55,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      }]),
    ]);

    const settleSpy = vi.spyOn(
      WriterAgent.prototype as unknown as {
        settleChapterState: (input: Record<string, unknown>) => Promise<WriteChapterOutput>;
      },
      "settleChapterState",
    ).mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        title: "夜灯",
        content: "林越推门进去，先停在门槛外听了一息，再去看柜台后那盏没关的灯。",
        wordCount: "林越推门进去，先停在门槛外听了一息，再去看柜台后那盏没关的灯。".length,
        updatedState: "synced state",
        updatedHooks: "synced hooks",
        updatedLedger: "synced ledger",
      }),
    );
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({
      passed: true,
      warnings: [],
    });

    const result = await (
      runner as unknown as {
        resyncChapterArtifacts: (bookId: string, chapterNumber?: number) => Promise<{
          status: string;
          chapterNumber: number;
        }>;
      }
    ).resyncChapterArtifacts(bookId, 1);
    const savedIndex = await state.loadChapterIndex(bookId);

    expect(result.status).toBe("ready-for-review");
    expect(result.chapterNumber).toBe(1);
    expect(settleSpy).toHaveBeenCalledWith(expect.objectContaining({
      allowReapply: true,
      baselineChapter: 0,
      chapterIntent: expect.stringContaining("把注意力收回师债主线"),
    }));
    await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe("synced state");
    await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8")).resolves.toBe("synced hooks");
    expect(savedIndex[0]?.status).toBe("ready-for-review");

    await rm(root, { recursive: true, force: true });
  });

  it("still persists the chapter when the state validator appends markdown after a valid JSON verdict", async () => {
    vi.mocked(StateValidatorAgent.prototype.validate).mockRestore();
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockImplementation(
      async (_bookDir, chapterContent) =>
        createReviseOutput({
          revisedContent: chapterContent,
          wordCount: chapterContent.length,
        }),
    );

    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const finalBody = "Validated chapter body that should still persist.";

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: finalBody,
        wordCount: finalBody.length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: finalBody,
        wordCount: finalBody.length,
      }),
    );
    vi.spyOn(
      StateValidatorAgent.prototype as unknown as {
        chat: (...args: unknown[]) => Promise<{ content: string; usage: typeof ZERO_USAGE }>;
      },
      "chat",
    ).mockResolvedValue({
      content: [
        "{\"warnings\":[],\"passed\":true}",
        "",
        "## Notes",
        "Trailing markdown can include } braces and should not abort persistence.",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    const result = await runner.writeNextChapter(bookId);

    expect(result.chapterNumber).toBe(1);
    await expect(readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8"))
      .resolves.toContain(finalBody);
    await expect(state.loadChapterIndex(bookId)).resolves.toEqual([
      expect.objectContaining({
        number: 1,
        title: "Test Chapter",
      }),
    ]);

    await rm(root, { recursive: true, force: true });
  });

  it("preserves the revised chapter content when final truth rebuild omits CHAPTER_CONTENT", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const revisedBody = "Final revised body that should never be replaced by an empty chapter.";

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        content: "Original draft body.",
        wordCount: "Original draft body.".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [CRITICAL_ISSUE],
          summary: "needs revision",
          overallScore: 40,
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
          overallScore: 95,
        }),
      );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: revisedBody.length,
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        content: "",
        wordCount: 0,
      }),
    );

    const result = await runner.writeNextChapter(bookId, revisedBody.length);
    const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
    const savedIndex = await state.loadChapterIndex(bookId);
    const expectedCount = countChapterLength(revisedBody, "zh_chars");

    expect(result.wordCount).toBe(expectedCount);
    expect(savedChapter).toContain(revisedBody);
    expect(savedIndex[0]?.wordCount).toBe(expectedCount);
    expect(savedIndex[0]?.status).toBe("ready-for-review");

    await rm(root, { recursive: true, force: true });
  });

  it("reports only resumed chapters in import results", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const now = "2026-03-19T00:00:00.000Z";
    const existingIndex: ChapterMeta[] = [
      {
        number: 1,
        title: "One",
        status: "imported",
        wordCount: 10,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
      {
        number: 2,
        title: "Two",
        status: "imported",
        wordCount: 20,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
    ];
    await state.saveChapterIndex(bookId, existingIndex);

    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockImplementation(async (input) =>
      createAnalyzedOutput({
        chapterNumber: input.chapterNumber,
        title: input.chapterTitle ?? `Chapter ${input.chapterNumber}`,
        content: input.chapterContent,
        wordCount: input.chapterContent.length,
      }),
    );
    vi.spyOn(WriterAgent.prototype, "saveChapter");

    const result = await runner.importChapters({
      bookId,
      resumeFrom: 3,
      chapters: [
        { title: "One", content: "1111111111" },
        { title: "Two", content: "22222222222222222222" },
        { title: "Three", content: "333333333333333" },
        { title: "Four", content: "4444444444444444444444444" },
      ],
    });

    expect(result.importedCount).toBe(2);
    expect(result.totalWords).toBe("333333333333333".length + "4444444444444444444444444".length);
    expect(result.nextChapter).toBe(5);

    await rm(root, { recursive: true, force: true });
  });

  it("preserves imported chapter body when the analyzer only returns truth-file updates", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "前文",
      status: "imported",
      wordCount: 12,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);
    await writeFile(
      join(chaptersDir, "0002_旧标题.md"),
      "# 第2章 旧标题\n\n旧正文不应该在重导入后继续留在目录里。",
      "utf-8",
    );
    const importedBody = [
      "老丁守了三十年桥，第一次在河灯节后半夜离开值班室。",
      "",
      "江面涨水，灯火贴着桥墩漂过去，他在第三个桥洞口捞起一盏湿透的河灯。",
      "灯芯没有烧完，里面却夹着半张旧照片。",
    ].join("\n");

    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        chapterNumber: 2,
        title: "河灯还亮着",
        content: "",
        wordCount: 0,
        updatedState: "imported state",
        updatedLedger: "imported ledger",
        updatedHooks: "imported hooks",
      }),
    );

    const result = await runner.importChapters({
      bookId,
      resumeFrom: 2,
      chapters: [
        { title: "前文", content: "已导入的前文。" },
        { title: "河灯还亮着", content: importedBody },
      ],
    });

    const savedChapter = await readFile(join(chaptersDir, "0002_河灯还亮着.md"), "utf-8");
    const chapterFiles = await readdir(chaptersDir);
    const savedIndex = await state.loadChapterIndex(bookId);
    const expectedCount = countChapterLength(importedBody, "zh_chars");

    expect(result.importedCount).toBe(1);
    expect(result.totalWords).toBe(expectedCount);
    expect(savedChapter).toContain(importedBody);
    expect(chapterFiles).not.toContain("0002_旧标题.md");
    expect(savedIndex[1]?.wordCount).toBe(expectedCount);
    expect(savedIndex[1]?.title).toBe("河灯还亮着");

    await rm(root, { recursive: true, force: true });
  });

  it("keeps fanfic initialization running when style guide extraction fails", async () => {
    const { root, runner, state } = await createRunnerFixture();
    const bookId = "fanfic-style-fallback";
    const now = "2026-03-19T00:00:00.000Z";
    const book: BookConfig = {
      id: bookId,
      title: "Fanfic Fallback",
      platform: "tomato",
      genre: "xuanhuan",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 3000,
      createdAt: now,
      updatedAt: now,
    };

    vi.spyOn(runner, "importFanficCanon").mockImplementation(async (targetBookId) => {
      const storyDir = join(state.bookDir(targetBookId), "story");
      await mkdir(storyDir, { recursive: true });
      await writeFile(join(storyDir, "fanfic_canon.md"), "# Fanfic Canon\n", "utf-8");
      return "# Fanfic Canon\n";
    });
    vi.spyOn(ArchitectAgent.prototype, "generateFanficFoundation").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: createStateCard({
        chapter: 0,
        location: "Lantern quay",
        protagonistState: "Lin Yue enters the fanfic timeline with a hidden debt.",
        goal: "Find the canon fissure.",
        conflict: "The old faction watches every move.",
      }),
      pendingHooks: "# Pending Hooks\n",
    });
    vi.spyOn(runner, "generateStyleGuide").mockRejectedValue(new Error("style failed"));

    try {
      await expect(runner.initFanficBook(book, "A".repeat(600), "canon.txt", "canon")).resolves.toBeUndefined();

      expect(await state.loadChapterIndex(bookId)).toEqual([]);
      await expect(readFile(join(state.bookDir(bookId), "story", "fanfic_canon.md"), "utf-8")).resolves.toContain("Fanfic Canon");
      await expect(stat(join(state.bookDir(bookId), "story", "snapshots", "0"))).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("imports short style samples with a deterministic guide instead of failing", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockRejectedValue(new Error("should not call llm for short samples"));
    const sample = "夜雨落在窗台。她没回头，只把那封信压进抽屉。楼下车灯一闪，像有人终于找到了这里。";

    try {
      const guide = await runner.generateStyleGuide(bookId, sample, "short-snippet");

      expect(chatSpy).not.toHaveBeenCalled();
      expect(guide).toContain("样本文本较短");
      await expect(readFile(join(state.bookDir(bookId), "story", "style_profile.json"), "utf-8")).resolves.toContain("short-snippet");
      await expect(readFile(join(state.bookDir(bookId), "story", "style_guide.md"), "utf-8")).resolves.toContain("样本文本较短");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps canon import running when style guide extraction fails", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const parentBookId = "parent-book";
    const now = "2026-03-19T00:00:00.000Z";
    const parentBook: BookConfig = {
      id: parentBookId,
      title: "Parent Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 3000,
      createdAt: now,
      updatedAt: now,
    };
    const parentStoryDir = join(state.bookDir(parentBookId), "story");
    const parentChaptersDir = join(state.bookDir(parentBookId), "chapters");

    await state.saveBookConfig(parentBookId, parentBook);
    await mkdir(parentStoryDir, { recursive: true });
    await mkdir(parentChaptersDir, { recursive: true });
    await Promise.all([
      writeFile(join(parentStoryDir, "story_bible.md"), "# Story Bible\n", "utf-8"),
      writeFile(join(parentStoryDir, "current_state.md"), createStateCard({
        chapter: 3,
        location: "North watchtower",
        protagonistState: "The mentor debt is no longer secret.",
        goal: "Protect the watchtower archive.",
        conflict: "Guild spies are already inside the archive.",
      }), "utf-8"),
      writeFile(join(parentStoryDir, "particle_ledger.md"), "# Ledger\n", "utf-8"),
      writeFile(join(parentStoryDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(parentStoryDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(parentChaptersDir, "0001_Parent.md"), `# Chapter 1\n\n${"Parent text. ".repeat(60)}`, "utf-8"),
    ]);

    vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: "# Parent Canon\n\nImported canon body.",
    } as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);
    vi.spyOn(runner, "generateStyleGuide").mockRejectedValue(new Error("style failed"));

    try {
      const canon = await runner.importCanon(bookId, parentBookId);

      expect(canon).toContain("# Parent Canon");
      await expect(readFile(join(state.bookDir(bookId), "story", "parent_canon.md"), "utf-8")).resolves.toContain("Imported canon body.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps chapter import running when style guide extraction fails", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const chapterContent = "章节正文。".repeat(120);

    vi.spyOn(ArchitectAgent.prototype, "generateFoundationFromImport").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }),
      pendingHooks: "# Pending Hooks\n",
    });
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        chapterNumber: 1,
        title: "Prelude",
        content: chapterContent,
        wordCount: chapterContent.length,
      }),
    );
    vi.spyOn(WriterAgent.prototype, "saveChapter").mockResolvedValue(undefined);
    vi.spyOn(runner, "generateStyleGuide").mockRejectedValue(new Error("style failed"));

    try {
      const result = await runner.importChapters({
        bookId,
        chapters: [
          { title: "Prelude", content: chapterContent },
        ],
      });

      expect(result.importedCount).toBe(1);
      expect((await state.loadChapterIndex(bookId))[0]?.status).toBe("imported");
      await expect(readFile(join(state.bookDir(bookId), "story", "story_bible.md"), "utf-8")).resolves.toContain("# Story Bible");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  sqliteIt("rebuilds fact history from imported chapter snapshots", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();

    vi.spyOn(ArchitectAgent.prototype, "generateFoundationFromImport").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: createStateCard({
        chapter: 0,
        location: "Shrine outskirts",
        protagonistState: "Lin Yue begins with the oath token hidden.",
        goal: "Reach the trial city.",
        conflict: "The trial deadline is closing in.",
      }),
      pendingHooks: "# Pending Hooks\n",
    });

    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter")
      .mockResolvedValueOnce(createAnalyzedOutput({
        chapterNumber: 1,
        title: "One",
        content: "One body.",
        wordCount: "One body.".length,
        updatedState: createStateCard({
          chapter: 1,
          location: "Ashen ferry crossing",
          protagonistState: "Lin Yue still hides the oath token.",
          goal: "Find the vanished mentor.",
          conflict: "The mentor debt is still personal.",
        }),
        updatedHooks: "# Pending Hooks\n",
      }))
      .mockResolvedValueOnce(createAnalyzedOutput({
        chapterNumber: 2,
        title: "Two",
        content: "Two body.",
        wordCount: "Two body.".length,
        updatedState: createStateCard({
          chapter: 2,
          location: "North watchtower",
          protagonistState: "Lin Yue finally shows the oath token.",
          goal: "Reach the watchtower before the guild.",
          conflict: "The merchant guild now contests the mentor trail.",
        }),
        updatedHooks: "# Pending Hooks\n",
      }));

    try {
      await runner.importChapters({
        bookId,
        chapters: [
          { title: "One", content: "One body." },
          { title: "Two", content: "Two body." },
        ],
      });

      const memoryDb = new MemoryDB(state.bookDir(bookId));
      try {
        const chapterOneFacts = memoryDb.getFactsAt("protagonist", 1);
        const currentFacts = memoryDb.getCurrentFacts();

        expect(chapterOneFacts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              predicate: "Current Conflict",
              object: "The mentor debt is still personal.",
            }),
          ]),
        );
        expect(currentFacts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              predicate: "Current Conflict",
              object: "The merchant guild now contests the mentor trail.",
              validFromChapter: 2,
              sourceChapter: 2,
            }),
          ]),
        );
      } finally {
        memoryDb.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  sqliteIt("rebuilds fact history from structured snapshot state instead of stale markdown snapshots", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const snapshotOneDir = join(storyDir, "snapshots", "1");
    const snapshotOneStateDir = join(snapshotOneDir, "state");
    await mkdir(snapshotOneStateDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(snapshotOneDir, "current_state.md"),
        createStateCard({
          chapter: 1,
          location: "Old markdown ferry crossing",
          protagonistState: "Markdown state still hides the oath token.",
          goal: "Follow the markdown trail.",
          conflict: "Old markdown conflict.",
        }),
        "utf-8",
      ),
      writeFile(join(snapshotOneStateDir, "current_state.json"), JSON.stringify({
        chapter: 1,
        facts: [
          {
            subject: "current",
            predicate: "Current Location",
            object: "Structured watchtower",
            validFromChapter: 1,
            validUntilChapter: null,
            sourceChapter: 1,
          },
          {
            subject: "protagonist",
            predicate: "Current Conflict",
            object: "Structured conflict replaces markdown drift.",
            validFromChapter: 1,
            validUntilChapter: null,
            sourceChapter: 1,
          },
        ],
      }, null, 2), "utf-8"),
    ]);

    try {
      await (runner as unknown as {
        syncCurrentStateFactHistory: (targetBookId: string, uptoChapter: number) => Promise<void>;
      }).syncCurrentStateFactHistory(bookId, 1);

      const memoryDb = new MemoryDB(state.bookDir(bookId));
      try {
        expect(memoryDb.getCurrentFacts()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              predicate: "Current Location",
              object: "Structured watchtower",
              validFromChapter: 1,
            }),
            expect.objectContaining({
              predicate: "Current Conflict",
              object: "Structured conflict replaces markdown drift.",
              validFromChapter: 1,
            }),
          ]),
        );
        expect(memoryDb.getCurrentFacts()).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              object: "Old markdown ferry crossing",
            }),
            expect.objectContaining({
              object: "Old markdown conflict.",
            }),
          ]),
        );
      } finally {
        memoryDb.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tracks imported English chapters using word counts instead of characters", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const englishBook = {
      ...(await state.loadBookConfig(bookId)),
      genre: "other",
      language: "en" as const,
    };
    const now = "2026-03-19T00:00:00.000Z";

    await state.saveBookConfig(bookId, englishBook);
    await state.saveChapterIndex(bookId, [
      {
        number: 1,
        title: "Prelude",
        status: "imported",
        wordCount: 3,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
      {
        number: 2,
        title: "Crossroads",
        status: "imported",
        wordCount: 2,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);

    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockImplementation(async (input) =>
      createAnalyzedOutput({
        chapterNumber: input.chapterNumber,
        title: input.chapterTitle ?? `Chapter ${input.chapterNumber}`,
        content: input.chapterContent,
        wordCount: countChapterLength(input.chapterContent, "en_words"),
      }),
    );
    vi.spyOn(WriterAgent.prototype, "saveChapter");

    const result = await runner.importChapters({
      bookId,
      resumeFrom: 3,
      chapters: [
        { title: "Prelude", content: "One two three" },
        { title: "Crossroads", content: "Four five" },
        { title: "The Watchtower", content: "The storm kept rolling west" },
        { title: "Aftermath", content: "Lanterns dimmed before dawn broke" },
      ],
    });

    const chapterIndex = await state.loadChapterIndex(bookId);
    const chapterThree = chapterIndex.find((entry) => entry.number === 3);
    const chapterFour = chapterIndex.find((entry) => entry.number === 4);

    expect(result.importedCount).toBe(2);
    expect(result.totalWords).toBe(10);
    expect(chapterThree?.wordCount).toBe(5);
    expect(chapterFour?.wordCount).toBe(5);

    await rm(root, { recursive: true, force: true });
  });

  it("imports English chapters with English foundation seeds and persistence files", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const englishBook = {
      ...(await state.loadBookConfig(bookId)),
      genre: "other",
      language: "en" as const,
      chapterWordCount: 2200,
    };

    await state.saveBookConfig(bookId, englishBook);

    const foundation = vi.spyOn(ArchitectAgent.prototype, "generateFoundationFromImport").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: createStateCard({
        chapter: 0,
        location: "Harbor gate",
        protagonistState: "Mara arrives with a sealed letter.",
        goal: "Find the missing captain before sunrise.",
        conflict: "The harbor watch is searching every ship.",
      }),
      pendingHooks: "# Pending Hooks\n\n| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |\n| --- | --- | --- | --- | --- | --- | --- |\n",
    });
    const saveChapter = vi.spyOn(WriterAgent.prototype, "saveChapter");

    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        chapterNumber: 1,
        title: "Prelude",
        content: "A cold wind crossed the harbor.",
        wordCount: countChapterLength("A cold wind crossed the harbor.", "en_words"),
        updatedState: createStateCard({
          chapter: 1,
          location: "Harbor gate",
          protagonistState: "Mara hides the sealed letter under her coat.",
          goal: "Slip past the harbor watch.",
          conflict: "The watch now searches for the missing captain's courier.",
        }),
        updatedHooks: "# Pending Hooks\n\n| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |\n| --- | --- | --- | --- | --- | --- | --- |\n| captain-letter | 1 | mystery | open | 1 | The captain's disappearance is explained. | The sealed letter points to the vanished captain. |\n",
        chapterSummary: "| 1 | Prelude | Mara | Mara reaches the harbor with a sealed letter. | Mara hides the letter and studies the watch patrol. | The captain-letter mystery opens. | tense | setup |",
        updatedSubplots: [
          "# Subplot Board",
          "",
          "| Subplot | Status | Note |",
          "| --- | --- | --- |",
          "| Harbor search | Active | Mara begins the search for the missing captain. |",
          "",
        ].join("\n"),
        updatedEmotionalArcs: "",
        updatedCharacterMatrix: "",
      }),
    );

    try {
      await runner.importChapters({
        bookId,
        chapters: [
          { title: "Prelude", content: "A cold wind crossed the harbor." },
        ],
      });

      const storyDir = join(state.bookDir(bookId), "story");
      const chapterPath = join(state.bookDir(bookId), "chapters", "0001_Prelude.md");
      const chapterFile = await readFile(chapterPath, "utf-8");
      const chapterSummaries = await readFile(join(storyDir, "chapter_summaries.md"), "utf-8");
      const subplotBoard = await readFile(join(storyDir, "subplot_board.md"), "utf-8");

      expect(foundation.mock.calls[0]?.[1]).toContain("Chapter 1: Prelude");
      expect(foundation.mock.calls[0]?.[1]).not.toContain("第1章");
      expect(saveChapter.mock.calls[0]?.[3]).toBe("en");
      expect(chapterFile).toContain("# Chapter 1: Prelude");
      expect(chapterSummaries).toContain("# Chapter Summaries");
      expect(chapterSummaries).not.toContain("# 章节摘要");
      expect(subplotBoard).toContain("# Subplot Board");
      expect(subplotBoard).not.toContain("# 支线进度板");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs localized replay progress during chapter import", async () => {
    const { logger, infos } = createCaptureLogger();
    const { root, runner, bookId } = await createRunnerFixture({ logger });

    vi.spyOn(ArchitectAgent.prototype, "generateFoundationFromImport").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }),
      pendingHooks: "# Pending Hooks\n",
    });
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        chapterNumber: 1,
        title: "Prelude",
        content: "章节正文。",
        wordCount: "章节正文。".length,
      }),
    );
    vi.spyOn(WriterAgent.prototype, "saveChapter").mockResolvedValue(undefined);

    try {
      await runner.importChapters({
        bookId,
        chapters: [
          { title: "第一章", content: "章节正文。" },
        ],
      });

      expect(infos).toEqual(expect.arrayContaining([
        "步骤 1：从 1 章生成基础设定...",
        "基础设定已生成。",
        "步骤 2：从第 1 章开始顺序回放...",
        "分析章节 1/1：第一章...",
        "完成。已导入 1 章，共 5字。下一章：2",
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes governed control inputs into import replay analyzer on the governed path", async () => {
    const { root, runner, bookId } = await createRunnerFixture();

    vi.spyOn(ArchitectAgent.prototype, "generateFoundationFromImport").mockResolvedValue({
      storyBible: "# Story Bible\n\n- Keep the harbor search grounded in the missing captain thread.\n",
      volumeOutline: "# Volume Outline\n\n## Volume 1\n- Chapter 1: Mara arrives at the harbor with the sealed letter.\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n\n- Stay close to Mara's viewpoint.\n",
      currentState: createStateCard({
        chapter: 0,
        location: "Harbor gate",
        protagonistState: "Mara arrives carrying a sealed letter.",
        goal: "Enter the harbor unnoticed.",
        conflict: "The harbor watch is hunting the captain's courier.",
      }),
      pendingHooks: [
        "# Pending Hooks",
        "",
        "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| captain-letter | 1 | mystery | open | 0 | The captain's disappearance is explained. | The sealed letter points to the missing captain. |",
        "",
      ].join("\n"),
    });

    const analyzeChapter = vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        chapterNumber: 1,
        title: "Prelude",
        content: "A cold wind crossed the harbor.",
        wordCount: countChapterLength("A cold wind crossed the harbor.", "en_words"),
      }),
    );
    vi.spyOn(WriterAgent.prototype, "saveChapter").mockResolvedValue(undefined);

    try {
      await runner.importChapters({
        bookId,
        chapters: [
          { title: "Prelude", content: "A cold wind crossed the harbor." },
        ],
      });

      expect(analyzeChapter.mock.calls[0]?.[0]).toMatchObject({
        chapterIntent: expect.stringContaining("# Chapter Intent"),
        contextPackage: expect.objectContaining({
          selectedContext: expect.any(Array),
        }),
        ruleStack: expect.objectContaining({
          activeOverrides: expect.any(Array),
        }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not leak imported future state into early replay chapters", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const englishBook = {
      ...(await state.loadBookConfig(bookId)),
      genre: "other",
      language: "en" as const,
      chapterWordCount: 2200,
    };

    await state.saveBookConfig(bookId, englishBook);
    await mkdir(join(storyDir, "snapshots", "0"), { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "subplot_board.md"), "# Subplot Board\n\nFUTURE LEAK subplot\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# Emotional Arcs\n\nFUTURE LEAK emotion\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Character Matrix\n\nFUTURE LEAK matrix\n", "utf-8"),
      writeFile(
        join(storyDir, "chapter_summaries.md"),
        [
          "# Chapter Summaries",
          "",
          "| Chapter | Title | Characters | Key Events | State Changes | Hook Activity | Mood | Chapter Type |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| 99 | Future | Future Cast | FUTURE LEAK event | FUTURE LEAK state | FUTURE LEAK hook | grim | finale |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "snapshots", "0", "current_state.md"),
        createStateCard({
          chapter: 60,
          location: "Chengdu court",
          protagonistState: "FUTURE LEAK snapshot",
          goal: "Secure the western kingdom.",
          conflict: "Late-book imperial rivalry is now fully active.",
        }),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "snapshots", "0", "pending_hooks.md"),
        [
          "# Pending Hooks",
          "",
          "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| future-hook | 60 | mystery | open | 60 | Future payoff | FUTURE LEAK |",
          "",
        ].join("\n"),
        "utf-8",
      ),
    ]);

    vi.spyOn(ArchitectAgent.prototype, "generateFoundationFromImport").mockResolvedValue({
      storyBible: "# Story Bible\n",
      volumeOutline: "# Volume Outline\n",
      bookRules: "---\nversion: \"1.0\"\n---\n\n# Book Rules\n",
      currentState: createStateCard({
        chapter: 60,
        location: "Chengdu court",
        protagonistState: "FUTURE LEAK: Liu Bei already holds Yizhou.",
        goal: "Secure the western kingdom.",
        conflict: "Late-book imperial rivalry is now fully active.",
      }),
      pendingHooks: [
        "# Pending Hooks",
        "",
        "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| future-hook | 60 | mystery | open | 60 | Future payoff | FUTURE LEAK |",
        "",
      ].join("\n"),
    });

    let stateSeenByFirstReplay = "";
    let hooksSeenByFirstReplay = "";
    let subplotSeenByFirstReplay = "";
    let emotionalSeenByFirstReplay = "";
    let matrixSeenByFirstReplay = "";
    let summariesSeenByFirstReplay = "";

    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockImplementationOnce(async (input) => {
      stateSeenByFirstReplay = await readFile(join(input.bookDir, "story", "current_state.md"), "utf-8");
      hooksSeenByFirstReplay = await readFile(join(input.bookDir, "story", "pending_hooks.md"), "utf-8");
      subplotSeenByFirstReplay = await readFile(join(input.bookDir, "story", "subplot_board.md"), "utf-8").catch(() => "");
      emotionalSeenByFirstReplay = await readFile(join(input.bookDir, "story", "emotional_arcs.md"), "utf-8").catch(() => "");
      matrixSeenByFirstReplay = await readFile(join(input.bookDir, "story", "character_matrix.md"), "utf-8").catch(() => "");
      summariesSeenByFirstReplay = await readFile(join(input.bookDir, "story", "chapter_summaries.md"), "utf-8").catch(() => "");

      return createAnalyzedOutput({
        chapterNumber: 1,
        title: "Prelude",
        content: "A cold wind crossed the harbor.",
        wordCount: countChapterLength("A cold wind crossed the harbor.", "en_words"),
        updatedState: createStateCard({
          chapter: 1,
          location: "Harbor gate",
          protagonistState: "Mara hides the sealed letter under her coat.",
          goal: "Slip past the harbor watch.",
          conflict: "The watch now searches for the missing captain's courier.",
        }),
        updatedHooks: [
          "# Pending Hooks",
          "",
          "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| captain-letter | 1 | mystery | open | 1 | The captain's disappearance is explained. | The sealed letter points to the vanished captain. |",
          "",
        ].join("\n"),
      });
    });

    try {
      await runner.importChapters({
        bookId,
        chapters: [
          { title: "Prelude", content: "A cold wind crossed the harbor." },
        ],
      });

      expect(stateSeenByFirstReplay).toContain("| Current Chapter | 0 |");
      expect(stateSeenByFirstReplay).not.toContain("FUTURE LEAK");
      expect(hooksSeenByFirstReplay).toContain("# Pending Hooks");
      expect(hooksSeenByFirstReplay).not.toContain("future-hook");
      expect(hooksSeenByFirstReplay).not.toContain("FUTURE LEAK");
      expect(subplotSeenByFirstReplay).not.toContain("FUTURE LEAK");
      expect(emotionalSeenByFirstReplay).not.toContain("FUTURE LEAK");
      expect(matrixSeenByFirstReplay).not.toContain("FUTURE LEAK");
      expect(summariesSeenByFirstReplay).not.toContain("FUTURE LEAK");

      const snapshotZeroState = await readFile(join(storyDir, "snapshots", "0", "current_state.md"), "utf-8");
      const snapshotZeroHooks = await readFile(join(storyDir, "snapshots", "0", "pending_hooks.md"), "utf-8");
      expect(snapshotZeroState).toContain("| Current Chapter | 0 |");
      expect(snapshotZeroState).not.toContain("FUTURE LEAK");
      expect(snapshotZeroHooks).toContain("# Pending Hooks");
      expect(snapshotZeroHooks).not.toContain("future-hook");
      expect(snapshotZeroHooks).not.toContain("FUTURE LEAK");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  sqliteIt("rebuilds current facts from the revised chapter snapshot", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const oldState = createStateCard({
      chapter: 1,
      location: "Ashen ferry crossing",
      protagonistState: "Lin Yue still hides the oath token.",
      goal: "Find the vanished mentor.",
      conflict: "The mentor debt is still personal.",
    });
    const revisedState = createStateCard({
      chapter: 1,
      location: "Ashen ferry crossing",
      protagonistState: "Lin Yue no longer hides the oath token.",
      goal: "Confront the vanished mentor.",
      conflict: "The oath token is public now, forcing the confrontation.",
    });

    await Promise.all([
      writeFile(join(chaptersDir, "0001_Test_Chapter.md"), "# 第1章 Test Chapter\n\nOriginal body.", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), oldState, "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "Test Chapter",
      status: "audit-failed",
      wordCount: "Original body.".length,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);
    await snapshotRevisionBaseline(state, bookId, 0);
    await state.snapshotState(bookId, 1);

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [CRITICAL_ISSUE],
          summary: "needs revision",
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
        }),
      );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: "Revised body.",
        wordCount: "Revised body.".length,
      }),
    );
    vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(
      async (input) => {
        const output = createSettledRevisionOutput(input, { updatedState: revisedState });
        return {
          ...output,
          runtimeStateSnapshot: {
            ...output.runtimeStateSnapshot!,
            currentState: {
              chapter: 1,
              facts: [{
                subject: "protagonist",
                predicate: "Current Conflict",
                object: "The oath token is public now, forcing the confrontation.",
                validFromChapter: 1,
                validUntilChapter: null,
                sourceChapter: 1,
              }],
            },
          },
        };
      },
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 0);
      await runner.reviseDraft(bookId, 1);

      const memoryDb = new MemoryDB(state.bookDir(bookId));
      try {
        expect(memoryDb.getCurrentFacts()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              predicate: "Current Conflict",
              object: "The oath token is public now, forcing the confrontation.",
              validFromChapter: 1,
              sourceChapter: 1,
            }),
          ]),
        );
      } finally {
        memoryDb.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("feeds long-span fatigue warnings back into pipeline audit and dedicated drift guidance", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const now = "2026-03-19T00:00:00.000Z";

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 2,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The debt trail keeps narrowing.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(
        join(storyDir, "chapter_summaries.md"),
        [
          "# 章节摘要",
          "",
          "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
          "|------|------|----------|----------|----------|----------|----------|----------|",
          "| 1 | 旧路 | 林越 | 进城 | 潜伏开始 | 债印未解 | 克制 | 布局 |",
          "| 2 | 暗巷 | 林越 | 试探 | 目标未变 | 债印未解 | 克制 | 布局 |",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(state.bookDir(bookId), "chapters", "0001_旧路.md"), "# 第1章 旧路\n\n城门在晨雾里半开。林越顺着石阶慢慢往里走。巷口那盏灯一直没有灭。", "utf-8"),
      writeFile(join(state.bookDir(bookId), "chapters", "0002_暗巷.md"), "# 第2章 暗巷\n\n午后的风掠过墙头。林越没有回头，只是沿着阴影继续向前。墙后的铃声很轻。", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [
      {
        number: 1,
        title: "旧路",
        status: "ready-for-review",
        wordCount: 36,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
      {
        number: 2,
        title: "暗巷",
        status: "ready-for-review",
        wordCount: 36,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 3,
        title: "回声",
        content: "夜色慢慢压低了屋檐。林越先停在门外，随后才抬手去碰那道旧债印。风从更深的巷子里吹了出来。",
        wordCount: "夜色慢慢压低了屋檐。林越先停在门外，随后才抬手去碰那道旧债印。风从更深的巷子里吹了出来。".length,
        updatedState: createStateCard({
          chapter: 3,
          location: "Ashen ferry crossing",
          protagonistState: "Lin Yue still hides the oath token.",
          goal: "Find the vanished mentor.",
          conflict: "The debt trail keeps narrowing.",
        }),
        updatedLedger: "",
        updatedHooks: "# Pending Hooks\n",
        chapterSummary: "| 3 | 回声 | 林越 | 继续潜伏 | 目标未变 | 债印未解 | 克制 | 布局 |",
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "ok",
      }),
    );

    try {
      await snapshotPersistedTestPrefix(state, bookId);
      const result = await runner.writeNextChapter(bookId);
      const driftFile = await readFile(join(storyDir, "audit_drift.md"), "utf-8");
      const currentState = await readFile(join(storyDir, "current_state.md"), "utf-8");

      expect(result.auditResult.issues.some((issue) => issue.category === "节奏单调")).toBe(true);
      expect(driftFile).toContain("节奏单调");
      expect(currentState).not.toContain("节奏单调");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("feeds hook health warnings back into pipeline audit and dedicated drift guidance", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const now = "2026-03-19T00:00:00.000Z";

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 2,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The debt trail keeps narrowing.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(state.bookDir(bookId), "chapters", "0001_旧路.md"), "# 第1章 旧路\n\n城门在晨雾里半开。林越顺着石阶慢慢往里走。", "utf-8"),
      writeFile(join(state.bookDir(bookId), "chapters", "0002_暗巷.md"), "# 第2章 暗巷\n\n午后的风掠过墙头。林越没有回头，只是沿着阴影继续向前。", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [
      {
        number: 1,
        title: "旧路",
        status: "ready-for-review",
        wordCount: 27,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
      {
        number: 2,
        title: "暗巷",
        status: "ready-for-review",
        wordCount: 29,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 3,
        title: "回声",
        content: "夜色慢慢压低了屋檐。林越先停在门外，随后才抬手去碰那道旧债印。",
        wordCount: "夜色慢慢压低了屋檐。林越先停在门外，随后才抬手去碰那道旧债印。".length,
        updatedState: createStateCard({
          chapter: 3,
          location: "Ashen ferry crossing",
          protagonistState: "Lin Yue still hides the oath token.",
          goal: "Find the vanished mentor.",
          conflict: "The debt trail keeps narrowing.",
        }),
        updatedLedger: "",
        updatedHooks: "# Pending Hooks\n",
        chapterSummary: "| 3 | 回声 | 林越 | 继续潜伏 | 目标未变 | 债印未解 | 克制 | 布局 |",
        hookHealthIssues: [{
          severity: "warning",
          category: "伏笔债务",
          description: "活跃伏笔过多，且本章没有处理陈旧债务。",
          suggestion: "下一章优先推进或延后至少一个僵死伏笔。",
        }],
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "ok",
      }),
    );

    try {
      await snapshotPersistedTestPrefix(state, bookId);
      const result = await runner.writeNextChapter(bookId);
      const driftFile = await readFile(join(storyDir, "audit_drift.md"), "utf-8");
      const currentState = await readFile(join(storyDir, "current_state.md"), "utf-8");
      const savedIndex = await state.loadChapterIndex(bookId);
      const persistedChapter = savedIndex.find((chapter) => chapter.number === result.chapterNumber);

      expect(result.auditResult.issues.some((issue) => issue.category === "伏笔债务")).toBe(true);
      expect(driftFile).toContain("伏笔债务");
      expect(currentState).not.toContain("伏笔债务");
      expect(persistedChapter?.auditIssues).toEqual(
        expect.arrayContaining([
          expect.stringContaining("活跃伏笔过多"),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("adds final paragraph fragmentation warnings from revised content before persist", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const draftBody = "林越先把门推开一条缝，再侧耳去听墙后的动静。屋里的灯没有亮，但桌角还有没散的热气，说明人刚离开不久。";
    const revisedBody = [
      "门开了。",
      "他没进去。",
      "先听了一下。",
      "里面没有声响。",
      "他这才抬脚。",
      "屋里很冷。",
    ].join("\n\n");

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 0,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The debt trail keeps narrowing.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 1,
        title: "雾线",
        content: draftBody,
        wordCount: draftBody.length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [CRITICAL_ISSUE],
          summary: "needs revision",
          overallScore: 40,
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
          overallScore: 95,
        }),
      );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: revisedBody.length,
      }),
    );
    vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(
      createAnalyzedOutput({
        title: "雾线",
        content: revisedBody,
        wordCount: revisedBody.length,
        chapterSummary: "| 1 | 雾线 | 林越 | 进入空屋 | 状态推进 | 无 | 紧绷 | 过渡 |",
      }),
    );

    try {
      await snapshotPersistedTestPrefix(state, bookId);
      const result = await runner.writeNextChapter(bookId, 120);

      expect(result.auditResult.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "paragraph-shape",
            description: expect.stringContaining("段落被切得过碎"),
          }),
          expect.objectContaining({
            category: "paragraph-shape",
            description: expect.stringContaining("连续出现"),
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves duplicate chapter titles before persist", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const now = "2026-03-19T00:00:00.000Z";

    await Promise.all([
      writeFile(join(chaptersDir, "0001_回声.md"), "# 第1章 回声\n\n旧章节。", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The debt trail keeps narrowing.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "回声",
      status: "ready-for-review",
      wordCount: 12,
      createdAt: now,
      updatedAt: now,
      auditIssues: [],
      lengthWarnings: [],
    }]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 2,
        title: "回声",
        content: "啊。",
        wordCount: "啊。".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      await snapshotPersistedTestPrefix(state, bookId);
      const result = await runner.writeNextChapter(bookId, 120);
      const index = await state.loadChapterIndex(bookId);

      expect(result.title).toBe("回声（2）");
      expect(index.at(-1)?.title).toBe("回声（2）");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("regenerates duplicate chapter titles before falling back to numeric suffixes", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const now = "2026-03-19T00:00:00.000Z";

    await Promise.all([
      writeFile(join(chaptersDir, "0001_回声.md"), "# 第1章 回声\n\n旧章节。", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The debt trail keeps narrowing.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "回声",
      status: "ready-for-review",
      wordCount: 12,
      createdAt: now,
      updatedAt: now,
      auditIssues: [],
      lengthWarnings: [],
    }]);

    vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(
      createWriterOutput({
        chapterNumber: 2,
        title: "回声",
        content: "塔楼里的铜铃只响了一声，风从缺口灌进来，守夜人没有回头。",
        wordCount: "塔楼里的铜铃只响了一声，风从缺口灌进来，守夜人没有回头。".length,
      }),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: true,
        issues: [],
        summary: "clean",
      }),
    );

    try {
      await snapshotPersistedTestPrefix(state, bookId);
      const result = await runner.writeNextChapter(bookId, 120);
      const index = await state.loadChapterIndex(bookId);

      expect(result.title).toContain("塔楼");
      expect(result.title).not.toBe("回声（2）");
      expect(index.at(-1)?.title).toBe(result.title);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defaults manual reviseDraft to auto when mode is omitted", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");

    await Promise.all([
      writeFile(join(chaptersDir, "0001_Test_Chapter.md"), "# 第1章 Test Chapter\n\nOriginal body.", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "Test Chapter",
      status: "audit-failed",
      wordCount: "Original body.".length,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(
      createAuditResult({
        passed: false,
        issues: [CRITICAL_ISSUE],
        summary: "needs revision",
      }),
    );
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: "Spot-fixed body.",
        wordCount: "Spot-fixed body.".length,
      }),
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 0);
      await runner.reviseDraft(bookId, 1);

      expect(reviseChapter).toHaveBeenCalledTimes(1);
      expect(reviseChapter.mock.calls[0]?.[4]).toBe("auto");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes governed control inputs into manual revise on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
    });
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const originalBody = "林越推门进去，先看见柜台后那盏没关的灯。";

    await Promise.all([
      writeFile(join(storyDir, "current_focus.md"), "# 当前聚焦\n\n## 当前重点\n\n把注意力收回师债主线。\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# 卷纲\n\n## 第1章\n先处理商会路线噪音。\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "旧港便利店",
        protagonistState: "林越仍在追查师债。",
        goal: "把注意力拉回师债线索。",
        conflict: "商会路线仍在分散注意力。",
      }), "utf-8"),
      writeFile(join(storyDir, "story_bible.md"), "# 世界观设定\n\n- 誓令碎片不可伪造。\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# 伏笔池\n\n- 师债线索仍未回收。\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), [
        "# 章节摘要",
        "",
        "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| 1 | 夜灯 | 林越 | 林越继续追查师债 | 追查意图更强 | 师债推进 | 压抑 | 主线推进 |",
        "",
      ].join("\n"), "utf-8"),
      writeFile(join(chaptersDir, "0001_夜灯.md"), `# 第1章 夜灯\n\n${originalBody}`, "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "夜灯",
      status: "audit-failed",
      wordCount: originalBody.length,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);

    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [CRITICAL_ISSUE],
          summary: "needs revision",
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
        }),
      );
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: "林越推门进去，先停在门槛外听了一息，再去看柜台后那盏没关的灯。",
        wordCount: "林越推门进去，先停在门槛外听了一息，再去看柜台后那盏没关的灯。".length,
        fixedIssues: ["- 收紧了主线焦点。"],
      }),
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 0);
      await runner.reviseDraft(bookId, 1);

      expect(auditChapter.mock.calls[0]?.[4]).toMatchObject({
        chapterIntent: expect.stringContaining("# Chapter Intent"),
        contextPackage: expect.objectContaining({
          selectedContext: expect.any(Array),
        }),
        ruleStack: expect.objectContaining({
          activeOverrides: expect.any(Array),
        }),
      });
      expect(reviseChapter.mock.calls[0]?.[6]).toMatchObject({
        chapterIntent: expect.stringContaining("# Chapter Intent"),
        contextPackage: expect.objectContaining({
          selectedContext: expect.any(Array),
        }),
        ruleStack: expect.objectContaining({
          activeOverrides: expect.any(Array),
        }),
        lengthSpec: expect.objectContaining({
          target: 3000,
        }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes one-off external brief into manual revise on the governed path", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture({
      externalContext: "把注意力收回师债主线，并强调柜台后的异常灯光。",
    });
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const originalBody = "林越推门进去，先看见柜台后那盏没关的灯。";

    await Promise.all([
      writeFile(join(storyDir, "current_focus.md"), "# 当前聚焦\n\n## 当前重点\n\n商会路线优先。\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# 卷纲\n\n## 第1章\n先处理商会路线噪音。\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "旧港便利店",
        protagonistState: "林越仍在追查师债。",
        goal: "把注意力拉回师债线索。",
        conflict: "商会路线仍在分散注意力。",
      }), "utf-8"),
      writeFile(join(storyDir, "story_bible.md"), "# 世界观设定\n\n- 誓令碎片不可伪造。\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# 伏笔池\n\n- 师债线索仍未回收。\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), [
        "# 章节摘要",
        "",
        "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| 1 | 夜灯 | 林越 | 林越继续追查师债 | 追查意图更强 | 师债推进 | 压抑 | 主线推进 |",
        "",
      ].join("\n"), "utf-8"),
      writeFile(join(chaptersDir, "0001_夜灯.md"), `# 第1章 夜灯\n\n${originalBody}`, "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "夜灯",
      status: "audit-failed",
      wordCount: originalBody.length,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);
    await saveChapterUserBrief(
      state.bookDir(bookId),
      1,
      "保留证人关于雨夜账本的原话。",
    );

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [CRITICAL_ISSUE],
          summary: "needs revision",
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
        }),
      );
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: "林越推门进去，先停在门槛外听了一息，再去看柜台后那盏没关的灯。",
        wordCount: "林越推门进去，先停在门槛外听了一息，再去看柜台后那盏没关的灯。".length,
        fixedIssues: ["- 收紧了主线焦点。"],
      }),
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 0);
      await runner.reviseDraft(bookId, 1);

      expect(reviseChapter.mock.calls[0]?.[6]).toMatchObject({
        chapterIntent: expect.stringContaining("把注意力收回师债主线"),
      });
      expect(reviseChapter.mock.calls[0]?.[6]).toMatchObject({
        chapterIntent: expect.stringContaining("保留证人关于雨夜账本的原话"),
      });
      expect(reviseChapter.mock.calls[0]?.[6]).not.toMatchObject({
        chapterIntent: expect.stringContaining("商会路线优先"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes merged AI-tell issues into manual revise and rejects no-improvement revisions", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const originalBody = "林越抬手。林越停步。林越转身。林越侧耳。";

    await Promise.all([
      writeFile(join(chaptersDir, "0001_Test_Chapter.md"), `# 第1章 Test Chapter\n\n${originalBody}`, "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "Test Chapter",
      status: "audit-failed",
      wordCount: originalBody.length,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [{
            severity: "warning",
            category: "节奏",
            description: "结尾解释略多。",
            suggestion: "压缩一行解释。",
          }],
          summary: "needs revision",
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [{
            severity: "warning",
            category: "节奏",
            description: "结尾解释略多。",
            suggestion: "压缩一行解释。",
          }],
          summary: "still weak",
        }),
      );
    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: `${originalBody}\n\n修订后收束更利落。`,
        wordCount: `${originalBody}\n\n修订后收束更利落。`.length,
        fixedIssues: ["- 压缩了结尾解释。"],
      }),
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 0);
      const result = await runner.reviseDraft(bookId, 1);
      const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(reviseChapter).toHaveBeenCalledTimes(1);
      expect(reviseChapter.mock.calls[0]?.[3]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "节奏" }),
          expect.objectContaining({ category: "列表式结构" }),
        ]),
      );
      expect(result.applied).toBe(false);
      expect(result.status).toBe("unchanged");
      expect(result.skippedReason).toContain("Manual revision kept original chapter");
      expect(savedChapter).toContain(originalBody);
      expect(savedChapter).not.toContain("修订后收束更利落");
      expect(savedIndex[0]?.status).toBe("audit-failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("persists manual revisions only when merged audit improves", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const originalBody = "林越抬手。林越停步。林越转身。林越侧耳。";
    const revisedBody = "门被风顶开，林越先停在门槛前。\n\n他侧过身，听见墙后那道更轻的呼吸。";

    await Promise.all([
      writeFile(join(chaptersDir, "0001_Test_Chapter.md"), `# 第1章 Test Chapter\n\n${originalBody}`, "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "Test Chapter",
      status: "audit-failed",
      wordCount: originalBody.length,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [{
            severity: "warning",
            category: "节奏",
            description: "结尾解释略多。",
            suggestion: "压缩一行解释。",
          }],
          summary: "needs revision",
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
        }),
      );
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: revisedBody.length,
        fixedIssues: ["- 收紧了结尾节奏。"],
      }),
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 0);
      const result = await runner.reviseDraft(bookId, 1);
      const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(result.applied).toBe(true);
      expect(result.status).toBe("ready-for-review");
      expect(result.fixedIssues).toEqual(["- 收紧了结尾节奏。"]);
      expect(savedChapter).toContain(revisedBody);
      expect(savedIndex[0]?.status).toBe("ready-for-review");
      expect(savedIndex[0]?.auditIssues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  async function createRevisionGateFixture(revisionGate?: "strict" | "lenient" | "always") {
    const fixture = await createRunnerFixture(revisionGate ? { revisionGate } : {});
    const storyDir = join(fixture.state.bookDir(fixture.bookId), "story");
    const chaptersDir = join(fixture.state.bookDir(fixture.bookId), "chapters");
    // Single paragraph, varied sentence openings, no hedge/transition words →
    // zero structural AI tells, so audit counts come only from the LLM audit mocks.
    const originalBody = "林越推门进去，先看见柜台后那盏没关的灯，他放轻脚步绕过货架。";
    const revisedBody = "门被风顶开，林越先停在门槛前，听见柜台后那盏灯轻轻晃动。";

    await Promise.all([
      writeFile(join(chaptersDir, "0001_Test_Chapter.md"), `# 第1章 Test Chapter\n\n${originalBody}`, "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Ashen ferry crossing",
        protagonistState: "Lin Yue still hides the oath token.",
        goal: "Find the vanished mentor.",
        conflict: "The mentor debt is still personal.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await fixture.state.saveChapterIndex(fixture.bookId, [{
      number: 1,
      title: "Test Chapter",
      status: "audit-failed",
      wordCount: originalBody.length,
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);

    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: revisedBody.length,
        fixedIssues: ["- 调整了开场镜头。"],
      }),
    );

    await snapshotRevisionBaseline(fixture.state, fixture.bookId, 0);

    return { ...fixture, chaptersDir, revisedBody };
  }

  const GATE_WARNING_ISSUE: AuditIssue = {
    severity: "warning",
    category: "节奏",
    description: "结尾解释略多。",
    suggestion: "压缩一行解释。",
  };

  it("rejects ambiguous retained chapter bodies before revision generation", async () => {
    const { root, runner, bookId, chaptersDir } = await createRevisionGateFixture("always");
    try {
      await writeFile(join(chaptersDir, "1-retained.md"), "Ambiguous original", "utf8");
      await expect(runner.reviseDraft(bookId, 1)).rejects.toThrow("CHAPTER_BODY_AMBIGUOUS");
      expect(ReviserAgent.prototype.reviseChapter).not.toHaveBeenCalled();
      expect(await readFile(join(chaptersDir, "1-retained.md"), "utf8")).toBe("Ambiguous original");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["sync", "revise", "next"])("%s rejects a corrupt predecessor snapshot before generation", async (operation) => {
    const { root, runner, state, bookId } = await createRevisionGateFixture("always");
    try {
      await writeFile(join(state.bookDir(bookId), "story", "snapshots", "0", "current_state.md"), "corrupted baseline", "utf-8");
      const execute = () => operation === "sync" ? runner.resyncChapterArtifacts(bookId, 1)
        : operation === "revise" ? runner.reviseDraft(bookId, 1, "rework", "repair")
          : runner.writeNextChapter(bookId);
      await expect(execute()).rejects.toThrow("STATE_RECOVERY_REQUIRED");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("sync rejects a stale predecessor body even when its audit status passes", async () => {
    const { root, runner, state, bookId, chaptersDir } = await createRevisionGateFixture("always");
    try {
      await state.snapshotState(bookId, 1);
      const [first] = await state.loadChapterIndex(bookId);
      await state.saveChapterIndex(bookId, [first!, { ...first!, number: 2, title: "Second", status: "audit-passed" }]);
      await writeFile(join(chaptersDir, "0002_Second.md"), "# Second\n\nSecond body", "utf-8");
      await writeFile(join(chaptersDir, "0001_Test_Chapter.md"), "# First\n\nChanged predecessor", "utf-8");
      await expect(runner.resyncChapterArtifacts(bookId, 2)).rejects.toThrow("STATE_RECOVERY_REQUIRED");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves a reachable candidate when validator parsing throws", async () => {
    const { root, runner, state, bookId, chaptersDir } = await createRevisionGateFixture("always");
    try {
      vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(createAuditResult({ passed: false, issues: [CRITICAL_ISSUE], summary: "needs revision" }));
      vi.spyOn(StateValidatorAgent.prototype, "validate").mockRejectedValue(new Error("State validator returned invalid response"));
      const before = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf8");
      const error = await runner.reviseDraft(bookId, 1, "rework").catch(error => error);
      expect(error).toMatchObject({ candidateId: expect.any(String), attemptId: expect.any(String), stage: "validation", reasonCode: "STATE_VALIDATION_FAILED" });
      const dir = join(state.bookDir(bookId), "story", "recovery", "candidates", error.candidateId);
      expect((await readdir(dir)).some(file => file.startsWith("attempt-"))).toBe(true);
      expect(await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf8")).toBe(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("keeps chapter and truth files unchanged when revised-body settlement cannot validate", async () => {
    const { root, runner, state, bookId, chaptersDir, revisedBody } = await createRevisionGateFixture("always");
    const storyDir = join(state.bookDir(bookId), "story");
    const originalChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
    const originalState = await readFile(join(storyDir, "current_state.md"), "utf-8");
    const originalHooks = await readFile(join(storyDir, "pending_hooks.md"), "utf-8");
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValueOnce(
      createAuditResult({ passed: false, issues: [CRITICAL_ISSUE], summary: "needs revision" }),
    );
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({
      passed: false,
      repairRequired: true,
      warnings: [{
        category: "state-conflict",
        description: "The derived hook board contradicts the revised body.",
      }],
    });

    try {
      const result = await runner.reviseDraft(bookId, 1, "rework", "Rewrite the chapter and sync state.");

      expect(result.applied).toBe(false);
      expect(result.skippedReason).toContain("state settlement did not validate");
      expect(result.auditIssues).toEqual([
        expect.objectContaining({ category: "state-validation" }),
      ]);
      await expect(readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8")).resolves.toBe(originalChapter);
      await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe(originalState);
      await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8")).resolves.toBe(originalHooks);
      expect(originalChapter).not.toContain(revisedBody);
      await expect(listChapterVersions(state.bookDir(bookId), 1)).resolves.toEqual([]);
      expect(result.candidateId).toBeTruthy();
      const reviserCalls = vi.mocked(ReviserAgent.prototype.reviseChapter).mock.calls.length;
      const rulesPath = join(storyDir, "book_rules.md");
      const rulesBefore = await readFile(rulesPath, "utf-8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      await writeFile(rulesPath, `${rulesBefore ?? ""}\nChanged author control.`, "utf-8");
      await expect(runner.resumeRevisionCandidate(bookId, result.candidateId!)).rejects.toThrow("CANDIDATE_INPUTS_CHANGED");
      expect(vi.mocked(ReviserAgent.prototype.reviseChapter).mock.calls.length).toBe(reviserCalls);
      if (rulesBefore === null) await rm(rulesPath);
      else await writeFile(rulesPath, rulesBefore, "utf-8");
      vi.mocked(StateValidatorAgent.prototype.validate).mockResolvedValue({ passed: true, repairRequired: false, warnings: [] });
      vi.mocked(ContinuityAuditor.prototype.auditChapter).mockResolvedValue(createAuditResult({ passed: true, issues: [], summary: "passed" }));
      const resumed = await runner.resumeRevisionCandidate(bookId, result.candidateId!);
      expect(resumed.applied).toBe(true);
      expect(vi.mocked(ReviserAgent.prototype.reviseChapter).mock.calls.length).toBe(reviserCalls);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it.each(["always", "strict"] as const)("resumes using saved %s policy despite the new runner default", async (gate) => {
    const { root, runner, bookId } = await createRevisionGateFixture(gate);
    try {
      vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(createAuditResult({ passed: true, issues: [], summary: "clean" }));
      vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ passed: false, repairRequired: true, warnings: [{ category: "state-conflict", description: "invalid settlement" }] });
      const retained = await runner.reviseDraft(bookId, 1, "rework");
      expect(retained.applied).toBe(false);
      expect(retained.candidateId).toBeTruthy();
      vi.mocked(StateValidatorAgent.prototype.validate).mockResolvedValue({ passed: true, repairRequired: false, warnings: [] });
      const calls = vi.mocked(ReviserAgent.prototype.reviseChapter).mock.calls.length;
      const retry = new PipelineRunner({ client: { provider: "openai", apiFormat: "chat", stream: false, defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0 } } as ConstructorParameters<typeof PipelineRunner>[0]["client"], model: "test-model", projectRoot: root, revisionGate: gate === "always" ? "strict" : "always" });
      if (gate === "always") {
        vi.mocked(StateValidatorAgent.prototype.validate).mockResolvedValue({ passed: false, repairRequired: true, warnings: [{ category: "state-conflict", description: "invalid retry settlement" }] });
        expect((await retry.resumeRevisionCandidate(bookId, retained.candidateId!)).applied).toBe(false);
        vi.mocked(StateValidatorAgent.prototype.validate).mockResolvedValue({ passed: true, repairRequired: false, warnings: [] });
      }
      const resumed = await retry.resumeRevisionCandidate(bookId, retained.candidateId!);
      expect(resumed.applied).toBe(gate === "always");
      expect(vi.mocked(ReviserAgent.prototype.reviseChapter).mock.calls.length).toBe(calls);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("requires legacy policy before model work and retains the explicit selection after failed settlement", async () => {
    const { root, runner, state, bookId } = await createRevisionGateFixture("strict");
    try {
      vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue(createAuditResult({ passed: true, issues: [], summary: "clean" }));
      vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ passed: false, repairRequired: true, warnings: [{ category: "state-conflict", description: "invalid" }] });
      const retained = await runner.reviseDraft(bookId, 1, "rework");
      const evidencePath = join(state.bookDir(bookId), "story", "recovery", "candidates", retained.candidateId!, "candidate.json");
      const legacy = JSON.parse(await readFile(evidencePath, "utf8"));
      legacy.version = 1;
      delete legacy.publicationPolicy;
      const bytes = JSON.stringify(legacy);
      await writeFile(evidencePath, bytes, "utf8");
      const auditCalls = vi.mocked(ContinuityAuditor.prototype.auditChapter).mock.calls.length;
      const settlementCalls = vi.mocked(WriterAgent.prototype.settleChapterState).mock.calls.length;
      await expect(runner.resumeRevisionCandidate(bookId, retained.candidateId!)).rejects.toMatchObject({ reasonCode: "CANDIDATE_POLICY_REQUIRED" });
      expect(vi.mocked(ContinuityAuditor.prototype.auditChapter).mock.calls.length).toBe(auditCalls);
      expect(vi.mocked(WriterAgent.prototype.settleChapterState).mock.calls.length).toBe(settlementCalls);
      expect((await runner.resumeRevisionCandidate(bookId, retained.candidateId!, { legacyRevisionGate: "always" })).applied).toBe(false);
      await expect(runner.resumeRevisionCandidate(bookId, retained.candidateId!, { legacyRevisionGate: "strict" })).rejects.toThrow("CANDIDATE_POLICY_CONFLICT");
      vi.mocked(StateValidatorAgent.prototype.validate).mockResolvedValue({ passed: true, repairRequired: false, warnings: [] });
      expect((await runner.resumeRevisionCandidate(bookId, retained.candidateId!)).applied).toBe(true);
      expect(await readFile(evidencePath, "utf8")).toBe(bytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("applies a no-improvement manual revision when revisionGate is lenient", async () => {
    const { root, runner, bookId, chaptersDir, revisedBody } = await createRevisionGateFixture("lenient");

    // Same warning before and after: strict would reject (no improvement),
    // lenient applies because nothing worsened.
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: false, issues: [GATE_WARNING_ISSUE], summary: "needs revision" }))
      .mockResolvedValueOnce(createAuditResult({ passed: false, issues: [GATE_WARNING_ISSUE], summary: "still weak" }));

    try {
      const result = await runner.reviseDraft(bookId, 1);
      const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");

      expect(result.applied).toBe(true);
      expect(result.skippedReason).toBeUndefined();
      expect(savedChapter).toContain(revisedBody);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("rejects a worsening manual revision under the lenient gate and reports the lenient standard", async () => {
    const { root, runner, bookId, chaptersDir, revisedBody } = await createRevisionGateFixture("lenient");

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: false, issues: [GATE_WARNING_ISSUE], summary: "needs revision" }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        issues: [GATE_WARNING_ISSUE, CRITICAL_ISSUE],
        summary: "worse",
      }));

    try {
      const result = await runner.reviseDraft(bookId, 1);
      const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");

      expect(result.applied).toBe(false);
      expect(result.skippedReason).toContain("Manual revision kept original chapter");
      expect(result.revisionDiagnostics?.standard).toContain("lenient gate");
      expect(result.revisionDiagnostics?.after.criticalCount).toBe(1);
      expect(savedChapter).not.toContain(revisedBody);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("always applies manual revisions when revisionGate is always, even when the audit worsens", async () => {
    const { root, runner, state, bookId, chaptersDir, revisedBody } = await createRevisionGateFixture("always");
    const { rename } = await import("node:fs/promises");
    await rename(join(chaptersDir, "0001_Test_Chapter.md"), join(chaptersDir, "1-retained.md"));
    await writeFile(join(chaptersDir, "10-retained.md"), "Chapter ten stays intact", "utf8");

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: false, issues: [GATE_WARNING_ISSUE], summary: "needs revision" }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        issues: [GATE_WARNING_ISSUE, CRITICAL_ISSUE],
        summary: "worse",
      }));

    try {
      const result = await runner.reviseDraft(bookId, 1);
      const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(result.applied).toBe(true);
      expect(savedChapter).toContain(revisedBody);
      await expect(readFile(join(chaptersDir, "1-retained.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(chaptersDir, "10-retained.md"), "utf8")).toBe("Chapter ten stays intact");
      const versions = await listChapterVersions(state.bookDir(bookId), 1);
      expect(versions).toHaveLength(1);
      await expect(readChapterVersion(state.bookDir(bookId), 1, versions[0]!.id))
        .resolves.toContain("林越推门进去");
      // Audit metrics are still recorded — the failing audit lands in the index
      // instead of blocking the user's explicit revision.
      expect(savedIndex[0]?.status).toBe("audit-failed");
      expect(savedIndex[0]?.auditIssues).toContain("[critical] Fix the chapter state");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("runs an explicit rework even when the current chapter already passes audit", async () => {
    const { root, runner, bookId, chaptersDir, revisedBody } = await createRevisionGateFixture("always");

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "clean" }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "clean alternative" }));

    try {
      const result = await runner.reviseDraft(
        bookId,
        1,
        "rework",
        "保留事实，但重新组织整章冲突。",
      );
      const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");

      expect(result.applied).toBe(true);
      expect(savedChapter).toContain(revisedBody);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("publishes verified middle-chapter truth and invalidates downstream state while retaining bodies", async () => {
    const { root, runner, state, bookId, chaptersDir, revisedBody } = await createRevisionGateFixture("always");
    const storyDir = join(state.bookDir(bookId), "story");
    const latestState = "# Current State\n\nThe second chapter is already complete.";
    const latestHooks = "# Pending Hooks\n\n- H2 remains active after chapter 2.";
    await Promise.all([
      writeFile(
        join(chaptersDir, "0002_Later_Chapter.md"),
        "# 第2章 Later Chapter\n\n第二章已经发生。",
        "utf-8",
      ),
      writeFile(join(storyDir, "current_state.md"), latestState, "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), latestHooks, "utf-8"),
    ]);
    const index = await state.loadChapterIndex(bookId);
    await state.saveChapterIndex(bookId, [
      ...index,
      {
        number: 2,
        title: "Later Chapter",
        status: "ready-for-review",
        wordCount: 8,
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "clean" }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, issues: [], summary: "clean alternative" }));

    try {
      const result = await runner.reviseDraft(
        bookId,
        1,
        "rework",
        "重写第一章，但不要假装第二章尚未发生。",
      );
      const savedChapter = await readFile(join(chaptersDir, "0001_Test_Chapter.md"), "utf-8");
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(result.applied).toBe(true);
      expect(savedChapter).toContain(revisedBody);
      const current = await readFile(join(storyDir, "current_state.md"), "utf8");
      expect(current).not.toBe(latestState);
      await expect(readFile(join(storyDir, "snapshots", "1", "current_state.md"), "utf8")).resolves.toBe(current);
      await expect(readFile(join(chaptersDir, "0002_Later_Chapter.md"), "utf8")).resolves.toContain("Later Chapter");
      expect(savedIndex[0]?.status).toBe("ready-for-review");
      expect(savedIndex[1]?.status).toBe("state-degraded");
      await expect(stat(join(storyDir, "snapshots", "2"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("re-audits revisions against updated state overrides instead of stale on-disk truth files", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const originalBody = "Taryn kept one hand on the annexe key and listened at the door.";
    const revisedBody = `${originalBody}\n\nHe checked the seal again before he moved.`;

    await state.saveBookConfig(bookId, {
      ...(await state.loadBookConfig(bookId)),
      platform: "other",
      genre: "progression",
      language: "en",
      chapterWordCount: 1800,
    });

    await Promise.all([
      writeFile(join(chaptersDir, "0001_First.md"), `# Chapter 1: First\n\nOpening chapter.`, "utf-8"),
      writeFile(join(chaptersDir, "0002_Test_Chapter.md"), `# Chapter 2: Test Chapter\n\n${originalBody}`, "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Orsden archive lower hall",
        protagonistState: "Taryn is still moving under Renn's first warning.",
        goal: "Reach the annexe.",
        conflict: "The archive is already compromised.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [
      {
        number: 1,
        title: "First",
        status: "ready-for-review",
        wordCount: countChapterLength("Opening chapter.", "en_words"),
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      },
      {
        number: 2,
        title: "Test Chapter",
        status: "audit-failed",
        wordCount: countChapterLength(originalBody, "en_words"),
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      },
    ]);

    const auditChapter = vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [{
            severity: "warning",
            category: "Pacing Check",
            description: "The beat needs a firmer end stop.",
            suggestion: "Tighten the closing move.",
          }],
          summary: "needs revision",
        }),
      )
      .mockImplementationOnce(async (_bookDir, _chapterContent, chapterNumber, _genre, options) => {
        const overrideState = (options as { truthFileOverrides?: { currentState?: string } } | undefined)
          ?.truthFileOverrides?.currentState;
        if (chapterNumber === 2 && overrideState?.includes("| Current Chapter | 2 |")) {
          return createAuditResult({
            passed: true,
            issues: [],
            summary: "clean",
          });
        }

        return createAuditResult({
          passed: false,
          issues: [{
            severity: "critical",
            category: "Chronicle Drift Check",
            description: "The chapter is presented as 'chapter 2', but the supplied Current State Card still lists 'Current Chapter | 1'.",
            suggestion: "Sync the state card before re-audit.",
          }],
          summary: "stale state card",
        });
      });

    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: countChapterLength(revisedBody, "en_words"),
        fixedIssues: ["- Synced the annexe beat and tightened the ending."],
      }),
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 1);
      const result = await runner.reviseDraft(bookId, 2);
      const savedIndex = await state.loadChapterIndex(bookId);

      expect(auditChapter).toHaveBeenCalledTimes(2);
      expect(result.applied).toBe(true);
      expect(result.status).toBe("ready-for-review");
      expect(savedIndex[1]?.status).toBe("ready-for-review");
      expect(savedIndex[1]?.auditIssues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, SLOW_PIPELINE_TEST_TIMEOUT_MS);

  it("excludes pure sequence-level fatigue from revision blocker counts", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const book = await state.loadBookConfig(bookId);

    await writeFile(join(storyDir, "chapter_summaries.md"), [
      "# 章节摘要",
      "",
      "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| 1 | 旧门 | 林越 | 进入旧门 | 压力升高 | none | 冷峻 | 调查 |",
      "| 2 | 灰灯 | 林越 | 检查灰灯 | 压力升高 | none | 冷峻 | 调查 |",
      "| 3 | 纸页 | 林越 | 对照纸页 | 压力升高 | none | 冷峻 | 调查 |",
      "",
    ].join("\n"), "utf-8");

    const result = await (
      runner as unknown as {
        evaluateMergedAudit: (params: {
          auditor: Pick<ContinuityAuditor, "auditChapter">;
          book: BookConfig;
          bookDir: string;
          chapterContent: string;
          chapterNumber: number;
          language: "zh" | "en";
        }) => Promise<{
          auditResult: AuditResult;
          aiTellCount: number;
          blockingCount: number;
          criticalCount: number;
        }>;
      }
    ).evaluateMergedAudit({
      auditor: {
        auditChapter: vi.fn().mockResolvedValue(
          createAuditResult({
            passed: true,
            issues: [],
            summary: "clean",
          }),
        ),
      },
      book,
      bookDir,
      chapterContent: "林越把纸页摊平，先看角上的水痕，再看最末那道被抹掉的签名。",
      chapterNumber: 3,
      language: "zh",
    });

    expect(result.auditResult.issues.some((issue) => issue.category === "节奏单调")).toBe(true);
    expect(result.blockingCount).toBe(0);
    expect(result.criticalCount).toBe(0);

    await rm(root, { recursive: true, force: true });
  });

  it("keeps chapter-level blockers even when sequence-level fatigue shares the same category label", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const book = await state.loadBookConfig(bookId);

    await writeFile(join(storyDir, "chapter_summaries.md"), [
      "# 章节摘要",
      "",
      "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| 1 | 旧门 | 林越 | 进入旧门 | 压力升高 | none | 冷峻 | 调查 |",
      "| 2 | 灰灯 | 林越 | 检查灰灯 | 压力升高 | none | 冷峻 | 调查 |",
      "| 3 | 纸页 | 林越 | 对照纸页 | 压力升高 | none | 冷峻 | 调查 |",
      "",
    ].join("\n"), "utf-8");

    const result = await (
      runner as unknown as {
        evaluateMergedAudit: (params: {
          auditor: Pick<ContinuityAuditor, "auditChapter">;
          book: BookConfig;
          bookDir: string;
          chapterContent: string;
          chapterNumber: number;
          language: "zh" | "en";
        }) => Promise<{
          auditResult: AuditResult;
          aiTellCount: number;
          blockingCount: number;
          criticalCount: number;
        }>;
      }
    ).evaluateMergedAudit({
      auditor: {
        auditChapter: vi.fn().mockResolvedValue(
          createAuditResult({
            passed: false,
            issues: [{
              severity: "warning",
              category: "节奏单调",
              description: "这一章的推进依然原地打转，没有完成当前场景应有的落点。",
              suggestion: "让当前章把既定动作落下，不要继续停在同一观察节拍。",
            }],
            summary: "needs revision",
          }),
        ),
      },
      book,
      bookDir,
      chapterContent: "林越把纸页摊平，先看角上的水痕，再看最末那道被抹掉的签名。",
      chapterNumber: 3,
      language: "zh",
    });

    expect(result.auditResult.issues.filter((issue) => issue.category === "节奏单调")).toHaveLength(2);
    expect(result.blockingCount).toBe(1);
    expect(result.criticalCount).toBe(0);

    await rm(root, { recursive: true, force: true });
  });

  it("uses chapter length telemetry target for manual revise when available", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const storyDir = join(state.bookDir(bookId), "story");
    const chaptersDir = join(state.bookDir(bookId), "chapters");
    const originalBody = "Tarin waited by the crooked berth marker and counted the missing lines twice.";
    const revisedBody = `${originalBody}\n\nHe did not move until the second bell rang across the water.`;

    await state.saveBookConfig(bookId, {
      ...(await state.loadBookConfig(bookId)),
      platform: "other",
      genre: "progression",
      language: "en",
      chapterWordCount: 1800,
    });

    await Promise.all([
      writeFile(join(chaptersDir, "0001_Test_Chapter.md"), `# Chapter 1: Test Chapter\n\n${originalBody}`, "utf-8"),
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        chapter: 1,
        location: "Dock Nine",
        protagonistState: "Tarin still carries the sealed packet.",
        goal: "Find Captain Voss.",
        conflict: "The berth is wrong and the crew is missing.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);
    await state.saveChapterIndex(bookId, [{
      number: 1,
      title: "Test Chapter",
      status: "audit-failed",
      wordCount: countChapterLength(originalBody, "en_words"),
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
      lengthTelemetry: {
        target: 900,
        softMin: 778,
        softMax: 1022,
        hardMin: 655,
        hardMax: 1145,
        countingMode: "en_words",
        writerCount: countChapterLength(originalBody, "en_words"),
        postReviseCount: 0,
        finalCount: countChapterLength(originalBody, "en_words"),
        repairApplied: false,
        lengthWarning: false,
      },
    }]);

    vi.spyOn(ContinuityAuditor.prototype, "auditChapter")
      .mockResolvedValueOnce(
        createAuditResult({
          passed: false,
          issues: [CRITICAL_ISSUE],
          summary: "needs revision",
        }),
      )
      .mockResolvedValueOnce(
        createAuditResult({
          passed: true,
          issues: [],
          summary: "clean",
        }),
      );

    const reviseChapter = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue(
      createReviseOutput({
        revisedContent: revisedBody,
        wordCount: countChapterLength(revisedBody, "en_words"),
        fixedIssues: ["- Tightened the berth discovery beat."],
      }),
    );

    try {
      await snapshotRevisionBaseline(state, bookId, 0);
      await runner.reviseDraft(bookId, 1, "polish");

      expect(reviseChapter).toHaveBeenCalledTimes(1);
      expect(reviseChapter.mock.calls[0]?.[6]?.lengthSpec).toMatchObject({
        target: 900,
        countingMode: "en_words",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
