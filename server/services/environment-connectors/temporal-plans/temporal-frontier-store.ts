import crypto from "node:crypto";
import { TemporalPlanError } from "./temporal-plan-error";
import {
  buildHelixEnvironmentAffordanceFrontier, helixEnvironmentAffordanceFrontierSchema,
  helixEnvironmentTimeSha256, type HelixEnvironmentTimeIdentity,
} from "@shared/helix-environment-time";
import { withSharedRealtimeRoomTransaction } from "../../helix-ask/realtime-room/room-store/database";

type Draft = Omit<Parameters<typeof buildHelixEnvironmentAffordanceFrontier>[0],
  "frontier_id" | "previous_frontier" | "identity"> & {
  identity: Omit<HelixEnvironmentTimeIdentity, "affordance_revision">;
};
const json = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value;

/** Internal storage boundary. Publisher must derive draft from authenticated sensors/catalog.
 * A stored frontier is never admission to execute the represented capabilities. */
export class EnvironmentTemporalFrontierStore {
  constructor(private readonly transaction = withSharedRealtimeRoomTransaction) {}

  /** Bounded maintenance only; preserve the newest row as revision high-water mark. */
  async pruneExpired(input: { goalId: string; profileId: string; participantId: string; now?: Date }) {
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new TemporalPlanError("temporal_frontier_time_invalid");
    return this.transaction(async (db) => {
      await db.query("SELECT goal_id FROM helix_environment_durable_goals WHERE goal_id=$1 FOR UPDATE", [input.goalId]);
      const grant = await db.query<{ scopes: unknown }>(`SELECT scopes FROM helix_environment_durable_goal_participants
        WHERE goal_id=$1 AND profile_id=$2 AND participant_id=$3 AND status='active'`,
        [input.goalId, input.profileId, input.participantId]);
      if (!json(grant.rows[0]?.scopes ?? []).includes("steer")) throw new TemporalPlanError("temporal_frontier_forbidden");
      const latest = await db.query<{ frontier_id: string }>(`SELECT frontier_id FROM helix_environment_temporal_frontiers
        WHERE goal_id=$1 ORDER BY frontier_revision DESC LIMIT 1`, [input.goalId]);
      if (!latest.rows[0]) return { removed: 0 };
      const expired = await db.query<{ frontier_id: string }>(`SELECT frontier_id FROM helix_environment_temporal_frontiers
        WHERE goal_id=$1 AND frontier_id<>$2 AND retained_until<=$3
          AND frontier_id NOT IN (SELECT frontier_id FROM helix_environment_temporal_plan_admissions)
        ORDER BY frontier_revision ASC LIMIT 64`,
        [input.goalId, latest.rows[0].frontier_id, now.toISOString()]);
      let removed = 0;
      for (const row of expired.rows) {
        const deleted = await db.query(`DELETE FROM helix_environment_temporal_frontiers
          WHERE goal_id=$1 AND frontier_id=$2 AND retained_until<=$3
            AND frontier_id NOT IN (SELECT frontier_id FROM helix_environment_temporal_plan_admissions)
          RETURNING frontier_id`,
          [input.goalId, row.frontier_id, now.toISOString()]);
        removed += deleted.rows.length;
      }
      return { removed };
    });
  }

  async read(input: { frontierId: string; profileId: string; participantId: string; now?: Date;
    expectedEvidenceRef?: string; expectedObservationProducerEpoch?: string;
    requireLatestForGoal?: boolean }) {
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new TemporalPlanError("temporal_frontier_time_invalid");
    return this.transaction(async (db) => {
      const result = await db.query<{ frontier_payload: unknown; payload_hash: string;
        goal_id: string; frontier_revision: string | number;
        observation_evidence_ref: string; observation_producer_epoch_ref: string;
        retained_until: string | Date; observed_at: string | Date; scopes: unknown }>(
        `SELECT f.goal_id, f.frontier_revision, f.frontier_payload, f.payload_hash,
           f.retained_until, f.observed_at, p.scopes,
           f.observation_evidence_ref, f.observation_producer_epoch_ref
         FROM helix_environment_temporal_frontiers f
         JOIN helix_environment_durable_goal_participants p ON p.goal_id=f.goal_id
         WHERE f.frontier_id=$1 AND p.profile_id=$2 AND p.participant_id=$3
           AND p.status='active' LIMIT 1`,
        [input.frontierId, input.profileId, input.participantId]);
      const row = result.rows[0];
      if (!row || !json(row.scopes).includes("read")) return null;
      if (input.requireLatestForGoal) {
        const latest = await db.query<{ frontier_revision: string | number }>(
          `SELECT frontier_revision FROM helix_environment_temporal_frontiers
           WHERE goal_id=$1 ORDER BY frontier_revision DESC LIMIT 1`, [row.goal_id]);
        if (!latest.rows[0] || Number(latest.rows[0].frontier_revision) !== Number(row.frontier_revision)) return null;
      }
      if ((input.expectedEvidenceRef !== undefined && row.observation_evidence_ref !== input.expectedEvidenceRef) ||
          (input.expectedObservationProducerEpoch !== undefined && row.observation_producer_epoch_ref !== input.expectedObservationProducerEpoch)) return null;
      if (new Date(row.retained_until).getTime() <= now.getTime() ||
          new Date(row.observed_at).getTime() > now.getTime()) return null;
      const frontier = helixEnvironmentAffordanceFrontierSchema.parse(json(row.frontier_payload));
      if (helixEnvironmentTimeSha256(frontier) !== row.payload_hash) throw new TemporalPlanError("temporal_frontier_integrity_invalid");
      return frontier;
    });
  }

