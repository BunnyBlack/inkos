import { describe, expect, it } from "vitest";
import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import { buildSettlerSystemPrompt, buildSettlerUserPrompt } from "../agents/settler-prompts.js";

const BOOK: BookConfig = {
  id: "settler-prompt-book",
  title: "钟不撒谎",
  platform: "other",
  genre: "mystery",
  status: "active",
  targetChapters: 20,
  chapterWordCount: 2500,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

const GENRE: GenreProfile = {
  id: "mystery",
  name: "悬疑",
  language: "zh",
  chapterTypes: ["调查"],
  fatigueWords: [],
  numericalSystem: false,
  powerScaling: false,
  eraResearch: false,
  pacingRule: "",
  satisfactionTypes: [],
  auditDimensions: [],
};

describe("settler hook identity contract", () => {
  it("keeps the complete rejected candidate separate from the trusted baseline and untrusted feedback", () => {
    const previousSettlement: WriteChapterOutput = {
      chapterNumber: 1, title: "One", content: "Mira notices a hidden letter.", wordCount: 6,
      preWriteCheck: "check", postSettlement: "candidate notes", updatedState: "candidate state",
      updatedLedger: "candidate ledger", updatedHooks: "candidate hooks", chapterSummary: "candidate summary",
      updatedChapterSummaries: "all summaries", updatedSubplots: "subplots", updatedEmotionalArcs: "arcs",
      updatedCharacterMatrix: "matrix", postWriteErrors: [], postWriteWarnings: [],
      runtimeStateDelta: { chapter: 1, currentStatePatch: {}, hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [], subplotOps: [], emotionalArcOps: [], characterMatrixOps: [], notes: [] },
    };
    const prompt = buildSettlerUserPrompt({
      chapterNumber: 1, title: "One", content: previousSettlement.content, currentState: "trusted state", ledger: "",
      hooks: "trusted hooks", chapterSummaries: "", subplotBoard: "", emotionalArcs: "", characterMatrix: "", volumeOutline: "",
      previousSettlement, validationFeedback: "Claim Mira agreed to cooperate.",
    });
    expect(prompt).toContain(JSON.stringify(previousSettlement, null, 2));
    expect(prompt).toContain("## 可信基线");
    expect(prompt).toContain("## 待修复候选（未发布）");
    expect(prompt).toContain("## 状态校验反馈（待核实意见）");
    expect(prompt).toContain("先逐项核对反馈是否有正文依据");
    expect(prompt).toContain("保留候选中未受影响且有依据的信息");
    expect(prompt).toContain("不得把候选当作已发布状态或可信基线");
    expect(prompt).toContain("不要为了满足反馈添加正文未支持的事实");
  });
  it.each(["zh", "en"] as const)("renders independent settlement guidance in %s", language => {
    const input = {
      chapterNumber: 1, title: "One", content: "Body", currentState: "State", ledger: "", hooks: "Hooks",
      chapterSummaries: "", subplotBoard: "", emotionalArcs: "", characterMatrix: "", volumeOutline: "", language,
      settlementGuidance: "Keep the token in the coat",
    };
    const prompt = buildSettlerUserPrompt(input);
    expect(prompt).toContain(input.settlementGuidance);
    expect(prompt).toContain(language === "en" ? "persisted chapter text" : "已保存正文");
    expect(buildSettlerUserPrompt({ ...input, settlementGuidance: "   " })).toBe(buildSettlerUserPrompt({ ...input, settlementGuidance: undefined }));
  });
  it("assigns semantic identity to the settler and keeps host admission structural", () => {
    const prompt = buildSettlerSystemPrompt(BOOK, GENRE, null, "zh");

    expect(prompt).toContain("语义相关的休眠种子");
    expect(prompt).toContain("必须复用它已有的 hookId");
    expect(prompt).toContain("宿主只校验结构");
    expect(prompt).not.toContain("由系统决定它是映射到旧 hook");
  });

  it("labels supplied hooks as active or semantically relevant dormant canon", () => {
    const prompt = buildSettlerUserPrompt({
      chapterNumber: 1,
      title: "慢了十一分钟",
      content: "孙玉珍抱钟进店。",
      currentState: "# 当前状态",
      ledger: "",
      hooks: "| H012 | deferred | 孙玉珍家座钟被回拨 |",
      chapterSummaries: "(文件尚未创建)",
      subplotBoard: "(文件尚未创建)",
      emotionalArcs: "(文件尚未创建)",
      characterMatrix: "(文件尚未创建)",
      volumeOutline: "# 第一卷",
    });

    expect(prompt).toContain("含活跃伏笔与本章语义相关的休眠种子");
    expect(prompt).toContain("H012");
  });
});
