import crypto from "node:crypto";
import {
  HELIX_ENVIRONMENT_ACTION_CONNECTOR_READINESS_SCHEMA,
  HELIX_ENVIRONMENT_ACTION_AUTHORITY_SCHEMA,
  HELIX_ENVIRONMENT_ACTION_CONTROL_REQUEST_SCHEMA,
  HELIX_ENVIRONMENT_ACTION_CONTROL_ENGINES,
  helixEnvironmentActionAuthoritySchema,
  helixEnvironmentActionConnectorReadinessSchema,
  helixEnvironmentActionControlRequestSchema,
  type HelixEnvironmentActionAuthority,
  type HelixEnvironmentActionAutonomyMode,
  type HelixEnvironmentActionConnectorReadiness,
  type HelixEnvironmentActionControlRequest,
  type HelixEnvironmentActionManualOverridePolicy,
} from "@shared/helix-environment-action";
import { readSharedRealtimeRoomMembership } from "../../helix-ask/realtime-room/room-store";
import {
  readSharedRealtimeRoomDatabase,
  withSharedRealtimeRoomTransaction,
} from "../../helix-ask/realtime-room/room-store/database";
import type { Queryable } from "../../helix-ask/realtime-room/room-store/types";
import { resolveEnvironmentActionAdapterProfile } from "../../situation-room/environment-action-adapter-registry";
import { requestDesktopMcpTunnelReadOnlyForSafety } from
  "../../local-supervisor/desktop-mcp-tunnel-safety";

export type EnvironmentActionAuthorityErrorCode =
  | "action_authority_forbidden"
  | "action_environment_not_found"
  | "action_environment_not_active"
  | "action_environment_binding_inactive"
  | "action_source_binding_inactive"
  | "action_room_closed"
  | "action_adapter_admission_inactive"
  | "action_participant_not_found"
  | "action_subject_binding_required"
  | "action_authority_not_found"
  | "action_authority_expiry_invalid"
  | "action_control_invalid";

export class EnvironmentActionAuthorityError extends Error {
  constructor(
    readonly code: EnvironmentActionAuthorityErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "EnvironmentActionAuthorityError";
  }
}

export const isEnvironmentActionAuthorityError = (
  error: unknown,
): error is EnvironmentActionAuthorityError =>
  error instanceof EnvironmentActionAuthorityError;

type EnvironmentRow = {
  environment_binding_id: string;
  room_source_binding_id: string;
  owner_profile_id: string;
  room_id: string;
  source_id: string;
  world_id: string;
  environment_status: string;
  source_status: string;
  room_status: string;
  adapter_profile_id: string;
  domain_adapter: string;
  adapter_admission_status: string;
};

type EnvironmentActionLifecycleRequirement = "active" | "authority_reduction";

export const assertEnvironmentActionLifecycle = (
  row: Pick<
    EnvironmentRow,
    | "environment_status"
    | "source_status"
    | "room_status"
    | "adapter_admission_status"
  >,
  requirement: EnvironmentActionLifecycleRequirement,
): void => {
  // An exact owner must be able to remove authority even after the producer
  // goes stale. Connector liveness is an admission requirement, not a veto on
  // emergency stop/revocation.
  if (requirement === "authority_reduction") return;
  if (row.environment_status !== "active") {
    throw new EnvironmentActionAuthorityError(
      "action_environment_binding_inactive",
      409,
      "The exact environment binding is not active enough to pair player embodiment.",
    );
  }
  if (row.source_status !== "active") {
    throw new EnvironmentActionAuthorityError(
      "action_source_binding_inactive",
      409,
      "The exact room source binding is not active enough to pair player embodiment.",
    );
  }
  if (row.room_status === "closed") {
    throw new EnvironmentActionAuthorityError(
      "action_room_closed",
      409,
      "The shared room is closed, so player embodiment cannot be paired.",
    );
  }
  if (row.adapter_admission_status !== "active") {
    throw new EnvironmentActionAuthorityError(
      "action_adapter_admission_inactive",
      409,
      "The exact environment adapter admission is not active enough to pair player embodiment.",
    );
  }
};

type AuthorityRow = {
  action_authority_id: string;
  environment_binding_id: string;
  room_source_binding_id: string;
  owner_profile_id: string;
  room_id: string;
  source_id: string;
  world_id: string;
  adapter_profile_id: string;
  domain_adapter: string;
  participant_id: string;
  subject_binding_id: string;
  subject_native_id: string;
  allowed_capability_ids: unknown;
  autonomy_mode: HelixEnvironmentActionAutonomyMode;
  manual_override_policy: HelixEnvironmentActionManualOverridePolicy;
  policy_version: number | string;
  status: "active" | "suspended" | "revoked" | "expired";
  created_at: Date | string;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
};

type ConnectorReadinessManifestRow = {
  manifest_id: string;
  manifest_hash: string;
  capabilities: unknown;
  available_control_engines: unknown;
  received_at: Date | string;
};

type ConnectorReadinessHeartbeatRow = {
  status: "active" | "degraded" | "paused" | "stale" | "error";
  active_workflow_ids: unknown;
  control_engines: unknown;
  controls_asserted: boolean;
  manual_input_detected: boolean;
  emergency_stop_latched: boolean;
  received_at: Date | string;
};

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  );
};
const sha256 = (value: unknown): string =>
  `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(stable(value)), "utf8")
    .digest("hex")}`;

