import { TemporalPlanError } from "./temporal-plan-error";
import type { PoolClient } from "pg";
import { helixEnvironmentEventSchema } from "@shared/helix-environment-event-stream";
import { helixEnvironmentActionWorkflowEventSchema } from "@shared/helix-environment-action";
import { environmentConnectorSha256 } from "../catalog";
import { helixEnvironmentTimeSha256 } from "@shared/helix-environment-time";
import { verifyTemporalCheckpointSettlement } from "./temporal-checkpoint-settlement";

const json = (value: unknown): any => typeof value === "string" ? JSON.parse(value) : value;

/** Internal transaction read. Authenticated task/authority admission is owned by
 * the broker. This resolves measured evidence, never dispatch or frontier state. */
export async function readTemporalCheckpointEvidence(db: Pick<PoolClient, "query">, input:
  Omit<Parameters<typeof verifyTemporalCheckpointSettlement>[0], "settlements"> & {
    actionRequestId: string; eventId: string; runId: string;
  }) {
  const admissions = await db.query(`SELECT source_plan, compilation_artifact, resident_action_request_id
    FROM helix_environment_temporal_plan_admissions
    WHERE plan_id=$1 AND plan_hash=$2 AND action_request_id=$3 FOR UPDATE`,
    [input.plan.plan_id, input.plan.plan_hash, input.actionRequestId]);
  const admission = admissions.rows[0];
  const residentActionId = admission?.resident_action_request_id;
  if (typeof residentActionId !== "string" || !residentActionId ||
      helixEnvironmentTimeSha256(json(admission.source_plan)) !== helixEnvironmentTimeSha256(input.plan) ||
      helixEnvironmentTimeSha256(json(admission.compilation_artifact)) !== helixEnvironmentTimeSha256(input.compilation)) {
    throw new TemporalPlanError("temporal_checkpoint_resident_association_mismatch");
  }
  const actions = await db.query(`SELECT request_payload FROM helix_environment_action_requests
    WHERE action_request_id=$1 FOR UPDATE`, [residentActionId]);
  const action = json(actions.rows[0]?.request_payload);
  const identity = input.plan.identity;
  if (!action || action.action_request_id !== residentActionId || action.run_id !== input.runId ||
      action.environment_binding_id !== identity.environment_id || action.source_id !== identity.source_id ||
      action.subject_binding_id !== identity.subject_id || action.action_authority_id !== identity.authority_id ||
      action.temporal_plan?.identity?.goal_id !== identity.goal_id ||
      action.temporal_plan?.identity?.producer_epoch !== identity.producer_epoch ||
      action.temporal_plan?.identity?.authority_revision !== identity.authority_revision || !action.workflow_id) {
    throw new TemporalPlanError("temporal_checkpoint_action_mismatch");
  }
  const events = await db.query(`SELECT event_id,event_payload,event_hash FROM helix_environment_events
    WHERE environment_binding_id=$1 AND producer_epoch_ref=$2 AND workflow_ref=$3
      AND producer_plane='player_embodiment' AND observed_at<=now()
      AND observed_at>now()-interval '5 seconds'
    ORDER BY sequence DESC LIMIT 1 FOR UPDATE`, [identity.environment_id, identity.producer_epoch, action.workflow_id]);
  const row = events.rows[0];
  if (!row) throw new TemporalPlanError("temporal_checkpoint_event_stale");
  // Preserve the caller's immutable locator, but independently validate the
  // newest state. A progress-only update must not invalidate the same checkpoint.
  const referenced = row.event_id === input.eventId ? row : (await db.query(`SELECT event_id,event_payload,event_hash
    FROM helix_environment_events WHERE event_id=$1 AND environment_binding_id=$2
      AND producer_epoch_ref=$3 AND workflow_ref=$4 AND producer_plane='player_embodiment'
      AND observed_at<=now() AND observed_at>now()-interval '5 seconds' LIMIT 1 FOR UPDATE`,
    [input.eventId, identity.environment_id, identity.producer_epoch, action.workflow_id])).rows[0];
  if (!referenced || referenced.event_id !== input.eventId) throw new TemporalPlanError("temporal_checkpoint_event_stale");
  const raw = json(row.event_payload);
  if (environmentConnectorSha256(raw) !== row.event_hash) throw new TemporalPlanError("temporal_checkpoint_event_hash_mismatch");
  const event = helixEnvironmentEventSchema.parse(raw);
  const active = event.attributes.active_workflow as Record<string, unknown> | undefined;
  if (event.event_id !== row.event_id || event.provenance !== "measured" || event.producer_plane !== "player_embodiment" ||
      event.producer_epoch_ref !== identity.producer_epoch || event.subject_ref !== identity.subject_id ||
      event.source_id !== identity.source_id || event.room_id !== action.room_id || event.world_id !== action.world_id ||
      event.workflow_ref !== action.workflow_id || active?.workflow_ref !== action.workflow_id ||
      active?.workflow_state !== "running" || active?.manual_override_detected !== false) {
    throw new TemporalPlanError("temporal_checkpoint_event_identity_or_state_mismatch");
  }
  const measurements = event.attributes.workflow_measurements as Record<string, unknown> | undefined;
  const actionEvents = await db.query(`SELECT event_id,event_payload,event_hash,producer_epoch_ref
    FROM helix_environment_action_workflow_events WHERE action_request_id=$1 AND workflow_id=$2
    ORDER BY sequence DESC LIMIT 1 FOR UPDATE`, [residentActionId, action.workflow_id]);
  const latestActionRow = actionEvents.rows[0];
  // The critical lane may run ahead of projection delivery. Resolve the exact
  // measured pair, but never substitute it for the newest safety state.
  const actionRow = latestActionRow?.event_id === event.attributes.action_event_ref
    ? latestActionRow : (await db.query(`SELECT event_id,event_payload,event_hash,producer_epoch_ref
      FROM helix_environment_action_workflow_events
      WHERE action_request_id=$1 AND workflow_id=$2 AND event_id=$3 LIMIT 1 FOR UPDATE`,
    [residentActionId, action.workflow_id, event.attributes.action_event_ref])).rows[0];
  if (!actionRow || actionRow.event_id !== event.attributes.action_event_ref ||
      actionRow.producer_epoch_ref !== identity.producer_epoch) throw new TemporalPlanError("temporal_checkpoint_action_event_mismatch");
  const actionRaw = json(actionRow.event_payload);
  if (environmentConnectorSha256(actionRaw) !== actionRow.event_hash) throw new TemporalPlanError("temporal_checkpoint_action_event_hash_mismatch");
  const actionEvent = helixEnvironmentActionWorkflowEventSchema.parse(actionRaw);
  if (actionEvent.event_id !== actionRow.event_id || actionEvent.action_request_id !== residentActionId ||
      actionEvent.workflow_id !== action.workflow_id || actionEvent.workflow_state !== "running" ||
      actionEvent.manual_override_detected ||
      environmentConnectorSha256(actionEvent.measurements.checkpoint_settlements) !==
        environmentConnectorSha256(measurements?.checkpoint_settlements)) {
    throw new TemporalPlanError("temporal_checkpoint_action_event_mismatch");
  }
  const compiledArguments = input.compilation.arguments as Record<string, unknown>;
  const planIdentityField = typeof compiledArguments.sequence_id === "string" ? "sequence_id" : "program_id";
  const nativePlanId = compiledArguments[planIdentityField];
  if (typeof nativePlanId !== "string" || !nativePlanId || measurements?.[planIdentityField] !== nativePlanId ||
      actionEvent.measurements[planIdentityField] !== nativePlanId) throw new TemporalPlanError("temporal_checkpoint_native_plan_mismatch");
  if (!latestActionRow || latestActionRow.producer_epoch_ref !== identity.producer_epoch) {
    throw new TemporalPlanError("temporal_checkpoint_action_event_mismatch");
  }
  const latestActionRaw = json(latestActionRow.event_payload);
  if (environmentConnectorSha256(latestActionRaw) !== latestActionRow.event_hash) {
    throw new TemporalPlanError("temporal_checkpoint_action_event_hash_mismatch");
  }
  const latestActionEvent = helixEnvironmentActionWorkflowEventSchema.parse(latestActionRaw);
  const pairedSettlements = actionEvent.measurements.checkpoint_settlements;
  const latestSettlements = latestActionEvent.measurements.checkpoint_settlements;
  // The critical action lane can append newly measured checkpoints before the
  // environment projection catches up. Keep the projected event as the exact
  // checkpoint anchor, but require every paired settlement to remain identical
  // in the newest running safety state. Reordering, truncation or revision
  // still fails closed.
  const checkpointPrefixUnchanged = Array.isArray(pairedSettlements) &&
    Array.isArray(latestSettlements) && latestSettlements.length <= 256 &&
    latestSettlements.length >= pairedSettlements.length &&
    pairedSettlements.every((settlement, index) =>
      environmentConnectorSha256(settlement) === environmentConnectorSha256(latestSettlements[index]));
  if (latestActionEvent.event_id !== latestActionRow.event_id ||
      latestActionEvent.action_request_id !== residentActionId || latestActionEvent.workflow_id !== action.workflow_id ||
      latestActionEvent.workflow_state !== "running" || latestActionEvent.manual_override_detected ||
      latestActionEvent.sequence < actionEvent.sequence ||
      (latestActionEvent.event_id !== actionEvent.event_id && latestActionEvent.sequence === actionEvent.sequence) ||
      latestActionEvent.measurements[planIdentityField] !== nativePlanId ||
      !checkpointPrefixUnchanged) {
    throw new TemporalPlanError("temporal_checkpoint_action_event_mismatch");
  }
  if (latestActionEvent.clock?.monotonic?.origin_id !== actionEvent.clock?.monotonic?.origin_id ||
      !latestActionEvent.clock || !actionEvent.clock ||
      latestActionEvent.clock.tick_index < actionEvent.clock.tick_index ||
      latestActionEvent.clock.world_tick_index == null || actionEvent.clock.world_tick_index == null ||
      latestActionEvent.clock.world_tick_index < actionEvent.clock.world_tick_index ||
      !latestActionEvent.clock.monotonic || !actionEvent.clock.monotonic ||
      latestActionEvent.clock.monotonic.elapsed_ms < actionEvent.clock.monotonic.elapsed_ms) {
    throw new TemporalPlanError("temporal_checkpoint_clock_unmapped");
  }
  const settlement = verifyTemporalCheckpointSettlement({ ...input, settlements: measurements?.checkpoint_settlements });
  const clock = event.attributes.clock as Record<string, unknown> | undefined;
  const worldTick = clock?.world_tick_index;
  const actionClock = actionEvent.clock;
  if (typeof worldTick !== "number" || !Number.isSafeInteger(worldTick) || worldTick < 0 ||
      !actionClock || actionClock.world_tick_index == null || actionClock.world_tick_index > worldTick ||
      actionClock.monotonic?.origin_id !== input.plan.clocks.monotonic.origin_id ||
      actionClock.tick_index < input.plan.clocks.environment.sequence + settlement.native_tick_index) {
    throw new TemporalPlanError("temporal_checkpoint_clock_unmapped");
  }
  // A fresh progress envelope can repeat a checkpoint settled earlier. Retain
  // its exact latest-event identity for admission, but separately anchor when
  // that identical settlement was already measured. This is not extrapolation.
  const history = await db.query(`SELECT event_id,event_payload,event_hash FROM helix_environment_events
    WHERE environment_binding_id=$1 AND producer_epoch_ref=$2 AND workflow_ref=$3
      AND producer_plane='player_embodiment' AND sequence<=$4
    ORDER BY sequence DESC LIMIT 256`,
  [identity.environment_id, identity.producer_epoch, action.workflow_id, event.sequence]);
  let anchor = { observed_at: event.observed_at, world_tick_index: worldTick, event_id: event.event_id };
  let referencedVerified = false;
  for (const candidate of [referenced, ...history.rows]) {
    const rawAnchor = json(candidate.event_payload);
    if (environmentConnectorSha256(rawAnchor) !== candidate.event_hash) {
      throw new TemporalPlanError("temporal_checkpoint_anchor_hash_mismatch");
    }
    const earlier = helixEnvironmentEventSchema.parse(rawAnchor);
    if (earlier.event_id !== candidate.event_id || earlier.provenance !== "measured" ||
        earlier.producer_plane !== "player_embodiment" || earlier.sequence > event.sequence ||
        ["producer_epoch_ref", "subject_ref", "source_id", "room_id", "world_id", "workflow_ref"].some(
          key => earlier[key as keyof typeof earlier] !== event[key as keyof typeof event])) {
      throw new TemporalPlanError("temporal_checkpoint_anchor_identity_mismatch");
    }
    const earlierMeasurements = earlier.attributes.workflow_measurements as Record<string, unknown> | undefined;
    if (earlierMeasurements?.[planIdentityField] !== nativePlanId) continue;
    const earlierSettlements = earlierMeasurements.checkpoint_settlements;
    if (!Array.isArray(earlierSettlements) || !earlierSettlements.some(value =>
      value?.checkpoint_id === settlement.checkpoint_id)) continue;
    const earlierActive = earlier.attributes.active_workflow as Record<string, unknown> | undefined;
    if (!earlierActive || earlierActive.workflow_ref !== action.workflow_id || earlierActive.workflow_state !== "running" ||
        earlierActive.manual_override_detected !== false) {
      throw new TemporalPlanError("temporal_checkpoint_anchor_state_invalid");
    }
    const earlierSettlement = verifyTemporalCheckpointSettlement({ ...input, settlements: earlierSettlements });
    if (helixEnvironmentTimeSha256(earlierSettlement) !== helixEnvironmentTimeSha256(settlement)) {
      throw new TemporalPlanError("temporal_checkpoint_anchor_settlement_changed");
    }
    const earlierClock = earlier.attributes.clock as Record<string, unknown> | undefined;
    const earlierTick = earlierClock?.world_tick_index;
    const earlierAt = Date.parse(earlier.observed_at);
    const earlierClockAt = typeof earlierClock?.observed_at === "string" ? Date.parse(earlierClock.observed_at) : NaN;
    const earlierMonotonic = earlierClock?.monotonic as Record<string, unknown> | undefined;
    if (!Number.isFinite(earlierAt) || !Number.isFinite(earlierClockAt) || earlierClockAt > earlierAt ||
        earlierAt > Date.parse(event.observed_at) ||
        !Number.isSafeInteger(earlierTick) || Number(earlierTick) < 0 || Number(earlierTick) > worldTick ||
        earlierMonotonic?.origin_id !== input.plan.clocks.monotonic.origin_id ||
        !Number.isSafeInteger(earlierClock?.tick_index) ||
        Number(earlierClock?.tick_index) < input.plan.clocks.environment.sequence + settlement.native_tick_index) {
      throw new TemporalPlanError("temporal_checkpoint_anchor_clock_invalid");
    }
    if (earlierAt < Date.parse(anchor.observed_at) && Number(earlierTick) <= anchor.world_tick_index) {
      anchor = { observed_at: earlier.observed_at, world_tick_index: Number(earlierTick), event_id: earlier.event_id };
    }
    if (candidate === referenced) referencedVerified = true;
  }
  if (!referencedVerified) throw new TemporalPlanError("temporal_checkpoint_reference_unverified");
  return { ...settlement, checkpoint_anchor: anchor, event_id: input.eventId, event_hash: referenced.event_hash as string,
    latest_event_id: event.event_id, latest_event_hash: row.event_hash as string,
    world_tick_index: worldTick,
    action_event_id: actionEvent.event_id, action_event_hash: actionRow.event_hash as string,
    event_sequence: event.sequence, observed_at: event.observed_at, action_request_id: input.actionRequestId,
    resident_action_request_id: residentActionId,
    workflow_id: action.workflow_id as string, plan_id: input.plan.plan_id, plan_hash: input.plan.plan_hash };
}
