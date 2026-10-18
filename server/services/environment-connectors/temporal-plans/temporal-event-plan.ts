import type { Queryable } from "../../helix-ask/realtime-room/room-store/types";
import type { HelixEnvironmentActionRequest } from "@shared/helix-environment-action";
import { helixEnvironmentTemporalPlanSchema, helixEnvironmentTimeSha256 } from "@shared/helix-environment-time";

const json = (value: unknown): any => typeof value === "string" ? JSON.parse(value) : value;

/** Recompute only from the caller's validated, plan-qualified chain. These are
 * reported effects, not proof of physical execution or terminal authority. */
export function verifyTemporalResidentEffects(
  measurements: Record<string, unknown>,
  chain: ReadonlyArray<{ measurements: Record<string, unknown> }>,
): void {
  const rolling = measurements.completed_sequence_measurements !== undefined ||
    measurements.resident_handoff_count !== undefined || measurements.resident_effect_totals !== undefined;
  if (!rolling) return;
  const claimed = measurements.resident_effect_totals;
  if (!claimed || typeof claimed !== "object" || Array.isArray(claimed) ||
      chain.length < 1 || chain.length > 32 || chain[chain.length - 1].measurements !== measurements) {
    throw new Error("temporal_resident_effect_totals_invalid");
  }
  const totals: Record<string, boolean | number> = {};
  for (const key of ["player_motion_performed", "player_interaction_performed", "inventory_mutation_performed"]) {
    let any = false;
    for (const sample of chain) {
      const value = sample.measurements[key];
      if (typeof value !== "boolean") throw new Error("temporal_resident_effect_measurement_invalid");
      any ||= value;
    }
    totals[key] = any;
  }
  for (const key of ["world_mutations_performed", "inventory_mutations_performed"]) {
    let total = 0;
    for (const sample of chain) {
      const value = sample.measurements[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error("temporal_resident_effect_measurement_invalid");
      }
      total += value;
      if (!Number.isSafeInteger(total)) throw new Error("temporal_resident_effect_total_overflow");
    }
    totals[key] = total;
  }
  totals.world_mutation_performed = Number(totals.world_mutations_performed) > 0;
  totals.inventory_mutation_performed = totals.inventory_mutation_performed === true ||
    Number(totals.inventory_mutations_performed) > 0;
  totals.side_effects_performed = totals.player_motion_performed === true ||
    totals.player_interaction_performed === true || totals.inventory_mutation_performed || totals.world_mutation_performed;
  if (Object.keys(claimed).length !== Object.keys(totals).length ||
      Object.entries(totals).some(([key, value]) => (claimed as Record<string, unknown>)[key] !== value)) {
    throw new Error("temporal_resident_effect_totals_mismatch");
  }
}

/** For an already-recorded terminal event; never replaces retained-plan or
 * postcondition validation. Result flags must not erase earlier plan effects. */
export function temporalResidentResultEffectsValid(
  measurements: Record<string, unknown>,
  result: { player_motion_performed: boolean; player_interaction_performed: boolean;
    inventory_mutation_performed: boolean; world_mutation_performed: boolean; side_effects_performed: boolean },
): boolean {
  if (measurements.completed_sequence_measurements === undefined &&
      measurements.resident_handoff_count === undefined && measurements.resident_effect_totals === undefined) return true;
  const history = measurements.completed_sequence_measurements;
  if (!Array.isArray(history) || history.length > 31 || measurements.resident_handoff_count !== history.length ||
      history.some(sample => !sample || typeof sample !== "object" || Array.isArray(sample))) return false;
  try {
    verifyTemporalResidentEffects(measurements, [...history, measurements].map(sample => ({ measurements: sample })));
  } catch {
    return false;
  }
  const totals = measurements.resident_effect_totals as Record<string, unknown>;
  return (["player_motion_performed", "player_interaction_performed", "inventory_mutation_performed",
    "world_mutation_performed", "side_effects_performed"] as const).every(key => result[key] === totals[key]);
}

/** Select evidence's retained graph, never dispatch work or infer completion.
 * Caller retains existing authenticated manifest, event cursor and lifecycle checks. */
export async function resolveTemporalEventArguments(db: Queryable, resident: HelixEnvironmentActionRequest,
  measurements: Record<string, unknown>, producerEpoch: string): Promise<HelixEnvironmentActionRequest["arguments"]> {
  return (await resolveTemporalEventPlan(db, resident, measurements, producerEpoch)).arguments;
}

