import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

const injected = vi.hoisted(() => ({ afterRead: undefined as undefined | ((path: string) => Promise<void>) }));
vi.mock("node:fs/promises", async () => {
  const fs = await vi.importActual<any>("node:fs/promises");
  return {
    ...fs,
    readFile: async (...args: any[]) => {
      const result = await fs.readFile(...args);
      await injected.afterRead?.(String(args[0]));
      return result;
    },
    readdir: async (...args: any[]) => {
      const result = await fs.readdir(...args);
      await injected.afterRead?.(String(args[0]));
      return result;
    },
  };
});
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createGrepTool, createLsTool, createReadTool } from "../agent/agent-tools.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inkos-consistent-read-"));
  await mkdir(join(root, "books", "sample", "story", "recovery"), { recursive: true });
  await writeFile(join(root, "books", "sample", "story", "pending_hooks.md"), "original", "utf8");
});
afterEach(async () => {
  injected.afterRead = undefined;
  await rm(root, { recursive: true, force: true });
});

it.each(["read", "ls", "grep"])("%s discards a read when a commit completes during the read", async (name) => {
  const story = join(root, "books", "sample", "story");
  const trigger = name === "ls" ? story : join(story, "pending_hooks.md");
  injected.afterRead = async (path) => {
    if (path !== trigger) return;
    injected.afterRead = undefined;
    await writeFile(join(story, "recovery", "transaction.json"), JSON.stringify({ version: 1, operationId: "11111111-1111-1111-1111-111111111111", phase: "committed", entries: [] }), "utf8");
  };
  const operation = name === "read"
    ? createReadTool(root).execute("r", { path: "sample/story/pending_hooks.md" })
    : name === "ls" ? createLsTool(root).execute("l", { bookId: "sample", subdir: "story" })
      : createGrepTool(root).execute("g", { bookId: "sample", pattern: "original" });
  await expect(operation).rejects.toThrow("BOOK_VIEW_CHANGED");
});
