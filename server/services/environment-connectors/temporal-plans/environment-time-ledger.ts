import {
  buildHelixEnvironmentTemporalPlanEvent,
  evaluateHelixEnvironmentPlanCurrentness,
  helixEnvironmentTemporalPlanSchema,
  reduceHelixEnvironmentTemporalPlanEvents,
  type HelixEnvironmentTemporalPlan,
  type HelixEnvironmentTemporalPlanEvent,
  type HelixEnvironmentThreeClock,
  type HelixEnvironmentTimeIdentity,
} from "@shared/helix-environment-time";

export type EnvironmentTimeLedgerErrorCode =
  | "temporal_plan_not_found"
  | "temporal_plan_idempotency_conflict"
  | "temporal_plan_identity_stale"
  | "temporal_plan_deadline_expired"
  | "temporal_plan_clock_domain_mismatch"
  | "temporal_plan_checkpoint_mismatch"
  | "temporal_plan_replacement_invalid"
  | "temporal_plan_recovery_invalid"
  | "temporal_plan_transition_invalid";

export class EnvironmentTimeLedgerError extends Error {
  constructor(
    readonly code: EnvironmentTimeLedgerErrorCode,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "EnvironmentTimeLedgerError";
  }
}

type PlanRecord = {
  plan: HelixEnvironmentTemporalPlan;
  events: HelixEnvironmentTemporalPlanEvent[];
};

type EventPayload = Parameters<
  typeof buildHelixEnvironmentTemporalPlanEvent
>[0]["payload"];

const stableIdentityKeys = [
  "environment_id",
  "source_id",
  "subject_id",
  "producer_epoch",
  "authority_id",
  "authority_revision",
  "goal_id",
] as const satisfies ReadonlyArray<keyof HelixEnvironmentTimeIdentity>;

export class EnvironmentTimePlanLedger {
  readonly #records = new Map<string, PlanRecord>();

  admit(input: {
    plan: HelixEnvironmentTemporalPlan;
    current_identity: HelixEnvironmentTimeIdentity;
    monotonic_elapsed_ms: number;
  }) {
    // Retained hash-linked records must never share mutable references with
    // callers, including nested adapter arguments accepted by the schema.
    const plan = structuredClone(helixEnvironmentTemporalPlanSchema.parse(input.plan));
    const existing = this.#records.get(plan.plan_id);
    if (existing) {
      if (existing.plan.plan_hash !== plan.plan_hash) {
        throw new EnvironmentTimeLedgerError(
          "temporal_plan_idempotency_conflict",
          "The plan id already names different semantic content.",
        );
      }
      return structuredClone({
        created: false as const,
        plan: existing.plan,
        projection: reduceHelixEnvironmentTemporalPlanEvents(existing.events),
      });
    }
    const currentness = evaluateHelixEnvironmentPlanCurrentness(input);
    if (!currentness.current) {
      throw new EnvironmentTimeLedgerError(
        currentness.reason === "deadline_expired"
          ? "temporal_plan_deadline_expired"
          : "temporal_plan_identity_stale",
        currentness.reason === "deadline_expired"
          ? "The temporal plan deadline has expired."
          : "The temporal plan does not match the current environment identity.",
        currentness.mismatch_fields.map(String),
      );
    }
    const event = buildHelixEnvironmentTemporalPlanEvent({
      event_id: `${plan.plan_id}:event:1`,
      plan_id: plan.plan_id,
      sequence: 1,
      previous_event_hash: null,
      identity: plan.identity,
      clocks: plan.clocks,
      payload: { kind: "plan_admitted", plan_hash: plan.plan_hash },
    });
    const record = { plan, events: [event] };
    this.#records.set(plan.plan_id, record);
    return structuredClone({
      created: true as const,
      plan,
      projection: reduceHelixEnvironmentTemporalPlanEvents(record.events),
    });
  }

  get(planId: string) {
    const record = this.#require(planId);
    return structuredClone({
      plan: record.plan,
      events: record.events,
      projection: reduceHelixEnvironmentTemporalPlanEvents(record.events),
    });
  }

