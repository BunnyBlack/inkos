import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMConfigSchema } from "../models/project.js";
import { chatCompletion, createLLMClient } from "../llm/provider.js";
import { guardedPiStream } from "../agent/pi-stream.js";
import { encodeRuntimePayload, runtimeStreamOptions } from "../llm/runtime.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { resolveServiceModel } from "../llm/service-resolver.js";

describe("LLM runtime contract", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([false, true])("preserves structured output format alongside explicit reasoning (Pi=%s)", (transportEncoded) => {
    const model = { id: "arbitrary", api: "anthropic-messages", reasoning: true } as any;
    const format = { type: "json_schema", schema: { type: "object", properties: { result: { type: "string" } } } };
    const result = encodeRuntimePayload({}, model, { reasoning: "off", extra: { output_config: { format, effort: "high" } } }, transportEncoded);
    expect(result.output_config).toEqual({ format });
  });
  it("retains metadata and policy when workers select another endpoint", () => {
    const base = LLMConfigSchema.parse({
      provider: "custom", baseUrl: "http://localhost:8100/v1", model: "first", reasoning: "high", thinkingBudget: 2048,
      headers: { "x-test": "runtime" }, extra: { custom_flag: true },
      modelMetadata: { second: { reasoning: true, maxOutput: 4096 } },
    });
    const pipeline = new PipelineRunner({
      client: createLLMClient(base), model: "first", projectRoot: process.cwd(), defaultLLMConfig: base,
      modelOverrides: { writer: { model: "second", baseUrl: "http://localhost:8200/v1" } },
    });
    const context = pipeline.createAgentContext("writer");
    expect(context.client._piModel).toMatchObject({ reasoning: true, maxTokens: 4096, headers: { "x-test": "runtime" } });
    expect(context.client.defaults).toMatchObject({ reasoning: "high", thinkingBudget: 2048, extra: { custom_flag: true } });
  });

  it("uses the same Pi-registry descriptor on client and Main Agent paths", async () => {
    const model = "codex-mini-latest";

    const config = LLMConfigSchema.parse({
      provider: "custom",
      service: "custom",
      baseUrl: "http://localhost:8100/v1",
      apiFormat: "responses",
      model,
    });

    const client = createLLMClient(config);
    const resolved = await resolveServiceModel(
      "custom:local",
      model,
      process.cwd(),
      "http://localhost:8100/v1",
      "responses",
    );

    expect(resolved.model).toMatchObject({
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 100_000,
    });

    expect(client._piModel).toMatchObject({
      reasoning: resolved.model.reasoning,
      contextWindow: resolved.model.contextWindow,
      maxTokens: resolved.model.maxTokens,
    });
  });

  it("uses the same provider-bank metadata for known models behind custom endpoints", async () => {
    const config = LLMConfigSchema.parse({
      provider: "custom",
      service: "custom",
      baseUrl: "http://localhost:8100/v1",
      model: "deepseek-v4-flash",
    });

    const client = createLLMClient(config);
    const resolved = await resolveServiceModel(
      "custom:local",
      "deepseek-v4-flash",
      process.cwd(),
      "http://localhost:8100/v1",
      "chat",
    );

    expect(client._piModel?.contextWindow).toBe(1_000_000);
    expect(client._piModel?.maxTokens).toBe(393_216);
    expect(resolved.model.contextWindow).toBe(client._piModel?.contextWindow);
    expect(resolved.model.maxTokens).toBe(client._piModel?.maxTokens);
  });

  it("uses the same fallback limits for unknown custom models on client and Main Agent paths", async () => {
    const config = LLMConfigSchema.parse({
      provider: "custom",
      service: "custom",
      baseUrl: "http://localhost:8100/v1",
      model: "completely-unknown-model",
    });

    const client = createLLMClient(config);
    const resolved = await resolveServiceModel(
      "custom:local",
      "completely-unknown-model",
      process.cwd(),
      "http://localhost:8100/v1",
      "chat",
    );

    expect(client._piModel).toMatchObject({
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 24_576,
    });
    expect(resolved.model.reasoning).toBe(client._piModel?.reasoning);
    expect(resolved.model.contextWindow).toBe(client._piModel?.contextWindow);
    expect(resolved.model.maxTokens).toBe(client._piModel?.maxTokens);
  });

  it("uses the declared Anthropic protocol for a custom endpoint on both paths", () => {
    const client = createLLMClient(LLMConfigSchema.parse({
      provider: "anthropic", service: "custom", baseUrl: "http://localhost:8100/v1", model: "arbitrary",
    }));
    expect(client._piModel?.api).toBe("anthropic-messages");
  });
  it("resolves metadata for a per-call model instead of inheriting the first model", async () => {
    let payload: any;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }));
    const client = createLLMClient(LLMConfigSchema.parse({
      provider: "custom", configSource: "studio", baseUrl: "http://localhost:8100/v1", model: "first", stream: false, reasoning: "high",
      modelMetadata: {
        first: { reasoning: false, maxOutput: 8192 },
        second: { reasoning: true, maxOutput: 4096, compat: { thinkingFormat: "qwen-chat-template" } },
      },
    }));
    await chatCompletion(client, "second", [{ role: "user", content: "hello" }], { retry: false });
    expect(payload).toMatchObject({
      model: "second",
      max_completion_tokens: 4096,
      chat_template_kwargs: { enable_thinking: true },
    });
    expect(payload).not.toHaveProperty("max_tokens");
  });

  it("forces explicit off through the real Pi qwen-chat-template serializer", async () => {
    let payload: any;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }));

    const client = createLLMClient(LLMConfigSchema.parse({
      provider: "custom",
      service: "custom",
      baseUrl: "http://localhost:8100/v1",
      apiKey: "test",
      model: "arbitrary-switch-model",
      stream: true,
      reasoning: "off",
      extra: {
        chat_template_kwargs: {
          enable_thinking: true,
          custom_flag: true,
        },
      },
      modelMetadata: {
        "arbitrary-switch-model": {
          reasoning: true,
          maxOutput: 8192,
          compat: {
            thinkingFormat: "qwen-chat-template",
            maxTokensField: "max_tokens",
            supportsUsageInStreaming: false,
          },
        },
      },
    }));

    const stream = guardedPiStream(
      client._piModel!,
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: "test",
        reasoning: "high",
        thinkingBudgets: { high: 4096 },
      },
      client.defaults,
    );

    await stream.result();

    expect(payload.chat_template_kwargs).toEqual({
      enable_thinking: false,
      custom_flag: true,
    });
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("forces explicit off through the real Pi Anthropic serializer", async () => {
    let payload: any;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response(
        'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"arbitrary","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
        'data: {"type":"content_block_stop","index":0}\n\n' +
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n' +
        'data: {"type":"message_stop"}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }));

    const client = createLLMClient(LLMConfigSchema.parse({
      provider: "anthropic",
      service: "custom",
      baseUrl: "http://localhost:8100",
      apiKey: "test",
      model: "arbitrary-anthropic-model",
      reasoning: "off",
      modelMetadata: {
        "arbitrary-anthropic-model": {
          reasoning: true,
          maxOutput: 8192,
        },
      },
    }));

    const stream = guardedPiStream(
      client._piModel!,
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      {
        apiKey: "test",
        reasoning: "high",
        thinkingBudgets: { high: 4096 },
      },
      client.defaults,
    );

    await stream.result();

    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload).not.toHaveProperty("output_config");
  });

  it.each(["openai-completions", "openai-responses"] as const)("enforces off against extra reasoning fields for %s", async (api) => {
    const model = { id: "generic", api, reasoning: true, maxTokens: 8192 } as any;
    const policy = { reasoning: "off" as const, thinkingBudget: 2048, extra: { reasoning_effort: "high", reasoning: { effort: "high" }, enable_thinking: true } };
    const upstream = api === "openai-responses" ? { reasoning: { effort: "none" } } : {};
    const options = runtimeStreamOptions(model, policy);
    const piPayload = await options.onPayload!(upstream, model);
    const nativePayload = encodeRuntimePayload({}, model, policy);
    const expected = api === "openai-responses" ? { reasoning: { effort: "none" } } : {};
    expect(piPayload).toEqual(expected);
    expect(nativePayload).toEqual(expected);
  });

  it.each([512, 1024])("rejects an output reservation of %i that cannot contain valid Anthropic thinking", (maxTokens) => {
    const model = { id: "generic", api: "anthropic-messages", reasoning: true } as any;
    expect(() => encodeRuntimePayload({ max_tokens: maxTokens }, model, { reasoning: "high", thinkingBudget: 2048, maxTokens }))
      .toThrow(/thinking.*1024/i);
  });
  it("uses registry capability without turning it into a runtime request", () => {
    const client = createLLMClient(LLMConfigSchema.parse({
      provider: "anthropic", service: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5-20250929",
    }));
    expect(client._piModel?.reasoning).toBe(true);
    expect(runtimeStreamOptions(client._piModel!, client.defaults).reasoning).toBeUndefined();
  });

  it("preserves the adapter encoding instead of adding a second reasoning dialect", async () => {
    const model = createLLMClient(LLMConfigSchema.parse({
      provider: "custom", baseUrl: "https://api.z.ai/api/paas/v4", model: "arbitrary",
      modelMetadata: { arbitrary: { reasoning: true } },
    }))._piModel!;
    const options = runtimeStreamOptions(model, { reasoning: "high", extra: { enable_thinking: false } });
    const payload = await options.onPayload!({ enable_thinking: true }, model);
    expect(payload).toEqual({ enable_thinking: true });
  });

  it("caps the requested output at model capacity before context reservation", () => {
    const model = createLLMClient(LLMConfigSchema.parse({
      provider: "custom", baseUrl: "http://localhost:8100/v1", model: "arbitrary",
      modelMetadata: { arbitrary: { maxOutput: 4096 } },
    }))._piModel!;
    expect(runtimeStreamOptions(model, { maxTokens: 8192 }).maxTokens).toBe(4096);
    expect(runtimeStreamOptions(model, { maxTokens: 8192 }, { maxTokens: 1024 }).maxTokens).toBe(1024);
  });

  it("does not let native extra replace the output limit or input", async () => {
    let payload: any;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: "ok" }] }] }));
    }));
    const client = createLLMClient(LLMConfigSchema.parse({
      provider: "custom", configSource: "studio", baseUrl: "http://localhost:8100/v1", model: "arbitrary", apiFormat: "responses", stream: false,
      modelMetadata: { arbitrary: { maxOutput: 4096 } },
      extra: { input: "wrong", max_output_tokens: 10, max_completion_tokens: 999999 },
    }));
    await chatCompletion(client, "arbitrary", [{ role: "user", content: "hello" }], { retry: false });
    expect(payload.max_output_tokens).toBe(4096);
    expect(payload.max_completion_tokens).toBeUndefined();
    expect(JSON.stringify(payload.input)).toContain("hello");
  });
  it("keeps capability independent of the requested thinking budget", () => {
    const config = LLMConfigSchema.parse({
      provider: "custom", baseUrl: "http://localhost:8100/v1", model: "generic-agent",
      thinkingBudget: 2048,
      modelMetadata: { "generic-agent": { reasoning: false, maxOutput: 8192 } },
    });
    expect(createLLMClient(config)._piModel?.reasoning).toBe(false);
  });

  it("leaves developer-role support unspecified for unknown compatible clients", () => {
    const client = createLLMClient(LLMConfigSchema.parse({
      provider: "custom",
      service: "custom",
      baseUrl: "http://localhost:8100/v1",
      model: "arbitrary",
      modelMetadata: { arbitrary: { reasoning: true } },
    }));

    expect(client._piModel?.reasoning).toBe(true);
    expect(client._piModel?.compat ?? {}).not.toHaveProperty("supportsDeveloperRole");
  });

  it("honors explicit store support on both native and Pi Chat transports", async () => {
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const payload = JSON.parse(init.body);
      requests.push(payload);
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }));

    const model = "arbitrary-explicit-store";
    const config = LLMConfigSchema.parse({
      provider: "custom",
      service: "custom",
      configSource: "studio",
      baseUrl: "http://localhost:8100/v1",
      apiKey: "test",
      model,
      stream: true,
      modelMetadata: {
        [model]: {
          maxOutput: 8192,
          compat: {
            supportsStore: true,
          },
        },
      },
    });

    const client = createLLMClient(config);
    expect(client._piModel?.api).toBe("openai-completions");
    const chatCompat = client._piModel?.compat as { supportsStore?: boolean } | undefined;
    expect(chatCompat?.supportsStore).toBe(true);

    await chatCompletion(
      client,
      model,
      [{ role: "user", content: "hello" }],
      { retry: false },
    );

    const stream = guardedPiStream(
      client._piModel!,
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      { apiKey: "test" },
      client.defaults,
    );
    await stream.result();

    expect(requests).toHaveLength(2);
    for (const payload of requests) {
      expect(payload.store).toBe(false);
    }
  });

  it("omits optional store for unknown custom Chat endpoints on both transports", async () => {
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const payload = JSON.parse(init.body);
      requests.push(payload);
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }));

    const model = "arbitrary-custom-store";
    const config = LLMConfigSchema.parse({
      provider: "custom",
      service: "custom",
      configSource: "studio",
      baseUrl: "http://localhost:8100/v1",
      apiKey: "test",
      model,
      stream: true,
      modelMetadata: {
        [model]: { maxOutput: 8192 },
      },
    });

    const client = createLLMClient(config);

    await chatCompletion(
      client,
      model,
      [{ role: "user", content: "hello" }],
      { retry: false },
    );

    const stream = guardedPiStream(
      client._piModel!,
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      { apiKey: "test" },
      client.defaults,
    );
    await stream.result();

    expect(requests).toHaveLength(2);
    for (const payload of requests) {
      expect(payload).not.toHaveProperty("store");
    }
  });

  it("uses the same auto-detected reasoning dialect through native and Pi transports", async () => {
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const payload = JSON.parse(init.body);
      requests.push(payload);
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }));

    const model = "arbitrary-zai-compatible";
    const config = LLMConfigSchema.parse({
      provider: "custom",
      service: "custom",
      configSource: "studio",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiKey: "test",
      model,
      reasoning: "high",
      stream: true,
      modelMetadata: {
        [model]: {
          reasoning: true,
          maxOutput: 8192,
        },
      },
    });

    const client = createLLMClient(config);

    await chatCompletion(
      client,
      model,
      [{ role: "user", content: "hello" }],
      { retry: false },
    );

    const stream = guardedPiStream(
      client._piModel!,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey: "test" },
      client.defaults,
    );
    await stream.result();

    expect(requests).toHaveLength(2);
    for (const payload of requests) {
      expect(payload.enable_thinking).toBe(true);
      expect(payload).not.toHaveProperty("reasoning_effort");
    }
  });

  it("uses the same auto-detected max token field through native and Pi transports", async () => {
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const payload = JSON.parse(init.body);
      requests.push(payload);
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }));

    const model = "arbitrary-auto-max-field";
    const config = LLMConfigSchema.parse({
      provider: "custom",
      service: "custom",
      configSource: "studio",
      baseUrl: "http://localhost:8100/v1",
      apiKey: "test",
      model,
      stream: true,
      modelMetadata: {
        [model]: {
          maxOutput: 8192,
        },
      },
    });

    const client = createLLMClient(config);

    expect(client._piModel?.compat ?? {}).not.toHaveProperty("maxTokensField");

    await chatCompletion(
      client,
      model,
      [{ role: "user", content: "hello" }],
      { retry: false },
    );

    const stream = guardedPiStream(
      client._piModel!,
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      { apiKey: "test" },
      client.defaults,
    );
    await stream.result();

    expect(requests).toHaveLength(2);
    for (const payload of requests) {
      expect(payload.max_completion_tokens).toBe(8192);
      expect(payload).not.toHaveProperty("max_tokens");
    }
  });

  it("uses the same auto-detected developer role through native and Pi transports", async () => {
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const payload = JSON.parse(init.body);
      requests.push(payload);
      return payload.stream
        ? new Response(
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          )
        : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }));

    const model = "arbitrary-auto-compat";
    const config = LLMConfigSchema.parse({
      provider: "custom",
      service: "custom",
      configSource: "studio",
      baseUrl: "http://localhost:8100/v1",
      apiKey: "test",
      model,
      reasoning: "high",
      stream: true,
      modelMetadata: {
        [model]: {
          reasoning: true,
          maxOutput: 8192,
          compat: {
            maxTokensField: "max_tokens",
          },
        },
      },
    });

    const client = createLLMClient(config);

    expect(client._piModel?.compat ?? {}).not.toHaveProperty("supportsDeveloperRole");

    await chatCompletion(
      client,
      model,
      [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ],
      { retry: false },
    );

    const stream = guardedPiStream(
      client._piModel!,
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      { apiKey: "test" },
      client.defaults,
    );
    await stream.result();

    expect(requests).toHaveLength(2);
    expect(requests.map((payload) => payload.messages[0].role)).toEqual([
      "developer",
      "developer",
    ]);
  });

  it("retains explicit capability and transport metadata without enabling runtime reasoning", () => {
    const config = LLMConfigSchema.parse({
      provider: "custom", baseUrl: "http://localhost:8100/v1", model: "generic-agent",
      modelMetadata: { "generic-agent": {
        reasoning: true, compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
      } },
    });
    expect(createLLMClient(config)._piModel).toMatchObject({
      reasoning: true, compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    });
  });

  it.each([
    ["qwen3.8-agent", false, "high"],
    ["arbitrary-model", false, "high"],
    ["arbitrary-model", true, "high"],
  ] as const)("sends the same runtime policy through native and Pi transports for %s (developer=%s)", async (model, developerRole, reasoning) => {
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const payload = JSON.parse(init.body);
      requests.push(payload);
      return payload.stream
        ? new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
        : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }));
    const config = LLMConfigSchema.parse({
      provider: "custom", configSource: "studio", baseUrl: "http://localhost:8100/v1", apiKey: "test", model,
      temperature: 0.3, reasoning, thinkingBudget: 2048, stream: true,
      extra: { chat_template_kwargs: { custom_flag: true }, model: "must-not-override" },
      modelMetadata: { [model]: { reasoning: true, maxOutput: 8192, compat: {
        supportsDeveloperRole: developerRole, maxTokensField: "max_tokens", thinkingFormat: "qwen-chat-template", supportsUsageInStreaming: false,
      } } },
    });
    const client = createLLMClient(config);
    await chatCompletion(client, model, [{ role: "system", content: "system" }, { role: "user", content: "hello" }], { retry: false });
    const stream = guardedPiStream(client._piModel!, { systemPrompt: "system", messages: [{ role: "user", content: "hello", timestamp: 0 }] }, { apiKey: "test" }, client.defaults);
    await stream.result();
    expect(requests).toHaveLength(2);
    for (const payload of requests) {
      expect(payload).toMatchObject({ model, temperature: 0.3, max_tokens: 8192,
        chat_template_kwargs: { enable_thinking: true, custom_flag: true },
      });
      expect(payload.messages[0].role).toBe(developerRole ? "developer" : "system");
      expect(payload.stream_options).toBeUndefined();
    }
  });
  it("uses the same xhigh fallback as the Pi adapter for an unknown model", () => {
    const model = { id: "arbitrary", api: "openai-completions", reasoning: true } as any;
    expect(encodeRuntimePayload({}, model, { reasoning: "xhigh" })).toEqual({ reasoning_effort: "high" });
  });

  it("removes a conflicting chat-template switch already present in a native payload", () => {
    const model = { id: "arbitrary", api: "openai-completions", reasoning: true } as any;
    const extra = { chat_template_kwargs: { enable_thinking: true, custom_flag: true } };
    const result = encodeRuntimePayload(extra, model, { reasoning: "off", extra });
    expect(result).toEqual({ chat_template_kwargs: { custom_flag: true } });
  });
});
