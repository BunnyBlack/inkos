import type { Api, Model, SimpleStreamOptions, ThinkingLevel } from "@mariozechner/pi-ai";
import { supportsXhigh } from "@mariozechner/pi-ai";

/** Request policy. Capability belongs to Model; encoding belongs to Model.compat. */
export interface LLMRuntimePolicy {
  readonly reasoning?: ThinkingLevel | "off";
  readonly thinkingBudget?: number;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly extra?: Record<string, unknown>;
}

export const RUNTIME_RESERVED_KEYS = new Set([
  "model", "messages", "input", "instructions", "system", "stream", "tools", "tool_choice",
  "temperature", "max_tokens", "max_completion_tokens", "max_output_tokens",
]);

export function runtimeReasoning(policy: LLMRuntimePolicy): ThinkingLevel | undefined {
  if (policy.reasoning === "off") return undefined;
  return policy.reasoning ?? ((policy.thinkingBudget ?? 0) > 0 ? "medium" : undefined);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Apply explicit policy after protocol serialization, preserving unrelated extra fields. */
export function encodeRuntimePayload(
  payload: Record<string, unknown>, model: Model<Api>, policy: LLMRuntimePolicy,
  transportEncoded = false,
): Record<string, unknown> {
  const result = { ...payload };
  const requestedEffort = runtimeReasoning(policy);
  const effort = requestedEffort === "xhigh" && !supportsXhigh(model) ? "high" : requestedEffort;
  const explicit = policy.reasoning !== undefined || (policy.thinkingBudget ?? 0) > 0;
  const reasoningKeys = new Set(["reasoning_effort", "reasoning", "thinking", "enable_thinking"]);
  const nestedReasoningFields: Record<string, string> = { chat_template_kwargs: "enable_thinking", output_config: "effort" };
  if (explicit && !transportEncoded) {
    for (const key of reasoningKeys) delete result[key];
    for (const [key, field] of Object.entries(nestedReasoningFields)) {
      if (result[key] !== undefined) {
        result[key] = Object.fromEntries(Object.entries(record(result[key])).filter(([name]) => name !== field));
      }
    }
  }
  for (const [key, value] of Object.entries(policy.extra ?? {})) {
    if (!RUNTIME_RESERVED_KEYS.has(key) && !(explicit && reasoningKeys.has(key))) {
      const extraValue = explicit && nestedReasoningFields[key]
        ? Object.fromEntries(Object.entries(record(value)).filter(([field]) => field !== nestedReasoningFields[key])) : value;
      result[key] = typeof value === "object" && value !== null && !Array.isArray(value)
        ? { ...record(result[key]), ...record(extraValue) } : extraValue;
    }
  }
  if (transportEncoded && explicit) {
    // Pi owns URL detection, effort mapping and adaptive-thinking serialization.
    for (const key of ["reasoning_effort", "reasoning", "thinking", "enable_thinking", "chat_template_kwargs", "output_config"]) {
      if (payload[key] !== undefined) {
        result[key] = typeof payload[key] === "object" && payload[key] !== null
          ? { ...record(result[key]), ...record(payload[key]) } : payload[key];
      }
    }
  }
  if (!transportEncoded && model.reasoning && explicit) {
    if (model.api === "openai-completions") {
      const compat = (model as Model<"openai-completions">).compat;
      const mappedEffort = effort ? compat?.reasoningEffortMap?.[effort] ?? effort : "none";
      switch (compat?.thinkingFormat) {
        case "qwen-chat-template":
          result.chat_template_kwargs = { ...record(result.chat_template_kwargs), enable_thinking: Boolean(effort) };
          break;
        case "qwen":
        case "zai":
          result.enable_thinking = Boolean(effort);
          break;
        case "openrouter":
          result.reasoning = { ...record(result.reasoning), effort: mappedEffort };
          break;
        default:
          // Match Pi's off semantics: omit effort on ordinary Chat Completions.
          if (effort && compat?.supportsReasoningEffort !== false) result.reasoning_effort = mappedEffort;
      }
    } else if (model.api === "openai-responses") {
      result.reasoning = { ...record(result.reasoning), effort: effort ?? "none" };
    } else if (model.api === "anthropic-messages") {
      if (!effort) result.thinking = { type: "disabled" };
      else if (!result.thinking) {
        const budgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384 };
        result.thinking = { type: "enabled", budget_tokens: policy.thinkingBudget || budgets[effort] };
      }
      if (effort) delete result.temperature;
    }
  }
  // Treat InkOS maxTokens as the total output reservation, including thinking.
  // Some Pi adapters add a thinking budget after SimpleStreamOptions is resolved.
  if (policy.maxTokens !== undefined) {
    for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
      if (typeof result[key] === "number") result[key] = Math.min(result[key] as number, policy.maxTokens);
    }
    const thinking = record(result.thinking);
    if (typeof thinking.budget_tokens === "number") {
      const budget = Math.min(thinking.budget_tokens, policy.maxTokens - 1);
      if (model.api === "anthropic-messages" && budget < 1024) {
        throw new Error("Anthropic thinking requires at least 1024 tokens and an output limit greater than its thinking budget");
      }
      result.thinking = { ...thinking, budget_tokens: budget };
    }
  }
  return result;
}

export function runtimeStreamOptions(
  model: Model<Api>, policy: LLMRuntimePolicy = {}, options: SimpleStreamOptions = {},
): SimpleStreamOptions {
  const explicit = policy.reasoning !== undefined || (policy.thinkingBudget ?? 0) > 0;
  const reasoning = explicit ? runtimeReasoning(policy) : options.reasoning;
  const budgetLevel = reasoning === "xhigh" ? "high" : reasoning;
  const requestedMaxTokens = options.maxTokens ?? policy.maxTokens ?? model.maxTokens;
  const maxTokens = Number.isFinite(model.maxTokens) && model.maxTokens > 0 && requestedMaxTokens !== undefined
    ? Math.min(requestedMaxTokens, model.maxTokens) : requestedMaxTokens;
  const effectivePolicy = { ...policy, ...(maxTokens !== undefined ? { maxTokens } : {}) };
  return {
    ...options,
    ...(policy.temperature !== undefined && options.temperature === undefined ? { temperature: policy.temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    reasoning,
    ...(budgetLevel && (policy.thinkingBudget ?? 0) > 0
      ? { thinkingBudgets: { ...options.thinkingBudgets, [budgetLevel]: policy.thinkingBudget } } : {}),
    onPayload: async (payload, transportModel) => {
      const transformed = await options.onPayload?.(payload, transportModel);
      return encodeRuntimePayload(record(transformed ?? payload), transportModel, effectivePolicy, true);
    },
  };
}