  start(input: { plan_id: string; clocks: HelixEnvironmentThreeClock }) {
    // An extension receipt is not a durable permission to start after its
    // execution chain has stopped. Check every linked extension ancestor;
    // explicit checkpoint recovery is a separate admission path.
    let child = this.#require(input.plan_id);
    const visited = new Set<string>();
    while (child.plan.previous_plan_id !== null) {
      if (visited.has(child.plan.plan_id)) {
        throw new EnvironmentTimeLedgerError("temporal_plan_transition_invalid", "Extension ancestry is cyclic.");
      }
      visited.add(child.plan.plan_id);
      const parent = this.#require(child.plan.previous_plan_id);
      const linked = parent.events.some((event) =>
        event.payload.kind === "extension_appended" &&
        event.payload.extension_plan_id === child.plan.plan_id &&
        event.payload.extension_plan_hash === child.plan.plan_hash,
      );
      if (!linked) break;
      const state = reduceHelixEnvironmentTemporalPlanEvents(parent.events).state;
      const terminal = parent.events.at(-1)?.payload;
      if (state !== "running" && !(state === "settled" &&
          terminal?.kind === "plan_settled" && terminal.outcome === "succeeded")) {
        throw new EnvironmentTimeLedgerError(
          "temporal_plan_transition_invalid",
          "An admitted extension cannot start after its predecessor has stopped or begun stopping.",
        );
      }
      child = parent;
    }
    return this.#append(input.plan_id, input.clocks, { kind: "execution_started" });
  }

