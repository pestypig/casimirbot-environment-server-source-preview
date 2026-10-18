import crypto from "node:crypto";
import {
  acknowledgeHelixEnvironmentMonitor,
  createHelixEnvironmentMonitorLease,
  deliverHelixEnvironmentMonitorItems,
  helixEnvironmentMonitorLeaseSchema,
  helixEnvironmentMonitorDeliverySchema,
  helixEnvironmentMonitorSha256,
  markHelixEnvironmentMonitorRetentionGap,
  repairHelixEnvironmentMonitorWithFreshSnapshot,
  revokeHelixEnvironmentMonitor,
  type HelixEnvironmentMonitorIdentity,
  type HelixEnvironmentMonitorItem,
  type HelixEnvironmentMonitorLease,
  type HelixEnvironmentMonitorDelivery,
} from "@shared/helix-environment-monitor";
import {
  readSharedRealtimeRoomDatabase,
  withSharedRealtimeRoomTransaction,
} from "../../helix-ask/realtime-room/room-store/database";
import type { Queryable } from "../../helix-ask/realtime-room/room-store/types";
import {
  HELIX_MINECRAFT_ACTOR_STATUS_READ_CAPABILITY,
  helixEnvironmentProbeObservationSchema,
} from "@shared/helix-environment-connector";

export type EnvironmentMonitorStoreErrorCode =
  | "mcp_client_identity_required"
  | "monitor_not_found"
  | "monitor_forbidden"
  | "monitor_identity_mismatch"
  | "monitor_goal_unavailable"
  | "monitor_run_unavailable"
  | "monitor_snapshot_evidence_missing"
  | "monitor_snapshot_evidence_identity_mismatch"
  | "monitor_snapshot_evidence_not_fresh_actor_snapshot"
  | "monitor_event_invalid";

export class EnvironmentMonitorStoreError extends Error {
  constructor(
    readonly code: EnvironmentMonitorStoreErrorCode,
    readonly statusCode: number,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "EnvironmentMonitorStoreError";
  }
}

type MonitorLeaseRow = {
  monitor_id: string;
  owner_profile_id: string;
  mcp_client_id: string;
  client_continuation_ref: string;
  run_id: string;
  goal_id: string;
  room_id: string | null;
  participant_id: string;
  environment_binding_id: string;
  source_id: string;
  world_id: string;
  subject_ref: string;
  producer_epoch_ref: string;
  policy_revision: number | string;
  status: string;
  delivered_cursor: number | string;
  acknowledged_cursor: number | string;
  current_sequence: number | string;
  latest_event_hash: string | null;
  lease_payload: unknown;
};

type GoalAccessRow = {
  room_id: string;
  participant_id: string;
  environment_binding_id: string;
  source_id: string;
  world_id: string;
  subject_binding_id: string;
  status: string;
  granted_scopes: unknown;
};

type RunAccessRow = {
  expires_at: Date | string;
};

type GoalIdentityEventRow = {
  producer_epoch_ref: string;
  authority_policy_version: number | string;
  run_id: string | null;
};

type MonitorDeliveryEventRow = {
  event_payload: unknown;
};

type EnvironmentMonitorTransactionRunner = <T>(
  handler: (db: Queryable) => Promise<T>,
) => Promise<T>;
type EnvironmentMonitorDatabaseReader = () => Promise<Queryable>;

export type EnvironmentMonitorSnapshotEvidenceResolution = {
  found: boolean;
  ownerProfileId: string | null;
  roomId: string | null;
  participantId: string | null;
  environmentBindingId: string | null;
  sourceId: string | null;
  worldId: string | null;
  subjectRef: string | null;
  producerEpochRef: string | null;
  capabilityId: string | null;
  observedAt: string | null;
  succeeded: boolean;
  provenanceValid: boolean;
};

export type EnvironmentMonitorSnapshotEvidenceResolver = (
  db: Queryable,
  evidenceRef: string,
) => Promise<EnvironmentMonitorSnapshotEvidenceResolution>;

const parseJson = <T>(value: unknown): T =>
  typeof value === "string" ? (JSON.parse(value) as T) : (value as T);

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const missingSnapshotEvidence = (): EnvironmentMonitorSnapshotEvidenceResolution => ({
  found: false,
  ownerProfileId: null,
  roomId: null,
  participantId: null,
  environmentBindingId: null,
  sourceId: null,
  worldId: null,
  subjectRef: null,
  producerEpochRef: null,
  capabilityId: null,
  observedAt: null,
  succeeded: false,
  provenanceValid: false,
});

