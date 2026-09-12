import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectBookHealth } from "../state/book-health.js";
import { planBookRecovery } from "../pipeline/book-recovery.js";
import { reconcileRecoveryIndex, readRecoveryBody } from "../state/recovery-index.js";
import { withBookTransaction } from "../state/book-transaction.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "recovery-index-"));
  await mkdir(join(dir, "chapters"));
  for (const n of [0, 1, 2]) {
    const path = join(dir, "story", "snapshots", String(n));
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "current_state.md"), "state", "utf8");
    await writeFile(join(path, "pending_hooks.md"), "hooks", "utf8");
  }
  await writeFile(join(dir, "chapters", "1_title.md"), "first body", "utf8");
  await writeFile(join(dir, "chapters", "2-title.md"), "second body", "utf8");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
it("does not approve an orphan snapshot as a baseline and plans its settlement", async () => {
  await writeFile(join(dir, "chapters", "index.json"), JSON.stringify([{ number: 1, status: "audit-passed" }]), "utf8");
  const health = await inspectBookHealth(dir);
  expect(health.stateFrontier).toBe(1);
  expect(health.issues).toContainEqual({ code: "CHAPTER_METADATA_MISSING", chapter: 2 });
  expect(planBookRecovery(health, 2).steps.map(step => step.chapter)).toEqual([2]);
  expect(await readFile(join(dir, "chapters", "index.json"), "utf8")).not.toContain('"number":2');
});
it("rejects duplicate index rows before recovery", async () => {
  await writeFile(join(dir, "chapters", "index.json"), JSON.stringify([{ number: 1 }, { number: 1 }]), "utf8");
  expect(planBookRecovery(await inspectBookHealth(dir), 2).blockedReason).toBe("CHAPTER_INDEX_INVALID");
});
it.each(["missing", "empty", "partial"])("reconciles %s index only through target and is idempotent", async mode => {
  const path = join(dir, "chapters", "index.json");
  const row = { number: 1, status: "audit-passed", custom: { retained: true } };
  if (mode !== "missing") await writeFile(path, JSON.stringify(mode === "partial" ? [row] : []), "utf8");
  await writeFile(join(dir, "book.json"), JSON.stringify({ language: "en" }), "utf8");
  const before = await readFile(join(dir, "chapters", "2-title.md"));
  const result = await withBookTransaction(dir, () => reconcileRecoveryIndex(dir, 1));
  expect(result.addedChapters).toEqual(mode === "partial" ? [] : [1]);
  expect(JSON.parse(await readFile(path, "utf8")).map((row: { number: number }) => row.number)).toEqual([1]);
  if (mode !== "partial") {
    const rows = JSON.parse(await readFile(path, "utf8"));
    expect(rows[0]).toMatchObject({ status: "state-degraded", stateIntegrity: { status: "stale" }, wordCount: 2 });
    expect(rows[0].auditIssues).toEqual([]);
  }
  expect((await withBookTransaction(dir, () => reconcileRecoveryIndex(dir, 2))).addedChapters).toEqual([2]);
  expect((await withBookTransaction(dir, () => reconcileRecoveryIndex(dir, 2))).addedChapters).toEqual([]);
  expect(await readFile(join(dir, "chapters", "2-title.md"))).toEqual(before);
  if (mode === "partial") expect(JSON.parse(await readFile(path, "utf8"))[0]).toEqual(row);
});
it.each(["duplicate", "missing", "unreadable"])("blocks %s required body before any index write", async mode => {
  const path = join(dir, "chapters", "index.json");
  await writeFile(path, "[]", "utf8");
  if (mode === "duplicate") await writeFile(join(dir, "chapters", "0002-other.md"), "duplicate", "utf8");
  else {
    await rm(join(dir, "chapters", "2-title.md"));
    if (mode === "unreadable") await mkdir(join(dir, "chapters", "2-title.md"));
  }
  const code = mode === "duplicate" ? "CHAPTER_BODY_AMBIGUOUS" : mode === "missing" ? "CHAPTER_BODY_MISSING" : "CHAPTER_BODY_UNREADABLE";
  await expect(reconcileRecoveryIndex(dir, 2)).rejects.toMatchObject({ code });
  expect(await readFile(path, "utf8")).toBe("[]");
});
it("rolls back exact index bytes after publication failure", async () => {
  const path = join(dir, "chapters", "index.json");
  const original = "[ ]\r\n";
  await writeFile(path, original, "utf8");
  await expect(withBookTransaction(dir, async () => {
    await reconcileRecoveryIndex(dir, 2);
    throw new Error("injected publication failure");
  })).rejects.toThrow("injected publication failure");
  expect(await readFile(path, "utf8")).toBe(original);
  expect((await readRecoveryBody(dir, 2)).bytes.toString("utf8")).toBe("second body");
});
it.each(["{broken", "{}", '[{"number":0}]', '[{"number":1,"status":"invented"}]', '[{"number":1,"wordCount":"bad"}]'])("refuses invalid raw index %s", async raw => {
  const path = join(dir, "chapters", "index.json");
  await writeFile(path, raw, "utf8");
  await expect(reconcileRecoveryIndex(dir, 2)).rejects.toMatchObject({ code: "CHAPTER_INDEX_INVALID" });
  expect(await readFile(path, "utf8")).toBe(raw);
});
it("restores exact bytes when the index writer fails after a partial write", async () => {
  const path = join(dir, "chapters", "index.json");
  await writeFile(path, "[ ]\r\n", "utf8");
  const actualWrite = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).writeFile;
  let injected = false;
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    if (args[0] === path && !injected) {
      injected = true;
      await actualWrite(path, "partial", "utf8");
      throw Object.assign(new Error("index disk failure"), { code: "EIO" });
    }
    return actualWrite(...args);
  });
  await expect(withBookTransaction(dir, () => reconcileRecoveryIndex(dir, 2))).rejects.toThrow("index disk failure");
  expect(await readFile(path, "utf8")).toBe("[ ]\r\n");
  expect((await readRecoveryBody(dir, 2)).bytes.toString("utf8")).toBe("second body");
});
