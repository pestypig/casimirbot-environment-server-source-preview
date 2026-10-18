import type { z } from "zod";
import {
  helixEnvironmentTimeSha256,
  helixEnvironmentTemporalPlanSchema,
  type HelixEnvironmentPlanCondition,
  type HelixEnvironmentTemporalPlan,
} from "../../../../shared/helix-environment-time";
import {
  HELIX_MINECRAFT_PLAYER_SEQUENCE_SCHEMA,
  helixMinecraftFluidConditionSchema,
  helixMinecraftFluidMutationScopeSchema,
  helixMinecraftFluidSequenceArgumentsSchema,
  type HelixMinecraftFluidCondition,
  type HelixMinecraftFluidSequenceArguments,
  type HelixMinecraftFluidSequenceNode,
} from "../../../../shared/helix-minecraft-fluid-sequence";
import {
  HELIX_MINECRAFT_REACTIVE_PROGRAM_SCHEMA,
  helixMinecraftReactiveMutationScopeSchema,
  helixMinecraftReactiveProgramArgumentsSchema,
  minecraftReactiveResourcesForAction,
  type HelixMinecraftReactiveNode,
  type HelixMinecraftReactiveProgramArguments,
  type HelixMinecraftReactiveResource,
} from "../../../../shared/helix-minecraft-reactive-program";
import {
  helixMinecraftPlayerActionArgumentsSchema,
  minecraftPlayerCapabilityForActionKind,
  type HelixMinecraftPlayerActionArguments,
} from "../../../../shared/helix-minecraft-player-capabilities";

type FluidMutationScope = z.infer<typeof helixMinecraftFluidMutationScopeSchema>;
type ReactiveMutationScope = z.infer<
  typeof helixMinecraftReactiveMutationScopeSchema
>;

export class MinecraftEnvironmentTimeCompileError extends Error {
  constructor(
    readonly code:
      | "adapter_mismatch"
      | "clock_mismatch"
      | "unsupported_condition"
      | "unsupported_semantics"
      | "capability_mismatch"
      | "resource_mismatch"
      | "effect_mismatch"
      | "invalid_compiled_program",
    message: string,
  ) {
    super(message);
    this.name = "MinecraftEnvironmentTimeCompileError";
  }
}

export type MinecraftEnvironmentTimeCompilation<T> = {
  schema: "environment.minecraft_temporal_plan_compilation.v1";
  source_plan_id: string;
  source_plan_hash: string;
  source_goal_id: string;
  source_goal_revision: number;
  target_schema: string;
  arguments: T;
  source_checkpoint_bindings: Array<{
    source_node_id: string;
    source_checkpoint_id: string;
    native_node_id: string;
    native_checkpoint_id: string;
  }>;
  compilation_hash: string;
  execution_authority: false;
  answer_authority: false;
  assistant_answer: false;
  terminal_eligible: false;
};

const wrapCompilation = <T extends object>(
  plan: HelixEnvironmentTemporalPlan,
  targetSchema: string,
  argumentsValue: T,
): MinecraftEnvironmentTimeCompilation<T> => {
  const base = {
    schema: "environment.minecraft_temporal_plan_compilation.v1" as const,
    source_plan_id: plan.plan_id,
    source_plan_hash: plan.plan_hash,
    source_goal_id: plan.identity.goal_id,
    source_goal_revision: plan.identity.goal_revision,
    target_schema: targetSchema,
    arguments: argumentsValue,
    // Generated action postconditions are intentionally absent. Only explicit
    // source checkpoints can anchor a source-plan extension. Both current
    // compilers preserve these node/checkpoint IDs; the map is hash-bound.
    source_checkpoint_bindings: plan.nodes.flatMap(node => node.kind === "checkpoint" ? [{
      source_node_id: node.node_id,
      source_checkpoint_id: node.checkpoint_id,
      native_node_id: node.node_id,
      native_checkpoint_id: node.checkpoint_id,
    }] : []),
    execution_authority: false as const,
    answer_authority: false as const,
    assistant_answer: false as const,
    terminal_eligible: false as const,
  };
  return { ...base, compilation_hash: helixEnvironmentTimeSha256(base) };
};