export const resolveEnvironmentMonitorSnapshotEvidence:
  EnvironmentMonitorSnapshotEvidenceResolver = async (db, evidenceRef) => {
    const result = await db.query<{
      owner_profile_id: string;
      room_id: string;
      requesting_participant_id: string | null;
      environment_binding_id: string;
      source_id: string;
      world_id: string;
      resolved_subject_binding_id: string | null;
      producer_epoch_ref: string;
      capability_id: string;
      request_status: string;
      binding_status: string;
      observation_outcome: string;
      normalized_observation: unknown;
    }>(
      `SELECT r.owner_profile_id, r.room_id, r.requesting_participant_id,
              r.environment_binding_id, r.source_id, b.world_id,
              r.resolved_subject_binding_id, r.producer_epoch_ref,
              r.capability_id, r.status AS request_status,
              b.status AS binding_status,
              o.outcome AS observation_outcome, o.normalized_observation
         FROM helix_environment_probe_observations o
         INNER JOIN helix_environment_probe_requests r
           ON r.probe_request_id = o.probe_request_id
         INNER JOIN helix_environment_connector_bindings b
           ON b.environment_binding_id = r.environment_binding_id
        WHERE o.evidence_ref = $1
        LIMIT 1;`,
      [evidenceRef],
    );
    const row = result.rows[0];
    if (!row) return missingSnapshotEvidence();
    const observation = helixEnvironmentProbeObservationSchema.safeParse(
      parseJson<unknown>(row.normalized_observation),
    );
    const parsedObservation = observation.success ? observation.data : null;
    const observationMatches = parsedObservation !== null &&
      parsedObservation.evidence_ref === evidenceRef &&
      parsedObservation.capability_id === row.capability_id &&
      parsedObservation.outcome === row.observation_outcome;
    return {
      found: true,
      ownerProfileId: row.owner_profile_id,
      roomId: row.room_id,
      participantId: row.requesting_participant_id,
      environmentBindingId: row.environment_binding_id,
      sourceId: row.source_id,
      worldId: row.world_id,
      subjectRef: row.resolved_subject_binding_id,
      producerEpochRef: row.producer_epoch_ref,
      capabilityId: row.capability_id,
      observedAt: observationMatches
        ? parsedObservation?.observed_at ?? null
        : null,
      succeeded: observationMatches && row.request_status === "succeeded" &&
        row.binding_status === "active" &&
        row.observation_outcome === "succeeded" &&
        parsedObservation?.outcome === "succeeded",
      provenanceValid: observationMatches &&
        parsedObservation?.provenance_valid === true &&
        parsedObservation?.raw_content_included === false &&
        parsedObservation?.answer_authority === false &&
        parsedObservation?.terminal_eligible === false,
    };
  };

const exactLeaseAccess = (input: {
  lease: HelixEnvironmentMonitorLease;
  profileId: string;
  mcpClientId: string;
  clientContinuationRef: string;
}): void => {
  if (
    input.lease.identity.owner_profile_id !== input.profileId ||
    input.lease.identity.mcp_client_id !== input.mcpClientId ||
    input.lease.identity.client_continuation_ref !==
      input.clientContinuationRef
  ) {
    throw new EnvironmentMonitorStoreError(
      "monitor_forbidden",
      403,
      "The environment monitor belongs to a different profile, MCP client, or continuation.",
    );
  }
};

const parseLeaseRow = (row: MonitorLeaseRow): HelixEnvironmentMonitorLease => {
  const lease = helixEnvironmentMonitorLeaseSchema.parse(
    parseJson<unknown>(row.lease_payload),
  );
  const matches =
    lease.monitor_id === row.monitor_id &&
    lease.identity.owner_profile_id === row.owner_profile_id &&
    lease.identity.mcp_client_id === row.mcp_client_id &&
    lease.identity.client_continuation_ref === row.client_continuation_ref &&
    lease.identity.run_id === row.run_id &&
    lease.identity.goal_id === row.goal_id &&
    lease.identity.room_id === row.room_id &&
    lease.identity.participant_id === row.participant_id &&
    lease.identity.environment_binding_id === row.environment_binding_id &&
    lease.identity.source_id === row.source_id &&
    lease.identity.world_id === row.world_id &&
    lease.identity.subject_ref === row.subject_ref &&
    lease.identity.producer_epoch_ref === row.producer_epoch_ref &&
    lease.identity.policy_revision === Number(row.policy_revision) &&
    lease.status === row.status &&
    lease.delivered_cursor === Number(row.delivered_cursor) &&
    lease.acknowledged_cursor === Number(row.acknowledged_cursor);
  if (!matches) {
    throw new EnvironmentMonitorStoreError(
      "monitor_event_invalid",
      409,
      "The stored environment monitor projection contradicts its canonical identity or cursor columns.",
    );
  }
  return lease;
};

