import crypto from "node:crypto";
import { z } from "zod";
import { helixEnvironmentActionChoiceProposalSchema,
  verifiedHelixEnvironmentActionChoiceSourceSchema } from
  "@shared/helix-environment-action-choice";
import { helixEnvironmentTimeSha256 } from "@shared/helix-environment-time";

const snapshotSchema = z.object({
  proposal: helixEnvironmentActionChoiceProposalSchema,
  source: verifiedHelixEnvironmentActionChoiceSourceSchema,
}).strict();

export type ResponsesDecisionSnapshot = z.infer<typeof snapshotSchema>;

/** Provider execution metadata is outside the generic broker's idempotency
 * projection. A Responses decision therefore has one binding-scoped key,
 * checked again when its exact action and snapshot are retained. */
export function responsesActionDecisionIdempotencyKey(input: {
  decisionId: string; bindingId: string; bindingEpoch: number;
}): string {
  const digest = crypto.createHash("sha256").update(JSON.stringify([
    input.decisionId, input.bindingId, input.bindingEpoch,
  ])).digest("hex");
  return `responses_decision:${digest}`;
}

/** Integrity and static provenance only. Historical source clocks are never
 * reinterpreted as a fresh proposal or admission authority. */
export function parseResponsesDecisionSnapshot(raw: unknown): {
  snapshot: ResponsesDecisionSnapshot; hash: string;
} | null {
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { proposal, source } = parsed.data;
  if (proposal.choice_id === "hold_safe" ||
      proposal.choice_id === "escalate_to_codex" ||
      proposal.choice_source_hash !== helixEnvironmentTimeSha256({
        observation_summary: source.observation_summary,
        candidates: source.candidates,
      }) ||
      Object.entries(proposal.context).some(([key, value]) =>
        source.context[key as keyof typeof source.context] !== value) ||
      source.context.interruption_pending ||
      proposal.proposed_at_unit > source.context.current_unit ||
      proposal.proposed_at_monotonic_ms > source.context.current_monotonic_ms ||
      proposal.expires_at_unit < source.context.current_unit ||
      proposal.expires_at_monotonic_ms < source.context.current_monotonic_ms ||
      proposal.expires_at_unit < proposal.proposed_at_unit ||
      proposal.expires_at_monotonic_ms < proposal.proposed_at_monotonic_ms ||
      proposal.expires_at_unit - proposal.proposed_at_unit >
        source.context.maximum_proposal_horizon_units ||
      proposal.expires_at_monotonic_ms - proposal.proposed_at_monotonic_ms >
        source.context.maximum_proposal_lifetime_ms ||
      !source.candidates.some(candidate =>
        candidate.candidate_id === proposal.choice_id &&
        candidate.plan_id === proposal.plan_id &&
        candidate.plan_hash === proposal.plan_hash &&
        candidate.action_code === proposal.action_code &&
        candidate.target_ref === proposal.target_ref)) return null;
  return { snapshot: parsed.data, hash: helixEnvironmentTimeSha256(parsed.data) };
}
