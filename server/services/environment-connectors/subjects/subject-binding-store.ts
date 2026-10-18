import crypto from "node:crypto";
import {
  HELIX_ENVIRONMENT_SUBJECT_DIRECTORY_SCHEMA,
  HELIX_ROOM_ENVIRONMENT_PROJECTION_SCHEMA,
  HELIX_ROOM_ENVIRONMENT_SUBJECT_BINDING_SCHEMA,
  type HelixEnvironmentSubjectDirectory,
  type HelixEnvironmentSubjectVerificationMethod,
  type HelixRoomEnvironmentProjection,
  type HelixRoomEnvironmentSubjectBinding,
} from "@shared/helix-environment-subject";
import type { HelixEnvironmentSourceHeartbeat } from
  "@shared/helix-environment-source-manifest";
import {
  getEnvironmentSourceHeartbeatForServerIdentity,
  projectEnvironmentSourceHeartbeatStatus,
} from "../../situation-room/environment-source-heartbeat-store";
import {
  resolveEnvironmentAdapterProfile,
} from "../../situation-room/environment-adapter-registry";
import {
  readSharedRealtimeRoomMembership,
  type SharedRealtimeRoomMembership,
} from "../../helix-ask/realtime-room/room-store";
import {
  readSharedRealtimeRoomDatabase,
  withSharedRealtimeRoomTransaction,
} from "../../helix-ask/realtime-room/room-store/database";
import {
  assertAccessibleMember,
  assertOpenRoom,
  insertAuditEvent,
} from "../../helix-ask/realtime-room/room-store/repository";
import type { Queryable } from
  "../../helix-ask/realtime-room/room-store/types";

export type RoomEnvironmentSubjectErrorCode =
  | "environment_not_found"
  | "environment_not_ready"
  | "subject_directory_missing"
  | "subject_directory_stale"
  | "subject_not_found"
  | "subject_already_claimed"
  | "subject_binding_required"
  | "subject_binding_stale"
  | "subject_offline"
  | "wrong_environment"
  | "wrong_world"
  | "producer_epoch_mismatch"
  | "subject_binding_forbidden";

export class RoomEnvironmentSubjectError extends Error {
  constructor(
    readonly code: RoomEnvironmentSubjectErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "RoomEnvironmentSubjectError";
  }
}

export const isRoomEnvironmentSubjectError = (
  error: unknown,
): error is RoomEnvironmentSubjectError =>
  error instanceof RoomEnvironmentSubjectError;

type EnvironmentRow = {
  environment_binding_id: string;
  room_source_binding_id: string;
  room_id: string;
  source_id: string;
  world_id: string;
  owner_profile_id: string;
  environment_status: string;
  environment_updated_at: Date | string;
  domain_adapter: string;
  source_label: string;
  source_status: string;
  device_id: string;
  device_status: string;
  health_status: string;
  producer_epoch_ref: string | null;
  last_contact_at: Date | string | null;
  adapter_profile_id: string;
  adapter_admission_status: string;
};

type SourceBindingRow = {
  binding_id: string;
  room_id: string;
  source_id: string;
  world_id: string;
  domain_adapter: string;
  source_label: string;
  status: string;
  updated_at: Date | string;
};

type SubjectBindingRow = {
  subject_binding_id: string;
  room_id: string;
  participant_id: string;
  profile_id: string;
  environment_binding_id: string;
  room_source_binding_id: string;
  source_id: string;
  world_id: string;
  subject_kind: string;
  subject_ref: string;
  subject_native_id: string;
  subject_label: string;
  verification_method: HelixEnvironmentSubjectVerificationMethod;
  confidence: number | string;
  status: "active" | "stale" | "revoked";
  producer_epoch_ref: string;
  verified_at: Date | string;
  last_confirmed_at: Date | string;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
};

type NativeSubject = {
  subjectRef: string;
  subjectKind: string;
  nativeId: string;
  label: string;
};

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const subjectRefFor = (
  environmentBindingId: string,
  nativeId: string,
): string =>
  `environment_subject:${crypto
    .createHash("sha256")
    .update(`${environmentBindingId}\n${nativeId}`, "utf8")
    .digest("hex")
    .slice(0, 48)}`;

const pendingEnvironmentId = (roomSourceBindingId: string): string =>
  `environment_binding:pending:${crypto
    .createHash("sha256")
    .update(roomSourceBindingId, "utf8")
    .digest("hex")
    .slice(0, 40)}`;

/** Workstation startup only; a pending source is never an admitted environment. */
export const assertPendingFabricWorkstationSource = async (input: {
  roomId: string;
  profileId: string;
  environmentBindingId: string;
}): Promise<void> => {
  const db = await readSharedRealtimeRoomDatabase();
  // Read current ownership, room/source lifecycle and absence of a connector
  // together. The caller's pending ID is matched against stored source identity,
  // never admitted by prefix or by a cached client/environment projection.
  const { rows } = await db.query<{ binding_id: string }>(
    `SELECT rs.binding_id
     FROM helix_room_source_bindings rs
     JOIN helix_shared_realtime_rooms r ON r.room_id = rs.room_id
     JOIN helix_shared_realtime_room_members m ON m.room_id = r.room_id
     LEFT JOIN helix_environment_connector_bindings b
       ON b.room_source_binding_id = rs.binding_id
     WHERE r.room_id = $1 AND r.owner_profile_id = $2
       AND r.status <> 'closed' AND rs.owner_profile_id = $2
       AND m.profile_id = $2 AND m.member_role = 'owner' AND m.presence <> 'left'
       AND rs.status = 'active' AND rs.domain_adapter = 'minecraft.fabric_mod.v1'
       AND b.environment_binding_id IS NULL;`,
    [input.roomId, input.profileId],
  );
  if (!rows.some((row) => pendingEnvironmentId(row.binding_id) === input.environmentBindingId)) {
    throw new RoomEnvironmentSubjectError(
      "environment_not_ready", 409,
      "The exact pending Fabric source is not available to this room owner. Refresh environment status before starting the workstation lifecycle.",
    );
  }
};

