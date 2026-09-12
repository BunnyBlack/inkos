import { describe, expect, it } from "vitest";
import {
  buildSettlementInspection,
  type SettlementInspectionSource,
} from "../pipeline/settlement-inspection.js";

const attemptId = "11111111-1111-4111-8111-111111111111";
const parentAttemptId = "22222222-2222-4222-8222-222222222222";

function event(
  sequence: number,
  type: string,
  data: Record<string, unknown>,
): SettlementInspectionSource["events"][number] {
  return {
    version: 1,
    attemptId,
    eventId: `33333333-3333-4333-8333-${String(sequence).padStart(12, "0")}`,
    sequence,
    recordedAt: `2026-09-12T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    type,
    data,
  };
}

function source(events: SettlementInspectionSource["events"]): SettlementInspectionSource {
  return {
    attempt: {
      version: 1,
      attemptId,
      parentAttemptId,
      createdAt: "2026-09-12T00:00:00.000Z",
      chapter: 1,
      inputs: { sourceHash: "source-hash", baselineHash: "baseline-hash", controlHash: "control-hash" },
      context: { baselineChapter: 0 },
      output: {
        chapterNumber: 1,
        title: "Synthetic candidate",
        content: "The candidate body is preserved.",
        updatedState: "candidate state",
        updatedHooks: "candidate hooks",
      },
      resumable: true,
      status: "rejected",
      reasonCode: "SETTLEMENT_REPAIR_REQUIRED",
    } as SettlementInspectionSource["attempt"],
    events,
  };
}

describe("settlement inspection projection", () => {
  it("shows all seven current-candidate opinions with trust and response provenance without model requests", () => {
    const firstResponse = JSON.stringify({ issues: [
      { issueIndex: 1, category: "continuity", description: "Old first issue", blocking: true },
      { issueIndex: 2, category: "hook", description: "Old second issue", blocking: false },
      { issueIndex: 3, category: "state", description: "Old third issue", blocking: true },
    ] });
    const secondResponse = JSON.stringify({ issues: [
      { issueIndex: 1, category: "continuity", description: "First issue", blocking: true },
      { issueIndex: 2, category: "hook", description: "Second issue", blocking: true },
      { issueIndex: 3, category: "state", description: "Third issue", blocking: false },
      { issueIndex: 7, category: "protocol", description: "Seventh issue", blocking: false },
    ] });
    const result = buildSettlementInspection(source([
      event(1, "validator-request", { messages: [{ role: "user", content: "current request" }] }),
      event(2, "validator-response", { response: firstResponse }),
      event(3, "validator-request", { messages: [{ role: "user", content: "correction request" }] }),
      event(4, "validator-response", { response: secondResponse }),
      event(5, "rejected", { passed: false, repairRequired: true, issues: [
        { issueIndex: 1, category: "continuity", description: "First issue", blocking: true },
        { issueIndex: 2, category: "hook", description: "Second issue", blocking: true },
        { issueIndex: 3, category: "state", description: "Third issue", blocking: false },
        { issueIndex: 4, category: "continuity", description: "Fourth issue", blocking: true },
        { issueIndex: 5, category: "hook", description: "Fifth issue", blocking: false },
        { issueIndex: 6, category: "state", description: "Sixth issue", blocking: true },
        { issueIndex: 7, category: "protocol", description: "Seventh issue", blocking: false },
      ] }),
    ]), { view: "overview" });

    expect(result.view).toBe("overview");
    expect(result.opinions).toHaveLength(7);
    expect(result.opinions.map(issue => issue.description)).toEqual([
      "First issue", "Second issue", "Third issue", "Fourth issue", "Fifth issue", "Sixth issue", "Seventh issue",
    ]);
    expect(result.opinions.every(issue => issue.trustStatus === "verified")).toBe(true);
    expect(result.opinions.every(issue => issue.validatorResponseEventId?.startsWith("33333333-"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("current request");
    expect(result).toMatchObject({ attemptId, parentAttemptId, inputs: { sourceHash: "source-hash" }, status: "rejected" });
  });

  it("returns one complete candidate without request logs and paginates diagnostics", () => {
    const input = source([
      event(1, "validation-input", { content: "chapter text" }),
      event(2, "validator-request", { messages: [{ role: "user", content: "request" }] }),
      event(3, "validator-response", { response: JSON.stringify({ issues: [{ description: "issue" }] }) }),
    ]);
    const candidate = buildSettlementInspection(input, { view: "candidate" });
    expect(candidate.view).toBe("candidate");
    expect(candidate.candidate).toMatchObject({ output: { content: "The candidate body is preserved." }, status: "rejected" });
    expect(candidate.candidate).not.toHaveProperty("content");
    expect(JSON.stringify(candidate)).not.toContain("request");

    const firstPage = buildSettlementInspection(input, { view: "diagnostics" });
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.limit).toBe(2);
    expect(firstPage.nextCursor).toBe(2);
    const lastPage = buildSettlementInspection(input, { view: "diagnostics", cursor: 2, limit: 10 });
    expect(lastPage.events).toHaveLength(1);
    expect(lastPage.nextCursor).toBeUndefined();
    expect(lastPage.events[0]?.data).toMatchObject({ response: expect.any(String) });
  });

  it("keeps malformed raw replies visible as protocol-invalid rawOnly and reads old failure fields", () => {
    const result = buildSettlementInspection(source([
      event(1, "validator-response", { response: "not json" }),
      event(2, "rejected", { reasonCode: "VALIDATOR_PROTOCOL_INVALID", error: "invalid response" }),
    ]));
    expect(result.finalError).toBe("invalid response");
    expect(result.responses[0]).toMatchObject({ rawOnly: true, trustStatus: "protocol-invalid" });
    expect(result.opinions).toHaveLength(0);
  });

  it("treats a plain PASS plus a validated event as certified with zero opinions", () => {
    const result = buildSettlementInspection(source([
      event(1, "validator-response", { response: "PASS" }),
      event(2, "validated", { passed: true, warnings: [] }),
    ]));
    expect(result.opinions).toEqual([]);
    expect(result.latestResponse).toMatchObject({ hasValidation: true });
    expect(result.responses[0]).toMatchObject({ rawOnly: false, opinionCount: 0 });
  });
});