export class EnvironmentMonitorStore {
  constructor(
    private readonly transaction: EnvironmentMonitorTransactionRunner =
      withSharedRealtimeRoomTransaction,
    private readonly readDatabase: EnvironmentMonitorDatabaseReader =
      readSharedRealtimeRoomDatabase,
    private readonly resolveSnapshotEvidence:
      EnvironmentMonitorSnapshotEvidenceResolver =
        resolveEnvironmentMonitorSnapshotEvidence,
  ) {}

  async create(input: {
    identity: HelixEnvironmentMonitorIdentity;
    eventFamilies: HelixEnvironmentMonitorLease["event_families"];
    maxEventAgeMs: number;
    wakeBudgetTotal: number;
    expiresAt: string;
    now?: string;
  }): Promise<HelixEnvironmentMonitorLease> {
    return this.transaction(async (db: Queryable) => {
      await this.requireCreationIdentity(db, input.identity, input.expiresAt);
      const existing = await db.query<MonitorLeaseRow>(
        `SELECT * FROM helix_environment_monitor_leases
          WHERE owner_profile_id=$1 AND mcp_client_id=$2
            AND client_continuation_ref=$3 AND run_id=$4 AND goal_id=$5
          LIMIT 1 FOR UPDATE;`,
        [
          input.identity.owner_profile_id,
          input.identity.mcp_client_id,
          input.identity.client_continuation_ref,
          input.identity.run_id,
          input.identity.goal_id,
        ],
      );
      if (existing.rows[0]) {
        const lease = await this.persistExpiryIfNeeded(
          db,
          parseLeaseRow(existing.rows[0]),
          input.now,
        );
        const requested = createHelixEnvironmentMonitorLease({
          monitorId: lease.monitor_id,
          identity: input.identity,
          eventFamilies: input.eventFamilies,
          maxEventAgeMs: input.maxEventAgeMs,
          wakeBudgetTotal: input.wakeBudgetTotal,
          createdAt: lease.created_at,
          expiresAt: input.expiresAt,
        });
        const requestedExpiryMs = Date.parse(requested.expires_at);
        const existingExpiryMs = Date.parse(lease.expires_at);
        const requestsExtension =
          !Number.isFinite(requestedExpiryMs) ||
          !Number.isFinite(existingExpiryMs) ||
          requestedExpiryMs > existingExpiryMs;
        if (
          requestsExtension ||
          helixEnvironmentMonitorSha256({
            identity: lease.identity,
            event_families: lease.event_families,
            max_event_age_ms: lease.max_event_age_ms,
            wake_budget_total: lease.wake_budget_total,
            expires_at: lease.expires_at,
          }) !==
          helixEnvironmentMonitorSha256({
            identity: requested.identity,
            event_families: requested.event_families,
            max_event_age_ms: requested.max_event_age_ms,
            wake_budget_total: requested.wake_budget_total,
            // A reconnect supplies a relative duration, so its derived expiry
            // cannot equal the original timestamp. Compare the immutable
            // identity and bounds at the existing expiry, then separately
            // reject any attempted extension above.
            expires_at: lease.expires_at,
          })
        ) {
          throw new EnvironmentMonitorStoreError(
            "monitor_identity_mismatch",
            409,
            "The existing monitor continuation was created with different identity or bounds.",
          );
        }
        return lease;
      }
      const lease = createHelixEnvironmentMonitorLease({
        monitorId: `environment_monitor:${crypto.randomUUID()}`,
        identity: input.identity,
        eventFamilies: input.eventFamilies,
        maxEventAgeMs: input.maxEventAgeMs,
        wakeBudgetTotal: input.wakeBudgetTotal,
        createdAt: input.now,
        expiresAt: input.expiresAt,
      });
      await db.query(
        `INSERT INTO helix_environment_monitor_leases(
           monitor_id, owner_profile_id, mcp_client_id,
           client_continuation_ref, run_id, goal_id, room_id, participant_id,
           environment_binding_id, source_id, world_id, subject_ref,
           producer_epoch_ref, policy_revision, status, delivered_cursor,
           acknowledged_cursor, lease_payload, created_at, updated_at,
           expires_at, revoked_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
           $18::jsonb,$19,$20,$21,$22
         );`,
        [
          lease.monitor_id,
          lease.identity.owner_profile_id,
          lease.identity.mcp_client_id,
          lease.identity.client_continuation_ref,
          lease.identity.run_id,
          lease.identity.goal_id,
          lease.identity.room_id,
          lease.identity.participant_id,
          lease.identity.environment_binding_id,
          lease.identity.source_id,
          lease.identity.world_id,
          lease.identity.subject_ref,
          lease.identity.producer_epoch_ref,
          lease.identity.policy_revision,
          lease.status,
          lease.delivered_cursor,
          lease.acknowledged_cursor,
          JSON.stringify(lease),
          lease.created_at,
          lease.updated_at,
          lease.expires_at,
          lease.revoked_at,
        ],
      );
      return this.appendEvent(db, lease, {
        eventKind: "monitor_created",
        cursorBefore: 0,
        cursorAfter: 0,
        evidenceRef: null,
        payload: { lease },
        occurredAt: lease.created_at,
      });
    });
  }

