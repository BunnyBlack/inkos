import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateRecordedSettlement, retrySettlementAfterValidationFailure, settlementFailure, buildStateValidationFeedback } from "../pipeline/chapter-state-recovery.js";
import { listSettlementAttempts, loadSettlementAttempt, readSettlementEvents, createSettlementAttempt, appendSettlementEvent } from "../pipeline/settlement-attempt.js";
import type { WriteChapterOutput } from "../agents/writer.js";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link) };
});
let book: string;
const output: WriteChapterOutput = {
  chapterNumber: 1, title: "Synthetic chapter", content: "Retained prose", wordCount: 2,
  preWriteCheck: "checked", postSettlement: "settled", updatedState: "candidate state", updatedLedger: "ledger",
  updatedHooks: "hooks", chapterSummary: "summary", updatedSubplots: "subplots", updatedEmotionalArcs: "arcs",
  updatedCharacterMatrix: "matrix", postWriteErrors: [], postWriteWarnings: [],
};
beforeEach(async () => {
  const temp = resolve(import.meta.dirname, "../../../../temp");
  await fs.mkdir(temp, { recursive: true });
  book = await fs.mkdtemp(join(temp, "settlement-evidence-failure-"));
  await fs.mkdir(join(book, "story"));
  await fs.mkdir(join(book, "chapters"));
  await fs.writeFile(join(book, "story", "current_state.md"), "published state\r\n", "utf8");
  await fs.writeFile(join(book, "chapters", "0001_retained.md"), "retained body\r\n", "utf8");
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(book, { recursive: true, force: true }); });

it("renders grounded issue details without turning observations into repair commands", () => {
  const feedback = buildStateValidationFeedback({
    passed: false,
    repairRequired: true,
    warnings: [{ category: "observation", description: "The token may be missing." }],
    issues: [{ category: "observation", description: "The token may be missing.", blocking: false,
      kind: "observation", basis: "ambiguous", rationale: "The chapter leaves the detail unresolved.",
      evidence: [{ source: "chapter", quote: "retained body" }] }],
  }, "en");
  expect(feedback).toContain("observation; do not invent facts");
  expect(feedback).toContain("ambiguous");
  expect(feedback).toContain("chapter: retained body");
  expect(feedback).not.toContain("Fix these contradictions");
  expect(buildStateValidationFeedback({ passed: false, repairRequired: true, warnings: [] }, "en")).toBe("");
});

it("records classified validator diagnostics and stops blind repair for protocol failures", async () => {
  const validatorFailure = Object.assign(new Error("protocol response invalid"), {
    reasonCode: "VALIDATOR_PROTOCOL_INVALID", diagnosticPath: "diagnostics/validator-2-response.json",
  });
  const result = await validateRecordedSettlement({
    validator: { validate: vi.fn(async () => { throw validatorFailure; }) },
    bookDir: book, chapterNumber: 1, content: output.content, output,
    oldState: "published state", oldHooks: "old hooks", language: "en",
    recording: { inputs: { sourceHash: "source", baselineHash: "baseline", controlHash: "control" }, resumable: true, context: { baselineChapter: 0 } },
  }).then(() => { throw new Error("Must not return protocol failure as validation"); }, error => error);

  const attempts = await listSettlementAttempts(book);
  const events = await readSettlementEvents(book, attempts[0]!.attemptId);
  expect(result).toMatchObject({ reasonCode: "VALIDATOR_PROTOCOL_INVALID", stage: "validation",
    failureKind: "protocol", diagnosticPath: validatorFailure.diagnosticPath, attemptId: attempts[0]!.attemptId });
  expect(result.message).toBe("protocol response invalid");
  expect(events.at(-1)).toMatchObject({ type: "rejected", data: {
    reasonCode: "VALIDATOR_PROTOCOL_INVALID", error: "protocol response invalid", failureKind: "protocol",
    diagnosticPath: validatorFailure.diagnosticPath,
  } });
  expect(settlementFailure(result)).toMatchObject({ reasonCode: "VALIDATOR_PROTOCOL_INVALID", failureKind: "protocol",
    diagnosticPath: validatorFailure.diagnosticPath, nextActions: ["inspect-settlement", "revalidate"] });
});

