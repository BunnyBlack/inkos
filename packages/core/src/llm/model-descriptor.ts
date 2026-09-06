import { getModel } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { LLMConfig } from "../models/project.js";
import { getEndpoint } from "./providers/index.js";
import { lookupModel } from "./providers/lookup.js";
import type { InkosModel } from "./providers/types.js";

export const UNKNOWN_MODEL_FALLBACK_CONTEXT_WINDOW = 128_000;
export const UNKNOWN_MODEL_FALLBACK_MAX_TOKENS = 24_576;

type ModelMetadataEntry = NonNullable<LLMConfig["modelMetadata"]>[string];

export interface ResolvedModelDescriptor {
  readonly bankModel?: InkosModel;
  readonly registryModel?: Model<Api>;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/**
 * Resolve model capability and limits independently of request policy and wire encoding.
 *
 * Precedence:
 * explicit model metadata > InkOS provider bank > pi-ai registry > conservative fallback.
 *
 * The provider-bank lookup preserves endpoint deploymentName matching before the
 * normal lookupModel() search, which itself falls back to the global InkOS bank.
 */
export function resolveModelDescriptor(params: {
  readonly serviceId: string;
  readonly modelId: string;
  readonly piProvider: string;
  readonly metadata?: ModelMetadataEntry;
}): ResolvedModelDescriptor {
  const endpoint = getEndpoint(params.serviceId);
  const bankModel = endpoint?.models.find(
    (model) => model.deploymentName === params.modelId,
  ) ?? lookupModel(params.serviceId, params.modelId);

  const registryModel = getModel(
    params.piProvider as any,
    params.modelId as any,
  ) as Model<Api> | undefined;

  return {
    bankModel,
    registryModel,
    reasoning:
      params.metadata?.reasoning
      ?? bankModel?.capabilities?.reasoning
      ?? registryModel?.reasoning
      ?? false,
    contextWindow:
      params.metadata?.contextWindowTokens
      ?? bankModel?.contextWindowTokens
      ?? registryModel?.contextWindow
      ?? UNKNOWN_MODEL_FALLBACK_CONTEXT_WINDOW,
    maxTokens:
      params.metadata?.maxOutput
      ?? bankModel?.maxOutput
      ?? registryModel?.maxTokens
      ?? UNKNOWN_MODEL_FALLBACK_MAX_TOKENS,
  };
}
