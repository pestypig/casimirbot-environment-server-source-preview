import {
  HELIX_ENVIRONMENT_CHECKPOINT_PUBLIC_OUTCOME_SCHEMA,
  helixEnvironmentCheckpointPublicOutcomeSchema,
  type HelixEnvironmentCheckpointPublicOutcome,
  type HelixEnvironmentCheckpointPublicScope,
} from "@shared/helix-environment-checkpoint-public-outcome";
import type { HelixEnvironmentCheckpointDecisionContext } from
  "@shared/helix-environment-checkpoint-decision";
import { assessHelixEnvironmentCheckpointDecision } from
  "@shared/helix-environment-checkpoint-decision";
import type { ResponsesCheckpointDecisionResult } from "./responses-checkpoint-choice";

const sameCheckpointIdentity = (
  left: HelixEnvironmentCheckpointDecisionContext,
  right: HelixEnvironmentCheckpointDecisionContext,
) => left.environment_id === right.environment_id &&
  left.source_id === right.source_id &&
  left.subject_id === right.subject_id &&
  left.goal_id === right.goal_id &&
  left.goal_revision === right.goal_revision &&
  left.predecessor_plan_id === right.predecessor_plan_id &&
  left.predecessor_plan_hash === right.predecessor_plan_hash &&
  left.checkpoint_id === right.checkpoint_id &&
  left.observation_ref === right.observation_ref &&
  left.observation_revision === right.observation_revision &&
  left.affordance_revision === right.affordance_revision &&
  left.producer_epoch === right.producer_epoch &&
  left.authority_id === right.authority_id &&
  left.authority_revision === right.authority_revision &&
  left.monotonic_origin_id === right.monotonic_origin_id;

/**
 * Public, model-text-free projection of a completed provider boundary. This
 * does not persist activity or claim a worker ran when only a parser was used.
 * A caller must verify and persist the source result before publishing it.
 */
export function projectResponsesCheckpointPublicOutcome(input: {
  result: ResponsesCheckpointDecisionResult;
  invocationContext: HelixEnvironmentCheckpointDecisionContext;
  currentContext: HelixEnvironmentCheckpointDecisionContext;
  scope: HelixEnvironmentCheckpointPublicScope;
  observedAt: string;
}): HelixEnvironmentCheckpointPublicOutcome | null {
  const { result, invocationContext: invocation, currentContext: current, scope } = input;
  // Even a parser/refusal rejection belongs to the invocation checkpoint.
  // It must not be relabeled as a current HUD event after source, plan,
  // authority or revision rotation merely because the four display refs match.
  if (!sameCheckpointIdentity(invocation, current)) return null;
  if (scope.goal_id !== invocation.goal_id || scope.checkpoint_id !== invocation.checkpoint_id ||
      scope.observation_ref !== invocation.observation_ref ||
      scope.producer_epoch !== invocation.producer_epoch ||
      scope.goal_id !== current.goal_id || scope.checkpoint_id !== current.checkpoint_id ||
      scope.observation_ref !== current.observation_ref ||
      scope.producer_epoch !== current.producer_epoch) return null;
  if (result.accepted && (result.proposal.goal_id !== scope.goal_id ||
      result.proposal.checkpoint_id !== scope.checkpoint_id ||
      result.proposal.observation_ref !== scope.observation_ref ||
      result.proposal.producer_epoch !== scope.producer_epoch)) return null;
  if (result.accepted && !assessHelixEnvironmentCheckpointDecision(
    result.proposal, current,
  ).accepted) return null;
  const candidate = {
    schema: HELIX_ENVIRONMENT_CHECKPOINT_PUBLIC_OUTCOME_SCHEMA,
    run_id: scope.run_id,
    goal_id: scope.goal_id,
    checkpoint_id: scope.checkpoint_id,
    observation_ref: scope.observation_ref,
    producer_epoch: scope.producer_epoch,
    decision_id: result.accepted ? result.proposal.decision_id : null,
    status: result.accepted ? "proposal" : "rejected",
    disposition: result.accepted ? result.proposal.disposition : null,
    reason: result.accepted ? null : result.reason,
    observed_at: input.observedAt,
    provenance: "derived",
    content_role: "checkpoint_worker_outcome_not_assistant_answer",
    raw_response_included: false,
    private_reasoning_included: false,
    execution_authority: false,
    action_authority_granted: false,
    answer_authority: false,
    assistant_answer: false,
    terminal_eligible: false,
  };
  const parsed = helixEnvironmentCheckpointPublicOutcomeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