  async inspect(input: {
    monitorId: string;
    profileId: string;
    mcpClientId: string;
    clientContinuationRef: string;
  }): Promise<HelixEnvironmentMonitorLease> {
    return this.transaction(async (db: Queryable) => {
      const current = await this.readLease(db, input.monitorId, true);
      exactLeaseAccess({ lease: current, ...input });
      return await this.persistExpiryIfNeeded(db, current);
    });
  }

  async listForEnvironment(input: {
    profileId: string;
    roomId: string;
    environmentBindingId: string;
    sourceId: string;
    worldId: string;
    subjectRef: string;
    limit?: number;
  }): Promise<HelixEnvironmentMonitorLease[]> {
    return this.transaction(async (db: Queryable) => {
      const limit = Math.max(1, Math.min(16, Math.floor(input.limit ?? 8)));
      const result = await db.query<MonitorLeaseRow>(
        `SELECT * FROM helix_environment_monitor_leases
          WHERE owner_profile_id=$1 AND room_id=$2
            AND environment_binding_id=$3 AND source_id=$4 AND world_id=$5
            AND subject_ref=$6
          ORDER BY updated_at DESC, created_at DESC
          LIMIT $7 FOR UPDATE;`,
        [
          input.profileId,
          input.roomId,
          input.environmentBindingId,
          input.sourceId,
          input.worldId,
          input.subjectRef,
          limit,
        ],
      );
      const leases: HelixEnvironmentMonitorLease[] = [];
      for (const row of result.rows) {
        leases.push(await this.persistExpiryIfNeeded(db, parseLeaseRow(row)));
      }
      return leases;
    });
  }

  async readPendingDeliveries(input: {
    monitorId: string;
    profileId: string;
    mcpClientId: string;
    clientContinuationRef: string;
    limit?: number;
  }): Promise<{
    lease: HelixEnvironmentMonitorLease;
    deliveries: HelixEnvironmentMonitorDelivery[];
  }> {
    return this.transaction(async (db: Queryable) => {
      const current = await this.readLease(db, input.monitorId, true);
      exactLeaseAccess({ lease: current, ...input });
      const lease = await this.persistExpiryIfNeeded(db, current);
      const limit = Math.max(1, Math.min(20, input.limit ?? 10));
      const result = await db.query<MonitorDeliveryEventRow>(
        `SELECT event_payload
           FROM helix_environment_monitor_events
          WHERE monitor_id=$1 AND event_kind='semantic_batch_delivered'
            AND cursor_after > $2
          ORDER BY cursor_after ASC, sequence ASC
          LIMIT $3;`,
        [lease.monitor_id, lease.acknowledged_cursor, limit],
      );
      const deliveries = result.rows.map((row: MonitorDeliveryEventRow) => {
        const eventPayload = parseJson<Record<string, unknown>>(row.event_payload);
        const payload = parseJson<Record<string, unknown>>(eventPayload.payload);
        return helixEnvironmentMonitorDeliverySchema.parse(
          payload.delivery,
        ) as HelixEnvironmentMonitorDelivery;
      });
      return { lease, deliveries };
    });
  }