/** Workstation startup only; this does not admit probes or player actions. */
export const assertExistingFabricWorkstationSource = async (input: {
  roomId: string;
  profileId: string;
  environmentBindingId: string;
}): Promise<void> => {
  const db = await readSharedRealtimeRoomDatabase();
  // A stale heartbeat, credential, or adapter admission is expected before the
  // workstation is restarted. Retain exact stored ownership and lifecycle
  // checks without making those gameplay-readiness signals a startup gate.
  const { rows } = await db.query<{ environment_binding_id: string }>(
    `SELECT b.environment_binding_id
     FROM helix_environment_connector_bindings b
     JOIN helix_room_source_bindings rs
       ON rs.binding_id = b.room_source_binding_id
     JOIN helix_shared_realtime_rooms r ON r.room_id = b.room_id
     JOIN helix_shared_realtime_room_members m ON m.room_id = r.room_id
     JOIN helix_environment_connector_devices d ON d.device_id = b.device_id
     JOIN helix_environment_connector_installations i
       ON i.installation_id = b.installation_id
     WHERE b.environment_binding_id = $1 AND b.room_id = $2
       AND b.owner_profile_id = $3 AND b.status = 'active'
       AND r.owner_profile_id = $3 AND r.status <> 'closed'
       AND rs.room_id = b.room_id AND rs.owner_profile_id = $3
       AND rs.source_id = b.source_id AND rs.status = 'active'
       AND rs.domain_adapter = 'minecraft.fabric_mod.v1'
       AND m.profile_id = $3 AND m.member_role = 'owner'
       AND m.presence <> 'left'
       AND d.installation_id = b.installation_id AND d.status = 'active'
       AND i.owner_profile_id = $3 AND i.status = 'active';`,
    [input.environmentBindingId, input.roomId, input.profileId],
  );
  if (rows.length !== 1) {
    throw new RoomEnvironmentSubjectError(
      "environment_not_ready", 409,
      "The exact Fabric source is not available to this room owner for workstation startup. Refresh environment status before retrying.",
    );
  }
};

const nativeSubjects = (input: {
  environmentBindingId: string;
  heartbeat: HelixEnvironmentSourceHeartbeat | null;
  subjectKind: string;
}): NativeSubject[] => {
  const seen = new Set<string>();
  return (input.heartbeat?.active_players ?? []).flatMap((player) => {
    const nativeId = player.stable_actor_id?.trim() || player.actor_id.trim();
    const label = player.actor_label.trim();
    if (!nativeId || !label || seen.has(nativeId)) return [];
    seen.add(nativeId);
    return [{
      subjectRef: subjectRefFor(input.environmentBindingId, nativeId),
      subjectKind: input.subjectKind,
      nativeId,
      label,
    }];
  });
};

const readEnvironmentRows = async (
  db: Queryable,
  roomId: string,
): Promise<EnvironmentRow[]> => {
  const result = await db.query<EnvironmentRow>(
    `
      SELECT
        b.environment_binding_id,
        b.room_source_binding_id,
        b.room_id,
        b.source_id,
        b.world_id,
        b.owner_profile_id,
        b.status AS environment_status,
        b.updated_at AS environment_updated_at,
        rs.domain_adapter,
        rs.source_label,
        rs.status AS source_status,
        d.device_id,
        d.status AS device_status,
        d.health_status,
        d.producer_epoch_ref,
        d.last_contact_at,
        a.adapter_profile_id,
        a.status AS adapter_admission_status
      FROM helix_environment_connector_bindings b
      JOIN helix_room_source_bindings rs
        ON rs.binding_id = b.room_source_binding_id
      JOIN helix_environment_connector_devices d
        ON d.device_id = b.device_id
      JOIN helix_environment_adapter_admissions a
        ON a.admission_id = b.adapter_admission_id
      WHERE b.room_id = $1
      ORDER BY b.updated_at DESC;
    `,
    [roomId],
  );
  const selected = new Map<string, EnvironmentRow>();
  for (const row of result.rows) {
    if (!selected.has(row.room_source_binding_id)) {
      selected.set(row.room_source_binding_id, row);
    }
  }
  return [...selected.values()];
};

const readSourceBindingRows = async (
  db: Queryable,
  roomId: string,
): Promise<SourceBindingRow[]> => {
  const result = await db.query<SourceBindingRow>(
    `
      SELECT
        binding_id,
        room_id,
        source_id,
        world_id,
        domain_adapter,
        source_label,
        status,
        updated_at
      FROM helix_room_source_bindings
      WHERE room_id = $1
        AND status <> 'revoked'
      ORDER BY created_at;
    `,
    [roomId],
  );
  return result.rows;
};

const readCapabilityIds = async (
  db: Queryable,
  environmentBindingId: string,
): Promise<string[]> => {
  const result = await db.query<{ capability_descriptors: unknown }>(
    `
      SELECT capability_descriptors
      FROM helix_environment_capability_catalog_snapshots
      WHERE environment_binding_id = $1
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY frozen_at DESC
      LIMIT 1;
    `,
    [environmentBindingId],
  );
  const raw = result.rows[0]?.capability_descriptors;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const capabilityId = (entry as Record<string, unknown>).capability_id;
    return typeof capabilityId === "string" && capabilityId.trim()
      ? [capabilityId.trim()]
      : [];
  });
};

const readSubjectBindingRows = async (
  db: Queryable,
  roomId: string,
): Promise<SubjectBindingRow[]> => {
  const result = await db.query<SubjectBindingRow>(
    `
      SELECT *
      FROM helix_room_environment_subject_bindings
      WHERE room_id = $1
        AND status <> 'revoked'
      ORDER BY updated_at DESC;
    `,
    [roomId],
  );
  return result.rows;
};

