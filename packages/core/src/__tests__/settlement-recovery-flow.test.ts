import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StateValidatorAgent } from "../agents/state-validator.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import { validateRecordedSettlement, retrySettlementAfterValidationFailure } from "../pipeline/chapter-state-recovery.js";
import { loadSettlementAttempt, readSettlementEvents } from "../pipeline/settlement-attempt.js";

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it("carries corrected raw evidence through recorded settlement repair without changing prose", async () => {
  const temp = resolve(import.meta.dirname, "../../../../temp");
  await mkdir(temp, { recursive: true });
  root = await mkdtemp(join(temp, "settlement-flow-"));
  await mkdir(join(root, "story"));
  await mkdir(join(root, "chapters"));
  const content = "甲走上楼梯。\r\n\r\n乙留在门口。";
  const body = join(root, "chapters", "0001_example.md");
  await writeFile(body, content, "utf8");
  const output: WriteChapterOutput = {
    chapterNumber: 1, title: "Example", content, wordCount: 12,
    preWriteCheck: "", postSettlement: "", updatedState: "甲的位置：地底",
    updatedLedger: "", updatedHooks: "", chapterSummary: "Example",
    updatedSubplots: "", updatedEmotionalArcs: "", updatedCharacterMatrix: "",
    postWriteErrors: [], postWriteWarnings: [],
  };
  const issue = {
    category: "contradiction", description: "The current location is stale.",
    blocking: true, kind: "conflict", basis: "explicit", rationale: "The chapter describes the move.",
    target: "candidate-state", evidence: [
      { source: "candidate-state", quote: output.updatedState },
      { source: "chapter", quote: "甲走上楼梯。乙留在门口。" },
    ],
  };
  const invalidReply = JSON.stringify({ verdict: "REPAIR", issues: [{ ...issue, evidence: [
    issue.evidence[0], { source: "chapter", quote: "Invented missing quotation" },
  ] }] });
  const validReply = JSON.stringify({ verdict: "REPAIR", issues: [issue] });
  const validator = new StateValidatorAgent({ client: {} as never, model: "stub", projectRoot: root });
  const chat = vi.spyOn(validator as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
    .mockResolvedValueOnce({ content: invalidReply })
    .mockResolvedValueOnce({ content: validReply })
    .mockResolvedValueOnce({ content: "PASS" });
  const recording = { inputs: { sourceHash: "source", baselineHash: "baseline", controlHash: "control" },
    context: { baselineChapter: 0 }, resumable: true };
  const original = await validateRecordedSettlement({ validator, bookDir: root, chapterNumber: 1,
    content, output, oldState: "before", oldHooks: "", language: "zh", recording });
  expect(original.validation.issues?.[0]?.evidence[1]?.quote).toBe(content);
  let receivedFeedback = "";
  const settle = vi.fn(async (input: { content: string; validationFeedback?: string }) => {
    receivedFeedback = input.validationFeedback ?? "";
    return { ...output, content: input.content, updatedState: "甲的位置：楼梯" };
  });
  const repaired = await retrySettlementAfterValidationFailure({
    writer: { settleChapterState: settle }, validator, book: {} as never, bookDir: root,
    chapterNumber: 1, title: output.title, content, oldState: "before", oldHooks: "",
    originalValidation: original.validation, previousSettlement: output, language: "zh",
    recording, parentAttemptId: original.attempt.attemptId, verifiedFeedback: true,
  });
  expect(repaired.kind).toBe("recovered");
  expect(settle).toHaveBeenCalledTimes(1);
  expect(chat).toHaveBeenCalledTimes(3);
  expect(receivedFeedback).toContain(content);
  expect(receivedFeedback).toContain("conflict/explicit");
  expect((await readFile(body, "utf8"))).toBe(content);
  const parentEvents = await readSettlementEvents(root, original.attempt.attemptId);
  expect(parentEvents.filter(event => event.type === "validator-response").map(event => (event.data as { response: string }).response))
    .toEqual([invalidReply, validReply]);
  expect(repaired.attemptId).not.toBe(original.attempt.attemptId);
  const child = await loadSettlementAttempt(root, repaired.attemptId!);
  expect(child).toMatchObject({ parentAttemptId: original.attempt.attemptId, status: "validated" });
  expect(child.output.content).toBe(content);
});