const condition = (
  source: HelixEnvironmentPlanCondition,
): HelixMinecraftFluidCondition => {
  if (source.kind === "adapter_condition") {
    const conditionId = source.condition_id.startsWith("minecraft.")
      ? source.condition_id.slice("minecraft.".length)
      : source.condition_id;
    const parsed = helixMinecraftFluidConditionSchema.safeParse({
      condition_kind: conditionId,
      ...source.arguments,
    });
    if (parsed.success) return parsed.data;
  }
  if (source.kind === "prior_node_outcome") {
    const outcome =
      source.outcome === "interrupted" || source.outcome === "not_started"
        ? null
        : source.outcome;
    if (outcome) {
      return helixMinecraftFluidConditionSchema.parse({
        condition_kind: "node_outcome_is",
        node_id: source.node_id,
        outcome,
      });
    }
  }
  if (source.kind === "checkpoint_satisfied") {
    return helixMinecraftFluidConditionSchema.parse({
      condition_kind: "checkpoint_satisfied",
      checkpoint_id: source.checkpoint_id,
    });
  }
  throw new MinecraftEnvironmentTimeCompileError(
    "unsupported_condition",
    `Minecraft cannot exactly compile shared condition ${source.kind}.`,
  );
};

const validateBase = (planInput: HelixEnvironmentTemporalPlan) => {
  const plan = helixEnvironmentTemporalPlanSchema.parse(planInput);
  if (plan.adapter_id !== "minecraft.fabric_client") {
    throw new MinecraftEnvironmentTimeCompileError(
      "adapter_mismatch",
      `Expected minecraft.fabric_client, received ${plan.adapter_id}.`,
    );
  }
  if (
    plan.clocks.environment.kind !== "tick" ||
    plan.clocks.environment.resolution_unit !== "minecraft_tick"
  ) {
    throw new MinecraftEnvironmentTimeCompileError(
      "clock_mismatch",
      "Minecraft plans require the tick/minecraft_tick clock domain.",
    );
  }
  for (const node of plan.nodes) {
    if (node.kind !== "action") continue;
    if (node.abort_guards.length > 0) {
      throw new MinecraftEnvironmentTimeCompileError(
        "unsupported_semantics",
        `Action ${node.node_id} has abort guards that require a separately admitted resident interrupt lane.`,
      );
    }
    const action = helixMinecraftPlayerActionArgumentsSchema.parse(node.arguments);
    if (
      minecraftPlayerCapabilityForActionKind(action.action_kind) !== node.capability_id ||
      node.capability_version !== "1"
    ) {
      throw new MinecraftEnvironmentTimeCompileError(
        "capability_mismatch",
        `Action ${node.node_id} arguments do not match capability ${node.capability_id}@${node.capability_version}.`,
      );
    }
  }
  return plan;
};

const minecraftAction = (
  plan: HelixEnvironmentTemporalPlan,
  nodeId: string,
): HelixMinecraftPlayerActionArguments => {
  const node = plan.nodes.find((candidate) => candidate.node_id === nodeId);
  if (!node || node.kind !== "action") {
    throw new MinecraftEnvironmentTimeCompileError(
      "unsupported_semantics",
      `Expected action node ${nodeId}.`,
    );
  }
  return helixMinecraftPlayerActionArgumentsSchema.parse(node.arguments);
};

const assertResources = (
  declared: readonly string[],
  action: HelixMinecraftPlayerActionArguments,
  bindings: Readonly<Record<string, HelixMinecraftReactiveResource>>,
) => {
  const required = minecraftReactiveResourcesForAction(action);
  const translated = new Set(declared.map((resource) => bindings[resource] ?? resource));
  const missing = required.filter((resource) => !translated.has(resource));
  if (missing.length > 0) {
    throw new MinecraftEnvironmentTimeCompileError(
      "resource_mismatch",
      `Minecraft action ${action.action_kind} is missing declared resources: ${missing.join(", ")}.`,
    );
  }
};

