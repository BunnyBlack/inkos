import type { SettlementAttempt, SettlementEvent } from "./settlement-attempt.js";

export type SettlementInspectionView = "overview" | "candidate" | "diagnostics";

export interface InspectionOptions {
  readonly view?: SettlementInspectionView;
  readonly cursor?: number;
  readonly limit?: number;
}

export interface SettlementInspectionSource {
  readonly attempt: SettlementAttempt;
  readonly events: ReadonlyArray<SettlementEvent>;
}

export interface SettlementInspectionOverview {
  readonly view: "overview";
  readonly attemptId: string;
  readonly parentAttemptId?: string;
  readonly chapter: number;
  readonly inputs: SettlementAttempt["inputs"];
  readonly status: SettlementAttempt["status"];
  readonly reasonCode?: string;
  readonly finalError?: string;
  readonly candidateLocation: { readonly attemptFile: string; readonly eventsDirectory: string };
  readonly opinions: ReadonlyArray<SettlementInspectionIssue>;
  readonly responses: ReadonlyArray<{ readonly eventId: string; readonly sequence: number; readonly trustStatus: InspectionTrustStatus; readonly rawOnly: boolean; readonly opinionCount: number }>;
  readonly latestResponse?: { readonly eventId: string; readonly trustStatus: InspectionTrustStatus; readonly rawOnly: boolean; readonly hasValidation: boolean };
  readonly blockedCategories: ReadonlyArray<string>;
}

export interface SettlementInspectionCandidate {
  readonly view: "candidate";
  readonly attemptId: string;
  readonly parentAttemptId?: string;
  readonly status: SettlementAttempt["status"];
  readonly candidate: {
    readonly attemptId: string;
    readonly parentAttemptId?: string;
    readonly status: SettlementAttempt["status"];
    readonly chapter: number;
    readonly title: string;
    readonly output: SettlementAttempt["output"];
    readonly location: { readonly attemptFile: string; readonly eventsDirectory: string };
  };
}

export interface SettlementInspectionDiagnostics {
  readonly view: "diagnostics";
  readonly attemptId: string;
  readonly cursor: number;
  readonly limit: number;
  readonly total: number;
  readonly events: ReadonlyArray<SettlementEvent>;
  readonly nextCursor?: number;
}

export type InspectionTrustStatus = "verified" | "unverified" | "protocol-invalid";

export interface SettlementInspectionIssue {
  readonly issueIndex: number;
  readonly category: string;
  readonly description: string;
  readonly [key: string]: unknown;
  readonly validatorResponseEventId: string;
  readonly sourceEventId: string;
  readonly trustStatus: InspectionTrustStatus;
  readonly rawOnly?: boolean;
  readonly validationEventId?: string;
}

interface ResponseProjection {
  readonly eventId: string;
  readonly sequence: number;
  readonly trustStatus: InspectionTrustStatus;
  readonly rawOnly: boolean;
  readonly opinions: ReadonlyArray<SettlementInspectionIssue>;
  readonly verifiedOpinions: ReadonlyArray<SettlementInspectionIssue>;
  readonly hasValidation: boolean;
}

