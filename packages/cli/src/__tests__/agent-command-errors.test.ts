import { afterEach, describe, expect, it, vi } from "vitest";

const { log, logError } = vi.hoisted(() => ({ log: vi.fn(), logError: vi.fn() }));
vi.mock("@actalk/inkos-core", () => ({
  PipelineRunner: class {},
  runAgentSession: async () => ({
    responseText: "", messages: [], errorMessage: "Agent loop guard: read failed 3 times.",
  }),
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
  afterEach(() => vi.restoreAllMocks());

  it("emits a JSON error and exits nonzero when the session guard stops a turn", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("test process exit"); });
    await expect(agentCommand.parseAsync(["List the directory.", "--json"], { from: "user" }))
      .rejects.toThrow("test process exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).error).toContain("Agent loop guard");
  });
});