async function resolveTemporalEventPlan(db: Queryable, resident: HelixEnvironmentActionRequest,
  measurements: Record<string, unknown>, producerEpoch: string, recordedSuccess = false) {
  const field = resident.action_kind === "execute_sequence" ? "sequence_id" : "program_id";
  const planId = measurements[field];
  if (!resident.temporal_plan || typeof planId !== "string" || !planId) throw new Error("temporal_event_plan_missing");
  const result = await db.query(`SELECT p.source_plan,p.compilation_artifact,p.resident_action_request_id,p.checkpoint_association,
    a.request_payload,a.status FROM helix_environment_temporal_plan_admissions p
    JOIN helix_environment_action_requests a ON a.action_request_id=p.action_request_id
    WHERE p.plan_id=$1 AND p.resident_action_request_id=$2 LIMIT 2`, [planId, resident.action_request_id]);
  if (result.rows.length !== 1) throw new Error("temporal_event_plan_unretained");
  const row = result.rows[0];
  if (!["leased", "running", "paused_manual_override", "cancel_requested"].includes(row.status) &&
      !(recordedSuccess && row.status === "succeeded")) {
    throw new Error("temporal_event_plan_not_delivered");
  }
  const plan = helixEnvironmentTemporalPlanSchema.parse(json(row.source_plan));
  const compilation = json(row.compilation_artifact);
  const action = json(row.request_payload);
  const { compilation_hash, ...content } = compilation;
  if (row.resident_action_request_id !== resident.action_request_id || plan.plan_id !== planId ||
      plan.identity.producer_epoch !== producerEpoch || plan.identity.goal_id !== resident.temporal_plan.identity.goal_id ||
      plan.identity.environment_id !== resident.environment_binding_id || plan.identity.source_id !== resident.source_id ||
      plan.identity.subject_id !== resident.subject_binding_id || plan.identity.authority_id !== resident.action_authority_id ||
      plan.identity.authority_revision !== resident.temporal_plan.identity.authority_revision ||
      compilation_hash !== helixEnvironmentTimeSha256(content) || content.source_plan_id !== planId ||
      content.source_plan_hash !== plan.plan_hash || content.arguments?.[field] !== planId ||
      helixEnvironmentTimeSha256(action.temporal_plan) !== helixEnvironmentTimeSha256(plan) ||
      helixEnvironmentTimeSha256(action.arguments) !== helixEnvironmentTimeSha256(content.arguments)) {
    throw new Error("temporal_event_plan_integrity_mismatch");
  }
  for (const key of ["action_kind", "run_id", "room_id", "world_id", "participant_id", "subject_binding_id",
    "subject_native_id", "action_authority_id", "environment_binding_id", "source_id"] as const) {
    if (action[key] !== resident[key]) throw new Error("temporal_event_plan_identity_mismatch");
  }
  return { plan, request: action as HelixEnvironmentActionRequest, checkpointAssociation: json(row.checkpoint_association ?? null),
    arguments: content.arguments as HelixEnvironmentActionRequest["arguments"] };
}

/** Acceptance is a queue observation, never execution or terminal authority. */
export async function verifyTemporalSuccessorAcceptance(db: Queryable, resident: HelixEnvironmentActionRequest,
  measurements: Record<string, unknown>, producerEpoch: string,
  clock: { tick_index: number; monotonic?: { origin_id: string; elapsed_ms: number } } | undefined): Promise<string | undefined> {
  const raw = measurements.temporal_successor_acceptance;
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || resident.action_kind !== "execute_sequence") {
    throw new Error("temporal_successor_acceptance_invalid");
  }
  const ack = raw as Record<string, unknown>;
  const current = await resolveTemporalEventPlan(db, resident, measurements, producerEpoch);
  const successor = await resolveTemporalEventPlan(db, resident, { sequence_id: ack.sequence_id }, producerEpoch);
  const association = successor.checkpointAssociation;
  const settlements = measurements.checkpoint_settlements;
  const latest = Array.isArray(settlements) ? settlements.at(-1) : null;
  const plan = current.plan;
  const start = plan.clocks.environment.sequence;
  const boundary = start + plan.watermarks.committed_through_unit;
  const stop = start + plan.watermarks.stop_unit;
  const tick = ack.accepted_client_tick;
  const elapsed = ack.accepted_monotonic_elapsed_ms;
  if (ack.predecessor_sequence_id !== plan.plan_id || successor.plan.plan_id === plan.plan_id ||
      successor.plan.previous_plan_id !== plan.plan_id || successor.plan.previous_plan_hash !== plan.plan_hash ||
      !association || association.resident_action_request_id !== resident.action_request_id ||
      association.workflow_id !== resident.workflow_id || association.plan_id !== plan.plan_id ||
      association.plan_hash !== plan.plan_hash || association.checkpoint_id !== ack.checkpoint_id ||
      !latest || latest.checkpoint_id !== ack.checkpoint_id || latest.node_id !== association.native_node_id ||
      latest.tick_index !== association.native_tick_index || latest.monotonic_elapsed_ns !== association.workflow_monotonic_elapsed_ns ||
      typeof tick !== "number" || !Number.isSafeInteger(tick) || tick < start + latest.tick_index || tick >= stop ||
      !Number.isSafeInteger(boundary) || !Number.isSafeInteger(stop) || ack.committed_client_tick !== boundary ||
      ack.lead_ticks !== boundary - tick || boundary - tick <= 0 ||
      typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < plan.clocks.monotonic.elapsed_ms ||
      elapsed >= plan.monotonic_deadline_elapsed_ms ||
      !clock || !Number.isSafeInteger(clock.tick_index) || clock.tick_index < tick ||
      clock.monotonic?.origin_id !== plan.clocks.monotonic.origin_id ||
      !Number.isFinite(clock.monotonic.elapsed_ms) || clock.monotonic.elapsed_ms < elapsed ||
      ack.queue_depth !== 1 || ack.execution_started !== false || ack.terminal_eligible !== false) {
    throw new Error("temporal_successor_acceptance_mismatch");
  }
  return successor.request.action_request_id;
}

