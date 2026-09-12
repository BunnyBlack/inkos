import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateValidatorAgent } from "../agents/state-validator.js";

let root: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }); });
it("retains a malformed validator reply with a diagnostic path without storing the request", async () => {
  root = await mkdtemp(join(tmpdir(), "validator-diagnostic-"));
  const agent = new StateValidatorAgent({ projectRoot: root, bookId: "sample", model: "test", client: {} as never });
  vi.spyOn(agent as never as { chat: () => Promise<unknown> }, "chat").mockResolvedValue({ content: "invalid protocol reply" });
  let caught: any;
  try { await agent.validate("A lantern was lit.", 1, "old", "new", "hooks", "updated hooks", "en"); }
  catch (error) { caught = error; }
  expect(caught.reasonCode).toBe("VALIDATOR_PROTOCOL_INVALID");
  const raw = await readFile(caught.diagnosticPath, "utf8");
  expect(raw).toContain("invalid protocol reply");
  expect(raw).not.toContain("A lantern was lit.");
});
