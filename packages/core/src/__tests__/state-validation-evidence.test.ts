import { describe, expect, it, vi } from "vitest";
import { StateValidatorAgent } from "../agents/state-validator.js";
import { checkValidationEvidence, resolveEvidenceQuote, type GroundedValidationIssue } from "../agents/state-validation-evidence.js";

const chapter = "Mira noticed the hidden seal. She did not answer the offer.";
const state = "Mira noticed the hidden seal.";
function setup(...responses: string[]) {
  const agent = new StateValidatorAgent({ client: {} as never, model: "test", projectRoot: process.cwd() });
  const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat");
  for (const content of responses) chat.mockResolvedValueOnce({ content });
  return { agent, chat };
}
function issue(overrides = {}) {
  return { category: "contradiction", description: "Candidate claims an answer was given.", blocking: true,
    basis: "explicit", kind: "conflict", rationale: "Silence contradicts the claimed agreement.",
    evidence: [{ source: "chapter", quote: "She did not answer the offer." }, { source: "candidate-state", quote: "Mira agreed." }], ...overrides };
}
describe("grounded validator feedback", () => {
  it.each([
    ["Mira \n  agreed.", "Mira agreed."],
    ["甲。 \r\n乙。", "甲。 乙。"],
  ])("preserves matching whitespace prefixes when resolving layout: %s", (source, quote) => {
    expect(resolveEvidenceQuote(source, quote)).toMatchObject({ text: source, mode: "layout" });
  });
  it("maps only the requested span and rejects two valid layout locations", () => {
    expect(resolveEvidenceQuote("前文。\n甲。\n乙。", "甲。乙。"))
      .toEqual({ start: 4, end: 9, text: "甲。\n乙。", mode: "layout" });
    expect(resolveEvidenceQuote("甲。\n乙。甲。\r\n乙。", "甲。乙。")).toBeUndefined();
    expect(resolveEvidenceQuote("not  now", "not now")).toBeUndefined();
  });
  it("resolves exact and layout-only quotes to the complete original source span", () => {
    expect(resolveEvidenceQuote("甲走上楼梯。乙留在门口。", "甲走上楼梯。乙留在门口。"))
      .toEqual({ start: 0, end: 12, text: "甲走上楼梯。乙留在门口。", mode: "exact" });
    expect(resolveEvidenceQuote("甲走上楼梯。\r\n\r\n乙留在门口。", "甲走上楼梯。乙留在门口。"))
      .toMatchObject({ text: "甲走上楼梯。\r\n\r\n乙留在门口。", mode: "layout" });
    expect(resolveEvidenceQuote("甲走上楼梯。\r\n  乙留在门口。", "甲走上楼梯。\n乙留在门口。"))
      .toMatchObject({ text: "甲走上楼梯。\r\n  乙留在门口。", mode: "layout" });
    expect(resolveEvidenceQuote("not\r\n now", "not now"))
      .toMatchObject({ text: "not\r\n now", mode: "layout" });
  });

  it.each([
    ["not now", "notnow"],
    ["Mira did not agree.", "Mira did agree."],
    ["甲走上楼梯。", "甲走上楼梯!"],
    ["甲没\n同意。", "甲没同意。"],
    ["甲离开。未答应。乙留下。", "甲离开。乙留下。"],
    ["Echo.\r\nEcho.\r\nEcho.", "Echo.Echo."],
  ])("rejects quote changes, omitted content, or ambiguous matches: %s -> %s", (source, quote) => {
    expect(resolveEvidenceQuote(source, quote)).toBeUndefined();
  });

  it("accepts internal conflicts only with two distinct candidate quotes and normalizes layout evidence", () => {
    const issues = [{
      category: "candidate-conflict", description: "Candidate state disagrees with candidate hooks.", blocking: true,
      basis: "explicit" as const, kind: "internal-conflict" as const,
      rationale: "The candidate state and candidate hooks contain incompatible explicit facts.",
      evidence: [
        { source: "candidate-state" as const, quote: "状态：门口" },
        { source: "candidate-state" as const, quote: "状态：楼梯" },
      ],
    }];
    const normalized = checkValidationEvidence(issues, {
      chapter: "正文",
      "candidate-state": "状态：门口\r\n状态：楼梯",
      "candidate-hooks": "候选钩子",
      baseline: "基线",
      authority: "权威",
    });
    expect(normalized[0]?.evidence[0]).toMatchObject({ quote: "状态：门口" });
  });

  it.each([
    [[{ source: "candidate-state", quote: "状态：门口" }]],
    [[{ source: "candidate-state", quote: "状态：门口" }, { source: "candidate-state", quote: "状态：门口" }]],
  ])("rejects internal conflicts without two distinct candidate evidence quotes", (rawEvidence) => {
    const evidence = rawEvidence as GroundedValidationIssue["evidence"];
    const issue = {
      category: "candidate-conflict", description: "Candidate conflict", blocking: true,
      basis: "explicit" as const, kind: "internal-conflict" as const,
      rationale: "Two candidate facts are required.", evidence,
    };
    expect(() => checkValidationEvidence([issue], {
      chapter: "正文", "candidate-state": "状态：门口", "candidate-hooks": "状态：楼梯",
      baseline: "基线", authority: "权威",
    })).toThrow(/internal-conflict|candidate evidence/i);
  });

  it.each(["inference", "ambiguous"] as const)("rejects internal conflicts with basis %s", (basis) => {
    const issue = {
      category: "candidate-conflict", description: "Candidate conflict", blocking: true,
      basis, kind: "internal-conflict" as const,
      rationale: "Candidate facts are only inferred.", evidence: [
        { source: "candidate-state" as const, quote: "状态：门口" },
        { source: "candidate-hooks" as const, quote: "状态：楼梯" },
      ],
    };
    expect(() => checkValidationEvidence([issue], {
      chapter: "正文", "candidate-state": "状态：门口", "candidate-hooks": "状态：楼梯",
      baseline: "基线", authority: "权威",
    })).toThrow(/explicit|inference|ambiguity/i);
  });

  it("completes legacy blocking evidence with only one validator correction", async () => {
    const { agent, chat } = setup("REPAIR\n[missing] Missing agreement", "PASS");
    const result = await agent.validate(chapter, 1, "old", state, "", "", "en");
    expect(result.passed).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(chat.mock.calls[1])).toContain("Do not infer consent");
  });
  it("keeps directly evidenced contradictions blocking", async () => {
    const { agent, chat } = setup(JSON.stringify({ verdict: "FAIL", issues: [issue()] }));
    const result = await agent.validate(chapter, 1, "old", "Mira agreed.", "", "", "en");
    expect(result).toMatchObject({ passed: false, repairRequired: false, issues: [issue()] });
    expect(chat).toHaveBeenCalledTimes(1);
  });
  it.each([
    issue({ evidence: [{ source: "chapter", quote: "Mira agreed." }] }),
    issue({ basis: "inference" }),
    issue({ kind: "omission", target: "candidate-state", evidence: [{ source: "candidate-state", quote: "Mira agreed." }] }),
  ])("does not turn invalid evidence or inference into an executable repair", async (bad) => {
    const reply = JSON.stringify({ verdict: "REPAIR", issues: [bad] });
    const { agent, chat } = setup(reply, reply);
    await expect(agent.validate(chapter, 1, "old", "Mira agreed.", "", "", "en"))
      .rejects.toMatchObject({ reasonCode: "VALIDATOR_EVIDENCE_INVALID" });
    expect(chat).toHaveBeenCalledTimes(2);
  });
  it("accepts an omission with a chapter quote and explicit check target", async () => {
    const omission = issue({ kind: "omission", target: "candidate-state", evidence: [{ source: "chapter", quote: "Mira noticed the hidden seal." }] });
    const { agent } = setup(JSON.stringify({ verdict: "REPAIR", issues: [omission] }));
    await expect(agent.validate(chapter, 1, "old", "unchanged", "", "", "en")).resolves.toMatchObject({ repairRequired: true });
  });
  it("checks completeness when candidate is unchanged", async () => {
    const { agent, chat } = setup("PASS");
    await agent.validate(chapter, 1, state, state, "", "", "en");
    expect(chat).toHaveBeenCalledTimes(1);
  });
  it("records each request before sending and raw response before parsing", async () => {
    const { agent, chat } = setup("broken", "PASS");
    const events: any[] = [];
    await agent.validate(chapter, 1, "old", state, "", "", "en", undefined, {
      onDiagnostic: (event: any) => { events.push(event); if (event.phase === "request") expect(chat.mock.calls).toHaveLength(event.attempt - 1); },
    });
    expect(events.map((event) => event.phase)).toEqual(["request", "response", "request", "response"]);
    expect(events[1].response).toBe("broken");
    expect(events[0].messages[1].content).toContain(state);
    expect(events[0].messages).toHaveLength(2);
  });
  it("stops before model request when evidence persistence fails", async () => {
    const { agent, chat } = setup("PASS");
    const failure = new Error("disk full");
    await expect(agent.validate(chapter, 1, "old", state, "", "", "en", undefined, {
      onDiagnostic: () => { throw failure; },
    })).rejects.toBe(failure);
    expect(chat).not.toHaveBeenCalled();
  });
  it("stops malformed protocol after one correction", async () => {
    const { agent, chat } = setup("broken", "broken");
    await expect(agent.validate(chapter, 1, "old", state, "", "", "en")).rejects.toMatchObject({ reasonCode: "VALIDATOR_PROTOCOL_INVALID" });
    expect(chat).toHaveBeenCalledTimes(2);
  });
  it.each(["PASS\nFAIL", '{"passed":true,"repairRequired":true}', '{"verdict":"PASS","issues":[],"passed":false}',
    '{"passed":true}\n{"passed":false}', 'FAIL\n{"passed":true}', '{"passed":true}\nFAIL'])
    ("rejects inconsistent verdicts: %s", async (content) => {
      const { agent } = setup(content, content);
      await expect(agent.validate(chapter, 1, "old", state, "", "", "en")).rejects.toMatchObject({ reasonCode: "VALIDATOR_PROTOCOL_INVALID" });
    });
  it("does not treat explicitly blocking legacy PASS warnings as approval", async () => {
    const { agent } = setup("PASS\n[unsupported_change] Candidate contains unsupported facts", "PASS");
    const events: any[] = [];
    await agent.validate(chapter, 1, "old", state, "", "", "en", undefined, { onDiagnostic: (e) => { events.push(e); } });
    expect(events).toHaveLength(4);
  });
  it.each([
    { verdict: "PASS", issues: [], warnings: [{ category: "contradiction", description: "State contradicts chapter" }] },
    { verdict: "PASS", issues: [], warnings: [] },
    { verdict: "PASS", issues: [], passed: true },
    { verdict: "PASS", issues: [], repairRequired: false },
  ])("rejects mixed structured and legacy verdict fields without dropping feedback", async (mixed) => {
    const reply = JSON.stringify(mixed);
    const { agent, chat } = setup(reply, reply);
    await expect(agent.validate(chapter, 1, "old", state, "", "", "en")).rejects.toMatchObject({ reasonCode: "VALIDATOR_PROTOCOL_INVALID" });
    expect(chat).toHaveBeenCalledTimes(2);
  });
});
