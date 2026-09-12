import { BaseAgent } from "./base.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { safeChildPath } from "../utils/path-safety.js";
import type { LLMMessage } from "../llm/provider.js";
import { checkValidationEvidence, groundedValidationIssueSchema, type GroundedValidationIssue, type ValidationEvidenceSources } from "./state-validation-evidence.js";

export interface ValidationWarning {
  readonly category: string;
  readonly description: string;
}

export interface ValidationResult {
  readonly warnings: ReadonlyArray<ValidationWarning>;
  readonly passed: boolean;
  readonly repairRequired?: boolean;
  readonly issues?: ReadonlyArray<GroundedValidationIssue>;
}

export type StateValidationDiagnostic = {
  readonly attempt: 1 | 2;
  readonly chapterNumber: number;
  readonly model: string;
} & ({ readonly phase: "request"; readonly messages: ReadonlyArray<LLMMessage> }
  | { readonly phase: "response"; readonly response: string });

export interface StateValidationOptions {
  readonly onDiagnostic?: (event: StateValidationDiagnostic) => Promise<void> | void;
}

export interface StateValidationAuthorityContext {
  readonly storyFrame?: string;
  readonly bookRules?: string;
  readonly chapterSummaries?: string;
}

/**
 * Validates Settler output by comparing old and new truth files via LLM.
 * Catches contradictions, missing state changes, and temporal inconsistencies.
 *
 * Blocking opinions require structured, source-grounded evidence. Legacy verdicts
 * remain parseable, but legacy blockers receive one evidence-completion request.
 * Quote verification establishes provenance, not semantic correctness.
 */
export class StateValidatorAgent extends BaseAgent {
  get name(): string {
    return "state-validator";
  }

