import { describe, expect, it, vi } from "vitest";
import { StateValidatorAgent, type StateValidationDiagnostic } from "../agents/state-validator.js";
import * as worker from "../agent/worker-agent.js";

describe("validator request preparation", () => {
  it("records the final hydrated messages before sending without duplicating guidance on correction", async () => {
    const events: StateValidationDiagnostic[] = [];
    const sent: unknown[] = [];
    const run = vi.spyOn(worker, "runWorkerAgent").mockImplementation(async (_client, _model, messages) => {
      const latest = events.at(-1);
      expect(latest?.phase).toBe("request");
      if (latest?.phase === "request") expect(latest.messages).toEqual(messages);
      const system = messages.find((message) => message.role === "system")!.content;
      expect(system.match(/Unique activated methodology/g)).toHaveLength(1);
      expect(system.match(/Unique reference material/g)).toHaveLength(1);
      sent.push(messages);
      return { content: sent.length === 1 ? "invalid" : "PASS", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    });
    try {
      const agent = new StateValidatorAgent({
        client: {} as never, model: "test", projectRoot: process.cwd(),
        activatedSkills: [{ skill: { id: "evidence-method", name: "Evidence method", description: "Method", body: "Unique activated methodology", source: "project" } as never,
          resources: [{ path: "reference.md", charStart: 0, charEnd: 25, body: "Unique reference material" }] }],
      });
      await expect(agent.validate("Body", 1, "old", "new", "", "", "en", undefined, { onDiagnostic: (event) => { events.push(event); } })).resolves.toMatchObject({ passed: true });
      expect(sent).toHaveLength(2);
      expect(events.map((event) => event.phase)).toEqual(["request", "response", "request", "response"]);
    } finally { run.mockRestore(); }
  });
});
