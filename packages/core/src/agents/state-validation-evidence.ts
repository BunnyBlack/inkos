import { z } from "zod";

export const validationEvidenceSchema = z.object({
  source: z.enum(["chapter", "candidate-state", "candidate-hooks", "baseline", "authority"]),
  quote: z.string().trim().min(1),
});
export const groundedValidationIssueSchema = z.object({
  category: z.string().trim().min(1),
  description: z.string().trim().min(1),
  blocking: z.boolean(),
  kind: z.enum(["conflict", "internal-conflict", "omission", "unsupported", "observation"]),
  basis: z.enum(["explicit", "inference", "ambiguous"]),
  rationale: z.string().trim().min(1),
  target: z.enum(["candidate-state", "candidate-hooks"]).optional(),
  evidence: z.array(validationEvidenceSchema),
});
export type ValidationEvidence = z.infer<typeof validationEvidenceSchema>;
export type GroundedValidationIssue = z.infer<typeof groundedValidationIssueSchema>;
export type ValidationEvidenceSources = Record<ValidationEvidence["source"], string>;
export type QuoteMatch = { start: number; end: number; text: string; mode: "exact" | "layout" };

export function resolveEvidenceQuote(source: string, quote: string): QuoteMatch | undefined {
  if (!source || !quote) return undefined;

  const exactStart = source.indexOf(quote);
  if (exactStart >= 0) return { start: exactStart, end: exactStart + quote.length, text: quote, mode: "exact" };

  const layoutMatches: QuoteMatch[] = [];
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== quote[0]) continue;
    const end = matchLayoutAt(source, quote, start);
    if (end !== undefined) {
      layoutMatches.push({ start, end, text: source.slice(start, end), mode: "layout" });
      if (layoutMatches.length > 1) return undefined;
    }
  }
  return layoutMatches.length === 1 ? layoutMatches[0] : undefined;
}

export function checkValidationEvidence(
  issues: ReadonlyArray<GroundedValidationIssue>,
  sources: ValidationEvidenceSources,
): ReadonlyArray<GroundedValidationIssue> {
  const invalid = (message: string): never => {
    throw Object.assign(new Error(message), { reasonCode: "VALIDATOR_EVIDENCE_INVALID" });
  };

  const normalizedIssues = issues.map((issue) => ({
    ...issue,
    evidence: issue.evidence.map((evidence) => {
      const match = resolveEvidenceQuote(sources[evidence.source], evidence.quote);
      if (!match) invalid(`Quote not found uniquely in ${evidence.source}: ${evidence.quote}`);
      return { ...evidence, quote: match!.text };
    }),
  }));

  for (const issue of normalizedIssues) {
    const candidateEvidence = issue.evidence.filter((evidence) => evidence.source === "candidate-state" || evidence.source === "candidate-hooks");
    if (issue.kind === "internal-conflict") {
      if (issue.basis !== "explicit") invalid("Internal conflict requires explicit candidate evidence; inference or ambiguity is not repairable.");
      const distinctCandidateEvidence = new Set(candidateEvidence.map((evidence) => `${evidence.source}\u0000${evidence.quote}`));
      if (distinctCandidateEvidence.size < 2) invalid("Internal conflict requires two distinct candidate evidence quotes.");
      continue;
    } else if (!issue.blocking) {
      continue;
    }
    // Exact quotes establish provenance, not semantic correctness. Never turn a
    // declared inference or ambiguity into an instruction to invent story facts.
    if (issue.basis !== "explicit") invalid("Blocking feedback relies on inference or ambiguity; manual judgment or validator correction is required.");
    const has = (source: ValidationEvidence["source"]) => issue.evidence.some((e) => e.source === source);
    if (issue.kind === "omission") {
      if (!has("chapter") || !issue.target) invalid("Omission requires a chapter fact quote and candidate check target.");
    } else {
      if (issue.kind === "observation" || !(has("candidate-state") || has("candidate-hooks")) || !(has("chapter") || has("authority") || has("baseline"))) {
        invalid("Blocking conflict requires candidate evidence and chapter, baseline, or authority evidence.");
      }
    }
  }
  return normalizedIssues;
}

function matchLayoutAt(source: string, quote: string, start: number): number | undefined {
  let sourceIndex = start;
  let quoteIndex = 0;
  while (sourceIndex < source.length && quoteIndex < quote.length) {
    const sourceWhitespace = whitespaceRun(source, sourceIndex);
    const quoteWhitespace = whitespaceRun(quote, quoteIndex);
    if (!sourceWhitespace && !quoteWhitespace) {
      if (source[sourceIndex] !== quote[quoteIndex]) return undefined;
      sourceIndex += 1;
      quoteIndex += 1;
      continue;
    }

    if (sourceWhitespace && quoteWhitespace) {
      if (sourceWhitespace.text !== quoteWhitespace.text
        && !containsLineBreak(sourceWhitespace.text) && !containsLineBreak(quoteWhitespace.text)) return undefined;
      sourceIndex = sourceWhitespace.end;
      quoteIndex = quoteWhitespace.end;
      continue;
    }

    if (sourceWhitespace) {
      if (!containsLineBreak(sourceWhitespace.text)
        || !hasChineseSentenceBoundary(source, sourceIndex)
        || joinsEnglishWords(source, sourceIndex, quote, quoteIndex)) return undefined;
      sourceIndex = sourceWhitespace.end;
      continue;
    }

    if (!quoteWhitespace || !containsLineBreak(quoteWhitespace.text) || !hasChineseSentenceBoundary(quote, quoteIndex)) return undefined;
    if (joinsEnglishWords(quote, quoteIndex, source, sourceIndex)) return undefined;
    quoteIndex = quoteWhitespace.end;
  }

  return quoteIndex === quote.length ? sourceIndex : undefined;
}

function whitespaceRun(text: string, start: number): { end: number; text: string } | undefined {
  if (!/\s/u.test(text[start] ?? "")) return undefined;
  let end = start + 1;
  while (end < text.length && /\s/u.test(text[end]!)) end += 1;
  return { end, text: text.slice(start, end) };
}

function containsLineBreak(text: string): boolean {
  return /[\r\n]/u.test(text);
}

function isEnglishWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/u.test(char);
}

function joinsEnglishWords(textWithGap: string, gapStart: number, otherText: string, otherIndex: number): boolean {
  return isEnglishWordChar(textWithGap[gapStart - 1]) && isEnglishWordChar(otherText[otherIndex]);
}

function hasChineseSentenceBoundary(text: string, whitespaceStart: number): boolean {
  return /[。！？；]/u.test(text[whitespaceStart - 1] ?? "");
}