it.each(["automatic-retry", "direct-append"] as const)("keeps the latest child ID when the final %s rejection log cannot be saved", async path => {
  const recording = { inputs: { sourceHash: "source", baselineHash: "baseline", controlHash: "control" }, resumable: true, context: { baselineChapter: 0 } };
  const parent = await createSettlementAttempt(book, { chapter: 1, output, ...recording });
  const validation = { passed: false, repairRequired: true, warnings: [{ category: "missing", description: "Missing state fact" }] };
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const diskError = Object.assign(new Error("final rejection log is full"), { code: "ENOSPC" });
  vi.mocked(fs.link).mockImplementation(async (...args) => {
    if (String(args[1]).replaceAll("\\", "/").includes("/events/000000000003-")) throw diskError;
    return actual.link(...args);
  });
  let error: any;
  try {
    if (path === "automatic-retry") {
      await retrySettlementAfterValidationFailure({
        writer: { settleChapterState: vi.fn(async () => output) }, validator: { validate: vi.fn(async () => validation) },
        book: {} as never, bookDir: book, chapterNumber: 1, title: output.title, content: output.content,
        oldState: "baseline", oldHooks: "old hooks", originalValidation: validation, previousSettlement: output,
        language: "en", recording, parentAttemptId: parent.attemptId,
      });
    } else {
      const child = await validateRecordedSettlement({ validator: { validate: vi.fn(async () => validation) },
        bookDir: book, chapterNumber: 1, content: output.content, output, oldState: "baseline", oldHooks: "old hooks",
        language: "en", recording, parentAttemptId: parent.attemptId });
      await appendSettlementEvent(book, child.attempt.attemptId, { type: "rejected", data: { ...validation, reasonCode: "SETTLEMENT_NO_PROGRESS" } });
    }
  } catch (failure) { error = failure; }
  const child = (await listSettlementAttempts(book)).find(attempt => attempt.parentAttemptId === parent.attemptId)!;
  expect(child).toMatchObject({ status: "rejected", resumable: true });
  expect(error).toMatchObject({ reasonCode: "SETTLEMENT_EVIDENCE_WRITE_FAILED", stage: "evidence", attemptId: child.attemptId });
  expect(error.cause).toBe(diskError);
  expect(error.attemptId).not.toBe(parent.attemptId);
  expect(settlementFailure(error)).toMatchObject({ stage: "evidence", attemptId: child.attemptId, nextActions: ["inspect-settlement", "revalidate", "repair"] });
  expect((await loadSettlementAttempt(book, child.attemptId)).output).toEqual(output);
  expect(await fs.readFile(join(book, "story", "current_state.md"), "utf8")).toBe("published state\r\n");
});

it.each(["validator", "evidence"] as const)("retains attempt and both causes when rejection logging fails after %s failure", async failureStage => {
  const original = Object.assign(new Error("original validator failure"), { reasonCode: "VALIDATOR_PROTOCOL_INVALID" });
  const firstDiskFailure = Object.assign(new Error("first evidence write failed"), { code: "EIO" });
  const rejectionDiskFailure = Object.assign(new Error("rejection write failed"), { code: "ENOSPC" });
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let inject = false;
  let failures = 0;
  vi.mocked(fs.link).mockImplementation(async (...args) => {
    if (inject && String(args[1]).replaceAll("\\", "/").includes("/events/")) {
      failures++;
      throw failureStage === "evidence" && failures === 1 ? firstDiskFailure : rejectionDiskFailure;
    }
    return actual.link(...args);
  });
  const result = await validateRecordedSettlement({
    validator: { validate: vi.fn(async () => {
      inject = true;
      if (failureStage === "validator") throw original;
      return { passed: true, warnings: [] };
    }) },
    bookDir: book, chapterNumber: 1, content: output.content, output,
    oldState: "published state", oldHooks: "old hooks", language: "en",
    recording: { inputs: { sourceHash: "source", baselineHash: "baseline", controlHash: "control" }, resumable: true, context: { baselineChapter: 0 } },
  }).then(() => { throw new Error("Must not return publishable validation"); }, error => error);
  const attempts = await listSettlementAttempts(book);
  expect(attempts).toHaveLength(1);
  expect(result).toMatchObject({ reasonCode: "SETTLEMENT_EVIDENCE_WRITE_FAILED", stage: "evidence", attemptId: attempts[0]!.attemptId });
  if (failureStage === "validator") expect(result.cause).toBe(original);
  else expect(result.cause.cause).toBe(firstDiskFailure);
  expect(result.evidenceCause.cause).toBe(rejectionDiskFailure);
  expect((await loadSettlementAttempt(book, attempts[0]!.attemptId)).output).toEqual(output);
  expect((await readSettlementEvents(book, attempts[0]!.attemptId)).map(event => event.type)).toEqual(["validation-input"]);
  expect(await fs.readFile(join(book, "story", "current_state.md"), "utf8")).toBe("published state\r\n");
  expect(await fs.readFile(join(book, "chapters", "0001_retained.md"), "utf8")).toBe("retained body\r\n");
  await expect(fs.stat(join(book, "chapters", ".settlement-receipts"))).rejects.toMatchObject({ code: "ENOENT" });
});
