import crypto from "node:crypto";
import {
  buildHelixEnvironmentDurableGoalEvent,
  HelixEnvironmentDurableGoalReductionError,
  helixEnvironmentDurableGoalObjectiveSchema,
  helixEnvironmentDurableGoalSha256,
  reduceHelixEnvironmentDurableGoalEvents,
  type HelixEnvironmentDurableGoalEvent,
  type HelixEnvironmentDurableGoalEventPayload,
  type HelixEnvironmentDurableGoalIdentity,
  type HelixEnvironmentDurableGoalObjective,
  type HelixEnvironmentDurableGoalProjection,
} from "@shared/helix-environment-durable-goal";
import {
  readSharedRealtimeRoomDatabase,
  withSharedRealtimeRoomTransaction,
} from "../../helix-ask/realtime-room/room-store/database";
import type { Queryable } from "../../helix-ask/realtime-room/room-store/types";
import {
  getStagePlayLiveSourceMailItem,
  getStagePlayLiveSourceMailItemForEvidenceRef,
} from "../../stage-play/stage-play-live-source-mailbox-store";

export type EnvironmentDurableGoalErrorCode =
  | "durable_goal_not_found"
  | "durable_goal_forbidden"
  | "durable_goal_identity_unavailable"
  | "durable_goal_identity_mismatch"
  | "durable_goal_authority_stale"
  | "durable_goal_revision_conflict"
  | "durable_goal_evidence_missing"
  | "durable_goal_evidence_identity_mismatch"
  | "durable_goal_evidence_stale"
  | "durable_goal_event_invalid"
  | "durable_goal_terminal"
  | "durable_goal_request_conflict"
  | "durable_goal_session_ambiguous";

export class EnvironmentDurableGoalError extends Error {
  constructor(
    readonly code: EnvironmentDurableGoalErrorCode,
    readonly statusCode: number,
    message: string,
    readonly evidenceRefs: string[] = [],
    readonly mismatchReasons: string[] = [],
    readonly evidenceExpiry?: {
      evidence_age_ms: number; max_age_ms: number;
      context_stage_ms?: { goal: number; catalog: number; perception: number };
    },
  ) {
    super(message);
    this.name = "EnvironmentDurableGoalError";
  }
}

export const isEnvironmentDurableGoalError = (
  value: unknown,
): value is EnvironmentDurableGoalError =>
  value instanceof EnvironmentDurableGoalError;

const reduceDurableGoalEvents = (
  events: HelixEnvironmentDurableGoalEvent[],
): HelixEnvironmentDurableGoalProjection => {
  try {
    return reduceHelixEnvironmentDurableGoalEvents(events);
  } catch (error) {
    if (error instanceof HelixEnvironmentDurableGoalReductionError) {
      throw new EnvironmentDurableGoalError(
        "durable_goal_event_invalid",
        409,
        error.message,
        [],
        [error.code],
      );
    }
    throw error;
  }
};

export type EnvironmentDurableGoalIdentityRequest = {
  ownerProfileId: string;
  roomId: string;
  participantId: string;
  environmentBindingId: string;
  subjectNativeId: string;
  actionAuthorityId: string;
  runId: string | null;
  turnId: string;
  goalOwnerParticipantId?: string;
  authorityParticipantId?: string;
};

export type EnvironmentDurableGoalEvidenceResolution = {
  ref: string;
  found: boolean;
  producerPlane?: "world_authority" | "player_embodiment";
  roomId: string | null;
  sourceId: string | null;
  worldId: string | null;
  producerEpochRef: string | null;
  subjectNativeId: string | null;
  observationRevision: number | null;
};

export type EnvironmentDurableGoalIdentityResolver = (
  db: Queryable,
  request: EnvironmentDurableGoalIdentityRequest,
) => Promise<HelixEnvironmentDurableGoalIdentity>;

export type EnvironmentDurableGoalEvidenceResolver = (
  db: Queryable,
  refs: string[],
) => Promise<EnvironmentDurableGoalEvidenceResolution[]>;

export type EnvironmentDurableGoalTransactionRunner = <T>(
  handler: (db: Queryable) => Promise<T>,
) => Promise<T>;
export type EnvironmentDurableGoalDatabaseReader = () => Promise<Queryable>;

type GoalRow = {
  goal_id: string;
  owner_profile_id: string;
  room_id: string;
  participant_id: string;
  subject_native_id: string;
  objective_payload: unknown;
  status: string;
  current_sequence: number | string;
  latest_event_hash: string | null;
  granted_scopes?: unknown;
};

type EventRow = {
  event_id: string;
  goal_id: string;
  sequence: number | string;
  previous_event_hash: string | null;
  event_hash: string;
  owner_profile_id: string;
  connector_installation_id: string;
  device_id: string;
  environment_binding_id: string;
  room_source_binding_id: string;
  room_id: string;
  goal_owner_participant_id: string;
  participant_id: string;
  authority_participant_id: string;
  subject_binding_id: string;
  subject_native_id: string;
  source_id: string;
  world_id: string;
  producer_epoch_ref: string;
  action_authority_id: string;
  authority_policy_version: number | string;
  authority_expires_at: Date | string;
  run_id: string | null;
  turn_id: string;
  event_payload: unknown;
  payload: unknown;
  evidence_refs: unknown;
  occurred_at: Date | string;
};

const parseJson = <T>(value: unknown): T => {
  if (typeof value !== "string") return value as T;
  return JSON.parse(value) as T;
};
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const unique = (values: string[]): string[] => [...new Set(values)];

const runtimeIdentityChanged = (
  previous: HelixEnvironmentDurableGoalIdentity,
  current: HelixEnvironmentDurableGoalIdentity,
): boolean =>
  previous.connector_installation_id !== current.connector_installation_id ||
  previous.device_id !== current.device_id ||
  previous.environment_binding_id !== current.environment_binding_id ||
  previous.room_source_binding_id !== current.room_source_binding_id ||
  previous.source_id !== current.source_id ||
  previous.subject_binding_id !== current.subject_binding_id ||
  previous.producer_epoch_ref !== current.producer_epoch_ref ||
  previous.action_authority_id !== current.action_authority_id ||
  previous.authority_policy_version !== current.authority_policy_version ||
  previous.authority_expires_at !== current.authority_expires_at;

const eventFromRow = (row: EventRow): HelixEnvironmentDurableGoalEvent =>
  parseJson<HelixEnvironmentDurableGoalEvent>(row.event_payload);