const inferredEffects = (action: HelixMinecraftPlayerActionArguments) => {
  if (action.action_kind === "mine") {
    return { block_mutations: action.count, inventory_transfers: action.count };
  }
  if (action.action_kind === "place") {
    const count = (action.positions?.length ?? 1) *
      (action.cleanup_after_landing === true ? 2 : 1);
    return { block_mutations: count, inventory_transfers: count };
  }
  if (["collect", "craft", "consume", "inventory_transfer"].includes(action.action_kind)) {
    return { inventory_transfers: "count" in action ? action.count : 0 };
  }
  if (action.action_kind === "equip") return { inventory_transfers: 1 };
  if (action.action_kind === "attack") return { combat_pulses: action.max_attack_pulses };
  if (action.action_kind === "combat_guard") return { combat_pulses: action.max_attack_pulses };
  return {};
};

const assertEffects = (
  plan: HelixEnvironmentTemporalPlan,
  nodeId: string,
  action: HelixMinecraftPlayerActionArguments,
) => {
  const node = plan.nodes.find((candidate) => candidate.node_id === nodeId);
  if (!node || node.kind !== "action") return;
  for (const [effect, count] of Object.entries(inferredEffects(action))) {
    if ((node.effect_budget[effect] ?? -1) < count) {
      throw new MinecraftEnvironmentTimeCompileError(
        "effect_mismatch",
        `Action ${nodeId} under-declares ${effect}: requires ${count}.`,
      );
    }
  }
};

const terminalOutcome = (outcome: "succeeded" | "failed" | "canceled") =>
  outcome === "succeeded" ? "succeeded" as const : "failed" as const;

/**
 * Compatibility compiler for the existing serial Fabric engine. It preserves
 * the finite graph and inserts explicit pre/post-condition nodes. Distinct
 * failure and timeout targets, cancellation terminals and live abort guards are
 * rejected because the serial v1 engine cannot represent them truthfully.
 */