  async validate(
    chapterContent: string,
    chapterNumber: number,
    oldState: string,
    newState: string,
    oldHooks: string,
    newHooks: string,
    language: "zh" | "en" = "zh",
    authorityContext?: StateValidationAuthorityContext,
    options?: StateValidationOptions,
  ): Promise<ValidationResult> {
    const stateDiff = this.computeDiff(oldState, newState, "State Card");
    const hooksDiff = this.computeDiff(oldHooks, newHooks, "Hooks Pool");

    const langInstruction = language === "en"
      ? "Respond in English."
      : "用中文回答。";

    const systemPrompt = `You are a continuity validator for a novel writing system. ${langInstruction}

Given the chapter text and the CHANGES made to truth files (state card + hooks pool), check for contradictions:

1. State change without narrative support — truth file says something changed but the chapter text doesn't describe it
2. Missing state change — chapter text describes something happening but the truth file didn't capture it
3. Temporal impossibility — character moves locations without transition, injury heals without time passing
4. Hook anomaly — a hook disappeared without being marked resolved, or a new hook has no basis in the chapter
5. Retroactive edit — truth file change implies something happened in a PREVIOUS chapter, not the current one
6. Cross-truth key-setting conflict — numbered rules, named laws, ranks, identities, locations, or relationship labels in the new truth files contradict the chapter text or the authority context

Output JSON: {"verdict":"PASS|REPAIR|FAIL","issues":[{"category":"contradiction","description":"explain the problem","blocking":true,"kind":"conflict|omission|unsupported|observation","basis":"explicit|inference|ambiguous","rationale":"why these exact quotes support the issue","target":"candidate-state|candidate-hooks","evidence":[{"source":"chapter|candidate-state|candidate-hooks|baseline|authority","quote":"exact quote from that source"}]}]}.
If no issues exist, legacy plain PASS is also accepted. Every blocking issue must include evidence. Quote full source text, not diff prefixes.
For conflicts quote both the candidate and the chapter/baseline/authority fact. For omissions quote the explicit chapter fact and give the candidate target to check; do not invent a quote for absent text.
Mark inferred or ambiguous interpretations as nonblocking observations, never explicit facts. If ambiguity prevents a reliable verdict, explain it for manual judgment rather than demand invented facts.

Verdict semantics:
- PASS: the truth-file projection is complete enough and consistent with the chapter.
- REPAIR: the chapter itself is valid, but a state change or hook transition is missing, stale, or incomplete. The host will regenerate only the truth-file settlement.
- FAIL: the proposed truth-file changes directly contradict the chapter or authority context.

IMPORTANT: Output FAIL ONLY for hard contradictions — facts that directly conflict with the chapter text. Output REPAIR for missing state updates and hook-management omissions that should be regenerated. Do NOT fail for:
- Slightly ahead-of-text inferences
- Reasonable extrapolations from text
Minor details that do not affect ongoing continuity may remain warnings with PASS.
Model feedback is an opinion to verify, not new story authority. Current chapter text takes priority. Do not infer consent from noticing deception, silence, or understanding a concealed motive. Do not require a candidate to assert agreement that the chapter does not explicitly establish. Never request changes to chapter text or author settings to satisfy your interpretation.`;

    const authorityBlock = this.buildAuthorityContextBlock(authorityContext);
    const sources: ValidationEvidenceSources = {
      chapter: chapterContent,
      "candidate-state": newState,
      "candidate-hooks": newHooks,
      baseline: [oldState, oldHooks].join("\n\n"),
      authority: [authorityContext?.storyFrame ?? "", authorityContext?.bookRules ?? "", authorityContext?.chapterSummaries ?? ""].join("\n\n"),
    };

    const userPrompt = `Chapter ${chapterNumber} validation:

${authorityBlock}

## Full evidence sources (source labels for exact quotes)
${JSON.stringify(sources)}

## State Card Changes
${stateDiff || "(no changes)"}

## Hooks Pool Changes
${hooksDiff || "(no changes)"}

## Chapter Text (for reference)
${chapterContent}`;

    const messages: LLMMessage[] = [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }];
    for (const attempt of [1, 2] as const) {
      const common = { attempt, chapterNumber, model: this.ctx.model };
      const preparedMessages = await this.appendTaskSkillGuidance([...messages]);
      await this.recordDiagnostic({ ...common, phase: "request", messages: preparedMessages }, options);
      const response = await this.chat(preparedMessages, { temperature: 0.1 }, { alreadyPrepared: true });
      const diagnosticPath = await this.recordDiagnostic({ ...common, phase: "response", response: response.content }, options);
      try {
        const result = this.parseResult(response.content);
        if (!result.issues && result.warnings.some((warning) => ["unsupported_change", "contradiction", "missing_state_update", "hook_anomaly", "temporal_impossibility", "retroactive_edit"].includes(warning.category))) {
          throw Object.assign(new Error("Legacy continuity warning requires grounded evidence and a consistent verdict."), { reasonCode: "VALIDATOR_EVIDENCE_INVALID" });
        }
        if (!result.passed && !result.issues?.some((issue) => issue.blocking)) {
          throw Object.assign(new Error("Blocking verdict requires structured grounded evidence."), { reasonCode: "VALIDATOR_EVIDENCE_INVALID" });
        }
        if (result.issues) checkValidationEvidence(result.issues, sources);
        return result;
      } catch (error) {
        const reasonCode = (error as { reasonCode?: string }).reasonCode ?? "VALIDATOR_PROTOCOL_INVALID";
        if (attempt === 2) throw Object.assign(new Error(String(error), { cause: error }), { reasonCode, diagnosticPath });
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: `Correct only your validation protocol/evidence against the SAME candidate and sources. ${reasonCode}: ${String(error)}. Return the required structured verdict with exact source quotes. Reassess unsupported interpretations; do not invent facts, change the chapter, or edit the candidate. Do not infer consent from noticing deception or silence. This is the only correction attempt.` });
      }
    }
    throw new Error("Validator correction budget exhausted");
  }

  private async recordDiagnostic(event: StateValidationDiagnostic, options?: StateValidationOptions): Promise<string | undefined> {
    if (options?.onDiagnostic) { await options.onDiagnostic(event); return undefined; }
    if (!this.ctx.bookId) return undefined;
    try {
      const directory = join(safeChildPath(join(this.ctx.projectRoot, "books"), this.ctx.bookId), "story", "recovery", "validator");
      const path = join(directory, `${event.chapterNumber}-${event.attempt}-${event.phase}-${randomUUID()}.json`);
      await mkdir(directory, { recursive: true });
      await writeFile(path, JSON.stringify({ ...event, recordedAt: new Date().toISOString() }), { encoding: "utf8", flag: "wx" });
      return path;
    } catch (cause) {
      throw Object.assign(new Error("Validator evidence could not be saved", { cause }), { reasonCode: "SETTLEMENT_EVIDENCE_WRITE_FAILED" });
    }
  }

  private computeDiff(oldText: string, newText: string, label: string): string | null {
    if (oldText === newText) return null;

    const oldLines = oldText.split("\n").filter((l) => l.trim());
    const newLines = newText.split("\n").filter((l) => l.trim());

    const added = newLines.filter((l) => !oldLines.includes(l));
    const removed = oldLines.filter((l) => !newLines.includes(l));

    if (added.length === 0 && removed.length === 0) return null;

    const parts = [`### ${label}`];
    if (removed.length > 0) parts.push("Removed:\n" + removed.map((l) => `- ${l}`).join("\n"));
    if (added.length > 0) parts.push("Added:\n" + added.map((l) => `+ ${l}`).join("\n"));
    return parts.join("\n");
  }

  private buildAuthorityContextBlock(authorityContext?: StateValidationAuthorityContext): string {
    if (!authorityContext) return "## Authority / Cross-Truth Context\n(no authority context provided)";

    const storyFrame = (authorityContext.storyFrame ?? "").trim();
    const bookRules = (authorityContext.bookRules ?? "").trim();
    const chapterSummaries = (authorityContext.chapterSummaries ?? "").trim();

    return [
      "## Authority / Cross-Truth Context",
      "Authority priority: current chapter text > runtime truth files/current summaries > story_frame/book_rules > legacy story_bible intro or marketing-style prose. If the current chapter establishes a numbered/name mapping, new truth files must follow that mapping instead of preserving an older intro-only version.",
      "",
      "### story_frame / legacy story_bible excerpt",
      storyFrame || "(empty)",
      "",
      "### book_rules excerpt",
      bookRules || "(empty)",
      "",
      "### recent chapter_summaries excerpt",
      chapterSummaries || "(empty)",
    ].join("\n");
  }

  private parseResult(content: string): ValidationResult {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error("LLM returned empty response");
    }

    const jsonResult = this.tryParseJsonResult(trimmed);
    if (jsonResult) {
      return jsonResult;
    }

    const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      throw new Error("LLM returned empty response");
    }

    const verdictLine = lines[0]!;
    if (!/^(PASS|REPAIR|FAIL)$/i.test(verdictLine)) {
      throw new Error("State validator returned invalid response");
    }
    const passed = /^PASS$/i.test(verdictLine);
    const repairRequired = /^REPAIR$/i.test(verdictLine);

    const warnings: ValidationWarning[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^(PASS|REPAIR|FAIL)$/i.test(line)) throw new Error("State validator returned multiple verdicts");

      const categoryMatch = line.match(/^\[([^\]]+)\]\s*(.+)$/);
      if (categoryMatch) {
        warnings.push({
          category: categoryMatch[1]!.trim(),
          description: categoryMatch[2]!.trim(),
        });
      } else if (line.startsWith("- ") || line.startsWith("* ")) {
        warnings.push({
          category: "general",
          description: line.slice(2).trim(),
        });
      } else if (line.length > 5) {
        warnings.push({
          category: "general",
          description: line,
        });
      }
    }

    return { warnings, passed, repairRequired };
  }

  private tryParseJsonResult(text: string): ValidationResult | null {
    const direct = this.tryParseExactJsonResult(text);
    if (direct) {
      return direct;
    }

    const candidate = extractBalancedJsonObject(text);
    if (!candidate) {
      return null;
    }
    return this.tryParseExactJsonResult(candidate);
  }

  private tryParseExactJsonResult(text: string): ValidationResult | null {
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch { return null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if ("verdict" in parsed || "issues" in parsed) {
      if (!["PASS", "REPAIR", "FAIL"].includes(parsed.verdict) || !Array.isArray(parsed.issues)) throw new Error("State validator returned invalid structured verdict");
      if (["warnings", "passed", "repairRequired"].some((field) => field in parsed)) throw new Error("State validator mixed structured and legacy verdict fields");
      const issues = groundedValidationIssueSchema.array().safeParse(parsed.issues);
      if (!issues.success) throw Object.assign(new Error("State validator returned invalid evidence structure"), { reasonCode: "VALIDATOR_EVIDENCE_INVALID" });
      if (parsed.verdict === "PASS" && issues.data.some((issue) => issue.blocking)) throw new Error("PASS cannot contain blocking issues");
      return { passed: parsed.verdict === "PASS", repairRequired: parsed.verdict === "REPAIR", issues: issues.data,
        warnings: issues.data.map(({ category, description }) => ({ category, description })) };
    }
    try {
      if (typeof parsed.passed !== "boolean") return null;
      if (parsed.repairRequired !== undefined && typeof parsed.repairRequired !== "boolean") return null;
      if (parsed.passed && parsed.repairRequired) return null;
      if (parsed.warnings !== undefined && (!Array.isArray(parsed.warnings) || parsed.warnings.some((w: any) => !w || typeof w.category !== "string" || typeof w.description !== "string"))) return null;
      return {
        warnings: (parsed.warnings ?? []).map((w: ValidationWarning) => ({
          category: w.category ?? "unknown",
          description: w.description ?? "",
        })),
        passed: parsed.passed,
        repairRequired: parsed.repairRequired === true,
      };
    } catch {
      return null;
    }
  }
}