  checkpoint(input: {
    plan_id: string;
    clocks: HelixEnvironmentThreeClock;
    checkpoint_id: string;
    observation_revision: number;
    affordance_revision: number;
    evidence_refs: string[];
  }) {
    const record = this.#require(input.plan_id);
    if (!record.plan.nodes.some((node) =>
      node.kind === "checkpoint" && node.checkpoint_id === input.checkpoint_id,
    ) || record.events.some((event) =>
      event.payload.kind === "checkpoint_settled" &&
      event.payload.checkpoint_id === input.checkpoint_id,
    )) {
      throw new EnvironmentTimeLedgerError(
        "temporal_plan_checkpoint_mismatch",
        "A finite plan may settle only an admitted, previously unsettled checkpoint.",
      );
    }
    return this.#append(input.plan_id, input.clocks, {
      kind: "checkpoint_settled",
      checkpoint_id: input.checkpoint_id,
      observation_revision: input.observation_revision,
      affordance_revision: input.affordance_revision,
      evidence_refs: input.evidence_refs,
    });
  }

  noteRunwayLow(input: {
    plan_id: string;
    clocks: HelixEnvironmentThreeClock;
    remaining_units: number;
  }) {
    return this.#append(input.plan_id, input.clocks, {
      kind: "runway_low",
      remaining_units: input.remaining_units,
    });
  }

  requireStabilization(input: {
    plan_id: string;
    clocks: HelixEnvironmentThreeClock;
    stabilization_node_id: string | null;
    reason_code: string;
  }) {
    return this.#append(input.plan_id, input.clocks, {
      kind: "stabilization_required",
      stabilization_node_id: input.stabilization_node_id,
      reason_code: input.reason_code,
    });
  }

  requestCancel(input: {
    plan_id: string;
    clocks: HelixEnvironmentThreeClock;
    reason_code: string;
  }) {
    return this.#append(input.plan_id, input.clocks, {
      kind: "cancel_requested",
      reason_code: input.reason_code,
      authority_reducing: true,
    });
  }

  settle(input: {
    plan_id: string;
    clocks: HelixEnvironmentThreeClock;
    outcome: "succeeded" | "failed" | "canceled" | "timed_out" | "interrupted" | "not_started";
    performed_effects: Record<string, number>;
    evidence_refs: string[];
  }) {
    return this.#append(input.plan_id, input.clocks, {
      kind: "plan_settled",
      outcome: input.outcome,
      performed_effects: input.performed_effects,
      controls_released: true,
      resources_released: true,
      evidence_refs: input.evidence_refs,
    });
  }

  assertCompatibleSuccessor(input: {
    predecessor_plan_id: string;
    successor: HelixEnvironmentTemporalPlan;
    current_identity: HelixEnvironmentTimeIdentity;
    monotonic_elapsed_ms: number;
  }) {
    const predecessor = this.#require(input.predecessor_plan_id);
    const successor = helixEnvironmentTemporalPlanSchema.parse(input.successor);
    if (
      successor.previous_plan_id !== predecessor.plan.plan_id ||
      successor.previous_plan_hash !== predecessor.plan.plan_hash
    ) {
      throw new EnvironmentTimeLedgerError(
        "temporal_plan_idempotency_conflict",
        "A successor must bind the exact predecessor plan and hash.",
      );
    }
    const drift = stableIdentityKeys.filter(
      (key) => successor.identity[key] !== predecessor.plan.identity[key],
    );
    if (drift.length > 0) {
      throw new EnvironmentTimeLedgerError(
        "temporal_plan_identity_stale",
        "A successor cannot change environment, source, subject, epoch, authority or goal identity.",
        drift.map(String),
      );
    }
    const currentness = evaluateHelixEnvironmentPlanCurrentness({
      plan: successor,
      current_identity: input.current_identity,
      monotonic_elapsed_ms: input.monotonic_elapsed_ms,
    });
    if (!currentness.current) {
      throw new EnvironmentTimeLedgerError(
        currentness.reason === "deadline_expired"
          ? "temporal_plan_deadline_expired"
          : "temporal_plan_identity_stale",
        "The successor plan is not current.",
        currentness.mismatch_fields.map(String),
      );
    }
    return successor;
  }

  commitExtension(input: {
    predecessor_plan_id: string;
    successor: HelixEnvironmentTemporalPlan;
    after_checkpoint_id: string;
    current_identity: HelixEnvironmentTimeIdentity;
    monotonic_elapsed_ms: number;
    clocks: HelixEnvironmentThreeClock;
  }) {
    const predecessor = this.#require(input.predecessor_plan_id);
    const predecessorProjection = reduceHelixEnvironmentTemporalPlanEvents(
      predecessor.events,
    );
    if (predecessorProjection.latest_checkpoint_id !== input.after_checkpoint_id) {
      throw new EnvironmentTimeLedgerError(
        "temporal_plan_checkpoint_mismatch",
        "A rolling extension must bind the latest settled checkpoint.",
      );
    }
    const successor = this.assertCompatibleSuccessor(input);
    if (
      successor.identity.observation_revision !==
        predecessorProjection.latest_observation_revision ||
      successor.identity.affordance_revision !==
        predecessorProjection.latest_affordance_revision
    ) {
      throw new EnvironmentTimeLedgerError(
        "temporal_plan_checkpoint_mismatch",
        "A rolling extension must start from the latest checkpoint revisions.",
      );
    }
    const duplicate = predecessor.events.find(
      (event) =>
        event.payload.kind === "extension_appended" &&
        event.payload.extension_plan_id === successor.plan_id,
    );
    if (duplicate) {
      if (
        duplicate.payload.kind !== "extension_appended" ||
        duplicate.payload.extension_plan_hash !== successor.plan_hash ||
        duplicate.payload.after_checkpoint_id !== input.after_checkpoint_id
      ) {
        throw new EnvironmentTimeLedgerError(
          "temporal_plan_idempotency_conflict",
          "The successor id is already linked with different extension semantics.",
        );
      }
      const admitted = this.admit({
        plan: successor,
        current_identity: input.current_identity,
        monotonic_elapsed_ms: input.monotonic_elapsed_ms,
      });
      return { created: false as const, event: structuredClone(duplicate), successor: admitted };
    }
    this.#assertCanAdmitSuccessor(
      successor,
      input.current_identity,
      input.monotonic_elapsed_ms,
    );
    const linked = this.#append(input.predecessor_plan_id, input.clocks, {
      kind: "extension_appended",
      extension_plan_id: successor.plan_id,
      extension_plan_hash: successor.plan_hash,
      after_checkpoint_id: input.after_checkpoint_id,
    });
    const admitted = this.admit({
      plan: successor,
      current_identity: input.current_identity,
      monotonic_elapsed_ms: input.monotonic_elapsed_ms,
    });
    return { created: true as const, event: linked.event, successor: admitted };
  }

  commitReplacement(input: {
    predecessor_plan_id: string;
    replacement: HelixEnvironmentTemporalPlan;
    current_identity: HelixEnvironmentTimeIdentity;
    monotonic_elapsed_ms: number;
    clocks: HelixEnvironmentThreeClock;
    canceled_unexecuted_node_ids: string[];
    executed_node_ids: string[];
  }) {
    const predecessor = this.#require(input.predecessor_plan_id);
    const replacement = this.assertCompatibleSuccessor({
      predecessor_plan_id: input.predecessor_plan_id,
      successor: input.replacement,
      current_identity: input.current_identity,
      monotonic_elapsed_ms: input.monotonic_elapsed_ms,
    });
    const knownNodes = new Set(predecessor.plan.nodes.map((node) => node.node_id));
    const executed = new Set(input.executed_node_ids);
    if (
      input.canceled_unexecuted_node_ids.some(
        (nodeId) => !knownNodes.has(nodeId) || executed.has(nodeId),
      ) ||
      new Set(input.canceled_unexecuted_node_ids).size !==
        input.canceled_unexecuted_node_ids.length
    ) {
      throw new EnvironmentTimeLedgerError(
        "temporal_plan_replacement_invalid",
        "Replacement may cancel only unique, known, unexecuted predecessor nodes.",
      );
    }
    const duplicate = predecessor.events.find(
      (event) =>
        event.payload.kind === "replacement_committed" &&
        event.payload.replacement_plan_id === replacement.plan_id,
    );
    if (duplicate) {
      if (
        duplicate.payload.kind !== "replacement_committed" ||
        duplicate.payload.replacement_plan_hash !== replacement.plan_hash ||
        JSON.stringify(duplicate.payload.canceled_unexecuted_node_ids) !==
          JSON.stringify(input.canceled_unexecuted_node_ids)
      ) {
        throw new EnvironmentTimeLedgerError(
          "temporal_plan_idempotency_conflict",
          "The replacement id is already linked with different semantics.",
        );
      }
      const admitted = this.admit({
        plan: replacement,
        current_identity: input.current_identity,
        monotonic_elapsed_ms: input.monotonic_elapsed_ms,
      });
      return { created: false as const, event: structuredClone(duplicate), replacement: admitted };
    }
    this.#assertCanAdmitSuccessor(
      replacement,
      input.current_identity,
      input.monotonic_elapsed_ms,
    );
    const linked = this.#append(input.predecessor_plan_id, input.clocks, {
      kind: "replacement_committed",
      replacement_plan_id: replacement.plan_id,
      replacement_plan_hash: replacement.plan_hash,
      canceled_unexecuted_node_ids: input.canceled_unexecuted_node_ids,
      performed_effects_preserved: true,
    });
    const admitted = this.admit({
      plan: replacement,
      current_identity: input.current_identity,
      monotonic_elapsed_ms: input.monotonic_elapsed_ms,
    });
    return { created: true as const, event: linked.event, replacement: admitted };
  }

  admitCheckpointRecovery(input: {
    predecessor_plan_id: string;
    successor: HelixEnvironmentTemporalPlan;
    checkpoint_id: string;
    performed_node_ids: string[];
    current_identity: HelixEnvironmentTimeIdentity;
    monotonic_elapsed_ms: number;
  }) {
    const predecessor = this.#require(input.predecessor_plan_id);
    const projection = reduceHelixEnvironmentTemporalPlanEvents(predecessor.events);
    const successor = helixEnvironmentTemporalPlanSchema.parse(input.successor);
    if (
      projection.state !== "settled" ||
      projection.latest_checkpoint_id !== input.checkpoint_id ||
      successor.previous_plan_id !== predecessor.plan.plan_id ||
      successor.previous_plan_hash !== predecessor.plan.plan_hash
    ) {
      throw new EnvironmentTimeLedgerError(
        "temporal_plan_recovery_invalid",
        "Reconnect recovery requires an exact settled predecessor and its latest checkpoint.",
      );
    }
    const stableAcrossReconnect = [
      "environment_id",
      "source_id",
      "subject_id",
      "goal_id",
    ] as const satisfies ReadonlyArray<keyof HelixEnvironmentTimeIdentity>;
    const drift = stableAcrossReconnect.filter(
      (key) => successor.identity[key] !== predecessor.plan.identity[key],
    );
    if (
      drift.length > 0 ||
      successor.identity.observation_revision < projection.latest_observation_revision ||
      successor.identity.affordance_revision < projection.latest_affordance_revision
    ) {
      throw new EnvironmentTimeLedgerError(
        "temporal_plan_recovery_invalid",
        "Reconnect recovery must preserve subject/goal identity and use a fresh checkpoint-bound snapshot.",
        drift.map(String),
      );
    }
    const predecessorNodes = new Set(
      predecessor.plan.nodes.map((node) => node.node_id),
    );
    const performed = new Set(input.performed_node_ids);
    if (
      performed.size !== input.performed_node_ids.length ||
      input.performed_node_ids.some((nodeId) => !predecessorNodes.has(nodeId)) ||
      successor.nodes.some((node) => performed.has(node.node_id))
    ) {
      throw new EnvironmentTimeLedgerError(
        "temporal_plan_recovery_invalid",
        "Reconnect recovery cannot replay or ambiguously name performed predecessor work.",
      );
    }
    return this.admit({
      plan: successor,
      current_identity: input.current_identity,
      monotonic_elapsed_ms: input.monotonic_elapsed_ms,
    });
  }

  #require(planId: string) {
    const record = this.#records.get(planId);
    if (!record) {
      throw new EnvironmentTimeLedgerError(
        "temporal_plan_not_found",
        "The temporal plan was not found.",
      );
    }
    return record;
  }

  #assertCanAdmitSuccessor(
    successor: HelixEnvironmentTemporalPlan,
    currentIdentity: HelixEnvironmentTimeIdentity,
    monotonicElapsedMs: number,
  ) {
    const existing = this.#records.get(successor.plan_id);
    if (existing && existing.plan.plan_hash !== successor.plan_hash) {
      throw new EnvironmentTimeLedgerError(
        "temporal_plan_idempotency_conflict",
        "The successor plan id already names different semantic content.",
      );
    }
    const currentness = evaluateHelixEnvironmentPlanCurrentness({
      plan: successor,
      current_identity: currentIdentity,
      monotonic_elapsed_ms: monotonicElapsedMs,
    });
    if (!currentness.current) {
      throw new EnvironmentTimeLedgerError(
        currentness.reason === "deadline_expired"
          ? "temporal_plan_deadline_expired"
          : "temporal_plan_identity_stale",
        "The successor plan is not current.",
        currentness.mismatch_fields.map(String),
      );
    }
  }

  #append(
    planId: string,
    clocks: HelixEnvironmentThreeClock,
    payload: EventPayload,
  ) {
    const record = this.#require(planId);
    this.#assertClockDomain(record.plan, clocks);
    const previous = record.events.at(-1)!;
    const event = buildHelixEnvironmentTemporalPlanEvent({
      event_id: `${planId}:event:${record.events.length + 1}`,
      plan_id: planId,
      sequence: record.events.length + 1,
      previous_event_hash: previous.event_hash,
      identity: record.plan.identity,
      clocks,
      payload,
    });
    const candidate = [...record.events, event];
    try {
      const projection = reduceHelixEnvironmentTemporalPlanEvents(candidate);
      record.events.push(event);
      return structuredClone({ event, projection });
    } catch (error) {
      throw new EnvironmentTimeLedgerError(
        "temporal_plan_transition_invalid",
        error instanceof Error ? error.message : "Temporal-plan transition is invalid.",
      );
    }
  }

  #assertClockDomain(
    plan: HelixEnvironmentTemporalPlan,
    clocks: HelixEnvironmentThreeClock,
  ) {
    if (
      clocks.environment.kind !== plan.clocks.environment.kind ||
      clocks.environment.resolution_unit !== plan.clocks.environment.resolution_unit ||
      clocks.monotonic.origin_id !== plan.clocks.monotonic.origin_id
    ) {
      throw new EnvironmentTimeLedgerError(
        "temporal_plan_clock_domain_mismatch",
        "Temporal-plan events must remain in the admitted environment and monotonic clock domains.",
      );
    }
  }
}
