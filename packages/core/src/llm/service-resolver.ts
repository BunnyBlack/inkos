import type { Model, Api } from "@mariozechner/pi-ai";
import { resolveModelDescriptor } from "./model-descriptor.js";
import { resolveServicePiProvider, resolveServicePreset } from "./service-presets.js";
import { getServiceApiKey } from "./secrets.js";
import { getEndpoint } from "./providers/index.js";
import type { InkosEndpoint } from "./providers/types.js";
import type { LLMConfig } from "../models/project.js";
import { isApiKeyOptionalForEndpoint } from "../utils/llm-endpoint-auth.js";

export interface ResolvedModel {
  model: Model<Api>;
  apiKey: string;
  writingTemperature?: number;
  temperatureRange?: readonly [number, number];
  temperatureHint?: string;
}

function resolveProviderCompat(
  provider: InkosEndpoint | undefined,
  baseUrl: string,
  conservativeCustomStore = false,
): Record<string, unknown> | undefined {
  const compat = {
    ...(conservativeCustomStore ? { supportsStore: false } : {}),
    ...(provider?.compat ?? {}),
    ...(baseUrl.includes("generativelanguage.googleapis.com") ? { supportsStore: false } : {}),
  };
  return Object.keys(compat).length > 0 ? compat : undefined;
}

export async function resolveServiceModel(
  service: string,
  modelId: string,
  projectRoot: string,
  customBaseUrl?: string,
  customApiFormat?: "chat" | "responses",
  modelMetadata?: LLMConfig["modelMetadata"],
): Promise<ResolvedModel> {
  // Determine pi-ai provider
  const baseService = service.startsWith("custom:") ? "custom" : service;
  const preset = resolveServicePreset(baseService);
  const endpoint = getEndpoint(baseService);
  const piProvider = baseService === "ollama" ? "ollama" : resolveServicePiProvider(baseService) ?? "openai";
  const apiType = service.startsWith("custom:")
    ? (customApiFormat === "responses" ? "openai-responses" : "openai-completions")
    : (preset?.api ?? "openai-completions");
  const configuredBaseUrl = customBaseUrl ?? preset?.baseUrl ?? "";
  const metadata = modelMetadata?.[modelId];
  const descriptor = resolveModelDescriptor({
    serviceId: baseService,
    modelId,
    piProvider,
    metadata,
  });
  const piModel = descriptor.registryModel;
  const effectiveBaseUrl = configuredBaseUrl || piModel?.baseUrl || "";
  const compat = apiType === "openai-completions"
    ? { ...resolveProviderCompat(endpoint, effectiveBaseUrl, baseService === "custom"), ...metadata?.compat }
    : undefined;

  if (!effectiveBaseUrl) {
    throw new Error(
      `Cannot resolve model "${modelId}" for service "${service}": no baseUrl available.`,
    );
  }

  // Resolve API key after baseUrl/provider are known so local/self-hosted endpoints
  // such as Ollama can be used without forcing a fake secret.
  const apiKey = await getServiceApiKey(projectRoot, service);
  if (!apiKey && !isApiKeyOptionalForEndpoint({ provider: preset?.providerFamily, baseUrl: effectiveBaseUrl })) {
    throw new Error(
      `API key not found for service "${service}". Add it in .inkos/secrets.json or set the environment variable.`,
    );
  }

  const model: Model<Api> = {
    id: modelId,
    name: piModel?.name ?? modelId,
    api: apiType as Api,
    provider: piProvider,
    baseUrl: effectiveBaseUrl,
    reasoning: descriptor.reasoning,
    input: piModel?.input ?? ["text"] as ("text" | "image")[],
    cost: piModel?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: descriptor.contextWindow,
    maxTokens: descriptor.maxTokens,
    ...(compat ? { compat: compat as Model<Api>["compat"] } : {}),
  };

  return {
    model,
    apiKey: apiKey ?? "",
    writingTemperature: preset?.writingTemperature,
    temperatureRange: preset?.temperatureRange,
    temperatureHint: preset?.temperatureHint,
  };
}