  async findDeliveredEvidenceRefs(input: {
    monitorId: string;
    profileId: string;
    mcpClientId: string;
    clientContinuationRef: string;
    evidenceRefs: string[];
  }): Promise<string[]> {
    const db = await this.readDatabase();
    const lease = await this.readLease(db, input.monitorId, false);
    exactLeaseAccess({ lease, ...input });
    const requested = [...new Set(input.evidenceRefs)].slice(0, 256);
    if (requested.length === 0) return [];
    const result = await db.query<{ evidence_ref: string }>(
      `SELECT evidence_ref
         FROM helix_environment_monitor_delivered_evidence
        WHERE monitor_id=$1 AND evidence_ref = ANY($2::text[]);`,
      [lease.monitor_id, requested],
    );
    return result.rows.map((row: { evidence_ref: string }) => row.evidence_ref);
  }

  async deliver(input: {
    monitorId: string;
    profileId: string;
    mcpClientId: string;
    clientContinuationRef: string;
    items: HelixEnvironmentMonitorItem[];
    now?: string;
    clientWakeTransport?: "active_wait" | "native_continuation";
  }): Promise<{
    lease: HelixEnvironmentMonitorLease;
    delivery: HelixEnvironmentMonitorDelivery | null;
    duplicate_evidence_refs: string[];
  }> {
    return this.transaction(async (db: Queryable) => {
      const current = await this.readLease(db, input.monitorId, true);
      exactLeaseAccess({ lease: current, ...input });
      const active = await this.persistExpiryIfNeeded(db, current, input.now);
      const refs = [
        ...new Set(
          input.items.map((item: HelixEnvironmentMonitorItem) => item.evidence_ref),
        ),
      ];
      const prior = refs.length
        ? await db.query<{ evidence_ref: string }>(
            `SELECT evidence_ref
               FROM helix_environment_monitor_delivered_evidence
              WHERE monitor_id=$1 AND evidence_ref = ANY($2::text[]);`,
            [input.monitorId, refs],
          )
        : { rows: [] };
      const duplicateRefs = prior.rows.map(
        (row: { evidence_ref: string }) => row.evidence_ref,
      );
      const admitted = input.items.filter(
        (item: HelixEnvironmentMonitorItem) =>
          !duplicateRefs.includes(item.evidence_ref),
      );
      if (admitted.length === 0) {
        return {
          lease: active,
          delivery: null,
          duplicate_evidence_refs: duplicateRefs,
        };
      }
      const delivered = deliverHelixEnvironmentMonitorItems({
        lease: active,
        items: admitted,
        now: input.now,
        clientWakeTransport: input.clientWakeTransport,
      });
      for (const item of delivered.delivery.items) {
        await db.query(
          `INSERT INTO helix_environment_monitor_delivered_evidence(
             monitor_id, evidence_ref, delivery_id, delivered_cursor,
             delivered_at
           ) VALUES ($1,$2,$3,$4,$5);`,
          [
            delivered.lease.monitor_id,
            item.evidence_ref,
            delivered.delivery.delivery_id,
            delivered.delivery.cursor_after,
            delivered.delivery.delivered_at,
          ],
        );
      }
      const lease = await this.appendEvent(db, delivered.lease, {
        eventKind: "semantic_batch_delivered",
        cursorBefore: delivered.delivery.cursor_before,
        cursorAfter: delivered.delivery.cursor_after,
        evidenceRef: null,
        payload: { delivery: delivered.delivery },
        occurredAt: delivered.delivery.delivered_at,
      });
      return {
        lease,
        delivery: delivered.delivery,
        duplicate_evidence_refs: duplicateRefs,
      };
    });
  }

  async acknowledge(input: {
    monitorId: string;
    profileId: string;
    mcpClientId: string;
    clientContinuationRef: string;
    cursor: number;
    now?: string;
  }): Promise<HelixEnvironmentMonitorLease> {
    return this.transaction(async (db: Queryable) => {
      const current = await this.readLease(db, input.monitorId, true);
      exactLeaseAccess({ lease: current, ...input });
      const active = await this.persistExpiryIfNeeded(db, current, input.now);
      if (input.cursor === active.acknowledged_cursor) return active;
      const lease = acknowledgeHelixEnvironmentMonitor({
        lease: active,
        cursor: input.cursor,
        now: input.now,
      });
      return this.appendEvent(db, lease, {
        eventKind: "cursor_acknowledged",
        cursorBefore: active.acknowledged_cursor,
        cursorAfter: lease.acknowledged_cursor,
        evidenceRef: null,
        payload: { acknowledged_cursor: lease.acknowledged_cursor },
        occurredAt: lease.updated_at,
      });
    });
  }