  async publish(input: {
    profileId: string; participantId: string; draft: Draft;
    observationEvidenceRef: string; observationProducerEpochRef: string;
    retainedUntil: string;
  }) {
    const draft = structuredClone(input.draft);
    return this.transaction(async (db) => {
      const goal = await db.query<{ current_sequence: string | number; status: string }>(
        `SELECT current_sequence, status FROM helix_environment_durable_goals WHERE goal_id=$1 FOR UPDATE`,
        [draft.identity.goal_id]);
      const grant = await db.query<{ scopes: unknown }>(
        `SELECT scopes FROM helix_environment_durable_goal_participants
         WHERE goal_id=$1 AND profile_id=$2 AND participant_id=$3 AND status='active'`,
        [draft.identity.goal_id, input.profileId, input.participantId]);
      if (!goal.rows[0] || !json(grant.rows[0]?.scopes ?? []).includes("steer")) throw new TemporalPlanError("temporal_frontier_forbidden");
      if (goal.rows[0].status !== "active" || Number(goal.rows[0].current_sequence) !== draft.identity.goal_revision) {
        throw new TemporalPlanError("temporal_frontier_goal_stale");
      }
      if (!input.observationEvidenceRef.trim() || !input.observationProducerEpochRef.trim() ||
          !Number.isFinite(Date.parse(input.retainedUntil)) ||
          Date.parse(input.retainedUntil) <= Date.parse(draft.clocks.audit_at)) throw new TemporalPlanError("temporal_frontier_retention_invalid");
      const identityHash = helixEnvironmentTimeSha256({ identity: draft.identity,
        observation_producer_epoch_ref: input.observationProducerEpochRef });
      const replay = await db.query<{ frontier_payload: unknown; payload_hash: string }>(
        `SELECT frontier_payload, payload_hash FROM helix_environment_temporal_frontiers
         WHERE goal_id=$1 AND goal_revision=$2 AND observation_evidence_ref=$3 AND identity_hash=$4`,
        [draft.identity.goal_id, draft.identity.goal_revision, input.observationEvidenceRef, identityHash]);
      if (replay.rows[0]) {
        const stored = helixEnvironmentAffordanceFrontierSchema.parse(json(replay.rows[0].frontier_payload));
        if (helixEnvironmentTimeSha256(stored) !== replay.rows[0].payload_hash) throw new TemporalPlanError("temporal_frontier_integrity_invalid");
        const candidate = buildHelixEnvironmentAffordanceFrontier({ ...draft,
          frontier_id: stored.frontier_id, identity: { ...draft.identity, affordance_revision: stored.identity.affordance_revision } });
        // Re-publication time never refreshes the retained observation clocks.
        if (helixEnvironmentTimeSha256({ entries: candidate.entries, clock: candidate.clocks.environment, expiry: candidate.expires_at_environment_sequence }) !==
            helixEnvironmentTimeSha256({ entries: stored.entries, clock: stored.clocks.environment, expiry: stored.expires_at_environment_sequence })) {
          throw new TemporalPlanError("temporal_frontier_replay_conflict");
        }
        return { created: false, frontier: stored };
      }
      const latest = await db.query<{ frontier_revision: string | number; frontier_payload: unknown;
        payload_hash: string; observation_producer_epoch_ref: string }>(
        `SELECT frontier_revision, frontier_payload, payload_hash, observation_producer_epoch_ref
         FROM helix_environment_temporal_frontiers WHERE goal_id=$1 ORDER BY frontier_revision DESC LIMIT 1`,
        [draft.identity.goal_id]);
      const revision = Number(latest.rows[0]?.frontier_revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new TemporalPlanError("temporal_frontier_revision_overflow");
      const priorRow = latest.rows[0];
      const prior = priorRow ? helixEnvironmentAffordanceFrontierSchema.parse(json(priorRow.frontier_payload)) : null;
      if (prior && helixEnvironmentTimeSha256(prior) !== priorRow.payload_hash) throw new TemporalPlanError("temporal_frontier_integrity_invalid");
      const stableKeys = ["environment_id", "source_id", "subject_id", "producer_epoch", "authority_id",
        "authority_revision", "goal_id", "goal_revision"] as const;
      const sameDomain = prior && stableKeys.every(key => prior.identity[key] === draft.identity[key]) &&
        priorRow.observation_producer_epoch_ref === input.observationProducerEpochRef &&
        prior.clocks.environment.kind === draft.clocks.environment.kind &&
        prior.clocks.environment.resolution_unit === draft.clocks.environment.resolution_unit &&
        prior.clocks.monotonic.origin_id === draft.clocks.monotonic.origin_id;
      if (sameDomain && draft.identity.observation_revision < prior.identity.observation_revision) {
        throw new TemporalPlanError("temporal_frontier_observation_regressed");
      }
      const previous = sameDomain && draft.clocks.environment.sequence < prior.expires_at_environment_sequence ? prior : null;
      const frontier = buildHelixEnvironmentAffordanceFrontier({ ...draft,
        frontier_id: `environment_frontier:${crypto.randomUUID()}`,
        previous_frontier: previous,
        identity: { ...draft.identity, affordance_revision: revision } });
      await db.query(`INSERT INTO helix_environment_temporal_frontiers
        (frontier_id,goal_id,goal_revision,frontier_revision,observation_evidence_ref,
         observation_producer_epoch_ref,action_producer_epoch_ref,identity_hash,payload_hash,
         frontier_payload,observed_at,retained_until)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [frontier.frontier_id, draft.identity.goal_id, draft.identity.goal_revision, revision,
          input.observationEvidenceRef, input.observationProducerEpochRef, draft.identity.producer_epoch,
          identityHash, helixEnvironmentTimeSha256(frontier), JSON.stringify(frontier), draft.clocks.audit_at, input.retainedUntil]);
      return { created: true, frontier };
    });
  }
}