const projectBinding = (input: {
  row: SubjectBindingRow;
  currentProducerEpochRef: string | null;
  heartbeat: HelixEnvironmentSourceHeartbeat | null;
  heartbeatFresh: boolean;
}): HelixRoomEnvironmentSubjectBinding => {
  const currentSubject = nativeSubjects({
    environmentBindingId: input.row.environment_binding_id,
    heartbeat: input.heartbeat,
    subjectKind: input.row.subject_kind,
  }).find((subject) => subject.nativeId === input.row.subject_native_id);
  const subjectOnline = Boolean(currentSubject);
  const expired = input.row.expires_at
    ? Date.parse(iso(input.row.expires_at)) <= Date.now()
    : false;
  const stale =
    input.row.status === "stale" ||
    expired ||
    !input.heartbeatFresh ||
    !subjectOnline ||
    !input.currentProducerEpochRef ||
    input.row.producer_epoch_ref !== input.currentProducerEpochRef;
  return {
    schema: HELIX_ROOM_ENVIRONMENT_SUBJECT_BINDING_SCHEMA,
    subject_binding_id: input.row.subject_binding_id,
    room_id: input.row.room_id,
    participant_id: input.row.participant_id,
    environment_binding_id: input.row.environment_binding_id,
    room_source_binding_id: input.row.room_source_binding_id,
    source_id: input.row.source_id,
    world_id: input.row.world_id,
    subject_kind: input.row.subject_kind,
    subject_ref: input.row.subject_ref,
    subject_label: currentSubject?.label ?? input.row.subject_label,
    verification_method: input.row.verification_method,
    confidence: Number(input.row.confidence),
    status: stale ? "stale" : input.row.status,
    producer_epoch_ref: input.row.producer_epoch_ref,
    verified_at: iso(input.row.verified_at),
    last_confirmed_at: iso(input.row.last_confirmed_at),
    expires_at: input.row.expires_at ? iso(input.row.expires_at) : null,
    revoked_at: input.row.revoked_at ? iso(input.row.revoked_at) : null,
    content_role: "environment_subject_identity_not_assistant_answer",
    answer_authority: false,
    assistant_answer: false,
    terminal_eligible: false,
    raw_content_included: false,
  };
};

const heartbeatContext = (row: EnvironmentRow): {
  heartbeat: HelixEnvironmentSourceHeartbeat | null;
  heartbeatFresh: boolean;
  status: HelixRoomEnvironmentProjection["connection_status"];
  subjectKind: string;
} => {
  const heartbeat = getEnvironmentSourceHeartbeatForServerIdentity({
    sourceId: row.source_id,
    roomId: row.room_id,
    domainAdapter: row.domain_adapter,
  });
  let profile: ReturnType<typeof resolveEnvironmentAdapterProfile> | null = null;
  try {
    profile = resolveEnvironmentAdapterProfile({
      domainAdapter: row.domain_adapter,
      worldId: row.world_id,
    });
  } catch {
    profile = null;
  }
  const maxAge = profile?.profile.freshness.heartbeat_max_age_ms ?? 30_000;
  const age = heartbeat ? Date.now() - Date.parse(heartbeat.created_at) : Infinity;
  const heartbeatFresh = Number.isFinite(age) && age >= 0 && age <= maxAge;
  const projectedStatus = projectEnvironmentSourceHeartbeatStatus({ heartbeat });
  const status =
    row.source_status === "revoked" || row.environment_status === "revoked"
      ? "revoked"
      : row.device_status !== "active" ||
          row.adapter_admission_status !== "active"
        ? "error"
        : projectedStatus;
  return {
    heartbeat,
    heartbeatFresh,
    status,
    subjectKind:
      profile?.profile.subject_directory.subject_kind ??
      `${profile?.profile.domain ?? "environment"}.subject`,
  };
};