const parseCapabilities = (value: unknown): string[] => {
  const parsed = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return [];
        }
      })()
    : value;
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string =>
        typeof entry === "string" && entry.length > 0 && entry.length <= 320)
    : [];
};

const parseJsonValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const countJsonArray = (value: unknown, maximum: number): number => {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? Math.min(parsed.length, maximum) : 0;
};

const EVENT_STREAM_RESYNC_TRANSPORT_ERROR =
  "action_delivery_environment_event_batch_http_409_action_event_conflict";

const readConnectorBlockingReason = (value: unknown): string | null => {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const lastError = (entry as Record<string, unknown>).last_error;
    if (lastError === EVENT_STREAM_RESYNC_TRANSPORT_ERROR) {
      return "event_stream_resync_required";
    }
  }
  return null;
};

const parseAvailableControlEngines = (
  value: unknown,
): HelixEnvironmentActionConnectorReadiness["available_control_engines"] => {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  const allowed = new Set<string>(HELIX_ENVIRONMENT_ACTION_CONTROL_ENGINES);
  return [...new Set(parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    return candidate.available === true &&
        typeof candidate.control_engine === "string" &&
        allowed.has(candidate.control_engine)
      ? [candidate.control_engine]
      : [];
  }))].sort() as HelixEnvironmentActionConnectorReadiness[
    "available_control_engines"
  ];
};

const projectAuthority = (row: AuthorityRow): HelixEnvironmentActionAuthority =>
  helixEnvironmentActionAuthoritySchema.parse({
    schema: HELIX_ENVIRONMENT_ACTION_AUTHORITY_SCHEMA,
    action_authority_id: row.action_authority_id,
    environment_binding_id: row.environment_binding_id,
    room_source_binding_id: row.room_source_binding_id,
    room_id: row.room_id,
    source_id: row.source_id,
    world_id: row.world_id,
    adapter_profile_id: row.adapter_profile_id,
    domain_adapter: row.domain_adapter,
    participant_id: row.participant_id,
    subject_binding_id: row.subject_binding_id,
    allowed_capability_ids: parseCapabilities(row.allowed_capability_ids),
    autonomy_mode: row.autonomy_mode,
    manual_override_policy: row.manual_override_policy,
    status:
      row.status === "active" &&
      row.expires_at !== null &&
      Date.parse(iso(row.expires_at)) <= Date.now()
        ? "expired"
        : row.status,
    policy_version: Number(row.policy_version),
    issued_at: iso(row.created_at),
    expires_at: isoOrNull(row.expires_at),
    revoked_at: isoOrNull(row.revoked_at),
    credential_included: false,
    content_role: "environment_action_authority_not_assistant_answer",
    answer_authority: false,
    assistant_answer: false,
    terminal_eligible: false,
    raw_content_included: false,
  });

export const projectEnvironmentActionConnectorReadiness = (input: {
  authority: HelixEnvironmentActionAuthority;
  heartbeatMaxAgeMs: number;
  manifest: {
    receivedAt: string;
    declaredCapabilityCount: number;
    availableControlEngines: HelixEnvironmentActionConnectorReadiness[
      "available_control_engines"
    ];
  } | null;
  heartbeat: {
    status: NonNullable<
      HelixEnvironmentActionConnectorReadiness["heartbeat_status"]
    >;
    receivedAt: string;
    activeWorkflowCount: number;
    controlsAsserted: boolean;
    manualInputDetected: boolean;
    emergencyStopLatched: boolean;
    blockingReason: string | null;
  } | null;
  nowMs?: number;
}): HelixEnvironmentActionConnectorReadiness => {
  const authorityActive = input.authority.status === "active";
  const manifestAdmitted = authorityActive && input.manifest !== null;
  const heartbeat = manifestAdmitted ? input.heartbeat : null;
  const heartbeatAgeMs = heartbeat
    ? (input.nowMs ?? Date.now()) - Date.parse(heartbeat.receivedAt)
    : Number.POSITIVE_INFINITY;
  const heartbeatFresh = heartbeat !== null &&
    Number.isFinite(heartbeatAgeMs) &&
    heartbeatAgeMs <= input.heartbeatMaxAgeMs;

  const state: HelixEnvironmentActionConnectorReadiness["state"] =
    !authorityActive
      ? "authority_inactive"
      : !input.manifest
        ? "awaiting_manifest"
        : !heartbeat
          ? "awaiting_heartbeat"
          : heartbeat.emergencyStopLatched
            ? "emergency_stopped"
            : !heartbeatFresh || heartbeat.status === "stale"
              ? "stale"
              : heartbeat.status === "active"
                ? "ready"
                : heartbeat.status;

  return helixEnvironmentActionConnectorReadinessSchema.parse({
    schema: HELIX_ENVIRONMENT_ACTION_CONNECTOR_READINESS_SCHEMA,
    action_authority_id: input.authority.action_authority_id,
    state,
    ready_for_actions: state === "ready",
    manifest_admitted: manifestAdmitted,
    manifest_received_at: manifestAdmitted
      ? input.manifest?.receivedAt ?? null
      : null,
    declared_capability_count: manifestAdmitted
      ? input.manifest?.declaredCapabilityCount ?? 0
      : 0,
    available_control_engines: manifestAdmitted
      ? input.manifest?.availableControlEngines ?? []
      : [],
    heartbeat_status: heartbeat?.status ?? null,
    heartbeat_fresh: heartbeatFresh,
    heartbeat_received_at: heartbeat?.receivedAt ?? null,
    heartbeat_max_age_ms: input.heartbeatMaxAgeMs,
    active_workflow_count: heartbeat?.activeWorkflowCount ?? 0,
    controls_asserted: heartbeat?.controlsAsserted ?? false,
    manual_input_detected: heartbeat?.manualInputDetected ?? false,
    emergency_stop_latched: heartbeat?.emergencyStopLatched ?? false,
    blocking_reason: heartbeat?.blockingReason ?? null,
    credential_included: false,
    content_role:
      "environment_action_connector_readiness_not_assistant_answer",
    answer_authority: false,
    assistant_answer: false,
    terminal_eligible: false,
    raw_content_included: false,
  });
};