export const compileEnvironmentTimePlanToMinecraftFluidSequence = (input: {
  plan: HelixEnvironmentTemporalPlan;
  mutation_scope: FluidMutationScope;
  resource_bindings?: Readonly<Record<string, HelixMinecraftReactiveResource>>;
}): HelixMinecraftFluidSequenceArguments => {
  const plan = validateBase(input.plan);
  const nodes: HelixMinecraftFluidSequenceNode[] = [];
  for (const node of plan.nodes) {
    if (node.kind === "terminal") {
      if (node.outcome === "canceled") {
        throw new MinecraftEnvironmentTimeCompileError(
          "unsupported_semantics",
          "The serial Fabric sequence format cannot preserve a canceled terminal.",
        );
      }
      nodes.push({
        node_id: node.node_id,
        node_kind: "terminal",
        terminal_outcome: terminalOutcome(node.outcome),
        reason_code: node.reason_code,
      });
      continue;
    }
    if (node.kind === "branch") {
      nodes.push({
        node_id: node.node_id,
        node_kind: "branch",
        earliest_tick: 0,
        condition: condition(node.condition),
        on_true: node.true_node_id,
        on_false: node.false_node_id,
      });
      continue;
    }
    if (node.kind === "checkpoint") {
      nodes.push({
        node_id: node.node_id,
        node_kind: "checkpoint",
        earliest_tick: 0,
        checkpoint_id: node.checkpoint_id,
        condition: condition(node.condition),
        wait_up_to_ticks: node.wait_up_to_units,
        on_satisfied: node.on_satisfied_node_id,
        on_timeout: node.on_timeout_node_id,
      });
      continue;
    }
    if (node.on_failure_node_id !== node.on_timeout_node_id) {
      throw new MinecraftEnvironmentTimeCompileError(
        "unsupported_semantics",
        `Serial action ${node.node_id} requires one shared failure/timeout target.`,
      );
    }
    const action = minecraftAction(plan, node.node_id);
    assertResources(node.required_resources, action, input.resource_bindings ?? {});
    assertEffects(plan, node.node_id, action);
    const actionId = `${node.node_id}.execute`;
    let entryId = actionId;
    for (let index = node.preconditions.length - 1; index >= 0; index -= 1) {
      const gateId = index === 0 ? node.node_id : `${node.node_id}.pre.${index}`;
      nodes.push({
        node_id: gateId,
        node_kind: "branch",
        earliest_tick: node.timing.earliest_start_unit,
        condition: condition(node.preconditions[index]),
        on_true: entryId,
        on_false: node.on_failure_node_id,
      });
      entryId = gateId;
    }
    const completionIds = node.completion_conditions.map((_, index) =>
      `${node.node_id}.post.${index}`,
    );
    nodes.push({
      node_id: node.preconditions.length === 0 ? node.node_id : actionId,
      node_kind: "workflow_action",
      earliest_tick: node.timing.earliest_start_unit,
      latest_start_tick: node.timing.latest_start_unit,
      timeout_ticks: node.timing.maximum_duration_units,
      action,
      on_success: completionIds[0],
      on_failure: node.on_failure_node_id,
    });
    node.completion_conditions.forEach((postcondition, index) => {
      nodes.push({
        node_id: completionIds[index],
        node_kind: "checkpoint",
        earliest_tick: node.timing.earliest_start_unit,
        checkpoint_id: `${node.node_id}.post.${index}`,
        condition: condition(postcondition),
        wait_up_to_ticks: 0,
        on_satisfied: completionIds[index + 1] ?? node.on_success_node_id,
        on_timeout: node.on_failure_node_id,
      });
    });
  }
  const compiled = {
    action_kind: "execute_sequence" as const,
    sequence_schema: HELIX_MINECRAFT_PLAYER_SEQUENCE_SCHEMA,
    sequence_id: plan.plan_id,
    ruleset: "survival_tas" as const,
    execution_plane: "player_embodiment" as const,
    scheduler_engine: "native_fabric" as const,
    optimization: {
      primary: "minimize_world_ticks" as const,
      record_wall_clock: true as const,
      stop_on_first_verified_success: true as const,
    },
    start_node_id: plan.start_node_id,
    max_total_ticks: plan.maximum_total_units,
    required_checkpoint_ids: plan.nodes
      .filter((node) => node.kind === "checkpoint")
      .map((node) => node.kind === "checkpoint" ? node.checkpoint_id : ""),
    mutation_scope: input.mutation_scope,
    nodes,
  };
  const parsed = helixMinecraftFluidSequenceArgumentsSchema.safeParse(compiled);
  if (!parsed.success) {
    throw new MinecraftEnvironmentTimeCompileError(
      "invalid_compiled_program",
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return parsed.data;
};

/** Compatibility compiler for the existing concurrent Fabric scheduler. */
export const compileEnvironmentTimePlanToMinecraftReactiveProgram = (input: {
  plan: HelixEnvironmentTemporalPlan;
  mutation_scope: ReactiveMutationScope;
  lane_kind: "camera" | "locomotion" | "inventory" | "hand" | "world" | "safety";
  resource_bindings?: Readonly<Record<string, HelixMinecraftReactiveResource>>;
}): HelixMinecraftReactiveProgramArguments => {
  const plan = validateBase(input.plan);
  const resourceCeiling = new Set<HelixMinecraftReactiveResource>();
  const nodes: HelixMinecraftReactiveNode[] = [];
  for (const node of plan.nodes) {
    if (node.kind === "terminal") {
      nodes.push({
        node_id: node.node_id,
        node_kind: "terminal",
        terminal_outcome: node.outcome,
        reason_code: node.reason_code,
      });
      continue;
    }
    if (node.kind === "branch") {
      nodes.push({
        node_id: node.node_id,
        node_kind: "branch",
        earliest_tick: 0,
        condition: condition(node.condition),
        on_true: node.true_node_id,
        on_false: node.false_node_id,
      });
      continue;
    }
    if (node.kind === "checkpoint") {
      nodes.push({
        node_id: node.node_id,
        node_kind: "checkpoint",
        earliest_tick: 0,
        checkpoint_id: node.checkpoint_id,
        condition: condition(node.condition),
        wait_up_to_ticks: node.wait_up_to_units,
        on_satisfied: node.on_satisfied_node_id,
        on_timeout: node.on_timeout_node_id,
      });
      continue;
    }
    const action = minecraftAction(plan, node.node_id);
    assertResources(node.required_resources, action, input.resource_bindings ?? {});
    assertEffects(plan, node.node_id, action);
    minecraftReactiveResourcesForAction(action).forEach((resource) =>
      resourceCeiling.add(resource),
    );
    const actionId = `${node.node_id}.execute`;
    let entryId = actionId;
    for (let index = node.preconditions.length - 1; index >= 0; index -= 1) {
      const gateId = index === 0 ? node.node_id : `${node.node_id}.pre.${index}`;
      nodes.push({
        node_id: gateId,
        node_kind: "branch",
        earliest_tick: node.timing.earliest_start_unit,
        condition: condition(node.preconditions[index]),
        on_true: entryId,
        on_false: node.on_failure_node_id,
      });
      entryId = gateId;
    }
    const completionIds = node.completion_conditions.map((_, index) =>
      `${node.node_id}.post.${index}`,
    );
    nodes.push({
      node_id: node.preconditions.length === 0 ? node.node_id : actionId,
      node_kind: "action",
      earliest_tick: node.timing.earliest_start_unit,
      latest_start_tick: node.timing.latest_start_unit,
      timeout_ticks: node.timing.maximum_duration_units,
      action,
      on_success: completionIds[0] ?? node.on_success_node_id,
      on_failure: node.on_failure_node_id,
      on_timeout: node.on_timeout_node_id,
    });
    node.completion_conditions.forEach((postcondition, index) => {
      nodes.push({
        node_id: completionIds[index],
        node_kind: "checkpoint",
        earliest_tick: node.timing.earliest_start_unit,
        checkpoint_id: `${node.node_id}.post.${index}`,
        condition: condition(postcondition),
        wait_up_to_ticks: 0,
        on_satisfied: completionIds[index + 1] ?? node.on_success_node_id,
        on_timeout: node.on_failure_node_id,
      });
    });
  }
  if (input.lane_kind === "safety") resourceCeiling.add("safety");
  const compiled = {
    action_kind: "execute_reactive_program" as const,
    program_schema: HELIX_MINECRAFT_REACTIVE_PROGRAM_SCHEMA,
    program_id: plan.plan_id,
    ruleset: "survival_tas" as const,
    execution_plane: "player_embodiment" as const,
    scheduler_engine: "native_fabric_concurrent" as const,
    max_total_ticks: plan.maximum_total_units,
    completion_policy: {
      mode: "all_required" as const,
      cancel_remaining_on_settle: true as const,
    },
    mutation_scope: input.mutation_scope,
    lanes: [{
      lane_id: "environment_time",
      lane_kind: input.lane_kind,
      priority: Math.min(255, plan.lanes[0].priority),
      required: true,
      activation: "immediate" as const,
      resource_ceiling: [...resourceCeiling],
      start_node_id: plan.start_node_id,
      nodes,
    }],
    races: [],
    interrupts: [],
  };
  const parsed = helixMinecraftReactiveProgramArgumentsSchema.safeParse(compiled);
  if (!parsed.success) {
    throw new MinecraftEnvironmentTimeCompileError(
      "invalid_compiled_program",
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return parsed.data;
};

export const compileEnvironmentTimePlanToMinecraftFluidSequenceArtifact = (
  input: Parameters<typeof compileEnvironmentTimePlanToMinecraftFluidSequence>[0],
) => {
  const plan = helixEnvironmentTemporalPlanSchema.parse(input.plan);
  return wrapCompilation(
    plan,
    HELIX_MINECRAFT_PLAYER_SEQUENCE_SCHEMA,
    compileEnvironmentTimePlanToMinecraftFluidSequence(input),
  );
};

export const compileEnvironmentTimePlanToMinecraftReactiveProgramArtifact = (
  input: Parameters<typeof compileEnvironmentTimePlanToMinecraftReactiveProgram>[0],
) => {
  const plan = helixEnvironmentTemporalPlanSchema.parse(input.plan);
  return wrapCompilation(
    plan,
    HELIX_MINECRAFT_REACTIVE_PROGRAM_SCHEMA,
    compileEnvironmentTimePlanToMinecraftReactiveProgram(input),
  );
};
