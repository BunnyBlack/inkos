import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TOOL_LOGS,
  applyStreamTextDeltas,
  appendBoundedToolLogs,
  attachSessionStreamListeners,
  buildBusinessFailureSummary,
  createLatestEventThrottle,
  createStreamTextDeltaBatcher,
} from "./stream-events";
import { createSessionRuntime } from "./runtime";

describe("stream event performance helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies queued text deltas in their original order", () => {
    const parts = applyStreamTextDeltas(
      [{ type: "thinking", content: "why", streaming: true }],
      [
        { kind: "thinking", text: " it matters" },
        { kind: "text", text: "Answer " },
        { kind: "text", text: "body." },
      ],
    );

    expect(parts).toEqual([
      { type: "thinking", content: "why it matters", streaming: true },
      { type: "text", content: "Answer body." },
    ]);
  });

  it("batches many text deltas into one scheduled flush", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batcher = createStreamTextDeltaBatcher(flush, 50);

    for (let i = 0; i < 100; i += 1) {
      batcher.enqueue({ kind: "text", text: "x" });
    }

    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(49);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0]).toHaveLength(100);
  });

  it("flushes queued text immediately before structural stream events", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batcher = createStreamTextDeltaBatcher(flush, 50);

    batcher.enqueue({ kind: "text", text: "before tool" });
    batcher.flush();
    vi.advanceTimersByTime(50);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([{ kind: "text", text: "before tool" }]);
  });

  it("throttles frequent progress events and publishes the latest one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const publish = vi.fn();
    const throttle = createLatestEventThrottle<string>(publish, 1000);

    throttle.enqueue("first");
    throttle.enqueue("second");
    throttle.enqueue("third");

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith("first");

    vi.advanceTimersByTime(999);
    expect(publish).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith("third");
  });

  it("keeps only recent tool logs", () => {
    const existing = Array.from({ length: MAX_TOOL_LOGS + 20 }, (_, i) => `old-${i}`);
    const logs = appendBoundedToolLogs(existing, ["latest"]);

    expect(logs).toHaveLength(MAX_TOOL_LOGS);
    expect(logs[0]).toBe("old-21");
    expect(logs.at(-1)).toBe("latest");
  });
});

class TestEventSource {
  private readonly listeners = new Map<string, (event: MessageEvent) => void>();
  closed = false;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function") this.listeners.set(type, listener as (event: MessageEvent) => void);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function attachTestSession(input: {
  source: TestEventSource;
  bookId: string | null;
  isChatStreaming: boolean;
  messages?: ReadonlyArray<unknown>;
}) {
  const sessionId = "session-1";
  let state: any = {
    sessions: {
      [sessionId]: {
        ...createSessionRuntime({ sessionId, bookId: input.bookId, title: null, messages: input.messages as any }),
        stream: input.source,
        isStreaming: true,
        isChatStreaming: input.isChatStreaming,
      },
    },
  };
  const set = (update: any) => {
    const patch = typeof update === "function" ? update(state) : update;
    state = { ...state, ...patch };
  };
  const get = () => state;
  attachSessionStreamListeners({ sessionId, streamTs: 100, streamEs: input.source as unknown as EventSource,
    set, get });
  return { sessionId, getState: () => state };
}

describe("business failure summaries", () => {
  it("keeps the model text and appends one persistent summary for final-only outcomes", () => {
    const source = new TestEventSource();
    const modelMessage = {
      role: "assistant" as const,
      content: "模型正文",
      timestamp: 100,
      parts: [{ type: "text" as const, content: "模型正文" }],
    };
    const session = attachTestSession({ source, bookId: "book-1", isChatStreaming: true, messages: [modelMessage] });
    const outcome = { bookId: "book-1", chapterNumber: 2, toolCallId: "settle-1", status: "failed" as const,
      reasonCode: "SETTLEMENT_REPAIR_REQUIRED", attemptId: "attempt-1" };

    source.emit("agent:complete", { sessionId: session.sessionId, activeBookId: "book-1", operationOutcomes: [outcome] });
    source.emit("agent:complete", { sessionId: session.sessionId, activeBookId: "book-1", operationOutcomes: [outcome] });

    const messages = session.getState().sessions[session.sessionId].messages;
    expect(messages[0]).toMatchObject({ content: "模型正文" });
    expect(messages.filter((message: any) => message.content.includes("结算未完成"))).toHaveLength(1);
    expect(messages.at(-1)?.content).toContain("SETTLEMENT_REPAIR_REQUIRED");
    expect(messages.at(-1)?.content).toContain("attempt-1");
    expect(source.closed).toBe(false);
  });

  it("formats a concise English summary with the reason and attempt id", async () => {
    const { setAppLanguage } = await import("../../../../lib/app-language");
    setAppLanguage("en");
    try {
      expect(buildBusinessFailureSummary([{ bookId: "book-1", toolCallId: "settle-1", status: "blocked",
        reasonCode: "VALIDATOR_PROTOCOL_INVALID", attemptId: "attempt-2" }])).toBe(
        "Conversation ended; settlement incomplete (reason: VALIDATOR_PROTOCOL_INVALID; attempt ID: attempt-2)",
      );
    } finally {
      setAppLanguage("zh");
    }
  });

  it("persists the summary when the completed response has no model text", () => {
    const source = new TestEventSource();
    const session = attachTestSession({ source, bookId: "book-1", isChatStreaming: true });

    source.emit("agent:complete", { sessionId: session.sessionId, activeBookId: "book-1", operationOutcomes: [{
      bookId: "book-1", toolCallId: "settle-1", status: "failed", reasonCode: "SETTLEMENT_REJECTED", attemptId: "attempt-empty",
    }] });

    expect(session.getState().sessions[session.sessionId].messages).toMatchObject([{
      role: "assistant",
      content: "对话已结束，结算未完成（原因：SETTLEMENT_REJECTED；尝试：attempt-empty）",
    }]);
  });

  it("filters another book and background task outcomes out of the chat transcript", () => {
    const backgroundExecution = {
      id: "background-1", tool: "resume_settlement_attempt", label: "Settlement", status: "error" as const,
      background: true, startedAt: 10,
    };
    const source = new TestEventSource();
    const session = attachTestSession({ source, bookId: "book-1", isChatStreaming: false,
      messages: [{ role: "assistant", content: "", timestamp: 10, toolExecutions: [backgroundExecution],
        parts: [{ type: "tool", execution: backgroundExecution }] }] });

    source.emit("agent:complete", { sessionId: session.sessionId, activeBookId: "book-2", operationOutcomes: [{
      bookId: "book-2", chapterNumber: 1, toolCallId: "background-1", status: "failed", reasonCode: "SETTLEMENT_REJECTED", attemptId: "attempt-3",
    }] });

    const messages = session.getState().sessions[session.sessionId].messages;
    expect(messages).toHaveLength(1);
    expect(messages.some((message: any) => message.content.includes("结算未完成"))).toBe(false);
    expect(source.closed).toBe(true);
  });
});