const requireMembership = async (input: {
  roomId: string;
  profileId: string;
  owner?: boolean;
}) => {
  const membership = await readSharedRealtimeRoomMembership({
    roomId: input.roomId,
    profileId: input.profileId,
  });
  if (!membership || (input.owner && membership.role !== "owner")) {
    throw new EnvironmentActionAuthorityError(
      "action_authority_forbidden",
      404,
      "Player-action settings are unavailable to this account.",
    );
  }
  return membership;
};

const readEnvironment = async (
  db: Queryable,
  roomId: string,
  environmentBindingId: string,
  lock = false,
  lifecycleRequirement: EnvironmentActionLifecycleRequirement = "active",
): Promise<EnvironmentRow> => {
  const result = await db.query<EnvironmentRow>(
    `
      SELECT
        b.environment_binding_id, b.room_source_binding_id,
        b.owner_profile_id, b.room_id, b.source_id, b.world_id,
        b.status AS environment_status, rs.status AS source_status,
        r.status AS room_status, a.adapter_profile_id,
        a.status AS adapter_admission_status
      FROM helix_environment_connector_bindings b
      JOIN helix_room_source_bindings rs
        ON rs.binding_id = b.room_source_binding_id
      JOIN helix_shared_realtime_rooms r ON r.room_id = b.room_id
      JOIN helix_environment_adapter_admissions a
        ON a.admission_id = b.adapter_admission_id
      WHERE b.room_id = $1 AND b.environment_binding_id = $2
      LIMIT 1
      ${lock ? "FOR UPDATE" : ""};
    `,
    [roomId, environmentBindingId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new EnvironmentActionAuthorityError(
      "action_environment_not_found",
      404,
      "The room environment was not found.",
    );
  }
  assertEnvironmentActionLifecycle(row, lifecycleRequirement);
  return row;
};

const readActiveAuthorities = async (
  db: Queryable,
  environmentBindingId: string,
): Promise<AuthorityRow[]> => {
  const result = await db.query<AuthorityRow>(
    `
      SELECT * FROM helix_environment_action_authorities
      WHERE environment_binding_id = $1 AND status = 'active'
      ORDER BY policy_version DESC, created_at DESC, participant_id;
    `,
    [environmentBindingId],
  );
  return result.rows;
};

export const planEnvironmentActionAuthoritySupersession = (
  rows: Array<Pick<
    AuthorityRow,
    "action_authority_id" | "policy_version" | "created_at"
  >>,
): {
  nextPolicyVersion: number;
  supersededAuthorityIds: string[];
  canonicalPriorAuthorityId: string | null;
} => {
  const ordered = [...rows].sort((left, right) => {
    const versionDelta = Number(right.policy_version) - Number(left.policy_version);
    if (versionDelta !== 0) return versionDelta;
    const createdDelta = Date.parse(String(right.created_at)) -
      Date.parse(String(left.created_at));
    if (Number.isFinite(createdDelta) && createdDelta !== 0) return createdDelta;
    return right.action_authority_id.localeCompare(left.action_authority_id);
  });
  const highestPolicyVersion = ordered.reduce(
    (highest, row) => Math.max(highest, Number(row.policy_version) || 0),
    0,
  );
  return {
    nextPolicyVersion: highestPolicyVersion + 1,
    supersededAuthorityIds: ordered.map((row) => row.action_authority_id),
    canonicalPriorAuthorityId: ordered[0]?.action_authority_id ?? null,
  };
};

export const isEnvironmentActionAuthorityLeaseExtension = (input: {
  prior: Pick<
    AuthorityRow,
    | "adapter_profile_id"
    | "domain_adapter"
    | "participant_id"
    | "subject_binding_id"
    | "subject_native_id"
    | "allowed_capability_ids"
    | "autonomy_mode"
    | "manual_override_policy"
    | "expires_at"
  >;
  adapterProfileId: string;
  domainAdapter: string;
  participantId: string;
  subjectBindingId: string;
  subjectNativeId: string;
  allowedCapabilityIds: string[];
  autonomyMode: HelixEnvironmentActionAutonomyMode;
  manualOverridePolicy: HelixEnvironmentActionManualOverridePolicy;
  expiresAt: string | null;
}): boolean => {
  const priorExpiry = input.prior.expires_at === null
    ? Number.NaN
    : Date.parse(iso(input.prior.expires_at));
  const nextExpiry = input.expiresAt === null
    ? Number.NaN
    : Date.parse(input.expiresAt);
  const priorCapabilities = parseCapabilities(
    input.prior.allowed_capability_ids,
  ).sort();
  const nextCapabilities = [...new Set(input.allowedCapabilityIds)].sort();
  return (
    Number.isFinite(priorExpiry) &&
    Number.isFinite(nextExpiry) &&
    nextExpiry >= priorExpiry &&
    input.prior.adapter_profile_id === input.adapterProfileId &&
    input.prior.domain_adapter === input.domainAdapter &&
    input.prior.participant_id === input.participantId &&
    input.prior.subject_binding_id === input.subjectBindingId &&
    input.prior.subject_native_id === input.subjectNativeId &&
    input.prior.autonomy_mode === input.autonomyMode &&
    input.prior.manual_override_policy === input.manualOverridePolicy &&
    priorCapabilities.length === nextCapabilities.length &&
    priorCapabilities.every(
      (capabilityId, index) => capabilityId === nextCapabilities[index],
    )
  );
};

export const readEnvironmentActionAuthorities = async (input: {
  roomId: string;
  profileId: string;
  environmentBindingId: string;
}): Promise<HelixEnvironmentActionAuthority[]> => {
  const membership = await requireMembership(input);
  const db = await readSharedRealtimeRoomDatabase();
  await readEnvironment(db, input.roomId, input.environmentBindingId);
  const rows = await readActiveAuthorities(db, input.environmentBindingId);
  return rows
    .filter((row) =>
      membership.role === "owner" || row.participant_id === membership.participantId)
    .map(projectAuthority);
};

export const readEnvironmentActionConnectorReadiness = async (input: {
  roomId: string;
  profileId: string;
  environmentBindingId: string;
}): Promise<HelixEnvironmentActionConnectorReadiness[]> => {
  const membership = await requireMembership(input);
  const db = await readSharedRealtimeRoomDatabase();
  const environment = await readEnvironment(
    db,
    input.roomId,
    input.environmentBindingId,
  );
  const rows = (await readActiveAuthorities(db, input.environmentBindingId))
    .filter((row) =>
      membership.role === "owner" || row.participant_id === membership.participantId
    );

  return Promise.all(rows.map(async (row) => {
    const authority = projectAuthority(row);
    const registry = resolveEnvironmentActionAdapterProfile({
      domainAdapter: row.domain_adapter,
      worldId: row.world_id,
      sourceAdapterProfileId: environment.adapter_profile_id,
    });
    const manifestResult = await db.query<ConnectorReadinessManifestRow>(
      `SELECT manifest_id, manifest_hash, capabilities,
              available_control_engines, received_at
       FROM helix_environment_action_connector_manifests m
       WHERE action_authority_id = $1 AND status = 'active'
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY received_at DESC LIMIT 1;`,
      [row.action_authority_id],
    );
    const candidateManifest = manifestResult.rows[0] ?? null;
    const catalogResult = candidateManifest
      ? await db.query<{ catalog_snapshot_id: string }>(
        `SELECT catalog_snapshot_id
         FROM helix_environment_capability_catalog_snapshots
         WHERE environment_binding_id = $1 AND adapter_profile_id = $2
           AND manifest_hash = $3
           AND (expires_at IS NULL OR expires_at > now())
         ORDER BY frozen_at DESC LIMIT 1;`,
        [
          row.environment_binding_id,
          row.adapter_profile_id,
          candidateManifest.manifest_hash,
        ],
      )
      : { rows: [] as Array<{ catalog_snapshot_id: string }> };
    const manifest = catalogResult.rows[0] ? candidateManifest : null;
    const heartbeatResult = manifest
      ? await db.query<ConnectorReadinessHeartbeatRow>(
        `SELECT status, active_workflow_ids, control_engines, controls_asserted,
                manual_input_detected, emergency_stop_latched, received_at
         FROM helix_environment_action_connector_heartbeats
         WHERE action_authority_id = $1 AND manifest_id = $2
         ORDER BY received_at DESC LIMIT 1;`,
        [row.action_authority_id, manifest.manifest_id],
      )
      : { rows: [] as ConnectorReadinessHeartbeatRow[] };
    const heartbeat = heartbeatResult.rows[0] ?? null;

    return projectEnvironmentActionConnectorReadiness({
      authority,
      heartbeatMaxAgeMs: registry.profile.freshness.heartbeat_max_age_ms,
      manifest: manifest
        ? {
          receivedAt: iso(manifest.received_at),
          declaredCapabilityCount: countJsonArray(manifest.capabilities, 128),
          availableControlEngines: parseAvailableControlEngines(
            manifest.available_control_engines,
          ),
        }
        : null,
      heartbeat: heartbeat
        ? {
          status: heartbeat.status,
          receivedAt: iso(heartbeat.received_at),
          activeWorkflowCount: countJsonArray(
            heartbeat.active_workflow_ids,
            128,
          ),
          controlsAsserted: heartbeat.controls_asserted,
          manualInputDetected: heartbeat.manual_input_detected,
          emergencyStopLatched: heartbeat.emergency_stop_latched,
          blockingReason: readConnectorBlockingReason(heartbeat.control_engines),
        }
        : null,
    });
  }));
};

export const configureEnvironmentActionAuthority = async (input: {
  roomId: string;
  ownerProfileId: string;
  environmentBindingId: string;
  participantId: string;
  domainAdapter: string;
  allowedCapabilityIds: string[];
  autonomyMode: HelixEnvironmentActionAutonomyMode;
  manualOverridePolicy: HelixEnvironmentActionManualOverridePolicy;
  expiresAt: string | null;
}): Promise<HelixEnvironmentActionAuthority> => {
  await requireMembership({
    roomId: input.roomId,
    profileId: input.ownerProfileId,
    owner: true,
  });
  if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
    throw new EnvironmentActionAuthorityError(
      "action_authority_expiry_invalid",
      400,
      "Player-action authority expiry must be in the future.",
    );
  }
  return withSharedRealtimeRoomTransaction(async (db) => {
    const environment = await readEnvironment(
      db,
      input.roomId,
      input.environmentBindingId,
      true,
    );
    if (environment.owner_profile_id !== input.ownerProfileId) {
      throw new EnvironmentActionAuthorityError(
        "action_authority_forbidden",
        404,
        "Only the environment owner may configure player-action authority.",
      );
    }
    const actionAdapter = resolveEnvironmentActionAdapterProfile({
      domainAdapter: input.domainAdapter,
      worldId: environment.world_id,
      sourceAdapterProfileId: environment.adapter_profile_id,
    });
    const profileCapabilities = new Set(
      actionAdapter.profile.capabilities.map((capability) => capability.capability_id),
    );
    if (input.allowedCapabilityIds.some((capabilityId) => !profileCapabilities.has(capabilityId))) {
      throw new EnvironmentActionAuthorityError(
        "action_authority_forbidden",
        400,
        "Player-action authority may include only capabilities registered for this action adapter.",
      );
    }
    const participant = await db.query<{ participant_id: string }>(
      `
        SELECT participant_id FROM helix_shared_realtime_room_members
        WHERE room_id = $1 AND participant_id = $2 AND presence <> 'left'
        LIMIT 1;
      `,
      [input.roomId, input.participantId],
    );
    if (!participant.rows[0]) {
      throw new EnvironmentActionAuthorityError(
        "action_participant_not_found",
        404,
        "The selected room participant is not active.",
      );
    }
    const subject = await db.query<{
      subject_binding_id: string;
      subject_native_id: string;
    }>(
      `
        SELECT subject_binding_id, subject_native_id
        FROM helix_room_environment_subject_bindings
        WHERE room_id = $1 AND environment_binding_id = $2
          AND participant_id = $3 AND status = 'active'
        LIMIT 1 FOR UPDATE;
      `,
      [input.roomId, input.environmentBindingId, input.participantId],
    );
    if (!subject.rows[0]) {
      throw new EnvironmentActionAuthorityError(
        "action_subject_binding_required",
        409,
        "Select and verify this participant's Minecraft player before enabling player embodiment.",
      );
    }
    const prior = await db.query<AuthorityRow>(
      `
        SELECT * FROM helix_environment_action_authorities
        WHERE environment_binding_id = $1 AND participant_id = $2
          AND status = 'active'
        ORDER BY policy_version DESC, created_at DESC
        FOR UPDATE;
      `,
      [
        input.environmentBindingId,
        input.participantId,
      ],
    );
    const solePrior = prior.rows.length === 1 ? prior.rows[0] : null;
    if (
      solePrior &&
      isEnvironmentActionAuthorityLeaseExtension({
        prior: solePrior,
        adapterProfileId: actionAdapter.profile.profile_id,
        domainAdapter: input.domainAdapter,
        participantId: input.participantId,
        subjectBindingId: subject.rows[0].subject_binding_id,
        subjectNativeId: subject.rows[0].subject_native_id,
        allowedCapabilityIds: input.allowedCapabilityIds,
        autonomyMode: input.autonomyMode,
        manualOverridePolicy: input.manualOverridePolicy,
        expiresAt: input.expiresAt,
      })
    ) {
      const extended = await db.query<AuthorityRow>(
        `UPDATE helix_environment_action_authorities
         SET expires_at = $2, updated_at = now()
         WHERE action_authority_id = $1 AND status = 'active'
         RETURNING *;`,
        [solePrior.action_authority_id, input.expiresAt],
      );
      if (!extended.rows[0]) {
        throw new Error("Player-action authority lease extension failed.");
      }
      return projectAuthority(extended.rows[0]);
    }
    const supersession = planEnvironmentActionAuthoritySupersession(prior.rows);
    const policyVersion = supersession.nextPolicyVersion;
    for (const priorId of supersession.supersededAuthorityIds) {
      await db.query(
        `UPDATE helix_environment_action_authorities
         SET status = 'revoked', revoked_at = now(), updated_at = now()
         WHERE action_authority_id = $1;`,
        [priorId],
      );
      await db.query(
        `UPDATE helix_environment_action_connector_credentials
         SET status = 'revoked', revoked_at = now()
         WHERE action_authority_id = $1 AND status = 'active';`,
        [priorId],
      );
      await db.query(
        `UPDATE helix_environment_action_connector_manifests
         SET status = 'revoked'
         WHERE action_authority_id = $1 AND status = 'active';`,
        [priorId],
      );
      await db.query(
        `UPDATE helix_environment_action_requests
         SET status = 'authority_stale', cancellation_reason = 'authority_reconfigured',
             updated_at = now(), completed_at = now()
         WHERE action_authority_id = $1
           AND status IN ('queued', 'admitted', 'leased', 'running',
             'paused_manual_override', 'cancel_requested');`,
        [priorId],
      );
    }
    const authorityId = `environment_action_authority:${crypto.randomUUID()}`;
    await db.query(
      `
        INSERT INTO helix_environment_action_authorities (
          action_authority_id, environment_binding_id, room_source_binding_id,
          owner_profile_id, room_id, source_id, world_id, adapter_profile_id,
          domain_adapter, participant_id, subject_binding_id, subject_native_id,
          allowed_capability_ids, autonomy_mode, manual_override_policy,
          policy_version, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          $13::jsonb, $14, $15, $16, $17
        );
      `,
      [
        authorityId,
        environment.environment_binding_id,
        environment.room_source_binding_id,
        input.ownerProfileId,
        input.roomId,
        environment.source_id,
        environment.world_id,
        actionAdapter.profile.profile_id,
        input.domainAdapter,
        input.participantId,
        subject.rows[0].subject_binding_id,
        subject.rows[0].subject_native_id,
        JSON.stringify([...new Set(input.allowedCapabilityIds)].sort()),
        input.autonomyMode,
        input.manualOverridePolicy,
        policyVersion,
        input.expiresAt,
      ],
    );
    const inserted = await db.query<AuthorityRow>(
      `SELECT * FROM helix_environment_action_authorities
       WHERE action_authority_id = $1 LIMIT 1;`,
      [authorityId],
    );
    if (!inserted.rows[0]) {
      throw new Error("Player-action authority failed to materialize.");
    }
    return projectAuthority(inserted.rows[0]);
  });
};