export const listRoomEnvironmentProjections = async (input: {
  roomId: string;
  profileId: string;
}): Promise<HelixRoomEnvironmentProjection[]> => {
  const membership = await readSharedRealtimeRoomMembership(input);
  if (!membership) {
    throw new RoomEnvironmentSubjectError(
      "subject_binding_forbidden",
      404,
      "The room environment is unavailable to this account.",
    );
  }
  const db = await readSharedRealtimeRoomDatabase();
  const [sources, environmentRows, subjectRows] = await Promise.all([
    readSourceBindingRows(db, input.roomId),
    readEnvironmentRows(db, input.roomId),
    readSubjectBindingRows(db, input.roomId),
  ]);
  const environmentBySourceBinding = new Map(
    environmentRows.map((row) => [row.room_source_binding_id, row]),
  );
  const projections: HelixRoomEnvironmentProjection[] = [];
  for (const source of sources) {
    const row = environmentBySourceBinding.get(source.binding_id);
    if (!row) {
      projections.push({
        schema: HELIX_ROOM_ENVIRONMENT_PROJECTION_SCHEMA,
        environment_binding_id: pendingEnvironmentId(source.binding_id),
        room_source_binding_id: source.binding_id,
        room_id: source.room_id,
        source_id: source.source_id,
        world_id: source.world_id,
        domain: "custom",
        domain_adapter: source.domain_adapter,
        source_label: source.source_label,
        connection_status: "missing",
        latest_observed_at: null,
        capability_ids: [],
        subject_directory: null,
        self_subject_binding: null,
        identity_assignment: "not_applicable",
        owner_controls_visible: membership.role === "owner",
        content_role: "room_environment_projection_not_assistant_answer",
        answer_authority: false,
        assistant_answer: false,
        terminal_eligible: false,
        raw_content_included: false,
      });
      continue;
    }
    const context = heartbeatContext(row);
    const native = nativeSubjects({
      environmentBindingId: row.environment_binding_id,
      heartbeat: context.heartbeat,
      subjectKind: context.subjectKind,
    });
    const bindings = subjectRows.filter(
      (binding) => binding.environment_binding_id === row.environment_binding_id,
    );
    const claimedByNativeId = new Map(
      bindings
        .filter((binding) => binding.status === "active")
        .map((binding) => [binding.subject_native_id, binding.participant_id]),
    );
    const selfRow = bindings.find(
      (binding) =>
        binding.participant_id === membership.participantId &&
        binding.status === "active",
    );
    const selfBinding = selfRow
      ? projectBinding({
          row: selfRow,
          currentProducerEpochRef: row.producer_epoch_ref,
          heartbeat: context.heartbeat,
          heartbeatFresh: context.heartbeatFresh,
        })
      : null;
    const directory: HelixEnvironmentSubjectDirectory = {
      schema: HELIX_ENVIRONMENT_SUBJECT_DIRECTORY_SCHEMA,
      environment_binding_id: row.environment_binding_id,
      room_source_binding_id: row.room_source_binding_id,
      room_id: row.room_id,
      source_id: row.source_id,
      world_id: row.world_id,
      subject_kind: context.subjectKind,
      observed_at: context.heartbeat?.created_at ?? null,
      freshness: context.heartbeat
        ? context.heartbeatFresh
          ? "fresh"
          : "stale"
        : "missing",
      subjects: native.map((subject) => ({
        subject_ref: subject.subjectRef,
        subject_kind: subject.subjectKind,
        display_label: subject.label,
        presence: context.heartbeatFresh ? "online" : "stale",
        claimed_by_participant_id:
          claimedByNativeId.get(subject.nativeId) ?? null,
        observed_at: context.heartbeat?.created_at ?? new Date(0).toISOString(),
        freshness: context.heartbeatFresh ? "fresh" : "stale",
        answer_authority: false,
        assistant_answer: false,
        terminal_eligible: false,
        raw_content_included: false,
      })),
      content_role: "environment_subject_directory_not_assistant_answer",
      answer_authority: false,
      assistant_answer: false,
      terminal_eligible: false,
      raw_content_included: false,
    };
    let domain = "custom";
    try {
      domain = resolveEnvironmentAdapterProfile({
        domainAdapter: row.domain_adapter,
        worldId: row.world_id,
      }).profile.domain;
    } catch {
      domain = "custom";
    }
    projections.push({
      schema: HELIX_ROOM_ENVIRONMENT_PROJECTION_SCHEMA,
      environment_binding_id: row.environment_binding_id,
      room_source_binding_id: row.room_source_binding_id,
      room_id: row.room_id,
      source_id: row.source_id,
      world_id: row.world_id,
      domain,
      domain_adapter: row.domain_adapter,
      source_label: row.source_label,
      connection_status: context.status,
      latest_observed_at: context.heartbeat?.created_at ?? null,
      capability_ids: await readCapabilityIds(db, row.environment_binding_id),
      subject_directory: directory,
      self_subject_binding: selfBinding,
      identity_assignment:
        native.length === 0
          ? "not_applicable"
          : selfBinding?.status === "active"
            ? "supported"
            : selfBinding
              ? "reverification_required"
              : "binding_required",
      owner_controls_visible: membership.role === "owner",
      content_role: "room_environment_projection_not_assistant_answer",
      answer_authority: false,
      assistant_answer: false,
      terminal_eligible: false,
      raw_content_included: false,
    });
  }
  return projections;
};

const readExactEnvironment = async (
  db: Queryable,
  roomId: string,
  environmentBindingId: string,
): Promise<EnvironmentRow> => {
  const rows = await readEnvironmentRows(db, roomId);
  const row = rows.find(
    (candidate) =>
      candidate.environment_binding_id === environmentBindingId &&
      candidate.environment_status === "active" &&
      candidate.source_status === "active" &&
      candidate.device_status === "active" &&
      candidate.adapter_admission_status === "active",
  );
  if (!row || !row.producer_epoch_ref) {
    throw new RoomEnvironmentSubjectError(
      environmentBindingId.startsWith("environment_binding:pending:")
        ? "environment_not_ready"
        : "environment_not_found",
      409,
      "The exact room environment is not active and ready for identity selection.",
    );
  }
  return row;
};

