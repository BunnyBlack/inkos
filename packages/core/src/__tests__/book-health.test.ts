import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";
import { createHash } from "node:crypto";
import { inspectBookHealth } from "../state/book-health.js";

let dir: string;
it.each([true, false])("diagnoses reservation-only publication, live=%s", async (live) => {
  await mkdir(join(dir, "story", "recovery"), { recursive: true });
  await writeFile(join(dir, "story", "recovery", "transaction-owner.json"), JSON.stringify({ pid: live ? process.pid : 2147483647, host: hostname(), token: "reservation" }), "utf8");
  const health = await inspectBookHealth(dir);
  expect(health.issues).toContainEqual({ code: "TRANSACTION_RECOVERY_REQUIRED" });
  expect(health.issues.some(issue => issue.code === "BOOK_BUSY")).toBe(live);
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "health-"));
  await mkdir(join(dir, "chapters"));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function snapshot(n: number) {
  const path = join(dir, "story", "snapshots", String(n));
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "current_state.md"), "state", "utf8");
  await writeFile(join(path, "pending_hooks.md"), "hooks", "utf8");
  return path;
}
async function chapters() {
  await writeFile(join(dir, "chapters", "index.json"), JSON.stringify([1, 2].map(number => ({ number, status: "audit-passed", reviewNote: JSON.stringify({ kind: "state-degraded", baseStatus: "ready-for-review", injectedIssues: [] }) }))), "utf8");
  for (const n of [1, 2]) await writeFile(join(dir, "chapters", `${n}_chapter.md`), "body", "utf8");
}
it("retains bodies and detects legacy degradation despite passed audit", async () => {
  await chapters(); await snapshot(0); await snapshot(1);
  const health = await inspectBookHealth(dir);
  expect(health.stateFrontier).toBe(0);
  expect(health.pendingChapters).toEqual([1, 2]);
  expect(await readFile(join(dir, "chapters", "2_chapter.md"), "utf8")).toBe("body");
});
it("never bridges a missing snapshot with a later snapshot", async () => {
  await chapters(); await writeFile(join(dir, "chapters", "index.json"), "[]", "utf8");
  await snapshot(0); await snapshot(2);
  expect((await inspectBookHealth(dir)).stateFrontier).toBe(0);
});
it("rejects partial snapshot zero", async () => {
  const path = await snapshot(0); await rm(join(path, "pending_hooks.md"));
  expect((await inspectBookHealth(dir)).stateFrontier).toBeNull();
});
it("rejects a stale chapter body hash", async () => {
  await chapters(); await writeFile(join(dir, "chapters", "index.json"), "[]", "utf8");
  await snapshot(0); const path = await snapshot(1);
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  await writeFile(join(path, "snapshot-manifest.json"), JSON.stringify({ schemaVersion: 1, chapter: 1, baseline: 0, bodyHash: hash("old"), files: { "current_state.md": hash("state"), "pending_hooks.md": hash("hooks") }, optionalAbsent: [] }), "utf8");
  const health = await inspectBookHealth(dir);
  expect(health.stateFrontier).toBe(0);
  expect(health.issues).toContainEqual(expect.objectContaining({ code: "SNAPSHOT_BODY_HASH_MISMATCH", chapter: 1 }));
});
it("returns pending before parsing mutable chapter files", async () => {
  await mkdir(join(dir, "story", "recovery"), { recursive: true });
  await writeFile(join(dir, "story", "recovery", "transaction.json"), JSON.stringify({ version: 1, operationId: "op", phase: "publishing" }), "utf8");
  await writeFile(join(dir, "chapters", "index.json"), "{broken", "utf8");
  const health = await inspectBookHealth(dir);
  expect(health.pendingOperationId).toBe("op");
  expect(health.stateFrontier).toBeNull();
  expect(health.issues).toEqual([{ code: "TRANSACTION_RECOVERY_REQUIRED" }]);
});
it("honors explicit stale metadata independently of audit", async () => {
  await chapters(); await snapshot(0); await snapshot(1);
  await writeFile(join(dir, "chapters", "index.json"), JSON.stringify([{ number: 1, status: "audit-passed", stateIntegrity: { status: "stale" } }]), "utf8");
  expect((await inspectBookHealth(dir)).stateFrontier).toBe(0);
});
it("does not advance through unreadable chapter metadata", async () => {
  await chapters(); await snapshot(0); await snapshot(1);
  await writeFile(join(dir, "chapters", "index.json"), "{broken", "utf8");
  expect((await inspectBookHealth(dir)).stateFrontier).toBe(0);
});
it("propagates I/O failure instead of treating it as absent", async () => {
  const path = await snapshot(0);
  await rm(join(path, "pending_hooks.md"));
  await mkdir(join(path, "pending_hooks.md"));
  await expect(inspectBookHealth(dir)).rejects.toMatchObject({ code: "EISDIR" });
});
it("keeps audit rejection separate from valid state", async () => {
  await chapters(); await snapshot(0); await snapshot(1);
  await writeFile(join(dir, "chapters", "index.json"), JSON.stringify([{ number: 1, status: "audit-failed", stateIntegrity: { status: "valid" } }]), "utf8");
  expect((await inspectBookHealth(dir)).stateFrontier).toBe(1);
});
it("does not treat a later-only snapshot as historical baseline zero", async () => {
  await chapters(); await snapshot(2);
  const health = await inspectBookHealth(dir);
  expect(health.stateFrontier).toBeNull();
  expect(health.verifiedBaselines).toEqual([]);
});