/** Call only after validating acceptance, inside the event transaction with the
 * resident row locked. Keep the child leased (not running), without renewing an
 * expired delivery or extending either action's admitted deadline. */
export async function retainAcceptedTemporalLease(db: Queryable, successorActionId: string,
  residentDeadline: string): Promise<void> {
  // CASE preserves the minimum admitted deadline on PostgreSQL and the packaged
  // pg-mem backend, which does not provide the LEAST timestamp builtin.
  const result = await db.query(`UPDATE helix_environment_action_requests
    SET lease_expires_at=CASE WHEN deadline_at<$2::timestamptz THEN deadline_at ELSE $2::timestamptz END,updated_at=now()
    WHERE action_request_id=$1 AND status='leased' AND lease_expires_at>now()
      AND deadline_at>now() AND $2::timestamptz>now()
    RETURNING action_request_id`, [successorActionId, residentDeadline]);
  if (result.rows.length !== 1) throw new Error("temporal_successor_acceptance_lease_expired");
}

export async function resolveTemporalEventChain(db: Queryable, resident: HelixEnvironmentActionRequest,
  measurements: Record<string, unknown>, producerEpoch: string, currentComplete: boolean) {
  return resolveTemporalChain(db, resident, measurements, producerEpoch, currentComplete, false);
}

/** Only for a previously recorded successful terminal event. The resident row
 * has already settled; this does not make a terminal row eligible for delivery. */
export async function resolveTemporalResultChain(db: Queryable, resident: HelixEnvironmentActionRequest,
  measurements: Record<string, unknown>, producerEpoch: string) {
  return resolveTemporalChain(db, resident, measurements, producerEpoch, true, true);
}

async function resolveTemporalChain(db: Queryable, resident: HelixEnvironmentActionRequest,
  measurements: Record<string, unknown>, producerEpoch: string, currentComplete: boolean, recordedSuccess: boolean) {
  const history = measurements.completed_sequence_measurements ?? [];
  if (!Array.isArray(history) || history.length > 31 ||
      (measurements.resident_handoff_count ?? 0) !== history.length) throw new Error("temporal_event_history_invalid");
  const resolved: Array<{ plan: NonNullable<HelixEnvironmentActionRequest["temporal_plan"]>;
    request: HelixEnvironmentActionRequest; arguments: HelixEnvironmentActionRequest["arguments"];
    measurements: Record<string, unknown>; require_complete: boolean }> = [];
  let previous: Awaited<ReturnType<typeof resolveTemporalEventPlan>>["plan"] | null = null;
  const seen = new Set<string>();
  for (let index = 0; index <= history.length; index++) {
    const historical = index < history.length;
    const sample = historical ? history[index] : measurements;
    if (!sample || typeof sample !== "object" || Array.isArray(sample) ||
        !Array.isArray(sample.checkpoint_settlements) || !Array.isArray(sample.satisfied_checkpoint_ids) ||
        (historical && (sample.sequence_completed !== true || sample.completed_sequence_measurements !== undefined))) {
      throw new Error("temporal_event_history_invalid");
    }
    const current = await resolveTemporalEventPlan(db, resident, sample, producerEpoch, recordedSuccess);
    if (seen.has(current.plan.plan_id) || (previous
      ? current.plan.previous_plan_id !== previous.plan_id || current.plan.previous_plan_hash !== previous.plan_hash
      : current.plan.plan_id !== resident.temporal_plan?.plan_id || current.plan.plan_hash !== resident.temporal_plan?.plan_hash)) {
      throw new Error("temporal_event_history_chain_mismatch");
    }
    seen.add(current.plan.plan_id);
    previous = current.plan;
    resolved.push({ plan: current.plan, request: current.request, arguments: current.arguments,
      measurements: sample, require_complete: historical || currentComplete });
  }
  return resolved;
}