const bindSubject = async (input: {
  roomId: string;
  actorProfileId: string;
  environmentBindingId: string;
  targetParticipantId?: string;
  subjectRef: string;
  verificationMethod: "self_claim" | "owner_assigned";
  /** Ready up may verify/reuse; explicit selection retains replacement semantics. */
  reuseCurrentOnly?: boolean;
  refreshCurrentEpoch?: { subjectBindingId: string; expectedProducerEpochRef: string };
}): Promise<HelixRoomEnvironmentSubjectBinding> =>
  withSharedRealtimeRoomTransaction(async (db) => {
    const { room, member: actorMember } = await assertAccessibleMember(
      db,
      input.roomId,
      input.actorProfileId,
      true,
    );
    assertOpenRoom(room);
    const actorParticipantId = actorMember.participant_id;
    const targetParticipantId = input.targetParticipantId ?? actorParticipantId;
    if (
      input.verificationMethod === "owner_assigned" &&
      actorMember.member_role !== "owner"
    ) {
      throw new RoomEnvironmentSubjectError(
        "subject_binding_forbidden",
        403,
        "Only the room owner may assign another member's environment subject.",
      );
    }
    if (
      input.verificationMethod === "self_claim" &&
      targetParticipantId !== actorParticipantId
    ) {
      throw new RoomEnvironmentSubjectError(
        "subject_binding_forbidden",
        403,
        "A room member may only select their own environment subject.",
      );
    }
    const target = await db.query<{
      participant_id: string;
      profile_id: string;
      presence: string;
    }>(
      `
        SELECT participant_id, profile_id, presence
        FROM helix_shared_realtime_room_members
        WHERE room_id = $1
          AND participant_id = $2
          AND presence <> 'left'
        LIMIT 1
        FOR UPDATE;
      `,
      [input.roomId, targetParticipantId],
    );
    const targetMember = target.rows[0];
    if (!targetMember) {
      throw new RoomEnvironmentSubjectError(
        "subject_binding_forbidden",
        404,
        "The target participant is not an active member of this room.",
      );
    }
    const environment = await readExactEnvironment(
      db,
      input.roomId,
      input.environmentBindingId,
    );
    const context = heartbeatContext(environment);
    if (!context.heartbeat) {
      throw new RoomEnvironmentSubjectError(
        "subject_directory_missing",
        409,
        "The connector has not published an online-subject directory yet.",
      );
    }
    if (!context.heartbeatFresh) {
      throw new RoomEnvironmentSubjectError(
        "subject_directory_stale",
        409,
        "The connector subject directory is stale; wait for a fresh heartbeat.",
      );
    }
    const subjects = nativeSubjects({
      environmentBindingId: environment.environment_binding_id,
      heartbeat: context.heartbeat,
      subjectKind: context.subjectKind,
    });
    const subject = subjects.find(
      (candidate) => candidate.subjectRef === input.subjectRef,
    );
    if (!subject) {
      throw new RoomEnvironmentSubjectError(
        "subject_not_found",
        409,
        "The selected subject is no longer online in this exact environment.",
      );
    }
    const conflict = await db.query<{ participant_id: string }>(
      `
        SELECT participant_id
        FROM helix_room_environment_subject_bindings
        WHERE environment_binding_id = $1
          AND subject_native_id = $2
          AND status = 'active'
          AND participant_id <> $3
        LIMIT 1
        FOR UPDATE;
      `,
      [environment.environment_binding_id, subject.nativeId, targetParticipantId],
    );
    if (conflict.rows[0]) {
      throw new RoomEnvironmentSubjectError(
        "subject_already_claimed",
        409,
        "Another room member already selected this environment subject.",
      );
    }
    if (input.reuseCurrentOnly) {
      const existing = await db.query<SubjectBindingRow>(
        `SELECT * FROM helix_room_environment_subject_bindings
         WHERE room_id=$1 AND environment_binding_id=$2 AND participant_id=$3
           AND profile_id=$4 AND status='active'
         ORDER BY updated_at DESC LIMIT 1 FOR UPDATE;`,
        [input.roomId, environment.environment_binding_id, targetParticipantId, targetMember.profile_id],
      );
      let row = existing.rows[0];
      const expiry = row?.expires_at ? Date.parse(iso(row.expires_at)) : Infinity;
      if (!row || row.subject_ref !== subject.subjectRef || row.subject_native_id !== subject.nativeId ||
          row.source_id !== environment.source_id || row.world_id !== environment.world_id ||
          row.room_source_binding_id !== environment.room_source_binding_id ||
          (input.refreshCurrentEpoch && row.subject_binding_id !== input.refreshCurrentEpoch.subjectBindingId) ||
          expiry <= Date.now() || Number.isNaN(expiry)) {
        throw new RoomEnvironmentSubjectError("subject_binding_stale", 409,
          "Ready up cannot reuse this player binding; explicit identity recovery is required.");
      }
      if (row.producer_epoch_ref !== environment.producer_epoch_ref) {
        if (!input.refreshCurrentEpoch ||
            row.producer_epoch_ref !== input.refreshCurrentEpoch.expectedProducerEpochRef) {
          throw new RoomEnvironmentSubjectError("subject_binding_stale", 409,
            "The player epoch changed; verify the exact prior binding before recovery.");
        }
        const priorEpoch = row.producer_epoch_ref;
        const refreshedAt = new Date().toISOString();
        const updated = await db.query<SubjectBindingRow>(
          `UPDATE helix_room_environment_subject_bindings
           SET producer_epoch_ref=$2, last_confirmed_at=$3, updated_at=$3
           WHERE subject_binding_id=$1 AND producer_epoch_ref=$4 AND status='active'
           RETURNING *;`,
          [row.subject_binding_id, environment.producer_epoch_ref, refreshedAt, priorEpoch],
        );
        if (!updated.rows[0]) throw new RoomEnvironmentSubjectError("subject_binding_stale", 409,
          "The player binding changed during epoch recovery.");
        row = updated.rows[0];
        await insertAuditEvent({ db, roomId: input.roomId, actorParticipantId,
          eventType: "environment_subject_epoch_refreshed", createdAt: refreshedAt,
          metadata: { subject_binding_id: row.subject_binding_id,
            environment_binding_id: row.environment_binding_id,
            previous_producer_epoch_ref: priorEpoch,
            producer_epoch_ref: row.producer_epoch_ref,
            expiry_extended: false, authority_granted: false } });
      }
      return projectBinding({ row, currentProducerEpochRef: environment.producer_epoch_ref,
        heartbeat: context.heartbeat, heartbeatFresh: true });
    }

    const now = new Date().toISOString();
    await db.query(
      `
        UPDATE helix_room_environment_subject_bindings
        SET status = 'revoked', revoked_at = $4, updated_at = $4
        WHERE room_id = $1
          AND environment_binding_id = $2
          AND participant_id = $3
          AND status = 'active';
      `,
      [input.roomId, environment.environment_binding_id, targetParticipantId, now],
    );
    const bindingId = `environment_subject_binding:${crypto.randomUUID()}`;
    const confidence =
      input.verificationMethod === "owner_assigned" ? 0.85 : 0.75;
    await db.query(
      `
        INSERT INTO helix_room_environment_subject_bindings (
          subject_binding_id,
          room_id,
          participant_id,
          profile_id,
          environment_binding_id,
          room_source_binding_id,
          source_id,
          world_id,
          subject_kind,
          subject_ref,
          subject_native_id,
          subject_label,
          verification_method,
          confidence,
          producer_epoch_ref,
          verified_at,
          last_confirmed_at,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $16, $16, $16
        );
      `,
      [
        bindingId,
        input.roomId,
        targetParticipantId,
        targetMember.profile_id,
        environment.environment_binding_id,
        environment.room_source_binding_id,
        environment.source_id,
        environment.world_id,
        subject.subjectKind,
        subject.subjectRef,
        subject.nativeId,
        subject.label,
        input.verificationMethod,
        confidence,
        environment.producer_epoch_ref,
        now,
      ],
    );
    await db.query(
      `
        UPDATE helix_environment_command_member_grants
        SET subject_binding_id = $4, updated_at = $5
        WHERE room_id = $1
          AND environment_binding_id = $2
          AND participant_id = $3
          AND status = 'active';
      `,
      [
        input.roomId,
        environment.environment_binding_id,
        targetParticipantId,
        bindingId,
        now,
      ],
    );
    await insertAuditEvent({
      db,
      roomId: input.roomId,
      actorParticipantId,
      eventType: "environment_subject_bound",
      metadata: {
        subject_binding_id: bindingId,
        environment_binding_id: environment.environment_binding_id,
        target_participant_id: targetParticipantId,
        subject_ref: subject.subjectRef,
        verification_method: input.verificationMethod,
      },
      createdAt: now,
    });
    const inserted = await db.query<SubjectBindingRow>(
      `
        SELECT *
        FROM helix_room_environment_subject_bindings
        WHERE subject_binding_id = $1;
      `,
      [bindingId],
    );
    return projectBinding({
      row: inserted.rows[0],
      currentProducerEpochRef: environment.producer_epoch_ref,
      heartbeat: context.heartbeat,
      heartbeatFresh: true,
    });
  });

