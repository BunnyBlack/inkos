import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBookSnapshot, restoreBookSnapshot, snapshotChapterBodyHash } from "../state/book-snapshot.js";
import { scanRecoveryBodies } from "../state/recovery-index.js";
import { StateManager } from "../state/manager.js";
vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

describe("complete book snapshots", () => {
  let project: string;
  let book: string;
  beforeEach(async () => {
    const temp = fileURLToPath(new URL("../../../../temp/", import.meta.url));
    await fs.mkdir(temp, { recursive: true });
    project = await fs.mkdtemp(join(temp, "snapshot-test-"));
    book = join(project, "books", "fixture");
    await fs.mkdir(join(book, "story"), { recursive: true });
    await fs.writeFile(join(book, "story/current_state.md"), "old state", "utf8");
    await fs.writeFile(join(book, "story/pending_hooks.md"), "old hooks", "utf8");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(project, { recursive: true, force: true });
  });
  it("publishes a manifest only with complete required files", async () => {
    await createBookSnapshot(book, 0);
    const manifest = JSON.parse(await fs.readFile(join(book, "story/snapshots/0/snapshot-manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ schemaVersion: 1, chapter: 0, baseline: null, bodyHash: null });
    expect(manifest.files["current_state.md"]).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.optionalAbsent).toContain("particle_ledger.md");
  });
  it.each(["2-retained.md", "0002_retained.md", "2retained.md", "2.md"])("uses the same complete chapter number for recovery, count and snapshot: %s", async (filename) => {
    await fs.mkdir(join(book, "chapters"));
    await fs.writeFile(join(book, "chapters", filename), "retained body", "utf8");
    await fs.writeFile(join(book, "chapters", "20-retained.md"), "twenty", "utf8");
    await fs.writeFile(join(book, "chapters", "0-invalid.md"), "invalid", "utf8");
    expect([...(await scanRecoveryBodies(book)).keys()]).toEqual(expect.arrayContaining([2, 20]));
    expect(await new StateManager(project).getPersistedChapterCount("fixture")).toBe(2);
    expect(await snapshotChapterBodyHash(book, 2)).toMatch(/^[a-f0-9]{64}$/);
    await createBookSnapshot(book, 2);
    await fs.writeFile(join(book, "chapters", filename), "changed body", "utf8");
    await expect(restoreBookSnapshot(book, 2)).rejects.toThrow("body hash mismatch");
  });
  it("retains the old published snapshot when reading new required state fails", async () => {
    await createBookSnapshot(book, 0);
    await fs.rm(join(book, "story/pending_hooks.md"));
    await expect(createBookSnapshot(book, 0)).rejects.toThrow();
    expect(await fs.readFile(join(book, "story/snapshots/0/pending_hooks.md"), "utf8")).toBe("old hooks");
  });
  it("preflights all required legacy files before replacing live state", async () => {
    await fs.mkdir(join(book, "story/snapshots/0"), { recursive: true });
    await fs.writeFile(join(book, "story/snapshots/0/current_state.md"), "snapshot state", "utf8");
    expect(await restoreBookSnapshot(book, 0)).toBe(false);
    expect(await fs.readFile(join(book, "story/current_state.md"), "utf8")).toBe("old state");
  });
  it("rejects corruption before changing any live file", async () => {
    await createBookSnapshot(book, 0);
    await fs.writeFile(join(book, "story/snapshots/0/pending_hooks.md"), "corrupt", "utf8");
    await expect(restoreBookSnapshot(book, 0)).rejects.toThrow(/snapshot/i);
    expect(await fs.readFile(join(book, "story/current_state.md"), "utf8")).toBe("old state");
  });
  it("restores optional absence and removes stale structured files", async () => {
    await fs.mkdir(join(book, "story/state"));
    await fs.writeFile(join(book, "story/state/kept.json"), "{}", "utf8");
    await createBookSnapshot(book, 0);
    await fs.writeFile(join(book, "story/state/stale.json"), "{}", "utf8");
    await fs.writeFile(join(book, "story/particle_ledger.md"), "stale", "utf8");
    expect(await restoreBookSnapshot(book, 0)).toBe(true);
    expect(await fs.readdir(join(book, "story/state"))).toEqual(["kept.json"]);
    await expect(fs.stat(join(book, "story/particle_ledger.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("propagates optional I/O errors without publishing", async () => {
    const original = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementation(((path: string, ...args: unknown[]) => {
      if (String(path).endsWith("particle_ledger.md")) return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      return (original as Function)(path, ...args);
    }) as typeof fs.readFile);
    await expect(createBookSnapshot(book, 0)).rejects.toMatchObject({ code: "EACCES" });
    await expect(fs.stat(join(book, "story/snapshots/0"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["EACCES", "ENOSPC"])("preserves a published snapshot on staging %s", async (code) => {
    await createBookSnapshot(book, 0);
    const original = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementation(((path: string, ...args: unknown[]) => {
      if (String(path).includes("prepared") && String(path).endsWith("pending_hooks.md")) {
        return Promise.reject(Object.assign(new Error("write failed"), { code }));
      }
      return (original as Function)(path, ...args);
    }) as typeof fs.writeFile);
    await expect(createBookSnapshot(book, 0)).rejects.toMatchObject({ code });
    expect(await fs.readFile(join(book, "story/snapshots/0/pending_hooks.md"), "utf8")).toBe("old hooks");
  });
  it("restores the old snapshot if the final publication rename fails", async () => {
    await createBookSnapshot(book, 0);
    const original = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from).endsWith("prepared")) throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
      return original(from, to);
    });
    await expect(createBookSnapshot(book, 0)).rejects.toMatchObject({ code: "EBUSY" });
    expect(await fs.readFile(join(book, "story/snapshots/0/pending_hooks.md"), "utf8")).toBe("old hooks");
  });
  it("propagates required restore read failure before changing live state", async () => {
    await createBookSnapshot(book, 0);
    await fs.writeFile(join(book, "story/current_state.md"), "new live state", "utf8");
    const original = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementation(((path: string, ...args: unknown[]) => {
      if (String(path).includes("snapshots") && String(path).endsWith("pending_hooks.md")) {
        return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      }
      return (original as Function)(path, ...args);
    }) as typeof fs.readFile);
    await expect(restoreBookSnapshot(book, 0)).rejects.toMatchObject({ code: "EACCES" });
    expect(await fs.readFile(join(book, "story/current_state.md"), "utf8")).toBe("new live state");
  });
  it("binds a snapshot to the unique retained chapter body", async () => {
    await fs.mkdir(join(book, "chapters"));
    await fs.writeFile(join(book, "chapters/001-fixture.md"), "original body", "utf8");
    await createBookSnapshot(book, 1);
    const manifest = JSON.parse(await fs.readFile(join(book, "story/snapshots/1/snapshot-manifest.json"), "utf8"));
    expect(manifest.bodyHash).toMatch(/^[a-f0-9]{64}$/);
    await fs.writeFile(join(book, "chapters/001-fixture.md"), "revised body", "utf8");
    await expect(restoreBookSnapshot(book, 1)).rejects.toThrow(/body hash/);
  });
});
