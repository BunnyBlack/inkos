import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureCandidateInputs, createRecoveryCandidate, loadRecoveryCandidate, assertCandidateInputs, discardRecoveryCandidate, listRecoveryCandidates, resolveCandidatePublicationPolicy } from "../pipeline/recovery-candidate.js";
let dir: string;
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
it.each(["strict", "lenient", "always"] as const)("persists the %s publication gate in version 2", async (revisionGate) => {
  const candidate = await createRecoveryCandidate(dir, { chapter: 1, mode: "rework", publicationPolicy: { revisionGate }, inputs: await captureCandidateInputs(dir, 1), output: { revisedContent: "candidate", fixedIssues: [], wordCount: 9 } });
  expect(await loadRecoveryCandidate(dir, candidate.candidateId)).toMatchObject({ version: 2, publicationPolicy: { revisionGate } });
  expect(await listRecoveryCandidates(dir)).toEqual([expect.objectContaining({ publicationPolicy: { revisionGate }, policySource: "candidate" })]);
  await expect(resolveCandidatePublicationPolicy(dir, candidate, { legacyRevisionGate: revisionGate })).rejects.toThrow("CANDIDATE_POLICY_OVERRIDE_FORBIDDEN");
});
it("keeps version 1 evidence unchanged and durably requires an explicit policy", async () => {
  const candidate = await createRecoveryCandidate(dir, { chapter: 1, mode: "rework", publicationPolicy: { revisionGate: "always" }, inputs: await captureCandidateInputs(dir, 1), output: { revisedContent: "candidate", fixedIssues: [], wordCount: 9 } });
  const evidencePath = join(dir, "story", "recovery", "candidates", candidate.candidateId, "candidate.json");
  const legacy = { ...candidate, version: 1, publicationPolicy: undefined };
  const evidence = JSON.stringify(legacy);
  await writeFile(evidencePath, evidence, "utf8");
  const loaded = await loadRecoveryCandidate(dir, candidate.candidateId);
  expect(loaded.version).toBe(1);
  expect(await listRecoveryCandidates(dir)).toEqual([expect.objectContaining({ policySource: "missing", issue: "CANDIDATE_POLICY_REQUIRED" })]);
  await expect(resolveCandidatePublicationPolicy(dir, loaded)).rejects.toThrow("CANDIDATE_POLICY_REQUIRED");
  expect(await resolveCandidatePublicationPolicy(dir, loaded, { legacyRevisionGate: "lenient" })).toEqual({ revisionGate: "lenient" });
  const reloaded = await loadRecoveryCandidate(dir, candidate.candidateId);
  expect(await resolveCandidatePublicationPolicy(dir, reloaded)).toEqual({ revisionGate: "lenient" });
  expect(await resolveCandidatePublicationPolicy(dir, reloaded, { legacyRevisionGate: "lenient" })).toEqual({ revisionGate: "lenient" });
  await expect(resolveCandidatePublicationPolicy(dir, reloaded, { legacyRevisionGate: "always" })).rejects.toThrow("CANDIDATE_POLICY_CONFLICT");
  expect(await readFile(evidencePath, "utf8")).toBe(evidence);
  expect(await listRecoveryCandidates(dir)).toEqual([expect.objectContaining({ publicationPolicy: { revisionGate: "lenient" }, policySource: "legacy-selection" })]);
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "candidate-"));
  await mkdir(join(dir, "chapters"));
  await mkdir(join(dir, "story", "snapshots", "0"), { recursive: true });
  await writeFile(join(dir, "chapters", "0001_test.md"), "# Heading\n\nbody", "utf8");
  await writeFile(join(dir, "story", "snapshots", "0", "current_state.md"), "state", "utf8");
  await writeFile(join(dir, "story", "book_rules.md"), "rules", "utf8");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
