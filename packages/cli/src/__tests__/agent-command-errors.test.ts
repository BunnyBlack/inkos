import { afterEach, describe, expect, it, vi } from "vitest";

const { log, logError, runAgentSessionMock } = vi.hoisted(() => ({
  log: vi.fn(),
  logError: vi.fn(),
  runAgentSessionMock: vi.fn(),
}));
vi.mock("@actalk/inkos-core", () => ({
  PipelineRunner: class {},
  hasFailedOperationOutcomes: (outcomes: any[] | undefined) => outcomes?.some((item) => item.status === "failed" || item.status === "blocked") ?? false,
  runAgentSession: runAgentSessionMock,
}));
vi.mock("../utils.js", () => ({
  buildPipelineConfig: () => ({}), loadConfig: async () => ({ llm: { model: "test" } }),
  createClient: () => ({ _piModel: { id: "test" } }),
  findProjectRoot: () => "E:/Repo/inkos/temp/unused",
  resolveBookId: async (id: string) => id, resolveContext: async () => undefined,
  log, logError,
}));

import { agentCommand } from "../commands/agent.js";

describe("agent command failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runAgentSessionMock.mockReset();
  });

  it("emits a JSON error and exits nonzero when the session guard stops a turn", async () => {
    runAgentSessionMock.mockResolvedValue({
      responseText: "",
      messages: [],
      errorMessage: "Agent loop guard: read failed 3 times.",
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("test process exit"); });
    await expect(agentCommand.parseAsync(["List the directory.", "--json"], { from: "user" }))
      .rejects.toThrow("test process exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).error).toContain("Agent loop guard");
  });

  it("keeps the assistant response and candidate ID when a business operation fails", async () => {
    runAgentSessionMock.mockResolvedValue({
      responseText: "结算未完成，但候选已保留。",
      messages: [{ role: "toolResult", details: { candidateId: "candidate-7" } }, { role: "assistant", content: "结算未完成，但候选已保留。" }],
      operationOutcomes: [{ bookId: "harbor", chapterNumber: 2, toolCallId: "repair", status: "failed", reasonCode: "SETTLEMENT_NO_PROGRESS" }],
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("test process exit"); });

    await expect(agentCommand.parseAsync(["repair", "--json"], { from: "user" }))
      .rejects.toThrow("test process exit");

    const payload = JSON.parse(log.mock.calls.at(-1)![0]);
    expect(payload.result.responseText).toContain("候选已保留");
    expect(payload.result.operationOutcomes[0].reasonCode).toBe("SETTLEMENT_NO_PROGRESS");
    expect(payload.candidateIds).toEqual(["candidate-7"]);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
