import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = vi.hoisted(() => ({ root: "" }));
const mocks = vi.hoisted(() => ({ log: vi.fn(), error: vi.fn(), config: vi.fn(), recover: vi.fn(), resume: vi.fn(), discard: vi.fn() }));
vi.mock("@actalk/inkos-core", async (original) => ({
  ...await original<typeof import("@actalk/inkos-core")>(),
  PipelineRunner: class { recoverChapters = mocks.recover; resumeRevisionCandidate = mocks.resume; resumeSettlementAttempt = mocks.resume; },
  discardRecoveryCandidate: mocks.discard,
}));
vi.mock("../utils.js", async (original) => ({
  ...await original<typeof import("../utils.js")>(),
  findProjectRoot: () => fixture.root,
  resolveBookId: async (id?: string) => id ?? "fixture",
  loadConfig: mocks.config,
  buildPipelineConfig: () => ({}),
  log: mocks.log,
  logError: mocks.error,
}));

describe("write recovery commands", () => {
  it("resumes a settlement with explicit action and reports failure details", async () => {
    mocks.resume.mockResolvedValue({ status: "failed", attemptId: "attempt-one", reasonCode: "SETTLEMENT_NO_PROGRESS", issues: ["Unproven consent"] });
    await run("resume-settlement", "fixture", "attempt-one", "--action", "revalidate", "--json");
    expect(mocks.resume).toHaveBeenCalledWith("fixture", "attempt-one", "revalidate");
    expect(JSON.parse(mocks.log.mock.calls.at(-1)![0])).toMatchObject({ reasonCode: "SETTLEMENT_NO_PROGRESS", issues: ["Unproven consent"] });
    expect(process.exitCode).toBe(1);
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    process.exitCode = 0;
    const temp = fileURLToPath(new URL("../../../../temp/", import.meta.url));
    await mkdir(temp, { recursive: true });
    fixture.root = await mkdtemp(join(temp, "cli-recovery-"));
    const book = join(fixture.root, "books/fixture");
    await mkdir(join(book, "story/snapshots/0"), { recursive: true });
    await mkdir(join(book, "chapters"));
    await writeFile(join(book, "book.json"), JSON.stringify({ id: "fixture", language: "en" }), "utf8");
    for (const name of ["current_state.md", "pending_hooks.md"]) await writeFile(join(book, "story/snapshots/0", name), "initial", "utf8");
    await writeFile(join(book, "chapters/0001_fixture.md"), "retained body", "utf8");
    await writeFile(join(book, "chapters/index.json"), JSON.stringify([{ number: 1, status: "state-degraded" }]), "utf8");
    mocks.config.mockResolvedValue({});
  });
  afterEach(async () => { process.exitCode = 0; await rm(fixture.root, { recursive: true, force: true }); });
  async function run(...args: string[]) {
    vi.resetModules();
    const { writeCommand } = await import("../commands/write.js");
    writeCommand.exitOverride();
    await writeCommand.parseAsync(["node", "write", ...args], { from: "node" });
  }
  it("inspects the real retained chapter without loading model configuration", async () => {
    await run("recovery-status", "fixture", "--chapter", "1", "--json");
    expect(JSON.parse(mocks.log.mock.calls.at(-1)![0])).toMatchObject({ health: { stateFrontier: 0, pendingChapters: [1] }, plan: { baseline: 0, steps: [{ chapter: 1 }] } });
    expect(mocks.config).not.toHaveBeenCalled();
  });
  it("recovers a transaction without loading model configuration", async () => {
    const { withBookTransaction } = await import("../../../core/dist/state/book-transaction.js");
    const book = join(fixture.root, "books/fixture");
    await expect(withBookTransaction(book, async () => {
      await writeFile(join(book, "book.json"), "partial", "utf8");
      throw new Error("interrupted");
    }, { leavePendingOnError: true })).rejects.toThrow();
    await run("recover-transaction", "fixture", "--json");
    expect(mocks.config).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.log.mock.calls.at(-1)![0])).toMatchObject({ status: "applied" });
    expect(JSON.parse(await readFile(join(book, "book.json"), "utf8")).id).toBe("fixture");
  });
  it("dry-runs recovery without changing the body or constructing a model", async () => {
    await run("recover", "fixture", "1", "--dry-run", "--json");
    expect(JSON.parse(mocks.log.mock.calls.at(-1)![0]).plan.preservesBodies).toBe(true);
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(await readFile(join(fixture.root, "books/fixture/chapters/0001_fixture.md"), "utf8")).toBe("retained body");
  });
  it("returns a nonzero exit code for blocked execution", async () => {
    mocks.recover.mockResolvedValue({ status: "blocked", reasonCode: "BASELINE_MISSING", completed: [], plan: {} });
    await run("recover", "fixture", "1", "--json");
    expect(mocks.recover).toHaveBeenCalledWith("fixture", 1);
    expect(process.exitCode).toBe(1);
  });
  it("resumes the requested candidate and reports unapplied settlement as failure", async () => {
    mocks.resume.mockResolvedValue({ applied: false, candidateId: "candidate-1" });
    await run("resume-candidate", "fixture", "candidate-1", "--json");
    expect(mocks.resume).toHaveBeenCalledWith("fixture", "candidate-1");
    expect(process.exitCode).toBe(1);
  });
  it("passes an explicit legacy policy without changing the default resume contract", async () => {
    mocks.resume.mockResolvedValue({ applied: true });
    await run("resume-candidate", "fixture", "candidate-1", "--legacy-revision-gate", "always");
    expect(mocks.resume).toHaveBeenCalledWith("fixture", "candidate-1", { legacyRevisionGate: "always" });
  });
  it("preserves candidate failure metadata in JSON and human-readable errors", async () => {
    mocks.resume.mockRejectedValue(Object.assign(new Error("validator parse failed"), { candidateId: "candidate-1", reasonCode: "CANDIDATE_VALIDATION_FAILED", stage: "validation" }));
    await run("resume-candidate", "fixture", "candidate-1", "--json");
    expect(JSON.parse(mocks.log.mock.calls.at(-1)![0])).toMatchObject({ candidateId: "candidate-1", reasonCode: "CANDIDATE_VALIDATION_FAILED", stage: "validation" });
    await run("resume-candidate", "fixture", "candidate-1");
    expect(mocks.error.mock.calls.at(-1)![0]).toContain("candidate-1");
  });
  it("discards only the named candidate under the book lock without model configuration", async () => {
    mocks.discard.mockImplementation(async (bookDir: string) => {
      expect(await readFile(join(bookDir, ".write.lock"), "utf8")).toContain("token");
    });
    await run("discard-candidate", "fixture", "candidate-1", "--json");
    expect(mocks.discard).toHaveBeenCalledWith(join(fixture.root, "books", "fixture"), "candidate-1");
    expect(mocks.config).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.log.mock.calls.at(-1)![0])).toMatchObject({ status: "discarded", candidateId: "candidate-1", preservesBodies: true });
    expect(await readFile(join(fixture.root, "books/fixture/chapters/0001_fixture.md"), "utf8")).toBe("retained body");
  });
});