const readGoalEvents = async (
  db: Queryable,
  goalId: string,
): Promise<HelixEnvironmentDurableGoalEvent[]> => {
  const result = await db.query<EventRow>(
    `SELECT * FROM helix_environment_durable_goal_events
      WHERE goal_id = $1 ORDER BY sequence ASC;`,
    [goalId],
  );
  return result.rows.map((row) => {
    const event = eventFromRow(row);
    const columnsMatch = event.event_id === row.event_id &&
      event.goal_id === row.goal_id && event.sequence === Number(row.sequence) &&
      event.previous_event_hash === row.previous_event_hash &&
      event.identity.owner_profile_id === row.owner_profile_id &&
      event.identity.environment_binding_id === row.environment_binding_id &&
      event.identity.room_id === row.room_id &&
      event.identity.participant_id === row.participant_id &&
      event.identity.authority_participant_id === row.authority_participant_id &&
      event.identity.subject_native_id === row.subject_native_id &&
      event.identity.producer_epoch_ref === row.producer_epoch_ref;
    if (event.event_hash !== row.event_hash || !columnsMatch) {
      throw new EnvironmentDurableGoalError(
        "durable_goal_event_invalid",
        409,
        `Stored durable goal event ${row.event_id} failed canonical payload or hash verification.`,
      );
    }
    return event;
  });
};

