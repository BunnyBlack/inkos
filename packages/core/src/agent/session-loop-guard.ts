import { createHash } from "node:crypto";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { mutationBookId, operationResultFailed, productionOperation } from "./operation-policy.js";

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
  private readonly activeBookId: string | null;
  private modelCalls = 0;
  private pending = new Map<string, string>();
  private failures = new Map<string, { name: string; count: number }>();
  private reads = new Map<string, { name: string; result: string; count: number }>();
  private productionCalls = new Map<string, Record<string, unknown>>();
  private productionFailures = new Map<string, { count: number; candidateId?: string }>();
  private mutationQueues = new Map<string, Promise<void>>();

  constructor(activeBookId: string | null = null) {
    this.activeBookId = activeBookId;
  }

  reset(): void {
    this.modelCalls = 0;
    this.pending.clear();
    this.failures.clear();
    this.reads.clear();
    this.productionCalls.clear();
    this.productionFailures.clear();
  }

  /** Checked per execute, so a third call in the same response cannot bypass the budget. */
  beforeToolExecution(name: string, args: Record<string, unknown>): void {
    if (productionOperation(name, args)) this.assertProductionBudget();
  }

  async executeTool<T>(
    name: string,
    id: string,
    args: Record<string, unknown>,
    execute: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const bookId = mutationBookId(name, args, this.activeBookId);
    if (!bookId) {
      if (!productionOperation(name, args)) return execute();
      this.preflightToolExecution(id, name, args, signal);
      try {
        const result = await execute();
        this.observe({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError: false } as AgentEvent);
        return result;
      } catch (error) {
        if ((error as Error)?.name === "AbortError") {
          this.pending.delete(id);
          this.productionCalls.delete(id);
          throw error;
        }
        this.observe({ type: "tool_execution_end", toolCallId: id, toolName: name, result: undefined, isError: true } as unknown as AgentEvent);
        throw error;
      }
    }

    const previous = this.mutationQueues.get(bookId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      // A cancelled task may have waited behind another mutation. It must not
      // enter the tool body after it reaches the front of the queue.
      this.preflightToolExecution(id, name, args, signal);
      try {
        const result = await execute();
        if (productionOperation(name, args)) {
          this.observe({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError: false } as AgentEvent);
        }
        return result;
      } catch (error) {
        if ((error as Error)?.name === "AbortError") {
          this.pending.delete(id);
          this.productionCalls.delete(id);
          throw error;
        }
        if (productionOperation(name, args)) {
          this.observe({ type: "tool_execution_end", toolCallId: id, toolName: name, result: undefined, isError: true } as unknown as AgentEvent);
        }
        throw error;
      }
    });

    const tail = task.then(() => undefined, () => undefined);
    this.mutationQueues.set(bookId, tail);
    void tail.then(() => {
      if (this.mutationQueues.get(bookId) === tail) this.mutationQueues.delete(bookId);
    });
    return task;
  }

  private preflightToolExecution(
    id: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): void {
    try {
      this.throwIfAborted(signal);
      this.beforeToolExecution(name, args);
    } catch (error) {
      // The host may still deliver a tool_execution_end after a rejected
      // wrapper promise. Do not let that late event create a false failure.
      this.pending.delete(id);
      this.productionCalls.delete(id);
      throw error;
    }
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
    const error = new Error("The queued mutation was cancelled before execution.");
    error.name = "AbortError";
    throw error;
  }

  private assertProductionBudget(): void {
    for (const failure of this.productionFailures.values()) {
      if (failure.count >= 2) throw new Error(`Agent loop guard: chapter production failed ${failure.count} times on unchanged inputs. Stopped this turn; inspect the recovery status and retry the preserved candidate${failure.candidateId ? ` ${failure.candidateId}` : ""} in an explicit user turn. Generic state writes are forbidden.`);
    }
  }

  observe(event: AgentEvent): void {
    if (event.type === "tool_execution_start") {
      this.pending.set(event.toolCallId, fingerprint([event.toolName, event.args]));
      if (productionOperation(event.toolName, event.args as Record<string, unknown>)) {
        this.productionCalls.set(event.toolCallId, event.args as Record<string, unknown>);
      }
      return;
    }
    if (event.type !== "tool_execution_end") return;
    const signature = this.pending.get(event.toolCallId);
    this.pending.delete(event.toolCallId);
    if (!signature) return;
    const productionArgs = this.productionCalls.get(event.toolCallId);
    this.productionCalls.delete(event.toolCallId);
    if (productionArgs && (event.isError || operationResultFailed(event.result))) {
      const details = (event.result as any)?.details;
      const outcome = details?.outcome;
      const key = fingerprint([
        details?.bookId ?? productionArgs.bookId ?? "active",
        details?.failedChapter ?? details?.chapterNumber ?? productionArgs.chapterNumber ?? "latest",
        details?.sourceRevision ?? outcome?.sourceRevision ?? "unchanged",
        "chapter-production", outcome?.stage ?? details?.stage ?? "production",
      ]);
      this.productionFailures.set(key, {
        count: (this.productionFailures.get(key)?.count ?? 0) + 1,
        candidateId: details?.attemptId ?? outcome?.candidateId ?? details?.candidateId,
      });
      this.reads.delete(signature);
      return;
    }

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
    this.assertProductionBudget();
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