export const bindOwnRoomEnvironmentSubject = async (input: {
  roomId: string;
  profileId: string;
  environmentBindingId: string;
  subjectRef: string;
}): Promise<HelixRoomEnvironmentSubjectBinding> =>
  bindSubject({
    roomId: input.roomId,
    actorProfileId: input.profileId,
    environmentBindingId: input.environmentBindingId,
    subjectRef: input.subjectRef,
    verificationMethod: "self_claim",
  });

/** Check a previously selected player without replacing identity or renewing consent. */
export const ensureOwnRoomEnvironmentSubject = async (input: {
  roomId: string;
  profileId: string;
  environmentBindingId: string;
  subjectRef: string;
}): Promise<HelixRoomEnvironmentSubjectBinding> => bindSubject({
  roomId: input.roomId,
  actorProfileId: input.profileId,
  environmentBindingId: input.environmentBindingId,
  subjectRef: input.subjectRef,
  verificationMethod: "self_claim",
  reuseCurrentOnly: true,
});

/**
 * Recover only the epoch of an existing active, unexpired self binding after
 * validating the same player in the current admitted roster. Keeps identity,
 * original verification and consent deadline; emits one audit event on change.
 */
export const refreshOwnRoomEnvironmentSubjectEpoch = async (input: {
  roomId: string;
  profileId: string;
  environmentBindingId: string;
  subjectRef: string;
  subjectBindingId: string;
  expectedProducerEpochRef: string;
}): Promise<HelixRoomEnvironmentSubjectBinding> => bindSubject({
  roomId: input.roomId, actorProfileId: input.profileId,
  environmentBindingId: input.environmentBindingId, subjectRef: input.subjectRef,
  verificationMethod: "self_claim", reuseCurrentOnly: true,
  refreshCurrentEpoch: { subjectBindingId: input.subjectBindingId,
    expectedProducerEpochRef: input.expectedProducerEpochRef },
});

export const assignRoomEnvironmentSubject = async (input: {
  roomId: string;
  ownerProfileId: string;
  environmentBindingId: string;
  participantId: string;
  subjectRef: string;
}): Promise<HelixRoomEnvironmentSubjectBinding> =>
  bindSubject({
    roomId: input.roomId,
    actorProfileId: input.ownerProfileId,
    environmentBindingId: input.environmentBindingId,
    targetParticipantId: input.participantId,
    subjectRef: input.subjectRef,
    verificationMethod: "owner_assigned",
  });

export const revokeOwnRoomEnvironmentSubject = async (input: {
  roomId: string;
  profileId: string;
  environmentBindingId: string;
}): Promise<void> => {
  await withSharedRealtimeRoomTransaction(async (db) => {
    const { room, member } = await assertAccessibleMember(
      db,
      input.roomId,
      input.profileId,
      true,
    );
    assertOpenRoom(room);
    const now = new Date().toISOString();
    await db.query(
      `
        UPDATE helix_room_environment_subject_bindings
        SET status = 'revoked', revoked_at = $4, updated_at = $4
        WHERE room_id = $1
          AND environment_binding_id = $2
          AND participant_id = $3
          AND status = 'active';
      `,
      [input.roomId, input.environmentBindingId, member.participant_id, now],
    );
    await db.query(
      `
        UPDATE helix_environment_command_member_grants
        SET subject_binding_id = NULL, updated_at = $4
        WHERE room_id = $1
          AND environment_binding_id = $2
          AND participant_id = $3
          AND status = 'active';
      `,
      [input.roomId, input.environmentBindingId, member.participant_id, now],
    );
    await insertAuditEvent({
      db,
      roomId: input.roomId,
      actorParticipantId: member.participant_id,
      eventType: "environment_subject_revoked",
      metadata: { environment_binding_id: input.environmentBindingId },
      createdAt: now,
    });
  });
};

