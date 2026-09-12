import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { withBookTransaction, recoverBookTransaction, assertBookReadable, readBookConsistently, afterBookCommit } from "../state/book-transaction.js";
import { StateManager } from "../state/manager.js";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm), rename: vi.fn(actual.rename) };
});

describe("book transaction", () => {
  let project: string;
  let book: string;
  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), "book-transaction-"));
    book = join(project, "books", "sample");
    await mkdir(join(book, "story"), { recursive: true });
    await mkdir(join(book, "chapters"), { recursive: true });
    await writeFile(join(book, "story", "current_state.md"), "old state", "utf8");
    await writeFile(join(book, "chapters", "1.md"), "old body", "utf8");
  });
  afterEach(async () => { await rm(project, { recursive: true, force: true }); });
  it("does not send completion effects from a rolled-back rewrite", async () => {
    let sent = false;
    await expect(withBookTransaction(book, async () => {
      await afterBookCommit(book, async () => { sent = true; });
      expect(sent).toBe(false);
      throw new Error("rewrite failed");
    })).rejects.toThrow("rewrite failed");
    expect(sent).toBe(false);
    await withBookTransaction(book, async () => {
      await afterBookCommit(book, async () => { sent = true; });
      expect(sent).toBe(false);
    });
    expect(sent).toBe(true);
  });
  it("retries transient Windows sharing failures while replacing the journal", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const spy = vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("sharing violation"), { code: "EPERM" })).mockImplementation(actual.rename);
    try { await withBookTransaction(book, async () => undefined); }
    finally { spy.mockRestore(); }
  });
  it("reclaims its retired token after release failed while the process remains alive", async () => {
    const originalRm = (await vi.importActual<typeof fs>("node:fs/promises")).rm;
    let ownerFailures = 0;
    const spy = vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
      if (String(path).endsWith("transaction-owner.json")) {
        ownerFailures++;
        throw Object.assign(new Error("sharing violation"), { code: "EACCES" });
      }
      return originalRm(path, options);
    });
    try { await expect(withBookTransaction(book, async () => 1)).rejects.toThrow("sharing violation"); }
    finally { spy.mockRestore(); }
    expect(ownerFailures).toBe(3);
    expect(await withBookTransaction(book, async () => 2)).toBe(2);
  });
  it("recovers after a real child is killed during publication, but never steals from it alive", async () => {
    const moduleUrl = new URL("../state/book-transaction.ts", import.meta.url).href;
    const script = `import { withBookTransaction } from ${JSON.stringify(moduleUrl)};
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      await withBookTransaction(process.argv[1], async () => {
        await writeFile(join(process.argv[1], 'chapters', '1.md'), 'partial', 'utf8');
        process.send('publishing');
        await new Promise(() => { setInterval(() => {}, 1000); });
      });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, book], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    try {
      await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(stderr || "Child exited before publication"); })]);
      await expect(recoverBookTransaction(book)).rejects.toMatchObject({ code: "BOOK_BUSY" });
      const exited = once(child, "exit");
      child.kill("SIGKILL"); await exited;
      // Mimic a second recovery process killed while holding the reclaim guard.
      const ownerPath = join(book, "story", "recovery", "transaction-owner.json");
      const deadOwner = await readFile(ownerPath, "utf8");
      const claimPath = join(book, "story", "recovery", `reclaim-${createHash("sha256").update(ownerPath).digest("hex")}.json`);
      await writeFile(claimPath, deadOwner, "utf8");
      await recoverBookTransaction(book);
      await recoverBookTransaction(book);
      expect(await readFile(join(book, "chapters", "1.md"), "utf8")).toBe("old body");
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  }, 15000);
  it("admits only one simultaneous checkpoint creator", async () => {
    const results = await Promise.allSettled([withBookTransaction(book, async () => 1), withBookTransaction(book, async () => 2)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });

  it("reserves the journal before two concurrent checkpoints can publish", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const first = withBookTransaction(book, async () => { entered(); await barrier; });
    await started;
    await expect(withBookTransaction(book, async () => undefined)).rejects.toMatchObject({ code: "BOOK_BUSY" });
    release(); await first;
  });

  it("rejects a read if publication completed during the read", async () => {
    await expect(readBookConsistently(book, async () => {
      const old = await readFile(join(book, "chapters", "1.md"), "utf8");
      await withBookTransaction(book, async () => { await writeFile(join(book, "chapters", "1.md"), "new", "utf8"); });
      return old;
    })).rejects.toThrow("BOOK_VIEW_CHANGED");
  });

  it("drops SQLite caches instead of restoring inconsistent database sidecars", async () => {
    for (const file of ["memory.db", "memory.db-wal", "memory.db-shm"]) await writeFile(join(book, "story", file), "cache", "utf8");
    await expect(withBookTransaction(book, async () => { throw new Error("fail"); })).rejects.toThrow("fail");
    for (const file of ["memory.db", "memory.db-wal", "memory.db-shm"]) await expect(readFile(join(book, "story", file))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports missing backups as recovery pending", async () => {
    await expect(withBookTransaction(book, async () => { throw new Error("crash"); }, { leavePendingOnError: true })).rejects.toThrow("crash");
    const journal = JSON.parse(await readFile(join(book, "story", "recovery", "transaction.json"), "utf8"));
    await rm(join(book, "story", "recovery", journal.operationId, "before", "chapters", "1.md"));
    await expect(recoverBookTransaction(book)).rejects.toThrow("TRANSACTION_RECOVERY_REQUIRED");
  });

  it("rejects replacement junctions before rollback touches external files", async () => {
    await expect(withBookTransaction(book, async () => { throw new Error("crash"); }, { leavePendingOnError: true })).rejects.toThrow("crash");
    const external = join(project, "outside");
    await mkdir(external);
    await writeFile(join(external, "1.md"), "outside", "utf8");
    await rm(join(book, "chapters"), { recursive: true });
    await symlink(external, join(book, "chapters"), "junction");
    await expect(recoverBookTransaction(book)).rejects.toThrow("TRANSACTION_RECOVERY_REQUIRED");
    expect(await readFile(join(external, "1.md"), "utf8")).toBe("outside");
    await rm(join(book, "chapters"));
  });

  it("restores every published file after a partial mutation fails", async () => {
    await expect(withBookTransaction(book, async () => {
      await writeFile(join(book, "story", "current_state.md"), "new state", "utf8");
      await rm(join(book, "chapters", "1.md"));
      await writeFile(join(book, "chapters", "2.md"), "new body", "utf8");
      throw new Error("injected ENOSPC");
    })).rejects.toThrow("injected ENOSPC");
    expect(await readFile(join(book, "story", "current_state.md"), "utf8")).toBe("old state");
    expect(await readFile(join(book, "chapters", "1.md"), "utf8")).toBe("old body");
    await expect(readFile(join(book, "chapters", "2.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await recoverBookTransaction(book);
  });

  it("retains complete successful writes and is restart-idempotent", async () => {
    expect(await withBookTransaction(book, async () => {
      await writeFile(join(book, "chapters", "1.md"), "new body", "utf8");
      return 42;
    })).toBe(42);
    await recoverBookTransaction(book);
    await recoverBookTransaction(book);
    expect(await readFile(join(book, "chapters", "1.md"), "utf8")).toBe("new body");
  });

  it("recovers a journal left by an interrupted publication without calling a model", async () => {
    await expect(withBookTransaction(book, async () => {
      await writeFile(join(book, "chapters", "1.md"), "partial", "utf8");
      throw new Error("simulated process death");
    }, { leavePendingOnError: true })).rejects.toThrow("simulated process death");
    await recoverBookTransaction(book);
    expect(await readFile(join(book, "chapters", "1.md"), "utf8")).toBe("old body");
  });

  it("does not allow a competing transaction to overwrite its recovery journal", async () => {
    await withBookTransaction(book, async () => {
      await expect(withBookTransaction(book, async () => undefined)).rejects.toThrow("TRANSACTION_RECOVERY_REQUIRED");
    });
  });

  it("checks ownership again before reporting committed success", async () => {
    let owned = true;
    await expect(withBookTransaction(book, async () => { owned = false; }, {
      assertOwner: async () => { if (!owned) throw new Error("LOCK_LOST"); },
    })).rejects.toThrow("LOCK_LOST");
  });

  it("refuses outside reads while an interrupted transaction is pending", async () => {
    await expect(withBookTransaction(book, async () => {
      await assertBookReadable(book);
      throw new Error("interrupted");
    }, { leavePendingOnError: true })).rejects.toThrow("interrupted");
    await expect(new StateManager(project).loadChapterIndex("sample")).rejects.toThrow("TRANSACTION_RECOVERY_REQUIRED");
    const release = await new StateManager(project).acquireBookLock("sample");
    await release();
    await assertBookReadable(book);
  });

  it("does not let public rollback or snapshot replace a live writer's book", async () => {
    const manager = new StateManager(project);
    const release = await manager.acquireBookLock("sample");
    try {
      await expect(new StateManager(project).rollbackToChapter("sample", 0)).rejects.toMatchObject({ code: "BOOK_BUSY" });
      await expect(new StateManager(project).snapshotState("sample", 0)).rejects.toMatchObject({ code: "BOOK_BUSY" });
      expect(await readFile(join(book, "chapters", "1.md"), "utf8")).toBe("old body");
    } finally { await release(); }
  });

  it("rolls back a cancellation during publication before releasing the book lock", async () => {
    const manager = new StateManager(project);
    const release = await manager.acquireBookLock("sample");
    const controller = new AbortController();
    try {
      await expect(manager.publishBookMutation("sample", async () => {
        await writeFile(join(book, "chapters", "1.md"), "partial candidate", "utf8");
        controller.abort(new Error("cancelled during publish"));
      }, controller.signal)).rejects.toThrow("cancelled during publish");
      expect(await readFile(join(book, "chapters", "1.md"), "utf8")).toBe("old body");
    } finally { await release(); }
    await (await new StateManager(project).acquireBookLock("sample"))();
  });
});