  async markRetentionGap(input: {
    monitorId: string;
    profileId: string;
    mcpClientId: string;
    clientContinuationRef: string;
    now?: string;
  }): Promise<{
    lease: HelixEnvironmentMonitorLease;
    delivery: HelixEnvironmentMonitorDelivery;
  }> {
    return this.transaction(async (db: Queryable) => {
      const current = await this.readLease(db, input.monitorId, true);
      exactLeaseAccess({ lease: current, ...input });
      const active = await this.persistExpiryIfNeeded(db, current, input.now);
      const gap = markHelixEnvironmentMonitorRetentionGap({
        lease: active,
        now: input.now,
      });
      const lease = await this.appendEvent(db, gap.lease, {
        eventKind: "retention_gap_detected",
        cursorBefore: gap.delivery.cursor_before,
        cursorAfter: gap.delivery.cursor_after,
        evidenceRef: null,
        payload: { delivery: gap.delivery },
        occurredAt: gap.delivery.delivered_at,
      });
      return { lease, delivery: gap.delivery };
    });
  }

  async recordFreshSnapshot(input: {
    monitorId: string;
    profileId: string;
    mcpClientId: string;
    clientContinuationRef: string;
    snapshotEvidenceRef: string;
    observedAt: string;
    now?: string;
  }): Promise<HelixEnvironmentMonitorLease> {
    return this.transaction(async (db: Queryable) => {
      const current = await this.readLease(db, input.monitorId, true);
      exactLeaseAccess({ lease: current, ...input });
      const active = await this.persistExpiryIfNeeded(db, current, input.now);
      const evidence = await this.resolveSnapshotEvidence(
        db,
        input.snapshotEvidenceRef,
      );
      if (!evidence.found) {
        throw new EnvironmentMonitorStoreError(
          "monitor_snapshot_evidence_missing",
          409,
          "The recovery snapshot evidence reference is absent from the durable probe ledger.",
        );
      }
      const identityMismatches = [
        evidence.ownerProfileId !== active.identity.owner_profile_id && "owner_profile_id",
        evidence.roomId !== active.identity.room_id && "room_id",
        evidence.participantId !== active.identity.participant_id && "participant_id",
        evidence.environmentBindingId !== active.identity.environment_binding_id &&
          "environment_binding_id",
        evidence.sourceId !== active.identity.source_id && "source_id",
        evidence.worldId !== active.identity.world_id && "world_id",
        evidence.subjectRef !== active.identity.subject_ref && "subject_ref",
        evidence.producerEpochRef !== active.identity.producer_epoch_ref &&
          "producer_epoch_ref",
      ].filter((value): value is string => typeof value === "string");
      if (identityMismatches.length > 0) {
        throw new EnvironmentMonitorStoreError(
          "monitor_snapshot_evidence_identity_mismatch",
          409,
          "The recovery snapshot belongs to a different monitor identity.",
          identityMismatches,
        );
      }
      const now = input.now ?? new Date().toISOString();
      const observedAtMs = evidence.observedAt
        ? Date.parse(evidence.observedAt)
        : Number.NaN;
      const ageMs = Date.parse(now) - observedAtMs;
      if (
        evidence.capabilityId !== HELIX_MINECRAFT_ACTOR_STATUS_READ_CAPABILITY ||
        !evidence.succeeded ||
        !evidence.provenanceValid ||
        evidence.observedAt !== input.observedAt ||
        !Number.isFinite(observedAtMs) ||
        ageMs < 0 ||
        ageMs > active.max_event_age_ms
      ) {
        throw new EnvironmentMonitorStoreError(
          "monitor_snapshot_evidence_not_fresh_actor_snapshot",
          409,
          "Recovery requires an exact, fresh, provenance-valid actor-status observation from the durable probe ledger.",
        );
      }
      const lease = repairHelixEnvironmentMonitorWithFreshSnapshot({
        lease: active,
        snapshotEvidenceRef: input.snapshotEvidenceRef,
        observedAt: evidence.observedAt,
        now: input.now,
      });
      if (lease === active) return active;
      return this.appendEvent(db, lease, {
        eventKind: "fresh_snapshot_recorded",
        cursorBefore: active.delivered_cursor,
        cursorAfter: active.delivered_cursor,
        evidenceRef: input.snapshotEvidenceRef,
        payload: {
          snapshot_evidence_ref: input.snapshotEvidenceRef,
          observed_at: input.observedAt,
        },
        occurredAt: lease.updated_at,
      });
    });
  }