export type ResolvedRoomEnvironmentSubject = {
  participantId: string;
  subjectBindingId: string;
  subjectNativeId: string;
  subjectRef: string;
  subjectLabel: string;
  verificationMethod: HelixEnvironmentSubjectVerificationMethod;
  confidence: number;
  producerEpochRef: string;
};

export type RoomEnvironmentParticipantSubjectContext = {
  participant_id: string;
  environment_binding_ref: string;
  environment_label: string;
  domain_adapter: string;
  subject_kind: string;
  subject_label: string;
  verification_method: HelixEnvironmentSubjectVerificationMethod;
  confidence: number;
  status: "active" | "stale";
  answer_authority: false;
  assistant_answer: false;
  terminal_eligible: false;
  raw_content_included: false;
};

export const listRoomEnvironmentParticipantSubjectContexts = async (
  roomId: string,
): Promise<RoomEnvironmentParticipantSubjectContext[]> => {
  const db = await readSharedRealtimeRoomDatabase();
  const result = await db.query<SubjectBindingRow & {
    domain_adapter: string;
    source_label: string;
    current_producer_epoch_ref: string | null;
  }>(
    `
      SELECT
        s.*,
        rs.domain_adapter,
        rs.source_label,
        d.producer_epoch_ref AS current_producer_epoch_ref
      FROM helix_room_environment_subject_bindings s
      JOIN helix_environment_connector_bindings b
        ON b.environment_binding_id = s.environment_binding_id
        AND b.status = 'active'
      JOIN helix_environment_connector_devices d
        ON d.device_id = b.device_id
        AND d.status = 'active'
      JOIN helix_room_source_bindings rs
        ON rs.binding_id = s.room_source_binding_id
        AND rs.status = 'active'
      WHERE s.room_id = $1
        AND s.status = 'active'
      ORDER BY s.participant_id, s.updated_at DESC;
    `,
    [roomId],
  );
  return result.rows.map((row) => {
    const heartbeat = getEnvironmentSourceHeartbeatForServerIdentity({
      sourceId: row.source_id,
      roomId: row.room_id,
      domainAdapter: row.domain_adapter,
    });
    let maxAge = 30_000;
    try {
      maxAge = resolveEnvironmentAdapterProfile({
        domainAdapter: row.domain_adapter,
        worldId: row.world_id,
      }).profile.freshness.heartbeat_max_age_ms;
    } catch {
      maxAge = 0;
    }
    const age = heartbeat
      ? Date.now() - Date.parse(heartbeat.created_at)
      : Infinity;
    const currentSubject = nativeSubjects({
      environmentBindingId: row.environment_binding_id,
      heartbeat,
      subjectKind: row.subject_kind,
    }).find((subject) => subject.nativeId === row.subject_native_id);
    const subjectOnline = Boolean(currentSubject);
    const active =
      row.current_producer_epoch_ref === row.producer_epoch_ref &&
      Number.isFinite(age) &&
      age >= 0 &&
      age <= maxAge &&
      subjectOnline;
    return {
      participant_id: row.participant_id,
      environment_binding_ref: row.environment_binding_id,
      environment_label: row.source_label,
      domain_adapter: row.domain_adapter,
      subject_kind: row.subject_kind,
      subject_label: currentSubject?.label ?? row.subject_label,
      verification_method: row.verification_method,
      confidence: Number(row.confidence),
      status: active ? "active" : "stale",
      answer_authority: false,
      assistant_answer: false,
      terminal_eligible: false,
      raw_content_included: false,
    };
  });
};