export const resolveCurrentEnvironmentDurableGoalIdentity:
  EnvironmentDurableGoalIdentityResolver = async (db, request) => {
    const subjectSelector = request.subjectNativeId.trim();
    const subjectIdentityColumn = (
      subjectSelector.startsWith("environment_subject_binding:") ||
      subjectSelector.startsWith("environment_subject:")
    )
      ? "s.subject_ref"
      : "s.subject_native_id";
    const result = await db.query<{
      owner_profile_id: string;
      installation_id: string;
      device_id: string;
      environment_binding_id: string;
      room_source_binding_id: string;
      room_id: string;
      source_id: string;
      world_id: string;
      participant_id: string;
      subject_binding_id: string;
      subject_native_id: string;
      producer_epoch_ref: string;
      action_authority_id: string;
      policy_version: number | string;
      expires_at: Date | string;
    }>(
      `SELECT e.owner_profile_id, e.installation_id, e.device_id,
              e.environment_binding_id, e.room_source_binding_id, e.room_id,
              e.source_id, e.world_id, s.participant_id, s.subject_binding_id,
              s.subject_native_id, m.producer_epoch_ref,
              a.action_authority_id, a.policy_version, a.expires_at
         FROM helix_environment_connector_bindings e
         INNER JOIN helix_room_environment_subject_bindings s
           ON s.environment_binding_id = e.environment_binding_id
         INNER JOIN helix_environment_action_authorities a
           ON a.environment_binding_id = e.environment_binding_id
          AND a.participant_id = s.participant_id
          AND a.subject_binding_id = s.subject_binding_id
         INNER JOIN helix_environment_action_connector_manifests m
           ON m.action_authority_id = a.action_authority_id
        WHERE e.environment_binding_id = $1 AND e.room_id = $2
          AND e.owner_profile_id = $3 AND e.status = 'active'
          AND s.participant_id = $4 AND ${subjectIdentityColumn} = $5
          AND s.status = 'active'
          AND a.action_authority_id = $6 AND a.status = 'active'
          AND a.expires_at > now() AND m.status = 'active'
          AND (m.expires_at IS NULL OR m.expires_at > now())
        ORDER BY m.received_at DESC LIMIT 1;`,
      [
        request.environmentBindingId,
        request.roomId,
        request.ownerProfileId,
        request.authorityParticipantId ?? request.participantId,
        subjectSelector,
        request.actionAuthorityId,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      const environment = await db.query<{
        owner_profile_id: string;
        status: string;
      }>(
        `SELECT owner_profile_id, status
           FROM helix_environment_connector_bindings
          WHERE environment_binding_id = $1 AND room_id = $2
          LIMIT 1;`,
        [request.environmentBindingId, request.roomId],
      );
      if (
        !environment.rows[0] ||
        environment.rows[0].owner_profile_id !== request.ownerProfileId ||
        environment.rows[0].status !== "active"
      ) {
        throw new EnvironmentDurableGoalError(
          "durable_goal_identity_mismatch",
          409,
          "The requested room environment is absent, inactive, or owned by another account.",
        );
      }
      const subject = await db.query<{
        subject_binding_id: string;
        status: string;
      }>(
        `SELECT subject_binding_id, status
           FROM helix_room_environment_subject_bindings
          WHERE environment_binding_id = $1 AND participant_id = $2
            AND ${subjectIdentityColumn.replace("s.", "")} = $3
          ORDER BY updated_at DESC LIMIT 1;`,
        [
          request.environmentBindingId,
          request.authorityParticipantId ?? request.participantId,
          subjectSelector,
        ],
      );
      if (!subject.rows[0] || subject.rows[0].status !== "active") {
        throw new EnvironmentDurableGoalError(
          "durable_goal_identity_unavailable",
          409,
          "The selected participant and player do not have a current verified subject binding.",
        );
      }
      const authority = await db.query<{
        status: string;
        expires_at: Date | string | null;
      }>(
        `SELECT status, expires_at
           FROM helix_environment_action_authorities
          WHERE action_authority_id = $1 AND environment_binding_id = $2
            AND participant_id = $3 AND subject_binding_id = $4
          LIMIT 1;`,
        [
          request.actionAuthorityId,
          request.environmentBindingId,
          request.authorityParticipantId ?? request.participantId,
          subject.rows[0].subject_binding_id,
        ],
      );
      const authorityExpiresAt = authority.rows[0]?.expires_at
        ? Date.parse(iso(authority.rows[0].expires_at!))
        : Number.NEGATIVE_INFINITY;
      if (
        !authority.rows[0] ||
        authority.rows[0].status !== "active" ||
        authorityExpiresAt <= Date.now()
      ) {
        throw new EnvironmentDurableGoalError(
          "durable_goal_authority_stale",
          409,
          "The exact player-action authority is absent, inactive, or expired.",
        );
      }
      const manifest = await db.query<{ manifest_id: string }>(
        `SELECT manifest_id
           FROM helix_environment_action_connector_manifests
          WHERE action_authority_id = $1 AND status = 'active'
            AND (expires_at IS NULL OR expires_at > now())
          ORDER BY received_at DESC LIMIT 1;`,
        [request.actionAuthorityId],
      );
      if (!manifest.rows[0]) {
        throw new EnvironmentDurableGoalError(
          "durable_goal_authority_stale",
          409,
          "The exact player-action connector has no current admitted manifest.",
        );
      }
      throw new EnvironmentDurableGoalError(
        "durable_goal_identity_unavailable",
        409,
        "The current room, player, connector epoch, and action authority remain inconsistent after staged verification.",
      );
    }
    return {
      owner_profile_id: row.owner_profile_id,
      host_ref: `environment_device:${row.device_id}`,
      connector_installation_id: row.installation_id,
      device_id: row.device_id,
      environment_binding_id: row.environment_binding_id,
      room_source_binding_id: row.room_source_binding_id,
      room_id: row.room_id,
      goal_owner_participant_id:
        request.goalOwnerParticipantId ?? row.participant_id,
      participant_id: request.participantId,
      authority_participant_id: row.participant_id,
      subject_binding_id: row.subject_binding_id,
      subject_native_id: row.subject_native_id,
      source_id: row.source_id,
      world_id: row.world_id,
      producer_epoch_ref: row.producer_epoch_ref,
      action_authority_id: row.action_authority_id,
      authority_policy_version: Number(row.policy_version),
      authority_expires_at: iso(row.expires_at),
      run_id: request.runId,
      turn_id: request.turnId,
    };
  };

export const resolveEnvironmentDurableGoalEvidence:
  EnvironmentDurableGoalEvidenceResolver = async (db, refs) => {
    const resolutions = new Map<string, EnvironmentDurableGoalEvidenceResolution>();
    refs.forEach((ref) => resolutions.set(ref, {
      ref,
      found: false,
      roomId: null,
      sourceId: null,
      worldId: null,
      producerEpochRef: null,
      subjectNativeId: null,
      observationRevision: null,
    }));
    if (refs.length === 0) return [];
    const refPlaceholders = refs.map((_, index) => `$${index + 1}`).join(", ");
    const allResolved = (): boolean =>
      refs.every((ref) => resolutions.get(ref)?.found === true);
    const events = await db.query<{
      event_id: string; room_id: string; source_id: string; world_id: string;
      producer_epoch_ref: string; subject_native_id: string | null; sequence: number | string;
    }>(
      `SELECT ev.event_id, b.room_id, b.source_id, b.world_id,
              ev.producer_epoch_ref, s.subject_native_id, ev.sequence
         FROM helix_environment_events ev
         INNER JOIN helix_environment_event_batches b ON b.batch_id = ev.batch_id
         LEFT JOIN helix_room_environment_subject_bindings s
           ON s.subject_binding_id = ev.subject_ref
        WHERE ev.event_id IN (${refPlaceholders});`,
      refs,
    );
    for (const row of events.rows) resolutions.set(row.event_id, {
      ref: row.event_id, found: true, producerPlane: "world_authority", roomId: row.room_id,
      sourceId: row.source_id, worldId: row.world_id,
      producerEpochRef: row.producer_epoch_ref,
      subjectNativeId: row.subject_native_id,
      observationRevision: Number(row.sequence),
    });
    if (allResolved()) return refs.map((ref) => resolutions.get(ref)!);
    const digests = await db.query<{
      digest_id: string; room_id: string; source_id: string; world_id: string;
      producer_epoch_ref: string; subject_native_id: string | null;
      latest_event_sequence: number | string;
    }>(
      `SELECT d.digest_id, b.room_id, b.source_id, b.world_id,
              d.producer_epoch_ref, s.subject_native_id,
              d.latest_event_sequence
         FROM helix_environment_situation_digests d
         INNER JOIN helix_environment_connector_bindings b
           ON b.environment_binding_id = d.environment_binding_id
         LEFT JOIN helix_room_environment_subject_bindings s
           ON s.subject_binding_id = d.subject_ref
        WHERE d.digest_id IN (${refPlaceholders});`,
      refs,
    );
    for (const row of digests.rows) resolutions.set(row.digest_id, {
      ref: row.digest_id, found: true, producerPlane: "world_authority", roomId: row.room_id,
      sourceId: row.source_id, worldId: row.world_id,
      producerEpochRef: row.producer_epoch_ref,
      subjectNativeId: row.subject_native_id,
      observationRevision: Number(row.latest_event_sequence),
    });
    if (allResolved()) return refs.map((ref) => resolutions.get(ref)!);
    const actionResults = await db.query<{
      evidence_ref: string; room_id: string; source_id: string; world_id: string;
      producer_epoch_ref: string; subject_native_id: string;
    }>(
      `SELECT CASE
                WHEN r.action_result_id IN (${refPlaceholders}) THEN r.action_result_id
                WHEN r.action_execution_id IN (${refPlaceholders}) THEN r.action_execution_id
                WHEN r.workflow_id IN (${refPlaceholders}) THEN r.workflow_id
                ELSE 'environment_action_evidence:' ||
                     substring(r.result_hash from 8 for 41)
              END AS evidence_ref,
              q.room_id, q.source_id, q.world_id,
              m.producer_epoch_ref, q.subject_native_id
         FROM helix_environment_action_results r
         INNER JOIN helix_environment_action_requests q
           ON q.action_request_id = r.action_request_id
         INNER JOIN helix_environment_action_connector_manifests m
           ON m.manifest_id = q.connector_manifest_id
        WHERE r.action_result_id IN (${refPlaceholders})
           OR r.action_execution_id IN (${refPlaceholders})
           OR r.workflow_id IN (${refPlaceholders})
           OR ('environment_action_evidence:' ||
               substring(r.result_hash from 8 for 41)) IN (${refPlaceholders});`,
      refs,
    );
    for (const row of actionResults.rows) resolutions.set(row.evidence_ref, {
      ref: row.evidence_ref, found: true, producerPlane: "player_embodiment", roomId: row.room_id,
      sourceId: row.source_id, worldId: row.world_id,
      producerEpochRef: row.producer_epoch_ref,
      subjectNativeId: row.subject_native_id, observationRevision: null,
    });
    if (allResolved()) return refs.map((ref) => resolutions.get(ref)!);
    const probeObservations = await db.query<{
      evidence_ref: string; room_id: string; source_id: string; world_id: string;
      producer_epoch_ref: string; subject_native_id: string | null;
      normalized_observation: unknown;
    }>(
      `SELECT o.evidence_ref, r.room_id, r.source_id, b.world_id,
              r.producer_epoch_ref, r.resolved_subject_native_id AS subject_native_id,
              o.normalized_observation
         FROM helix_environment_probe_observations o
         INNER JOIN helix_environment_probe_requests r
           ON r.probe_request_id = o.probe_request_id
         INNER JOIN helix_environment_connector_bindings b
           ON b.environment_binding_id = r.environment_binding_id
        WHERE o.evidence_ref IN (${refPlaceholders});`,
      refs,
    );
    for (const row of probeObservations.rows) {
      const observation = parseJson<{
        outcome?: unknown;
        provenance_valid?: unknown;
        observation_revision?: unknown;
      }>(row.normalized_observation);
      const revision = Number(observation.observation_revision);
      if (
        observation.outcome !== "succeeded" ||
        observation.provenance_valid !== true ||
        !Number.isInteger(revision) ||
        revision < 0
      ) continue;
      resolutions.set(row.evidence_ref, {
        ref: row.evidence_ref, found: true, producerPlane: "world_authority", roomId: row.room_id,
        sourceId: row.source_id, worldId: row.world_id,
        producerEpochRef: row.producer_epoch_ref,
        subjectNativeId: row.subject_native_id,
        observationRevision: revision,
      });
    }
    if (allResolved()) return refs.map((ref) => resolutions.get(ref)!);
    const goalEvents = await db.query<{
      event_id: string; room_id: string; source_id: string; world_id: string;
      producer_epoch_ref: string; subject_native_id: string;
    }>(
      `SELECT event_id, room_id, source_id, world_id, producer_epoch_ref,
              subject_native_id
         FROM helix_environment_durable_goal_events
        WHERE event_id IN (${refPlaceholders});`,
      refs,
    );
    for (const row of goalEvents.rows) resolutions.set(row.event_id, {
      ref: row.event_id, found: true, producerPlane: "player_embodiment", roomId: row.room_id,
      sourceId: row.source_id, worldId: row.world_id,
      producerEpochRef: row.producer_epoch_ref,
      subjectNativeId: row.subject_native_id, observationRevision: null,
    });
    for (const ref of refs) {
      if (resolutions.get(ref)?.found) continue;
      const mail = getStagePlayLiveSourceMailItem(ref) ??
        getStagePlayLiveSourceMailItemForEvidenceRef(ref);
      const environment = mail?.environmentIdentity;
      if (!mail || !environment || environment.provenanceValid !== true) continue;
      resolutions.set(ref, {
        ref,
        found: true,
        producerPlane: "world_authority",
        roomId: mail.roomId ?? null,
        sourceId: mail.sourceId,
        worldId: environment.worldId,
        producerEpochRef: environment.producerEpochRef,
        subjectNativeId: environment.selectedPlayerNativeId,
        observationRevision: environment.observationRevision,
      });
    }
    return refs.map((ref) => resolutions.get(ref)!);
  };

export class EnvironmentDurableGoalStore {
  constructor(
    private readonly transaction: EnvironmentDurableGoalTransactionRunner =
      withSharedRealtimeRoomTransaction,
    private readonly resolveIdentity: EnvironmentDurableGoalIdentityResolver =
      resolveCurrentEnvironmentDurableGoalIdentity,
    private readonly resolveEvidence: EnvironmentDurableGoalEvidenceResolver =
      resolveEnvironmentDurableGoalEvidence,
    private readonly readDatabase: EnvironmentDurableGoalDatabaseReader =
      readSharedRealtimeRoomDatabase,
  ) {}

  async create(input: EnvironmentDurableGoalIdentityRequest & {
    objective: HelixEnvironmentDurableGoalObjective;
    occurredAt?: string;
    idempotencyKey?: string;
  }): Promise<HelixEnvironmentDurableGoalProjection> {
    const objective = helixEnvironmentDurableGoalObjectiveSchema.parse(input.objective);
    if (input.idempotencyKey !== undefined &&
        (!input.idempotencyKey.trim() || input.idempotencyKey.length > 320)) {
      throw new EnvironmentDurableGoalError("durable_goal_request_conflict", 409, "Invalid goal creation retry key.");
    }
    return this.transaction(async (db) => {
      const identityValue = await this.resolveIdentity(db, input);
      // Database uniqueness, not process memory, owns keyed creation. Resolve
      // current authority even on replay; the key never bypasses admission.
      const goalId = input.idempotencyKey === undefined
        ? `environment_durable_goal:${crypto.randomUUID()}`
        : `environment_durable_goal:${crypto.createHash("sha256")
          .update(JSON.stringify(["creation-v1", input.ownerProfileId, input.idempotencyKey])).digest("hex")}`;
      const event = buildHelixEnvironmentDurableGoalEvent({
        event_id: `environment_durable_goal_event:${crypto.randomUUID()}`,
        goal_id: goalId,
        sequence: 1,
        previous_event_hash: null,
        identity: identityValue,
        payload: { kind: "goal_created", objective },
        evidence_refs: [],
        occurred_at: input.occurredAt ?? new Date().toISOString(),
      });
      const inserted = await db.query<{ goal_id: string; latest_event_hash: string }>(
        `INSERT INTO helix_environment_durable_goals (
           goal_id, owner_profile_id, connector_installation_id, device_id,
           environment_binding_id, room_source_binding_id, room_id,
           participant_id, subject_binding_id, subject_native_id, source_id,
           world_id, objective_hash, objective_payload, status,
           current_sequence, latest_event_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active',1,$15)
         ON CONFLICT (goal_id) DO NOTHING RETURNING goal_id, latest_event_hash;`,
        [goalId, identityValue.owner_profile_id, identityValue.connector_installation_id,
          identityValue.device_id, identityValue.environment_binding_id,
          identityValue.room_source_binding_id, identityValue.room_id,
          identityValue.goal_owner_participant_id, identityValue.subject_binding_id,
          identityValue.subject_native_id, identityValue.source_id,
          identityValue.world_id, helixEnvironmentDurableGoalSha256(objective),
          JSON.stringify(objective), event.event_hash],
      );
      if (inserted.rows[0]?.latest_event_hash !== event.event_hash) {
        const events = await readGoalEvents(db, goalId);
        const creation = events[0];
        if (input.idempotencyKey === undefined || creation?.payload.kind !== "goal_created" ||
            helixEnvironmentDurableGoalSha256(creation.payload.objective) !== helixEnvironmentDurableGoalSha256(objective) ||
            helixEnvironmentDurableGoalSha256(creation.identity) !== helixEnvironmentDurableGoalSha256(identityValue)) {
          throw new EnvironmentDurableGoalError("durable_goal_request_conflict", 409,
            "The goal creation retry key belongs to a different objective or identity.");
        }
        // Return current ledger state, including pauses/cancellation. Never
        // reinsert participant grants or resurrect the original active state.
        return reduceDurableGoalEvents(events);
      }
      await db.query(
        `INSERT INTO helix_environment_durable_goal_participants (
           goal_id, participant_id, profile_id, granted_by_profile_id, scopes
         ) VALUES ($1,$2,$3,$3,'["read","steer"]'::jsonb);`,
        [goalId, identityValue.goal_owner_participant_id, identityValue.owner_profile_id],
      );
      await this.insertParticipantEvent(db, {
        goalId,
        participantId: identityValue.goal_owner_participant_id,
        profileId: identityValue.owner_profile_id,
        actorProfileId: identityValue.owner_profile_id,
        eventKind: "granted",
        scopes: ["read", "steer"],
      });
      await this.insertEvent(db, event);
      return reduceDurableGoalEvents([event]);
    });
  }

  async inspect(input: { goalId: string; profileId: string; participantId: string }): Promise<HelixEnvironmentDurableGoalProjection> {
    const db = await this.readDatabase();
    const goal = await db.query<GoalRow>(
      `SELECT g.*, p.scopes AS granted_scopes FROM helix_environment_durable_goals g
        INNER JOIN helix_environment_durable_goal_participants p
          ON p.goal_id=g.goal_id
       WHERE g.goal_id=$1 AND p.profile_id=$2 AND p.participant_id=$3
         AND p.status='active' LIMIT 1;`,
      [input.goalId, input.profileId, input.participantId],
    );
    if (!goal.rows[0] || !parseJson<string[]>(goal.rows[0].granted_scopes ?? []).includes("read")) {
      throw new EnvironmentDurableGoalError("durable_goal_not_found", 404, "The durable environment goal was not found.");
    }
    return reduceDurableGoalEvents(await readGoalEvents(db, input.goalId));
  }

  /** Internal proposal preflight only. Dispatch must revalidate in its own transaction. */
  async resolveTemporalAdmissionContext(input: {
    goalId: string; profileId: string; participantId: string;
    expectedRevision: number; roomId: string; runId: string | null; turnId: string;
  }) {
    return this.transaction(async (db) => {
      const selected = await db.query<GoalRow>(
        `SELECT g.*, p.scopes AS granted_scopes FROM helix_environment_durable_goals g
          INNER JOIN helix_environment_durable_goal_participants p ON p.goal_id=g.goal_id
         WHERE g.goal_id=$1 AND p.profile_id=$2 AND p.participant_id=$3
           AND p.status='active' LIMIT 1;`,
        [input.goalId, input.profileId, input.participantId],
      );
      const goal = selected.rows[0];
      if (!goal || !parseJson<string[]>(goal.granted_scopes ?? []).includes("steer")) {
        throw new EnvironmentDurableGoalError("durable_goal_forbidden", 403, "Temporal planning requires a current goal steering grant.");
      }
      const projection = reduceDurableGoalEvents(await readGoalEvents(db, input.goalId));
      if (projection.revision !== input.expectedRevision) {
        throw new EnvironmentDurableGoalError("durable_goal_revision_conflict", 409, "The temporal proposal references a stale goal revision.");
      }
      if (projection.status !== "active" || projection.recovery.required) {
        throw new EnvironmentDurableGoalError("durable_goal_authority_stale", 409, "Temporal planning requires an active goal with completed recovery.");
      }
      const prior = projection.identity;
      if (prior.room_id !== input.roomId || prior.run_id !== input.runId) {
        throw new EnvironmentDurableGoalError("durable_goal_identity_mismatch", 409, "The temporal proposal must use the goal's exact room and run.");
      }
      const current = await this.resolveIdentity(db, {
        ownerProfileId: goal.owner_profile_id, roomId: prior.room_id,
        participantId: input.participantId, goalOwnerParticipantId: goal.participant_id,
        authorityParticipantId: prior.authority_participant_id,
        environmentBindingId: prior.environment_binding_id,
        subjectNativeId: prior.subject_native_id, actionAuthorityId: prior.action_authority_id,
        runId: prior.run_id, turnId: input.turnId,
      });
      if (runtimeIdentityChanged(prior, current) ||
          prior.source_id !== current.source_id || prior.world_id !== current.world_id ||
          prior.subject_native_id !== current.subject_native_id || prior.room_id !== current.room_id) {
        throw new EnvironmentDurableGoalError("durable_goal_authority_stale", 409, "Temporal planning requires fresh checkpoint recovery for changed identity.");
      }
      return { goal_id: input.goalId, goal_revision: projection.revision,
        identity: current, execution_authority: false as const,
        answer_authority: false as const, terminal_eligible: false as const };
    });
  }

  /** Exact session lookup for setup, never a newest-goal fallback or resume. */
  async findForSession(input: {
    roomId: string; profileId: string; participantId: string; runId: string;
  }): Promise<HelixEnvironmentDurableGoalProjection | null> {
    if (!input.runId.trim()) return null;
    const db = await this.readDatabase();
    const candidates = await db.query<GoalRow>(
      `SELECT g.*, p.scopes AS granted_scopes
         FROM helix_environment_durable_goals g
         INNER JOIN helix_environment_durable_goal_participants p ON p.goal_id=g.goal_id
         INNER JOIN helix_environment_durable_goal_events e
           ON e.goal_id=g.goal_id AND e.sequence=g.current_sequence
        WHERE g.room_id=$1 AND p.profile_id=$2 AND p.participant_id=$3
          AND p.status='active' AND e.run_id=$4
          AND g.status NOT IN ('completed', 'canceled')
        LIMIT 2;`,
      [input.roomId, input.profileId, input.participantId, input.runId],
    );
    if (!candidates.rows.length) return null;
    if (candidates.rows.length > 1) {
      throw new EnvironmentDurableGoalError("durable_goal_session_ambiguous", 409,
        "Select the intended unfinished goal for this environment session.");
    }
    const goal = await this.inspect({ goalId: candidates.rows[0].goal_id,
      profileId: input.profileId, participantId: input.participantId });
    // Re-read the authoritative ledger: a concurrent identity/status change
    // cannot turn a candidate query into current-session evidence.
    if (goal.identity.room_id !== input.roomId || goal.identity.run_id !== input.runId ||
        ["completed", "canceled"].includes(goal.status)) {
      throw new EnvironmentDurableGoalError("durable_goal_revision_conflict", 409,
        "The environment session changed during discovery.");
    }
    return goal;
  }

  async listForRoom(input: {
    roomId: string;
    profileId: string;
    participantId: string;
    sourceId: string;
    worldId: string;
    roomSourceBindingId: string;
    limit?: number;
  }): Promise<HelixEnvironmentDurableGoalProjection[]> {
    const db = await this.readDatabase();
    const limit = Math.max(1, Math.min(8, Math.floor(input.limit ?? 4)));
    const goals = await db.query<GoalRow>(
      `SELECT g.*, p.scopes AS granted_scopes
         FROM helix_environment_durable_goals g
         INNER JOIN helix_environment_durable_goal_participants p
           ON p.goal_id=g.goal_id
        WHERE g.room_id=$1 AND p.profile_id=$2 AND p.participant_id=$3
          AND g.source_id=$4 AND g.world_id=$5 AND g.room_source_binding_id=$6
          AND p.status='active'
        ORDER BY g.updated_at DESC, g.created_at DESC
        LIMIT $7;`,
      [input.roomId, input.profileId, input.participantId, input.sourceId,
        input.worldId, input.roomSourceBindingId, limit],
    );
    const projections: HelixEnvironmentDurableGoalProjection[] = [];
    for (const goal of goals.rows) {
      if (!parseJson<string[]>(goal.granted_scopes ?? []).includes("read")) continue;
      projections.push(reduceDurableGoalEvents(await readGoalEvents(db, goal.goal_id)));
    }
    return projections;
  }

  async recordRecoveryFromEnvironmentEvent(input: {
    roomId: string;
    sourceId: string;
    worldId: string;
    producerEpochRef: string;
    subjectBindingId: string;
    eventRef: string;
    reason: Extract<HelixEnvironmentDurableGoalEventPayload, { kind: "recovery_required" }>["reason"];
    occurredAt?: string;
  }): Promise<HelixEnvironmentDurableGoalProjection[]> {
    return this.transaction(async (db) => {
      const goals = await db.query<GoalRow>(
        `SELECT * FROM helix_environment_durable_goals
          WHERE room_id=$1 AND source_id=$2 AND world_id=$3
            AND subject_binding_id=$4
            AND status NOT IN ('completed', 'canceled')
          ORDER BY created_at ASC FOR UPDATE;`,
        [input.roomId, input.sourceId, input.worldId, input.subjectBindingId],
      );
      const projections: HelixEnvironmentDurableGoalProjection[] = [];
      for (const goal of goals.rows) {
        const existingEvents = await readGoalEvents(db, goal.goal_id);
        const previous = reduceDurableGoalEvents(existingEvents);
        if (previous.recovery.required) continue;
        if (previous.identity.producer_epoch_ref !== input.producerEpochRef) {
          continue;
        }
        const identityValue: HelixEnvironmentDurableGoalIdentity = {
          ...previous.identity,
          participant_id: previous.identity.goal_owner_participant_id,
          run_id: previous.identity.run_id,
          turn_id: `environment_recovery:${input.eventRef}`,
        };
        await this.requireEvidenceIdentity(
          db,
          identityValue,
          { kind: "recovery_required", reason: input.reason, last_recoverable_checkpoint_id: previous.latest_checkpoint?.checkpoint_id ?? null },
          [input.eventRef],
        );
        const event = buildHelixEnvironmentDurableGoalEvent({
          event_id: `environment_durable_goal_event:${crypto.randomUUID()}`,
          goal_id: goal.goal_id,
          sequence: Number(goal.current_sequence) + 1,
          previous_event_hash: goal.latest_event_hash,
          identity: identityValue,
          payload: { kind: "recovery_required", reason: input.reason, last_recoverable_checkpoint_id: previous.latest_checkpoint?.checkpoint_id ?? null },
          evidence_refs: [input.eventRef],
          occurred_at: input.occurredAt ?? new Date().toISOString(),
        });
        const projection = reduceDurableGoalEvents([...existingEvents, event]);
        await this.insertEvent(db, event);
        await db.query(
          `UPDATE helix_environment_durable_goals
              SET status='recovery_required', current_sequence=$2,
                  latest_event_hash=$3, updated_at=now()
            WHERE goal_id=$1;`,
          [goal.goal_id, projection.revision, projection.latest_event_hash],
        );
        projections.push(projection);
      }
      return projections;
    });
  }

  async append(input: EnvironmentDurableGoalIdentityRequest & {
    goalId: string;
    expectedRevision: number;
    /** Internal recovery precondition; checked against current authority in this transaction. */
    expectedCurrentIdentity?: HelixEnvironmentDurableGoalIdentity;
    payload: HelixEnvironmentDurableGoalEventPayload;
    evidenceRefs?: string[];
    occurredAt?: string;
  }): Promise<HelixEnvironmentDurableGoalProjection> {
    return this.transaction(async (db) => {
      const goalResult = await db.query<GoalRow>(
        `SELECT * FROM helix_environment_durable_goals WHERE goal_id=$1 FOR UPDATE;`,
        [input.goalId],
      );
      const goal = goalResult.rows[0];
      if (!goal) throw new EnvironmentDurableGoalError("durable_goal_not_found", 404, "The durable environment goal was not found.");
      const grantResult = await db.query<{ scopes: unknown }>(
        `SELECT scopes FROM helix_environment_durable_goal_participants
          WHERE goal_id=$1 AND participant_id=$2 AND profile_id=$3
            AND status='active' LIMIT 1;`,
        [input.goalId, input.participantId, input.ownerProfileId],
      );
      const grantedScopes = parseJson<string[]>(grantResult.rows[0]?.scopes ?? []);
      if (!grantedScopes.includes("steer")) throw new EnvironmentDurableGoalError("durable_goal_forbidden", 403, "This room participant is not authorized to steer the durable goal.");
      if (["completed", "canceled"].includes(goal.status)) throw new EnvironmentDurableGoalError("durable_goal_terminal", 409, "A terminal durable goal cannot accept another event.");
      const currentRevision = Number(goal.current_sequence);
      if (currentRevision !== input.expectedRevision) throw new EnvironmentDurableGoalError("durable_goal_revision_conflict", 409, `Expected revision ${input.expectedRevision}; current revision is ${currentRevision}.`);
      const existingEvents = await readGoalEvents(db, input.goalId);
      const previousProjection = reduceDurableGoalEvents(existingEvents);
      const previousIdentity = previousProjection.identity;
      const identityRequest = {
        ...input,
        ownerProfileId: goal.owner_profile_id,
        goalOwnerParticipantId: goal.participant_id,
        authorityParticipantId: goal.participant_id,
        subjectNativeId: goal.subject_native_id,
      };
      const currentIdentity = input.payload.kind !== "recovery_required" || input.expectedCurrentIdentity
        ? await this.resolveIdentity(db, identityRequest) : null;
      if (input.expectedCurrentIdentity && helixEnvironmentDurableGoalSha256(currentIdentity) !==
          helixEnvironmentDurableGoalSha256(input.expectedCurrentIdentity)) {
        throw new EnvironmentDurableGoalError("durable_goal_authority_stale", 409,
          "Current identity changed after the recovery observation; acquire fresh exact evidence.");
      }
      if (input.payload.kind === "authority_rebound" && currentIdentity &&
          (previousIdentity.room_source_binding_id !== currentIdentity.room_source_binding_id ||
           previousIdentity.source_id !== currentIdentity.source_id)) {
        // A replacement ingress may inherit this exact player's goal only
        // after the old source is revoked. This server-side check is required
        // even for callers that append directly rather than using Ready up.
        const sources = await db.query<{ binding_id: string; owner_profile_id: string; room_id: string;
          source_id: string; world_id: string; domain_adapter: string; status: string }>(
          `SELECT binding_id, owner_profile_id, room_id, source_id, world_id, domain_adapter, status
             FROM helix_room_source_bindings WHERE binding_id IN ($1, $2);`,
          [previousIdentity.room_source_binding_id, currentIdentity.room_source_binding_id]);
        const oldSource = sources.rows.find(row => row.binding_id === previousIdentity.room_source_binding_id);
        const newSource = sources.rows.find(row => row.binding_id === currentIdentity.room_source_binding_id);
        if (!previousProjection.recovery.required || !oldSource || !newSource ||
            oldSource.status !== "revoked" || newSource.status !== "active" ||
            previousIdentity.owner_profile_id !== currentIdentity.owner_profile_id ||
            previousIdentity.connector_installation_id !== currentIdentity.connector_installation_id ||
            previousIdentity.subject_native_id !== currentIdentity.subject_native_id ||
            previousIdentity.room_id !== currentIdentity.room_id ||
            previousIdentity.world_id !== currentIdentity.world_id ||
            previousIdentity.run_id !== currentIdentity.run_id ||
            oldSource.owner_profile_id !== previousIdentity.owner_profile_id ||
            newSource.owner_profile_id !== currentIdentity.owner_profile_id ||
            oldSource.room_id !== previousIdentity.room_id || newSource.room_id !== currentIdentity.room_id ||
            oldSource.source_id !== previousIdentity.source_id || newSource.source_id !== currentIdentity.source_id ||
            oldSource.world_id !== previousIdentity.world_id || newSource.world_id !== currentIdentity.world_id ||
            oldSource.domain_adapter !== "minecraft.fabric_mod.v1" ||
            newSource.domain_adapter !== oldSource.domain_adapter) {
          throw new EnvironmentDurableGoalError("durable_goal_identity_mismatch", 409,
            "A replacement source must be the same owner's active Fabric source after revocation of the old source.");
        }
      }
      let identityValue: HelixEnvironmentDurableGoalIdentity;
      if (input.payload.kind === "recovery_required") {
        identityValue = {
          ...previousIdentity,
          participant_id: input.participantId,
          run_id: input.runId,
          turn_id: input.turnId,
        };
      } else {
        identityValue = currentIdentity!;
        if (
          runtimeIdentityChanged(previousIdentity, identityValue) &&
          input.payload.kind !== "authority_rebound"
        ) {
          throw new EnvironmentDurableGoalError(
            "durable_goal_authority_stale",
            409,
            "The connector epoch or action authority changed. Record recovery_required, then rebind with fresh evidence before continuing.",
          );
        }
      }
      if (
        previousProjection.recovery.required &&
        !["authority_rebound", "checkpoint_verified", "goal_resumed", "goal_paused", "goal_canceled"].includes(input.payload.kind)
      ) {
        throw new EnvironmentDurableGoalError(
          "durable_goal_authority_stale",
          409,
          "The durable goal is recovering. Rebind authority, verify a checkpoint, and resume before starting more work.",
        );
      }
      const refs = unique(input.evidenceRefs ?? []);
      await this.requireEvidenceIdentity(db, identityValue, input.payload, refs);
      const event = buildHelixEnvironmentDurableGoalEvent({
        event_id: `environment_durable_goal_event:${crypto.randomUUID()}`,
        goal_id: input.goalId,
        sequence: currentRevision + 1,
        previous_event_hash: goal.latest_event_hash,
        identity: identityValue,
        payload: input.payload,
        evidence_refs: refs,
        occurred_at: input.occurredAt ?? new Date().toISOString(),
      });
      const projection = reduceDurableGoalEvents([...existingEvents, event]);
      await this.insertEvent(db, event);
      await db.query(
        `UPDATE helix_environment_durable_goals SET status=$2,
           current_sequence=$3, latest_event_hash=$4, updated_at=now(),
           connector_installation_id=$5, device_id=$6,
           environment_binding_id=$7, subject_binding_id=$8,
           completed_at=CASE WHEN $2='completed' THEN now() ELSE completed_at END,
           canceled_at=CASE WHEN $2='canceled' THEN now() ELSE canceled_at END
         WHERE goal_id=$1;`,
        [input.goalId, projection.status, projection.revision,
          projection.latest_event_hash,
          projection.identity.connector_installation_id,
          projection.identity.device_id,
          projection.identity.environment_binding_id,
          projection.identity.subject_binding_id],
      );
      return projection;
    });
  }

  async grantParticipant(input: {
    goalId: string;
    ownerProfileId: string;
    participantId: string;
    scopes: Array<"read" | "steer">;
  }): Promise<{ participant_id: string; profile_id: string; scopes: string[]; status: "active" }> {
    return this.transaction(async (db) => {
      const goal = await db.query<GoalRow>(
        `SELECT * FROM helix_environment_durable_goals
          WHERE goal_id=$1 AND owner_profile_id=$2 FOR UPDATE;`,
        [input.goalId, input.ownerProfileId],
      );
      if (!goal.rows[0]) throw new EnvironmentDurableGoalError("durable_goal_forbidden", 403, "Only the durable goal owner may grant continuation.");
      const member = await db.query<{ profile_id: string }>(
        `SELECT profile_id FROM helix_shared_realtime_room_members
          WHERE room_id=$1 AND participant_id=$2 AND presence <> 'left' LIMIT 1;`,
        [goal.rows[0].room_id, input.participantId],
      );
      const profileId = member.rows[0]?.profile_id;
      if (!profileId) throw new EnvironmentDurableGoalError("durable_goal_identity_unavailable", 404, "The requested continuation participant is not active in this room.");
      const scopes = unique(input.scopes);
      await db.query(
        `INSERT INTO helix_environment_durable_goal_participants (
           goal_id, participant_id, profile_id, granted_by_profile_id, scopes,
           status, revoked_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,'active',NULL)
         ON CONFLICT (goal_id, participant_id) DO UPDATE SET
           profile_id=EXCLUDED.profile_id,
           granted_by_profile_id=EXCLUDED.granted_by_profile_id,
           scopes=EXCLUDED.scopes,
           status='active', updated_at=now(), revoked_at=NULL;`,
        [input.goalId, input.participantId, profileId, input.ownerProfileId, JSON.stringify(scopes)],
      );
      await this.insertParticipantEvent(db, {
        goalId: input.goalId,
        participantId: input.participantId,
        profileId,
        actorProfileId: input.ownerProfileId,
        eventKind: "granted",
        scopes,
      });
      return { participant_id: input.participantId, profile_id: profileId, scopes, status: "active" };
    });
  }

  async revokeParticipant(input: {
    goalId: string;
    ownerProfileId: string;
    participantId: string;
  }): Promise<{ participant_id: string; status: "revoked" }> {
    return this.transaction(async (db) => {
      const goal = await db.query<GoalRow>(
        `SELECT * FROM helix_environment_durable_goals
          WHERE goal_id=$1 AND owner_profile_id=$2 FOR UPDATE;`,
        [input.goalId, input.ownerProfileId],
      );
      if (!goal.rows[0]) throw new EnvironmentDurableGoalError("durable_goal_forbidden", 403, "Only the durable goal owner may revoke continuation.");
      if (input.participantId === goal.rows[0].participant_id) {
        throw new EnvironmentDurableGoalError("durable_goal_forbidden", 409, "The goal owner continuation cannot be revoked; pause or cancel the goal instead.");
      }
      const result = await db.query(
        `UPDATE helix_environment_durable_goal_participants
            SET status='revoked', updated_at=now(), revoked_at=now()
          WHERE goal_id=$1 AND participant_id=$2 AND status='active';`,
        [input.goalId, input.participantId],
      );
      if ((result.rowCount ?? 0) === 0) throw new EnvironmentDurableGoalError("durable_goal_not_found", 404, "The continuation grant was not found.");
      const participant = await db.query<{ profile_id: string; scopes: unknown }>(
        `SELECT profile_id, scopes FROM helix_environment_durable_goal_participants
          WHERE goal_id=$1 AND participant_id=$2 LIMIT 1;`,
        [input.goalId, input.participantId],
      );
      await this.insertParticipantEvent(db, {
        goalId: input.goalId,
        participantId: input.participantId,
        profileId: participant.rows[0]!.profile_id,
        actorProfileId: input.ownerProfileId,
        eventKind: "revoked",
        scopes: parseJson<string[]>(participant.rows[0]!.scopes),
      });
      return { participant_id: input.participantId, status: "revoked" };
    });
  }

  private async requireEvidenceIdentity(
    db: Queryable,
    identityValue: HelixEnvironmentDurableGoalIdentity,
    payload: HelixEnvironmentDurableGoalEventPayload,
    refs: string[],
  ): Promise<void> {
    const evidenceRequired = [
      "attempt_settled", "semantic_wake_consumed", "checkpoint_verified",
      "milestone_completed", "authority_rebound", "goal_completed",
    ].includes(payload.kind);
    if (evidenceRequired && refs.length === 0) throw new EnvironmentDurableGoalError("durable_goal_evidence_missing", 409, `${payload.kind} requires current evidence.`);
    if (refs.length === 0) return;
    const resolved = await this.resolveEvidence(db, refs);
    const missing = resolved.filter((entry) => !entry.found).map((entry) => entry.ref);
    if (missing.length > 0) throw new EnvironmentDurableGoalError("durable_goal_evidence_missing", 409, "One or more durable goal evidence refs were not found.", missing);
    const mismatchReasons = (entry: EnvironmentDurableGoalEvidenceResolution): string[] => [
      ...(entry.roomId !== identityValue.room_id ? ["wrong_room"] : []),
      ...(entry.sourceId !== identityValue.source_id ? ["wrong_source"] : []),
      ...(entry.worldId !== identityValue.world_id ? ["wrong_world"] : []),
      ...(entry.producerPlane !== "world_authority" &&
      entry.producerEpochRef !== null &&
      entry.producerEpochRef !== identityValue.producer_epoch_ref
        ? ["wrong_producer_epoch"]
        : []),
      ...(entry.subjectNativeId !== null &&
      entry.subjectNativeId !== identityValue.subject_native_id
        ? ["wrong_subject"]
        : []),
    ];
    const mismatched = resolved.filter((entry) => mismatchReasons(entry).length > 0);
    if (mismatched.length > 0) throw new EnvironmentDurableGoalError(
      "durable_goal_evidence_identity_mismatch",
      409,
      "Durable goal evidence belongs to another room, source, world, or player.",
      mismatched.map((entry) => entry.ref),
      unique(mismatched.flatMap(mismatchReasons)),
    );
    const expectedRevision = payload.kind === "checkpoint_verified"
      ? payload.observation_revision
      : payload.kind === "semantic_wake_consumed"
        ? payload.observation_revision
        : payload.kind === "authority_rebound"
          ? payload.fresh_observation_revision
          : null;
    if (
      expectedRevision !== null &&
      !resolved.some((entry) => entry.observationRevision === expectedRevision)
    ) {
      throw new EnvironmentDurableGoalError(
        "durable_goal_evidence_identity_mismatch",
        409,
        "The claimed observation revision is not present in the admitted evidence.",
        refs,
      );
    }
    if (payload.kind === "checkpoint_verified") {
      const expectedHash = helixEnvironmentDurableGoalSha256({
        evidence_refs: refs,
        observation_revision: payload.observation_revision,
        verified_facts: payload.verified_facts,
        completed_postcondition_ids: payload.completed_postcondition_ids,
        incomplete_postcondition_ids: payload.incomplete_postcondition_ids,
      });
      if (payload.checkpoint_evidence_hash !== expectedHash) {
        throw new EnvironmentDurableGoalError(
          "durable_goal_event_invalid",
          409,
          "The checkpoint evidence hash does not match the admitted evidence and verified facts.",
          refs,
        );
      }
    }
  }

  private async insertEvent(db: Queryable, event: HelixEnvironmentDurableGoalEvent): Promise<void> {
    await db.query(
      `INSERT INTO helix_environment_durable_goal_events (
         event_id, goal_id, sequence, event_kind, previous_event_hash,
         event_hash, owner_profile_id, connector_installation_id, device_id,
         environment_binding_id, room_source_binding_id, room_id,
         goal_owner_participant_id, participant_id, subject_binding_id,
         authority_participant_id, subject_native_id, source_id, world_id, producer_epoch_ref,
         action_authority_id, authority_policy_version, authority_expires_at,
         run_id, turn_id, event_payload, payload, evidence_refs, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29);`,
      [event.event_id, event.goal_id, event.sequence, event.payload.kind,
        event.previous_event_hash, event.event_hash, event.identity.owner_profile_id,
        event.identity.connector_installation_id, event.identity.device_id,
        event.identity.environment_binding_id, event.identity.room_source_binding_id,
        event.identity.room_id, event.identity.goal_owner_participant_id,
        event.identity.participant_id, event.identity.subject_binding_id,
        event.identity.authority_participant_id,
        event.identity.subject_native_id, event.identity.source_id,
        event.identity.world_id, event.identity.producer_epoch_ref,
        event.identity.action_authority_id, event.identity.authority_policy_version,
        event.identity.authority_expires_at, event.identity.run_id,
        event.identity.turn_id, JSON.stringify(event), JSON.stringify(event.payload),
        JSON.stringify(event.evidence_refs), event.occurred_at],
    );
  }

  private async insertParticipantEvent(db: Queryable, input: {
    goalId: string;
    participantId: string;
    profileId: string;
    actorProfileId: string;
    eventKind: "granted" | "revoked";
    scopes: string[];
  }): Promise<void> {
    const previous = await db.query<{ sequence: number | string; event_hash: string }>(
      `SELECT sequence, event_hash
         FROM helix_environment_durable_goal_participant_events
        WHERE goal_id=$1 ORDER BY sequence DESC LIMIT 1;`,
      [input.goalId],
    );
    const sequence = previous.rows[0] ? Number(previous.rows[0].sequence) + 1 : 1;
    const previousEventHash = previous.rows[0]?.event_hash ?? null;
    const occurredAt = new Date().toISOString();
    const content = {
      goal_id: input.goalId,
      sequence,
      previous_event_hash: previousEventHash,
      event_kind: input.eventKind,
      participant_id: input.participantId,
      profile_id: input.profileId,
      actor_profile_id: input.actorProfileId,
      scopes: unique(input.scopes).sort(),
      occurred_at: occurredAt,
    };
    const eventHash = helixEnvironmentDurableGoalSha256(content);
    await db.query(
      `INSERT INTO helix_environment_durable_goal_participant_events (
         grant_event_id, goal_id, sequence, previous_event_hash, event_hash,
         event_kind, participant_id, profile_id, actor_profile_id, scopes,
         occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11);`,
      [`environment_durable_goal_grant_event:${crypto.randomUUID()}`,
        input.goalId, sequence, previousEventHash, eventHash, input.eventKind,
        input.participantId, input.profileId, input.actorProfileId,
        JSON.stringify(content.scopes), occurredAt],
    );
  }
}

export const environmentDurableGoalStore = new EnvironmentDurableGoalStore();
