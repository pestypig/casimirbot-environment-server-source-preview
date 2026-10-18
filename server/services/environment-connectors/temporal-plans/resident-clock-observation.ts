import { helixEnvironmentClockSnapshotSchema } from "@shared/helix-environment-action";
import type { Queryable } from "../../helix-ask/realtime-room/room-store/types";
import { TEMPORAL_OBSERVATION_MAX_AGE_MS } from "./temporal-observation-window";

/** Called only after current authority/catalog resolution. Never extrapolates a clock. */
export const readTemporalResidentClockObservation = async (db: Queryable, input: {
  authorityId: string; manifestId: string; producerEpochRef: string; now?: Date;
}) => {
  const result = await db.query<{
    heartbeat_id: string; producer_epoch_ref: string; status: string; emergency_stop_latched: boolean;
    manual_input_detected: boolean;
    received_at: string | Date; created_at: string | Date; clock_snapshot: unknown;
  }>(`SELECT heartbeat_id, producer_epoch_ref, status, emergency_stop_latched, manual_input_detected,
      received_at, created_at, clock_snapshot
    FROM helix_environment_action_connector_heartbeats
    WHERE action_authority_id=$1 AND manifest_id=$2
    ORDER BY received_at DESC LIMIT 1`, [input.authorityId, input.manifestId]);
  const row = result.rows[0];
  if (!row || row.producer_epoch_ref !== input.producerEpochRef || row.status !== "active" || row.emergency_stop_latched ||
      typeof row.manual_input_detected !== "boolean") return null;
  const now = (input.now ?? new Date()).getTime();
  const received = new Date(row.received_at).getTime();
  const created = new Date(row.created_at).getTime();
  if (!Number.isFinite(now) || !Number.isFinite(received) || !Number.isFinite(created) ||
      received > now || now - received > TEMPORAL_OBSERVATION_MAX_AGE_MS) return null;
  let payload = row.clock_snapshot;
  try { if (typeof payload === "string") payload = JSON.parse(payload); } catch { return null; }
  const parsed = helixEnvironmentClockSnapshotSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.monotonic) return null;
  const clock = parsed.data;
  // These two timestamps are from the same resident, not a host clock mapping.
  const observed = Date.parse(clock.observed_at);
  // Sum resident-side sample delay and server-side receipt age; checking each
  // separately could admit nearly twice the intended window. No cross-host
  // wall-clock subtraction or tick extrapolation is performed.
  if (!Number.isFinite(observed) || observed > created ||
      created - observed + now - received > TEMPORAL_OBSERVATION_MAX_AGE_MS) return null;
  return {
    heartbeat_id: row.heartbeat_id, manifest_id: input.manifestId,
    producer_epoch_ref: row.producer_epoch_ref, clock,
    manual_input_detected: row.manual_input_detected,
    received_at: new Date(received).toISOString(), receipt_age_ms: now - received,
    clock_extrapolated: false as const, execution_authority: false as const,
    answer_authority: false as const, terminal_eligible: false as const,
  };
};