export const resolveRoomEnvironmentSubjectForProbe = async (input: {
  membership: SharedRealtimeRoomMembership;
  participantId?: string | null;
  environmentBindingId: string;
  sourceId: string;
  worldId: string;
  producerEpochRef: string;
}): Promise<ResolvedRoomEnvironmentSubject | null> => {
  const db = await readSharedRealtimeRoomDatabase();
  const participantId =
    input.participantId?.trim() || input.membership.participantId;
  const resolvingOwnParticipant =
    participantId === input.membership.participantId;
  const result = await db.query<SubjectBindingRow & {
    domain_adapter: string;
    current_producer_epoch_ref: string | null;
  }>(
    `
      SELECT
        s.*,
        rs.domain_adapter,
        d.producer_epoch_ref AS current_producer_epoch_ref
      FROM helix_room_environment_subject_bindings s
      JOIN helix_environment_connector_bindings b
        ON b.environment_binding_id = s.environment_binding_id
        AND b.status = 'active'
      JOIN helix_environment_connector_devices d
        ON d.device_id = b.device_id
        AND d.status = 'active'
      JOIN helix_room_source_bindings rs
        ON rs.binding_id = s.room_source_binding_id
        AND rs.status = 'active'
      WHERE s.room_id = $1
        AND ($2::text IS NULL OR s.profile_id = $2)
        AND s.participant_id = $3
        AND s.environment_binding_id = $4
        AND s.status = 'active'
      LIMIT 1;
    `,
    [
      input.membership.roomId,
      resolvingOwnParticipant ? input.membership.profileId : null,
      participantId,
      input.environmentBindingId,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    const environment = await db.query<{
      room_id: string;
      source_id: string;
      world_id: string;
      domain_adapter: string;
      producer_epoch_ref: string | null;
    }>(
      `
        SELECT
          b.room_id,
          b.source_id,
          b.world_id,
          rs.domain_adapter,
          d.producer_epoch_ref
        FROM helix_environment_connector_bindings b
        JOIN helix_environment_connector_devices d
          ON d.device_id = b.device_id
          AND d.status = 'active'
        JOIN helix_room_source_bindings rs
          ON rs.binding_id = b.room_source_binding_id
          AND rs.status = 'active'
        WHERE b.environment_binding_id = $1
          AND b.status = 'active'
        LIMIT 1;
      `,
      [input.environmentBindingId],
    );
    const exact = environment.rows[0];
    if (!exact || exact.room_id !== input.membership.roomId) {
      throw new RoomEnvironmentSubjectError(
        "wrong_environment",
        409,
        "The requested environment is not active in this room.",
      );
    }
    if (exact.source_id !== input.sourceId) {
      throw new RoomEnvironmentSubjectError(
        "wrong_environment",
        409,
        "The requested environment does not match the admitted source.",
      );
    }
    if (exact.world_id !== input.worldId) {
      throw new RoomEnvironmentSubjectError(
        "wrong_world",
        409,
        "The requested environment does not match the admitted world.",
      );
    }
    if (exact.producer_epoch_ref !== input.producerEpochRef) {
      throw new RoomEnvironmentSubjectError(
        "producer_epoch_mismatch",
        409,
        "The environment connector restarted; choose and verify the player identity again.",
      );
    }
    let supportsSubjectDirectory = false;
    try {
      supportsSubjectDirectory = resolveEnvironmentAdapterProfile({
        domainAdapter: exact.domain_adapter,
        worldId: exact.world_id,
      }).profile.subject_directory.supported;
    } catch {
      throw new RoomEnvironmentSubjectError(
        "wrong_environment",
        409,
        "The environment adapter is no longer admitted.",
      );
    }
    if (supportsSubjectDirectory) {
      throw new RoomEnvironmentSubjectError(
        "subject_binding_required",
        409,
        "Choose which online player you are in this room before asking about yourself.",
      );
    }
    return null;
  }
  if (row.source_id !== input.sourceId) {
    throw new RoomEnvironmentSubjectError(
      "wrong_environment",
      409,
      "The participant subject belongs to a different environment source.",
    );
  }
  if (row.world_id !== input.worldId) {
    throw new RoomEnvironmentSubjectError(
      "wrong_world",
      409,
      "The participant subject belongs to a different environment world.",
    );
  }
  if (
    row.producer_epoch_ref !== input.producerEpochRef ||
    row.current_producer_epoch_ref !== input.producerEpochRef
  ) {
    throw new RoomEnvironmentSubjectError(
      "producer_epoch_mismatch",
      409,
      "The participant subject binding predates the active connector epoch and must be verified again.",
    );
  }
  const heartbeat = getEnvironmentSourceHeartbeatForServerIdentity({
    sourceId: row.source_id,
    roomId: row.room_id,
    domainAdapter: row.domain_adapter,
  });
  let maxAge = 30_000;
  try {
    maxAge = resolveEnvironmentAdapterProfile({
      domainAdapter: row.domain_adapter,
      worldId: row.world_id,
    }).profile.freshness.heartbeat_max_age_ms;
  } catch {
    throw new RoomEnvironmentSubjectError(
      "wrong_environment",
      409,
      "The participant subject adapter is no longer admitted.",
    );
  }
  const age = heartbeat ? Date.now() - Date.parse(heartbeat.created_at) : Infinity;
  if (!heartbeat || !Number.isFinite(age) || age < 0 || age > maxAge) {
    throw new RoomEnvironmentSubjectError(
      "subject_binding_stale",
      409,
      "The participant subject cannot be confirmed from a fresh connector roster.",
    );
  }
  const onlineSubject = nativeSubjects({
    environmentBindingId: row.environment_binding_id,
    heartbeat,
    subjectKind: row.subject_kind,
  }).find((subject) => subject.nativeId === row.subject_native_id);
  if (!onlineSubject) {
    throw new RoomEnvironmentSubjectError(
      "subject_offline",
      409,
      "The participant's selected environment subject is not currently online.",
    );
  }
  return {
    participantId: row.participant_id,
    subjectBindingId: row.subject_binding_id,
    subjectNativeId: row.subject_native_id,
    subjectRef: row.subject_ref,
    subjectLabel: onlineSubject.label,
    verificationMethod: row.verification_method,
    confidence: Number(row.confidence),
    producerEpochRef: row.producer_epoch_ref,
  };
};

export const resolveActiveRoomEnvironmentSubjectByRef = async (input: {
  roomId: string;
  profileId: string;
  environmentBindingId: string;
  sourceId: string;
  worldId: string;
  subjectRef: string;
}): Promise<ResolvedRoomEnvironmentSubject> => {
  const membership = await readSharedRealtimeRoomMembership({
    roomId: input.roomId,
    profileId: input.profileId,
  });
  if (!membership || membership.roomStatus === "closed") {
    throw new RoomEnvironmentSubjectError(
      "subject_binding_forbidden",
      403,
      "The current account is not an active member of this room.",
    );
  }
  const db = await readSharedRealtimeRoomDatabase();
  const result = await db.query<{
    participant_id: string;
    producer_epoch_ref: string;
  }>(
    `
      SELECT participant_id, producer_epoch_ref
      FROM helix_room_environment_subject_bindings
      WHERE room_id = $1
        AND environment_binding_id = $2
        AND source_id = $3
        AND world_id = $4
        AND subject_ref = $5
        AND status = 'active'
      LIMIT 1;
    `,
    [
      input.roomId,
      input.environmentBindingId,
      input.sourceId,
      input.worldId,
      input.subjectRef.trim(),
    ],
  );
  const target = result.rows[0];
  if (!target) {
    throw new RoomEnvironmentSubjectError(
      "subject_binding_required",
      409,
      "The requested follow target is not an active, room-bound environment subject.",
    );
  }
  const resolved = await resolveRoomEnvironmentSubjectForProbe({
    membership,
    participantId: target.participant_id,
    environmentBindingId: input.environmentBindingId,
    sourceId: input.sourceId,
    worldId: input.worldId,
    producerEpochRef: target.producer_epoch_ref,
  });
  if (!resolved) {
    throw new RoomEnvironmentSubjectError(
      "subject_binding_required",
      409,
      "The requested follow target could not be resolved to a live player.",
    );
  }
  return resolved;
};