  async revoke(input: {
    monitorId: string;
    profileId: string;
    mcpClientId: string;
    clientContinuationRef: string;
    now?: string;
  }): Promise<HelixEnvironmentMonitorLease> {
    return this.transaction(async (db: Queryable) => {
      const current = await this.readLease(db, input.monitorId, true);
      exactLeaseAccess({ lease: current, ...input });
      const active = await this.persistExpiryIfNeeded(db, current, input.now);
      if (active.status === "revoked") return active;
      const lease = revokeHelixEnvironmentMonitor({
        lease: active,
        now: input.now,
      });
      return this.appendEvent(db, lease, {
        eventKind: "monitor_revoked",
        cursorBefore: active.delivered_cursor,
        cursorAfter: active.delivered_cursor,
        evidenceRef: null,
        payload: { status: "revoked" },
        occurredAt: lease.updated_at,
      });
    });
  }

  private async requireCreationIdentity(
    db: Queryable,
    identity: HelixEnvironmentMonitorIdentity,
    expiresAt: string,
  ): Promise<void> {
    const goalResult = await db.query<GoalAccessRow>(
      `SELECT g.room_id, p.participant_id,
              g.environment_binding_id, g.source_id, g.world_id,
              g.subject_binding_id, g.status, p.scopes AS granted_scopes
         FROM helix_environment_durable_goals g
         INNER JOIN helix_environment_durable_goal_participants p
           ON p.goal_id=g.goal_id
        WHERE g.goal_id=$1 AND p.profile_id=$2 AND p.participant_id=$3
          AND p.status='active' LIMIT 1;`,
      [identity.goal_id, identity.owner_profile_id, identity.participant_id],
    );
    const goal = goalResult.rows[0];
    if (!goal) {
      throw new EnvironmentMonitorStoreError(
        "monitor_goal_unavailable",
        404,
        "The durable environment goal is unavailable to this profile and participant.",
      );
    }
    const scopes = parseJson<string[]>(goal.granted_scopes ?? []);
    if (!scopes.includes("read")) {
      throw new EnvironmentMonitorStoreError(
        "monitor_forbidden",
        403,
        "The participant lacks read access to the durable environment goal.",
      );
    }
    const goalMismatches = [
      goal.room_id !== identity.room_id && "room_id",
      goal.participant_id !== identity.participant_id && "participant_id",
      goal.environment_binding_id !== identity.environment_binding_id &&
        "environment_binding_id",
      goal.source_id !== identity.source_id && "source_id",
      goal.world_id !== identity.world_id && "world_id",
      goal.subject_binding_id !== identity.subject_ref && "subject_ref",
    ].filter((value): value is string => Boolean(value));
    if (goalMismatches.length > 0) {
      throw new EnvironmentMonitorStoreError(
        "monitor_identity_mismatch",
        409,
        "The requested monitor identity differs from the durable environment goal.",
        goalMismatches,
      );
    }
    const runResult = await db.query<RunAccessRow>(
      `SELECT expires_at FROM helix_agent_runs
        WHERE run_id=$1 LIMIT 1;`,
      [identity.run_id],
    );
    const run = runResult.rows[0];
    if (!run) {
      throw new EnvironmentMonitorStoreError(
        "monitor_run_unavailable",
        404,
        "The durable agent run is unavailable to this profile.",
      );
    }
    if (Date.parse(expiresAt) > Date.parse(iso(run.expires_at))) {
      throw new EnvironmentMonitorStoreError(
        "monitor_run_unavailable",
        409,
        "The monitor lease cannot outlive its durable agent run.",
      );
    }
    const eventResult = await db.query<GoalIdentityEventRow>(
      `SELECT producer_epoch_ref, authority_policy_version, run_id
         FROM helix_environment_durable_goal_events
        WHERE goal_id=$1 ORDER BY sequence DESC LIMIT 1;`,
      [identity.goal_id],
    );
    const latest = eventResult.rows[0];
    if (
      !latest ||
      latest.producer_epoch_ref !== identity.producer_epoch_ref ||
      Number(latest.authority_policy_version) !== identity.policy_revision ||
      latest.run_id !== identity.run_id
    ) {
      throw new EnvironmentMonitorStoreError(
        "monitor_identity_mismatch",
        409,
        "The monitor producer epoch or policy revision is not current for the durable goal.",
        ["producer_epoch_ref", "policy_revision", "run_id"],
      );
    }
  }