it("retains prose and verifies all revision inputs", async () => {
  const inputs = await captureCandidateInputs(dir, 1, "instruction");
  const candidate = await createRecoveryCandidate(dir, { chapter: 1, mode: "rework", publicationPolicy: { revisionGate: "strict" }, externalContext: "instruction", inputs, output: { revisedContent: "candidate", fixedIssues: [], wordCount: 9 } });
  expect((await loadRecoveryCandidate(dir, candidate.candidateId)).output.revisedContent).toBe("candidate");
  assertCandidateInputs(candidate, await captureCandidateInputs(dir, 1, "instruction"));
  await writeFile(join(dir, "story", "book_rules.md"), "edited", "utf8");
  expect(() => assertCandidateInputs(candidate, { ...inputs, controlHash: "changed" })).toThrow("CANDIDATE_INPUTS_CHANGED");
  expect((await captureCandidateInputs(dir, 1, "instruction")).controlHash).not.toBe(inputs.controlHash);
  expect(await readFile(join(dir, "chapters", "0001_test.md"), "utf8")).toBe("# Heading\n\nbody");
});
it("detects baseline and heading-only body changes", async () => {
  const inputs = await captureCandidateInputs(dir, 1, "instruction");
  await writeFile(join(dir, "story", "snapshots", "0", "current_state.md"), "new", "utf8");
  expect((await captureCandidateInputs(dir, 1, "instruction")).baselineHash).not.toBe(inputs.baselineHash);
  await writeFile(join(dir, "chapters", "0001_test.md"), "# Edited\n\nbody", "utf8");
  expect((await captureCandidateInputs(dir, 1, "instruction")).sourceHash).not.toBe(inputs.sourceHash);
});
it("hashes the same unpadded body selected by recovery without prefix collisions", async () => {
  const before = await captureCandidateInputs(dir, 1);
  await fs.rename(join(dir, "chapters", "0001_test.md"), join(dir, "chapters", "1-test.md"));
  await writeFile(join(dir, "chapters", "00010_later.md"), "different chapter", "utf8");
  expect((await captureCandidateInputs(dir, 1)).sourceHash).toBe(before.sourceHash);
});
it("keeps final legacy policy absent after a partial write and permits an explicit retry", async () => {
  const candidate = await createRecoveryCandidate(dir, { chapter: 1, mode: "rework", publicationPolicy: { revisionGate: "always" }, inputs: await captureCandidateInputs(dir, 1), output: { revisedContent: "candidate", fixedIssues: [], wordCount: 9 } });
  const folder = join(dir, "story", "recovery", "candidates", candidate.candidateId);
  const evidence = JSON.stringify({ ...candidate, version: 1, publicationPolicy: undefined });
  await writeFile(join(folder, "candidate.json"), evidence, "utf8");
  const legacy = await loadRecoveryCandidate(dir, candidate.candidateId);
  const actualOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
  let injected = false;
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await actualOpen(...args);
    if (!injected && String(args[0]).includes("publication-policy")) {
      injected = true;
      const actualWrite = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementation(async () => {
        await actualWrite('{"version":', "utf8");
        throw new Error("injected policy write failure");
      });
    }
    return handle;
  });
  await expect(resolveCandidatePublicationPolicy(dir, legacy, { legacyRevisionGate: "lenient" })).rejects.toThrow("injected policy write failure");
  await expect(readFile(join(folder, "publication-policy.json"))).rejects.toMatchObject({ code: "ENOENT" });
  openSpy.mockRestore();
  expect(await resolveCandidatePublicationPolicy(dir, legacy, { legacyRevisionGate: "lenient" })).toEqual({ revisionGate: "lenient" });
  expect(await readFile(join(folder, "candidate.json"), "utf8")).toBe(evidence);
});
it("retains corrupt existing policy evidence and rejects explicit reselection", async () => {
  const candidate = await createRecoveryCandidate(dir, { chapter: 1, mode: "rework", publicationPolicy: { revisionGate: "always" }, inputs: await captureCandidateInputs(dir, 1), output: { revisedContent: "candidate", fixedIssues: [], wordCount: 9 } });
  const folder = join(dir, "story", "recovery", "candidates", candidate.candidateId);
  await writeFile(join(folder, "candidate.json"), JSON.stringify({ ...candidate, version: 1, publicationPolicy: undefined }), "utf8");
  const path = join(folder, "publication-policy.json");
  await writeFile(path, '{"version":', "utf8");
  await expect(resolveCandidatePublicationPolicy(dir, await loadRecoveryCandidate(dir, candidate.candidateId), { legacyRevisionGate: "always" })).rejects.toMatchObject({ reasonCode: "CANDIDATE_POLICY_INVALID" });
  expect(await readFile(path, "utf8")).toBe('{"version":');
});
it("discard prevents resume without changing published body", async () => {
  const candidate = await createRecoveryCandidate(dir, { chapter: 1, mode: "auto", publicationPolicy: { revisionGate: "strict" }, inputs: await captureCandidateInputs(dir, 1), output: { revisedContent: "candidate", fixedIssues: [], wordCount: 9 } });
  await discardRecoveryCandidate(dir, candidate.candidateId);
  expect(await listRecoveryCandidates(dir)).toEqual([expect.objectContaining({ candidateId: candidate.candidateId, chapter: 1, status: "discarded" })]);
  await expect(loadRecoveryCandidate(dir, candidate.candidateId)).rejects.toThrow("CANDIDATE_DISCARDED");
  await expect(loadRecoveryCandidate(dir, "../escape")).rejects.toThrow("INVALID_CANDIDATE_ID");
});

it("lists complete candidates alongside incomplete or corrupt artifacts without modifying them", async () => {
  const candidate = await createRecoveryCandidate(dir, { chapter: 1, mode: "auto", publicationPolicy: { revisionGate: "strict" }, inputs: await captureCandidateInputs(dir, 1), output: { revisedContent: "candidate", fixedIssues: [], wordCount: 9 } });
  const root = join(dir, "story", "recovery", "candidates");
  const missing = "11111111-1111-4111-8111-111111111111";
  const truncated = "22222222-2222-4222-8222-222222222222";
  const invalidId = "interrupted-candidate";
  for (const id of [missing, truncated, invalidId]) await mkdir(join(root, id));
  await writeFile(join(root, truncated, "candidate.json"), '{"version":', "utf8");
  const entriesBefore = await readdir(root);
  const listed = await listRecoveryCandidates(dir);
  expect(listed).toHaveLength(4);
  expect(listed.find(entry => entry.candidateId === candidate.candidateId)).toMatchObject({ chapter: 1, status: "pending" });
  for (const id of [missing, truncated, invalidId]) {
    expect(listed.find(entry => entry.candidateId === id)).toMatchObject({ chapter: null, createdAt: null, status: "invalid", issue: expect.any(String) });
  }
  expect(await readdir(root)).toEqual(entriesBefore);
  expect(await readdir(join(root, missing))).toEqual([]);
  expect(await readdir(join(root, invalidId))).toEqual([]);
  expect(await readFile(join(root, truncated, "candidate.json"), "utf8")).toBe('{"version":');
});