const validationEventTypes = new Set([
  "validated", "rejected",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function eventData(event: SettlementEvent): Record<string, unknown> {
  return asRecord(event.data) ?? {};
}

function relevantEvents(source: SettlementInspectionSource): SettlementEvent[] {
  return source.events.filter(event => event.attemptId === source.attempt.attemptId);
}

function responseText(data: Record<string, unknown>): string | undefined {
  if (typeof data.response === "string") return data.response;
  if (typeof data.content === "string") return data.content;
  return undefined;
}

function parseStructuredResponse(value: string | undefined): { issues: unknown[]; rawOnly: boolean; protocolInvalid: boolean } {
  if (!value?.trim()) return { issues: [], rawOnly: true, protocolInvalid: true };
  let parsed: unknown;
  try {
    const trimmed = value.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    parsed = JSON.parse(fenced?.[1] ?? trimmed);
  } catch {
    const firstLine = value.trim().split(/\r?\n/u)[0]?.trim();
    if (/^(?:PASS|REPAIR|FAIL)$/iu.test(firstLine ?? "")) return { issues: [], rawOnly: false, protocolInvalid: false };
    return { issues: [], rawOnly: true, protocolInvalid: true };
  }
  const record = asRecord(parsed);
  if (!record) return { issues: [], rawOnly: true, protocolInvalid: true };
  if (Array.isArray(record.issues)) return { issues: record.issues, rawOnly: false, protocolInvalid: false };
  if (Array.isArray(record.warnings)) return { issues: record.warnings, rawOnly: false, protocolInvalid: false };
  return { issues: [], rawOnly: false, protocolInvalid: false };
}

function normalizedOpinion(value: unknown, fallbackIndex: number, event: SettlementEvent, trustStatus: InspectionTrustStatus, rawOnly: boolean, validationEventId?: string): SettlementInspectionIssue {
  const record = asRecord(value);
  const description = typeof record?.description === "string"
    ? record.description
    : typeof value === "string" ? value : JSON.stringify(value) ?? "Unstructured validator opinion";
  const category = typeof record?.category === "string" ? record.category : "general";
  const issueIndex = typeof record?.issueIndex === "number" && Number.isInteger(record.issueIndex)
    ? record.issueIndex : fallbackIndex;
  const detail: Record<string, unknown> = record ? { ...record } : { description, category };
  delete detail.issueIndex;
  delete detail.category;
  delete detail.description;
  return {
    issueIndex,
    category,
    description,
    ...detail,
    validatorResponseEventId: event.eventId,
    sourceEventId: event.eventId,
    trustStatus,
    ...(rawOnly ? { rawOnly: true } : {}),
    ...(validationEventId ? { validationEventId } : {}),
  };
}

function validationPayload(event: SettlementEvent): { issues: unknown[]; eventId: string } | undefined {
  if (!validationEventTypes.has(event.type)) return undefined;
  const data = eventData(event);
  const nested = asRecord(data.validation) ?? asRecord(data.validationResult) ?? asRecord(data.result) ?? data;
  if (typeof nested.passed !== "boolean") return undefined;
  const issues = Array.isArray(nested.issues) ? nested.issues : Array.isArray(nested.warnings) ? nested.warnings : [];
  return { issues, eventId: event.eventId };
}

function projectResponses(events: ReadonlyArray<SettlementEvent>): ResponseProjection[] {
  const responses: ResponseProjection[] = [];
  for (const event of events) {
    if (event.type !== "validator-response" && event.type !== "validation-response") continue;
    const parsed = parseStructuredResponse(responseText(eventData(event)));
    responses.push({
      eventId: event.eventId,
      sequence: event.sequence,
      trustStatus: parsed.protocolInvalid ? "protocol-invalid" : "unverified",
      rawOnly: parsed.rawOnly,
      opinions: parsed.issues.map((issue, index) => normalizedOpinion(issue, index, event, parsed.protocolInvalid ? "protocol-invalid" : "unverified", parsed.rawOnly)),
      verifiedOpinions: [],
      hasValidation: false,
    });
  }

  for (const event of events) {
    const validation = validationPayload(event);
    if (!validation) continue;
    const prior = [...responses].reverse().find(response => response.sequence < event.sequence);
    if (!prior) continue;
    const certified = validation.issues.map((issue, index) => normalizedOpinion(issue, index, {
      ...event,
      eventId: prior.eventId,
    }, "verified", false, validation.eventId));
    const index = responses.indexOf(prior);
    responses[index] = { ...prior, verifiedOpinions: certified, hasValidation: true };
  }
  return responses;
}

function finalError(events: ReadonlyArray<SettlementEvent>): string | undefined {
  for (const event of [...events].reverse()) {
    if (!/(reject|fail|error)/iu.test(event.type)) continue;
    const data = eventData(event);
    const envelope = asRecord(data.failure) ?? asRecord(data.error) ?? data;
    if (typeof data.errorMessage === "string") return data.errorMessage;
    if (typeof envelope.errorMessage === "string") return envelope.errorMessage;
    if (typeof envelope.error === "string") return envelope.error;
  }
  return undefined;
}

function reasonCode(source: SettlementInspectionSource, events: ReadonlyArray<SettlementEvent>): string | undefined {
  if (source.attempt.reasonCode) return source.attempt.reasonCode;
  for (const event of [...events].reverse()) {
    const code = eventData(event).reasonCode;
    if (typeof code === "string") return code;
    const failure = asRecord(eventData(event).failure);
    if (typeof failure?.reasonCode === "string") return failure.reasonCode;
  }
  return undefined;
}

function location(attemptId: string) {
  return {
    attemptFile: `story/recovery/settlements/${attemptId}/attempt.json`,
    eventsDirectory: `story/recovery/settlements/${attemptId}/events`,
  };
}

function boundedPage(options: InspectionOptions): { cursor: number; limit: number } {
  const cursor = Number.isInteger(options.cursor) && (options.cursor ?? 0) >= 0 ? options.cursor ?? 0 : 0;
  const limit = Number.isInteger(options.limit) && (options.limit ?? 2) > 0 ? Math.min(options.limit ?? 2, 10) : 2;
  return { cursor, limit };
}

export function buildSettlementInspection(source: SettlementInspectionSource, options: InspectionOptions & { readonly view: "overview" }): SettlementInspectionOverview;
export function buildSettlementInspection(source: SettlementInspectionSource, options: InspectionOptions & { readonly view: "candidate" }): SettlementInspectionCandidate;
export function buildSettlementInspection(source: SettlementInspectionSource, options: InspectionOptions & { readonly view: "diagnostics" }): SettlementInspectionDiagnostics;
export function buildSettlementInspection(source: SettlementInspectionSource, options?: InspectionOptions & { readonly view?: undefined }): SettlementInspectionOverview;
export function buildSettlementInspection(source: SettlementInspectionSource, options?: InspectionOptions): SettlementInspectionOverview | SettlementInspectionCandidate | SettlementInspectionDiagnostics;
export function buildSettlementInspection(source: SettlementInspectionSource, options: InspectionOptions = {}): SettlementInspectionOverview | SettlementInspectionCandidate | SettlementInspectionDiagnostics {
  const events = relevantEvents(source);
  const responses = projectResponses(events);
  const finalReasonCode = reasonCode(source, events);
  const error = finalError(events);
  const candidateLocation = location(source.attempt.attemptId);
  const view = options.view ?? "overview";

  if (view === "candidate") {
    return {
      view,
      attemptId: source.attempt.attemptId,
      parentAttemptId: source.attempt.parentAttemptId,
      status: source.attempt.status,
      candidate: {
        attemptId: source.attempt.attemptId,
        parentAttemptId: source.attempt.parentAttemptId,
        status: source.attempt.status,
        chapter: source.attempt.chapter,
        title: source.attempt.output.title,
        output: source.attempt.output,
        location: candidateLocation,
      },
    };
  }

  if (view === "diagnostics") {
    const { cursor, limit } = boundedPage(options);
    const page = events.slice(cursor, cursor + limit);
    return {
      view,
      attemptId: source.attempt.attemptId,
      cursor,
      limit,
      total: events.length,
      events: page,
      ...(cursor + page.length < events.length ? { nextCursor: cursor + page.length } : {}),
    };
  }

  const latestResponse = responses.at(-1);
  const latestOpinions = latestResponse?.hasValidation
    ? latestResponse.verifiedOpinions
    : latestResponse?.opinions ?? [];
  return {
    view,
    attemptId: source.attempt.attemptId,
    ...(source.attempt.parentAttemptId ? { parentAttemptId: source.attempt.parentAttemptId } : {}),
    chapter: source.attempt.chapter,
    inputs: source.attempt.inputs,
    status: source.attempt.status,
    ...(finalReasonCode ? { reasonCode: finalReasonCode } : {}),
    ...(error ? { finalError: error } : {}),
    candidateLocation,
    opinions: latestOpinions,
    responses: responses.map(response => ({
      eventId: response.eventId,
      sequence: response.sequence,
      trustStatus: response.hasValidation ? "verified" : response.trustStatus,
      rawOnly: response.rawOnly,
      opinionCount: response.opinions.length,
    })),
    ...(latestResponse ? {
      latestResponse: {
        eventId: latestResponse.eventId,
        trustStatus: latestResponse.hasValidation ? "verified" : latestResponse.trustStatus,
        rawOnly: latestResponse.rawOnly,
        hasValidation: latestResponse.hasValidation,
      },
    } : {}),
    blockedCategories: [...new Set(latestOpinions.filter(issue => issue.blocking === true).map(issue => issue.category))],
  };
}