  private async readLease(
    db: Queryable,
    monitorId: string,
    forUpdate: boolean,
  ): Promise<HelixEnvironmentMonitorLease> {
    const result = await db.query<MonitorLeaseRow>(
      `SELECT * FROM helix_environment_monitor_leases
        WHERE monitor_id=$1 LIMIT 1${forUpdate ? " FOR UPDATE" : ""};`,
      [monitorId],
    );
    if (!result.rows[0]) {
      throw new EnvironmentMonitorStoreError(
        "monitor_not_found",
        404,
        "The environment monitor was not found.",
      );
    }
    return parseLeaseRow(result.rows[0]);
  }

  private async persistExpiryIfNeeded(
    db: Queryable,
    lease: HelixEnvironmentMonitorLease,
    nowValue?: string,
  ): Promise<HelixEnvironmentMonitorLease> {
    const now = nowValue ?? new Date().toISOString();
    if (
      lease.status !== "active" ||
      Date.parse(lease.expires_at) > Date.parse(now)
    ) {
      return lease;
    }
    const expired = helixEnvironmentMonitorLeaseSchema.parse({
      ...lease,
      status: "expired",
      updated_at: now,
    }) as HelixEnvironmentMonitorLease;
    return await this.appendEvent(db, expired, {
      eventKind: "monitor_expired",
      cursorBefore: lease.delivered_cursor,
      cursorAfter: lease.delivered_cursor,
      evidenceRef: null,
      payload: { status: "expired" },
      occurredAt: now,
    });
  }

  private async appendEvent(
    db: Queryable,
    lease: HelixEnvironmentMonitorLease,
    input: {
      eventKind:
        | "monitor_created"
        | "semantic_batch_delivered"
        | "cursor_acknowledged"
        | "retention_gap_detected"
        | "fresh_snapshot_recorded"
        | "monitor_revoked"
        | "monitor_expired";
      evidenceRef: string | null;
      cursorBefore: number;
      cursorAfter: number;
      payload: Record<string, unknown>;
      occurredAt: string;
    },
  ): Promise<HelixEnvironmentMonitorLease> {
    const row = await db.query<Pick<MonitorLeaseRow, "current_sequence" | "latest_event_hash">>(
      `SELECT current_sequence, latest_event_hash
         FROM helix_environment_monitor_leases
        WHERE monitor_id=$1 LIMIT 1 FOR UPDATE;`,
      [lease.monitor_id],
    );
    if (!row.rows[0]) {
      throw new EnvironmentMonitorStoreError(
        "monitor_not_found",
        404,
        "The environment monitor disappeared while appending its event.",
      );
    }
    const sequence = Number(row.rows[0].current_sequence) + 1;
    const previousEventHash = row.rows[0].latest_event_hash;
    const monitorEventId = `environment_monitor_event:${crypto.randomUUID()}`;
    const eventContent = {
      monitor_event_id: monitorEventId,
      monitor_id: lease.monitor_id,
      sequence,
      event_kind: input.eventKind,
      previous_event_hash: previousEventHash,
      evidence_ref: input.evidenceRef,
      cursor_before: input.cursorBefore,
      cursor_after: input.cursorAfter,
      payload: input.payload,
      occurred_at: input.occurredAt,
    };
    const eventHash = helixEnvironmentMonitorSha256(eventContent);
    await db.query(
      `INSERT INTO helix_environment_monitor_events(
         monitor_event_id, monitor_id, sequence, event_kind,
         previous_event_hash, event_hash, evidence_ref, cursor_before,
         cursor_after, event_payload, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11);`,
      [
        monitorEventId,
        lease.monitor_id,
        sequence,
        input.eventKind,
        previousEventHash,
        eventHash,
        input.evidenceRef,
        input.cursorBefore,
        input.cursorAfter,
        JSON.stringify(eventContent),
        input.occurredAt,
      ],
    );
    await db.query(
      `UPDATE helix_environment_monitor_leases
          SET status=$2, delivered_cursor=$3, acknowledged_cursor=$4,
              current_sequence=$5, latest_event_hash=$6,
              lease_payload=$7::jsonb, updated_at=$8, revoked_at=$9
        WHERE monitor_id=$1;`,
      [
        lease.monitor_id,
        lease.status,
        lease.delivered_cursor,
        lease.acknowledged_cursor,
        sequence,
        eventHash,
        JSON.stringify(lease),
        lease.updated_at,
        lease.revoked_at,
      ],
    );
    return lease;
  }
}

export const environmentMonitorStore = new EnvironmentMonitorStore();