/** Apply only to an owner-scoped, identity-verified authority record. A
 * transport error, unknown identity or invalid timestamp is not new consent. */
export const environmentActionAuthorityRequiresNewGrant = (authority: {
  status: string; expires_at: Date | string | null;
}, nowMs = Date.now()): boolean => {
  if (!Number.isFinite(nowMs)) return false;
  if (authority.status === "revoked" || authority.status === "expired") return true;
  const expiry = authority.expires_at === null ? NaN : new Date(authority.expires_at).getTime();
  return authority.status === "active" && Number.isFinite(expiry) && expiry <= nowMs;
};

export const extendEnvironmentActionAuthorityLease = async (input: {
  roomId: string;
  ownerProfileId: string;
  environmentBindingId: string;
  actionAuthorityId: string;
  expiresAt: string;
}): Promise<HelixEnvironmentActionAuthority> => {
  await requireMembership({
    roomId: input.roomId,
    profileId: input.ownerProfileId,
    owner: true,
  });
  const requestedExpiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(requestedExpiry) || requestedExpiry <= Date.now()) {
    throw new EnvironmentActionAuthorityError(
      "action_authority_expiry_invalid",
      400,
      "Player-action authority expiry must be in the future.",
    );
  }
  return withSharedRealtimeRoomTransaction(async (db) => {
    const selected = await db.query<AuthorityRow>(
      `SELECT * FROM helix_environment_action_authorities
        WHERE action_authority_id = $1 AND environment_binding_id = $2
          AND room_id = $3 AND owner_profile_id = $4 AND status = 'active'
        LIMIT 1 FOR UPDATE;`,
      [
        input.actionAuthorityId,
        input.environmentBindingId,
        input.roomId,
        input.ownerProfileId,
      ],
    );
    const authority = selected.rows[0];
    if (!authority) {
      throw new EnvironmentActionAuthorityError(
        "action_authority_not_found",
        404,
        "The exact active player-action authority was not found for this owner and environment.",
      );
    }
    // Stored status can remain active after its finite consent has elapsed.
    // An extension is not a new grant and must never resurrect that consent.
    const priorExpiry = authority.expires_at === null
      ? null
      : new Date(authority.expires_at).getTime();
    if (
      requestedExpiry <= Date.now() ||
      environmentActionAuthorityRequiresNewGrant(authority) ||
      (priorExpiry !== null &&
        !Number.isFinite(priorExpiry))
    ) {
      throw new EnvironmentActionAuthorityError(
        "action_authority_expiry_invalid",
        409,
        "Expired player-action authority requires a new explicit grant, not lease extension.",
      );
    }
    const extended = await db.query<AuthorityRow>(
      `UPDATE helix_environment_action_authorities
          SET expires_at = $2, updated_at = now()
        WHERE action_authority_id = $1 AND status = 'active'
          AND (expires_at IS NULL OR expires_at > clock_timestamp())
          AND $2::timestamptz > clock_timestamp()
        RETURNING *;`,
      [input.actionAuthorityId, input.expiresAt],
    );
    if (!extended.rows[0]) {
      throw new EnvironmentActionAuthorityError(
        "action_authority_expiry_invalid",
        409,
        "Player-action authority expired before the lease could be extended.",
      );
    }
    await db.query(
      `UPDATE helix_environment_action_connector_credentials
          SET expires_at = $2
        WHERE action_authority_id = $1 AND status = 'active'
          AND (expires_at IS NULL OR expires_at > clock_timestamp());`,
      [input.actionAuthorityId, input.expiresAt],
    );
    return projectAuthority(extended.rows[0]);
  });
};