function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }
  const prefix = text.slice(0, start).trim();
  if (prefix && !/^```(?:json)?$/i.test(prefix)) {
    throw new Error("State validator returned content before its JSON verdict");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIndex = -1;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        endIndex = index;
        break;
      }
      if (depth < 0) {
        return null;
      }
    }
  }

  if (endIndex < 0) return null;

  const suffix = text.slice(endIndex + 1).trim();
  // Preserve harmless historical markdown notes, but never choose the first
  // verdict when another object or verdict token follows it.
  if (suffix.includes("{") || /\b(?:PASS|REPAIR|FAIL)\b/i.test(suffix)) {
    throw new Error("State validator returned competing verdict content");
  }
  if (prefix && suffix !== "```") {
    throw new Error("State validator returned an invalid JSON fence");
  }

  // Only accept the candidate if what follows the closing brace is
  // nothing, whitespace, or a structural JSON terminator.
  // This rejects trailing content like "{...} more text here"
  const followingChar = text[endIndex + 1];
  if (
    followingChar !== undefined &&
    followingChar !== "\n" &&
    followingChar !== "\r" &&
    followingChar !== "\t" &&
    followingChar !== " " &&
    followingChar !== "," &&
    followingChar !== "]" &&
    followingChar !== "}"
  ) {
    return null;
  }

  return text.slice(start, endIndex + 1);
}
