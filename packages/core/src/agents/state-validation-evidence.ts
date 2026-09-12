import { z } from "zod";

export const validationEvidenceSchema = z.object({
  source: z.enum(["chapter", "candidate-state", "candidate-hooks", "baseline", "authority"]),
  quote: z.string().trim().min(1),
});
export const groundedValidationIssueSchema = z.object({
  category: z.string().trim().min(1),
  description: z.string().trim().min(1),
  blocking: z.boolean(),
  kind: z.enum(["conflict", "omission", "unsupported", "observation"]),
  basis: z.enum(["explicit", "inference", "ambiguous"]),
  rationale: z.string().trim().min(1),
  target: z.enum(["candidate-state", "candidate-hooks"]).optional(),
  evidence: z.array(validationEvidenceSchema),
});
export type ValidationEvidence = z.infer<typeof validationEvidenceSchema>;
export type GroundedValidationIssue = z.infer<typeof groundedValidationIssueSchema>;
export type ValidationEvidenceSources = Record<ValidationEvidence["source"], string>;

export function checkValidationEvidence(issues: ReadonlyArray<GroundedValidationIssue>, sources: ValidationEvidenceSources): void {
  const invalid = (message: string): never => {
    throw Object.assign(new Error(message), { reasonCode: "VALIDATOR_EVIDENCE_INVALID" });
  };
  for (const issue of issues) {
    for (const evidence of issue.evidence) {
      if (!sources[evidence.source].includes(evidence.quote)) invalid(`Quote not found in ${evidence.source}: ${evidence.quote}`);
    }
    if (!issue.blocking) continue;
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
}