export const requestEnvironmentActionWorkflowControl = async (input: {
  roomId: string;
  profileId: string;
  environmentBindingId: string;
  actionAuthorityId: string;
  workflowId: string;
  controlKind: "status" | "resume" | "cancel";
  reason: string;
}): Promise<HelixEnvironmentActionControlRequest> => {
  const membership = await requireMembership({
    roomId: input.roomId,
    profileId: input.profileId,
  });
  return withSharedRealtimeRoomTransaction(async (db) => {
    await readEnvironment(db, input.roomId, input.environmentBindingId, true);
    const selected = await db.query<AuthorityRow>(
      `SELECT * FROM helix_environment_action_authorities
       WHERE action_authority_id = $1 AND environment_binding_id = $2
         AND room_id = $3 AND status IN ('active', 'suspended')
       LIMIT 1 FOR UPDATE;`,
      [input.actionAuthorityId, input.environmentBindingId, input.roomId],
    );
    const authority = selected.rows[0];
    if (!authority) {
      throw new EnvironmentActionAuthorityError(
        "action_authority_not_found",
        404,
        "Player-action authority was not found.",
      );
    }
    if (
      membership.role !== "owner" &&
      membership.participantId !== authority.participant_id
    ) {
      throw new EnvironmentActionAuthorityError(
        "action_authority_forbidden",
        404,
        "Only the room owner or paired player may control this workflow.",
      );
    }
    if (authority.status !== "active") {
      throw new EnvironmentActionAuthorityError(
        "action_control_invalid",
        409,
        "This player-action authority is suspended; configure a new authority before ordinary workflow controls are used.",
      );
    }
    const workflow = await db.query<{ workflow_id: string; status: string }>(
      `SELECT workflow_id, status
       FROM helix_environment_action_requests
       WHERE action_authority_id = $1 AND workflow_id = $2
       LIMIT 1 FOR UPDATE;`,
      [authority.action_authority_id, input.workflowId],
    );
    const workflowRow = workflow.rows[0];
    if (!workflowRow) {
      throw new EnvironmentActionAuthorityError(
        "action_control_invalid",
        404,
        "The exact player workflow was not found for this authority.",
      );
    }
    if (
      input.controlKind === "resume" &&
      (authority.manual_override_policy !== "pause" ||
        workflowRow.status !== "paused_manual_override")
    ) {
      throw new EnvironmentActionAuthorityError(
        "action_control_invalid",
        409,
        "Only a workflow paused by the configured manual-override policy may resume.",
      );
    }
    if (
      input.controlKind === "cancel" &&
      !canCancelEnvironmentActionWorkflowStatus(workflowRow.status)
    ) {
      throw new EnvironmentActionAuthorityError(
        "action_control_invalid",
        409,
        "Only an active or paused workflow may be canceled.",
      );
    }
    const existing = await db.query<{ request_payload: unknown }>(
      `SELECT request_payload
       FROM helix_environment_action_control_requests
       WHERE action_authority_id = $1 AND workflow_id = $2
         AND control_kind = $3 AND status IN ('pending', 'leased')
       ORDER BY created_at DESC LIMIT 1;`,
      [authority.action_authority_id, input.workflowId, input.controlKind],
    );
    if (existing.rows[0]) {
      const replay = helixEnvironmentActionControlRequestSchema.safeParse(
        typeof existing.rows[0].request_payload === "string"
          ? JSON.parse(existing.rows[0].request_payload)
          : existing.rows[0].request_payload,
      );
      if (replay.success) return replay.data;
    }
    const now = new Date();
    const controlRequest = helixEnvironmentActionControlRequestSchema.parse({
      schema: HELIX_ENVIRONMENT_ACTION_CONTROL_REQUEST_SCHEMA,
      control_request_id: `environment_action_control:${crypto.randomUUID()}`,
      control_kind: input.controlKind,
      action_authority_id: authority.action_authority_id,
      environment_binding_id: authority.environment_binding_id,
      room_id: authority.room_id,
      source_id: authority.source_id,
      world_id: authority.world_id,
      participant_id: authority.participant_id,
      subject_binding_id: authority.subject_binding_id,
      workflow_id: input.workflowId,
      reason:
        input.reason.trim().slice(0, 1_000) ||
        `Player workflow ${input.controlKind} requested.`,
      release_all_controls: input.controlKind === "cancel",
      created_at: now.toISOString(),
      deadline_at: new Date(now.getTime() + 30_000).toISOString(),
      answer_authority: false,
      assistant_answer: false,
      terminal_eligible: false,
      raw_content_included: false,
    });
    await db.query(
      `INSERT INTO helix_environment_action_control_requests (
         control_request_id, action_authority_id, workflow_id, control_kind,
         request_payload, request_hash, deadline_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7);`,
      [
        controlRequest.control_request_id,
        authority.action_authority_id,
        input.workflowId,
        input.controlKind,
        JSON.stringify(controlRequest),
        sha256(controlRequest),
        controlRequest.deadline_at,
      ],
    );
    if (input.controlKind === "cancel") {
      await db.query(
        `UPDATE helix_environment_action_requests
         SET status = 'cancel_requested', cancellation_reason = 'control_cancel_requested',
             updated_at = now()
         WHERE action_authority_id = $1 AND workflow_id = $2
           AND status IN ('admitted', 'leased', 'running',
             'paused_manual_override', 'cancel_requested');`,
        [authority.action_authority_id, input.workflowId],
      );
    }
    return controlRequest;
  });
};

