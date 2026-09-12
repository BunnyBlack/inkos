import { describe, expect, it } from "vitest";
import {
  createOperationOutcomeCollector,
  hasFailedOperationOutcomes,
  type AgentOperationOutcome,
} from "../agent/operation-outcomes.js";

describe("agent operation outcomes", () => {
  it("collects a structured failed result even when the tool transport succeeded", () => {
    const collector = createOperationOutcomeCollector();

    collector.observeToolStart("repair", "resume_settlement_attempt", {
      bookId: "harbor",
      chapterNumber: 2,
    });
    collector.observeToolEnd("repair", "resume_settlement_attempt", {
      details: {
        kind: "settlement_recovery",
        bookId: "harbor",
        chapterNumber: 2,
        status: "failed",
        reasonCode: "SETTLEMENT_NO_PROGRESS",
        attemptId: "attempt-2",
      },
    }, false);

    expect(collector.getOutcomes()).toEqual([{
      bookId: "harbor",
      chapterNumber: 2,
      toolCallId: "repair",
      status: "failed",
      attemptId: "attempt-2",
      reasonCode: "SETTLEMENT_NO_PROGRESS",
    }]);
    expect(hasFailedOperationOutcomes(collector.getOutcomes())).toBe(true);
  });

  it("keeps multi-chapter results and clears only the same chapter after success", () => {
    const collector = createOperationOutcomeCollector();

    collector.observeToolEnd("batch", "sub_agent", {
      details: {
        kind: "chapters_written",
        bookId: "harbor",
        chapters: [
          { chapterNumber: 1, status: "ready-for-review" },
          { chapterNumber: 2, status: "audit-failed" },
        ],
      },
    }, false);
    collector.observeToolEnd("recover", "recover_chapters", {
      details: {
        kind: "chapter_recovery",
        bookId: "harbor",
        completed: [1],
        failedChapter: 2,
        attemptId: "attempt-2",
      },
    }, false);
    collector.observeToolEnd("resync", "resync_chapter_state", {
      details: {
        kind: "chapter_state_resynced",
        bookId: "harbor",
        chapterNumber: 2,
        status: "audit-failed",
      },
    }, false);

    expect(collector.getOutcomes()).toEqual([
      expect.objectContaining({ bookId: "harbor", chapterNumber: 1, status: "applied" }),
      expect.objectContaining({ bookId: "harbor", chapterNumber: 2, status: "applied", toolCallId: "resync" }),
    ] satisfies AgentOperationOutcome[]);
  });

  it("does not create outcomes for read or settlement inspection results", () => {
    const collector = createOperationOutcomeCollector();

    collector.observeToolEnd("read", "read", {
      details: { kind: "file_read", bookId: "harbor", status: "failed" },
    }, false);
    collector.observeToolEnd("inspect", "inspect_settlement_attempt", {
      details: { kind: "settlement_inspection", bookId: "harbor", status: "failed" },
    }, false);

    expect(collector.getOutcomes()).toEqual([]);
  });

  it("uses the nested publication outcome and retains a failure through cancellation", () => {
    const collector = createOperationOutcomeCollector();

    collector.observeToolEnd("write", "sub_agent", {
      details: {
        kind: "chapter_written",
        bookId: "harbor",
        chapterNumber: 3,
        status: "audit-failed",
        outcome: { status: "applied" },
      },
    }, false);
    collector.observeToolEnd("fail", "resume_settlement_attempt", {
      details: { kind: "settlement_recovery", bookId: "harbor", chapterNumber: 3, status: "failed" },
    }, false);
    collector.observeToolEnd("cancel", "resume_settlement_attempt", {
      details: { kind: "settlement_recovery", bookId: "harbor", chapterNumber: 3, status: "cancelled" },
    }, false);

    expect(collector.getOutcomes()).toEqual([
      expect.objectContaining({ bookId: "harbor", chapterNumber: 3, status: "failed", toolCallId: "fail" }),
    ]);
  });

  it("reports a thrown production operation without parsing its error text", () => {
    const collector = createOperationOutcomeCollector("harbor");

    collector.observeToolStart("write", "sub_agent", { agent: "writer", chapterNumber: 4 });
    collector.observeToolEnd("write", "sub_agent", undefined, true);

    expect(collector.getOutcomes()).toEqual([
      { bookId: "harbor", chapterNumber: 4, toolCallId: "write", status: "failed" },
    ]);
  });

  it("keeps explicit blocked status and ignores architect or auditor failures", () => {
    expect(collectorOutcome("sub_agent", { agent: "writer", bookId: "harbor", chapterNumber: 5 }, {
      details: { kind: "chapter_written", bookId: "harbor", chapterNumber: 5, status: "blocked" },
      isError: false,
    })).toEqual([expect.objectContaining({ status: "blocked" })]);
    expect(collectorOutcome("sub_agent", { agent: "architect", bookId: "harbor" }, undefined, true)).toEqual([]);
    expect(collectorOutcome("sub_agent", { agent: "auditor", bookId: "harbor" }, undefined, true)).toEqual([]);
  });

  it("tracks generic chapter mutations by resource and accepts Chinese book paths", () => {
    const collector = createOperationOutcomeCollector("港城");
    const failedArgs = { chapterNumber: 2, targetText: "old", replacementText: "new" };
    // The event API keeps the original arguments from tool_execution_start.
    collector.observeToolStart("patch-fail", "patch_chapter_text", failedArgs);
    collector.observeToolEnd("patch-fail", "patch_chapter_text", {
      details: { bookId: "港城", status: "failed", reasonCode: "PATCH_REJECTED" },
    }, false);
    collector.observeToolStart("other", "write_truth_file", { fileName: "outline/story_frame.md" });
    collector.observeToolEnd("other", "write_truth_file", {
      details: { bookId: "港城", status: "applied" },
    }, false);
    expect(collector.getOutcomes()).toEqual([
      expect.objectContaining({ status: "failed", resourceKey: "chapter:2" }),
      expect.objectContaining({ status: "applied", resourceKey: "write_truth_file:outline/story_frame.md" }),
    ]);
    collector.observeToolStart("patch-success", "patch_chapter_text", failedArgs);
    collector.observeToolEnd("patch-success", "patch_chapter_text", undefined, false);
    expect(collector.getOutcomes()).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "applied", resourceKey: "chapter:2" }),
      expect.objectContaining({ status: "applied", resourceKey: "write_truth_file:outline/story_frame.md" }),
    ]));

    const pathFailure = collectorOutcome("edit", { path: "./海港/chapters/2.md" }, undefined, true);
    expect(pathFailure).toEqual([expect.objectContaining({ bookId: "海港", status: "failed", resourceKey: "edit:海港/chapters/2.md" })]);
  });
});

function collectorOutcome(
  toolName: string,
  args: Record<string, unknown>,
  result?: unknown,
  isError = false,
) {
  const collector = createOperationOutcomeCollector();
  collector.observeToolStart("test", toolName, args);
  collector.observeToolEnd("test", toolName, result, isError);
  return collector.getOutcomes();
}
