import { helixEnvironmentTemporalPlanSchema, helixEnvironmentTimeSha256, type HelixEnvironmentTemporalPlan } from "@shared/helix-environment-time";
import type { MinecraftEnvironmentTimeCompilation } from "./minecraft-environment-time-compiler";

/** Content validation only. The caller must resolve the authenticated event,
 * exact workflow/action and frontier before retaining or admitting a successor. */
export function verifyTemporalCheckpointSettlement(input: {
  plan: HelixEnvironmentTemporalPlan;
  compilation: MinecraftEnvironmentTimeCompilation<unknown>;
  settlements: unknown;
  checkpointId: string;
}) {
  const plan = helixEnvironmentTemporalPlanSchema.parse(input.plan);
  const { compilation_hash, ...content } = input.compilation;
  if (compilation_hash !== helixEnvironmentTimeSha256(content) || content.source_plan_id !== plan.plan_id ||
      content.source_plan_hash !== plan.plan_hash || content.source_goal_id !== plan.identity.goal_id ||
      content.source_goal_revision !== plan.identity.goal_revision) throw new Error("temporal_checkpoint_compilation_mismatch");
  const source = plan.nodes.filter(node => node.kind === "checkpoint" && node.checkpoint_id === input.checkpointId);
  const bindings = content.source_checkpoint_bindings?.filter(binding => binding.source_checkpoint_id === input.checkpointId);
  if (source.length !== 1 || bindings?.length !== 1 || bindings[0].source_node_id !== source[0].node_id) {
    throw new Error("temporal_checkpoint_source_mismatch");
  }
  if (!Array.isArray(input.settlements) || input.settlements.length > 256) throw new Error("temporal_checkpoint_settlements_invalid");
  const binding = bindings[0];
  const matching = input.settlements.filter(value => value && typeof value === "object" &&
    value.node_id === binding.native_node_id && value.checkpoint_id === binding.native_checkpoint_id);
  if (matching.length !== 1) throw new Error("temporal_checkpoint_settlement_missing_or_duplicate");
  const measured = matching[0];
  // Native evidence is cumulative and ordered by settlement. A caller cannot
  // choose an earlier source checkpoint from the latest event. Generated
  // postcondition checkpoints do not replace an explicit source checkpoint.
  const sourceSettlements = input.settlements.filter(value => value && typeof value === "object" &&
    content.source_checkpoint_bindings.some(mapped => mapped.native_node_id === value.node_id &&
      mapped.native_checkpoint_id === value.checkpoint_id));
  const seen = new Set<string>();
  let lastTick = -1;
  let lastElapsed = -1;
  for (const value of sourceSettlements) {
    if (seen.has(value.checkpoint_id)) throw new Error("temporal_checkpoint_settlement_missing_or_duplicate");
    seen.add(value.checkpoint_id);
    if (!Number.isSafeInteger(value.tick_index) || value.tick_index < 0 || value.tick_index >= plan.maximum_total_units ||
        !Number.isSafeInteger(value.monotonic_elapsed_ns) || value.monotonic_elapsed_ns < 0 ||
        value.tick_index < lastTick || value.monotonic_elapsed_ns < lastElapsed) {
      throw new Error("temporal_checkpoint_clock_invalid");
    }
    lastTick = value.tick_index;
    lastElapsed = value.monotonic_elapsed_ns;
  }
  if (sourceSettlements.at(-1) !== measured) throw new Error("temporal_checkpoint_not_latest");
  if (!Number.isSafeInteger(measured.tick_index) || measured.tick_index < 0 || measured.tick_index >= plan.maximum_total_units ||
      !Number.isSafeInteger(measured.monotonic_elapsed_ns) || measured.monotonic_elapsed_ns < 0) {
    throw new Error("temporal_checkpoint_clock_invalid");
  }
  return { checkpoint_id: input.checkpointId, source_node_id: source[0].node_id,
    native_node_id: binding.native_node_id, native_tick_index: measured.tick_index,
    workflow_monotonic_elapsed_ns: measured.monotonic_elapsed_ns,
    execution_authority: false as const, answer_authority: false as const, terminal_eligible: false as const };
}