export const canCancelEnvironmentActionWorkflowStatus = (
  status: string,
): boolean =>
  [
    "admitted",
    "leased",
    "running",
    "paused_manual_override",
    "cancel_requested",
    // The broker deadline is an observation boundary, not proof that the
    // connector released its local controls. Permit a release-only cancel so
    // a timed-out connector workflow can be reconciled without replaying it.
    "timed_out",
  ].includes(status);

export const emergencyStopEnvironmentActionAuthority = async (input: {
  roomId: string;
  profileId: string;
  environmentBindingId: string;
  actionAuthorityId: string;
  reason: string;
}): Promise<{
  authority: HelixEnvironmentActionAuthority;
  controlRequest: HelixEnvironmentActionControlRequest;
}> => {
  const membership = await requireMembership({
    roomId: input.roomId,
    profileId: input.profileId,
  });
  const stopped = await withSharedRealtimeRoomTransaction(async (db) => {
    await readEnvironment(
      db,
      input.roomId,
      input.environmentBindingId,
      true,
      "authority_reduction",
    );
    const selected = await db.query<AuthorityRow>(
      `SELECT * FROM helix_environment_action_authorities
       WHERE action_authority_id = $1 AND environment_binding_id = $2
         AND room_id = $3 AND status IN ('active', 'suspended')
       LIMIT 1 FOR UPDATE;`,
      [input.actionAuthorityId, input.environmentBindingId, input.roomId],
    );
    const authority = selected.rows[0];
    if (!authority) {
      throw new EnvironmentActionAuthorityError(
        "action_authority_not_found",
        404,
        "Player-action authority was not found.",
      );
    }
    if (
      membership.role !== "owner" &&
      membership.participantId !== authority.participant_id
    ) {
      throw new EnvironmentActionAuthorityError(
        "action_authority_forbidden",
        404,
        "Only the room owner or paired player may stop this authority.",
      );
    }
    if (authority.status === "suspended") {
      const pending = await db.query<{ control_request_id: string; deadline_at: Date | string; request_payload: unknown; request_hash: string }>(
        `SELECT control_request_id, deadline_at, request_payload, request_hash FROM helix_environment_action_control_requests
         WHERE action_authority_id=$1 AND workflow_id IS NULL AND control_kind='emergency_stop'
           AND status IN ('pending','leased') AND deadline_at>now()
         ORDER BY created_at DESC LIMIT 1;`, [authority.action_authority_id]);
      if (pending.rows[0]) {
        let replay: HelixEnvironmentActionControlRequest | null = null;
        try {
          replay = helixEnvironmentActionControlRequestSchema.parse(typeof pending.rows[0].request_payload === "string"
            ? JSON.parse(pending.rows[0].request_payload) : pending.rows[0].request_payload);
        } catch { /* Invalid retained controls cannot authorize a replacement. */ }
        if (!replay || sha256(replay) !== pending.rows[0].request_hash ||
            replay.control_request_id !== pending.rows[0].control_request_id ||
            Date.parse(replay.deadline_at) !== Date.parse(iso(pending.rows[0].deadline_at)) ||
            replay.control_kind !== "emergency_stop" || replay.workflow_id !== null || !replay.release_all_controls ||
            Date.parse(replay.deadline_at) <= Date.now() ||
            replay.action_authority_id !== authority.action_authority_id ||
            replay.environment_binding_id !== authority.environment_binding_id || replay.room_id !== authority.room_id ||
            replay.source_id !== authority.source_id || replay.world_id !== authority.world_id ||
            replay.participant_id !== authority.participant_id || replay.subject_binding_id !== authority.subject_binding_id) {
          throw new EnvironmentActionAuthorityError("action_control_invalid", 409,
            "The retained emergency-stop control does not match this exact authority.");
        }
        // The transaction's required snapshot still runs on this read-only retry.
        return { authority: projectAuthority(authority), controlRequest: replay };
      }
    }
    const now = new Date();
    const controlRequest = helixEnvironmentActionControlRequestSchema.parse({
      schema: HELIX_ENVIRONMENT_ACTION_CONTROL_REQUEST_SCHEMA,
      control_request_id: `environment_action_control:${crypto.randomUUID()}`,
      control_kind: "emergency_stop",
      action_authority_id: authority.action_authority_id,
      environment_binding_id: authority.environment_binding_id,
      room_id: authority.room_id,
      source_id: authority.source_id,
      world_id: authority.world_id,
      participant_id: authority.participant_id,
      subject_binding_id: authority.subject_binding_id,
      workflow_id: null,
      reason: input.reason.trim().slice(0, 1_000) || "Emergency stop requested.",
      release_all_controls: true,
      created_at: now.toISOString(),
      deadline_at: new Date(now.getTime() + 30_000).toISOString(),
      answer_authority: false,
      assistant_answer: false,
      terminal_eligible: false,
      raw_content_included: false,
    });
    await db.query(
      `UPDATE helix_environment_action_authorities
       SET status = 'suspended', updated_at = now()
       WHERE action_authority_id = $1;`,
      [authority.action_authority_id],
    );
    await db.query(
      `UPDATE helix_environment_action_requests
       SET status = 'emergency_stopped', cancellation_reason = 'emergency_stop',
           updated_at = now(), completed_at = now()
       WHERE action_authority_id = $1
         AND status IN ('queued', 'admitted', 'leased', 'running',
           'paused_manual_override', 'cancel_requested');`,
      [authority.action_authority_id],
    );
    await db.query(
      `INSERT INTO helix_environment_action_control_requests (
         control_request_id, action_authority_id, workflow_id, control_kind,
         request_payload, request_hash, deadline_at
       ) VALUES ($1, $2, NULL, 'emergency_stop', $3::jsonb, $4, $5)
       ON CONFLICT (control_request_id) DO NOTHING;`,
      [
        controlRequest.control_request_id,
        authority.action_authority_id,
        JSON.stringify(controlRequest),
        sha256(controlRequest),
        controlRequest.deadline_at,
      ],
    );
    return {
      authority: projectAuthority({ ...authority, status: "suspended" }),
      controlRequest,
    };
  }, { requireLocalSnapshot: true, snapshotTables: [
    "helix_environment_action_authorities", "helix_environment_action_requests",
    "helix_environment_action_control_requests",
  ] });
  void requestDesktopMcpTunnelReadOnlyForSafety(
    "environment_emergency_stop",
  ).catch(() => false);
  return stopped;
};
