import { createHash } from "node:crypto";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

const MAX_MODEL_CALLS = 32;
const MAX_IDENTICAL_FAILURES = 3;
const MAX_UNCHANGED_READS = 4;
const FILE_READ_TOOLS = new Set(["read", "ls", "grep"]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)) ?? "undefined").digest("hex");
}

/** Per-user-turn guard, independent of transformed/compressed model history. */
export class SessionLoopGuard {
  private modelCalls = 0;
  private pending = new Map<string, string>();
  private failures = new Map<string, { name: string; count: number }>();
  private reads = new Map<string, { name: string; result: string; count: number }>();

  reset(): void {
    this.modelCalls = 0;
    this.pending.clear();
    this.failures.clear();
    this.reads.clear();
  }

  observe(event: AgentEvent): void {
    if (event.type === "tool_execution_start") {
      this.pending.set(event.toolCallId, fingerprint([event.toolName, event.args]));
      return;
    }
    if (event.type !== "tool_execution_end") return;
    const signature = this.pending.get(event.toolCallId);
    this.pending.delete(event.toolCallId);
    if (!signature) return;

    // These events include argument-validation errors that never reach execute().
    if (event.isError) {
      const count = (this.failures.get(signature)?.count ?? 0) + 1;
      this.failures.set(signature, { name: event.toolName, count });
      this.reads.delete(signature);
      return;
    }
    this.failures.delete(signature);
    if (FILE_READ_TOOLS.has(event.toolName)) {
      const result = fingerprint(event.result?.content);
      const previous = this.reads.get(signature);
      this.reads.set(signature, {
        name: event.toolName, result,
        count: previous?.result === result ? previous.count + 1 : 1,
      });
    } else {
      // Other successful tools may change state and make rereading useful.
      this.reads.clear();
    }
  }

  beforeModelCall(): void {
    for (const failure of this.failures.values()) {
      if (failure.count >= MAX_IDENTICAL_FAILURES) {
        throw new Error(`Agent loop guard: ${failure.name} failed ${failure.count} times with the same arguments. Stopped this turn; inspect the tool errors before retrying.`);
      }
    }
    for (const read of this.reads.values()) {
      if (read.count >= MAX_UNCHANGED_READS) {
        throw new Error(`Agent loop guard: ${read.name} returned unchanged results ${read.count} times. Stopped this turn because no file-reading progress was made.`);
      }
    }
    if (this.modelCalls >= MAX_MODEL_CALLS) {
      throw new Error(`Agent loop guard: reached ${MAX_MODEL_CALLS} model calls in one user turn. Stopped this turn; review the results before continuing.`);
    }
    this.modelCalls += 1;
  }
}
