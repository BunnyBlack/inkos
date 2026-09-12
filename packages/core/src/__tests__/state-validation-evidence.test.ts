import { describe, expect, it, vi } from "vitest";
import { StateValidatorAgent } from "../agents/state-validator.js";

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
