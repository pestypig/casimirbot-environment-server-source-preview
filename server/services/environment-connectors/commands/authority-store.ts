import crypto from "node:crypto";
import {
  HELIX_ENVIRONMENT_COMMAND_AUTHORITY_SCHEMA,
  HELIX_ENVIRONMENT_COMMAND_MEMBER_GRANT_SCHEMA,
  helixEnvironmentCommandAuthoritySchema,
  helixEnvironmentCommandMemberGrantSchema,
  type HelixEnvironmentCommandAuthority,
  type HelixEnvironmentCommandAuthorityProfile,
  type HelixEnvironmentCommandAutonomyMode,
  type HelixEnvironmentCommandCategory,
  type HelixEnvironmentCommandMemberGrant,
} from "@shared/helix-environment-command";
import {
  readSharedRealtimeRoomMembership,
} from "../../helix-ask/realtime-room/room-store";
import {
  readSharedRealtimeRoomDatabase,
  withSharedRealtimeRoomTransaction,
} from "../../helix-ask/realtime-room/room-store/database";
import type { Queryable } from
  "../../helix-ask/realtime-room/room-store/types";
import { environmentCommandProfileAtMost } from "./authority-policy";
import { requestDesktopMcpTunnelReadOnlyForSafety } from
  "../../local-supervisor/desktop-mcp-tunnel-safety";

export type EnvironmentCommandAuthorityErrorCode =
  | "command_authority_forbidden"
  | "command_environment_not_found"
  | "command_environment_not_active"
  | "command_authority_not_found"
  | "command_authority_profile_exceeded"
  | "command_authority_expiry_invalid"
  | "command_member_not_found";

export class EnvironmentCommandAuthorityError extends Error {
  constructor(
    readonly code: EnvironmentCommandAuthorityErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "EnvironmentCommandAuthorityError";
  }
}

export const isEnvironmentCommandAuthorityError = (
  error: unknown,
): error is EnvironmentCommandAuthorityError =>
  error instanceof EnvironmentCommandAuthorityError;

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
  adapter_admission_status: string;
};

type AuthorityRow = {
  command_authority_id: string;
  environment_binding_id: string;
  room_source_binding_id: string;
  room_id: string;
  source_id: string;
  world_id: string;
  adapter_profile_id: string;
  authority_profile: HelixEnvironmentCommandAuthorityProfile;
  autonomy_mode: HelixEnvironmentCommandAutonomyMode;
  approved_categories: unknown;
  policy_version: number | string;
  status: "active" | "suspended" | "revoked" | "expired";
  created_at: Date | string;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
};

type GrantRow = {
  command_grant_id: string;
  command_authority_id: string;
  room_id: string;
  participant_id: string;
  environment_binding_id: string;
  subject_binding_id: string | null;
  max_authority_profile: HelixEnvironmentCommandAuthorityProfile;
  autonomy_override: HelixEnvironmentCommandAutonomyMode | null;
  status: "active" | "suspended" | "revoked" | "expired";
  created_at: Date | string;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
};

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);

const parseCategories = (value: unknown): HelixEnvironmentCommandCategory[] => {
  const parsed = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return [];
        }
      })()
    : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is HelixEnvironmentCommandCategory =>
      typeof entry === "string" &&
      [
        "query",
        "player_state",
        "player_inventory",
        "player_movement",
        "world_time_weather",
        "world_build",
        "entity_control",
        "server_administration",
        "mod_command",
      ].includes(entry),
  );
};

const projectedStatus = <T extends AuthorityRow | GrantRow>(
  row: T,
): T["status"] =>
  row.status === "active" &&
  row.expires_at !== null &&
  Date.parse(iso(row.expires_at)) <= Date.now()
    ? "expired"
    : row.status;

const projectAuthority = (
  row: AuthorityRow,
): HelixEnvironmentCommandAuthority =>
  helixEnvironmentCommandAuthoritySchema.parse({
    schema: HELIX_ENVIRONMENT_COMMAND_AUTHORITY_SCHEMA,
    command_authority_id: row.command_authority_id,
    environment_binding_id: row.environment_binding_id,
    room_source_binding_id: row.room_source_binding_id,
    room_id: row.room_id,
    source_id: row.source_id,
    world_id: row.world_id,
    adapter_profile_id: row.adapter_profile_id,
    authority_profile: row.authority_profile,
    autonomy_mode: row.autonomy_mode,
    approved_categories: parseCategories(row.approved_categories),
    status: projectedStatus(row),
    policy_version: Number(row.policy_version),
    issued_at: iso(row.created_at),
    expires_at: isoOrNull(row.expires_at),
    revoked_at: isoOrNull(row.revoked_at),
    credential_included: false,
    content_role: "environment_command_authority_not_assistant_answer",
    answer_authority: false,
    assistant_answer: false,
    terminal_eligible: false,
    raw_content_included: false,
  });

const projectGrant = (row: GrantRow): HelixEnvironmentCommandMemberGrant =>
  helixEnvironmentCommandMemberGrantSchema.parse({
    schema: HELIX_ENVIRONMENT_COMMAND_MEMBER_GRANT_SCHEMA,
    command_grant_id: row.command_grant_id,
    command_authority_id: row.command_authority_id,
    room_id: row.room_id,
    participant_id: row.participant_id,
    environment_binding_id: row.environment_binding_id,
    subject_binding_id: row.subject_binding_id,
    max_authority_profile: row.max_authority_profile,
    autonomy_override: row.autonomy_override,
    status: projectedStatus(row),
    issued_at: iso(row.created_at),
    expires_at: isoOrNull(row.expires_at),
    revoked_at: isoOrNull(row.revoked_at),
    content_role: "environment_command_member_grant_not_assistant_answer",
    answer_authority: false,
    assistant_answer: false,
    terminal_eligible: false,
    raw_content_included: false,
  });

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
    throw new EnvironmentCommandAuthorityError(
      "command_authority_forbidden",
      404,
      "The environment command settings are unavailable to this account.",
    );
  }
  return membership;
};

const readEnvironment = async (
  db: Queryable,
  roomId: string,
  environmentBindingId: string,
  lock = false,
): Promise<EnvironmentRow> => {
  const result = await db.query<EnvironmentRow>(
    `
      SELECT
        b.environment_binding_id,
        b.room_source_binding_id,
        b.owner_profile_id,
        b.room_id,
        b.source_id,
        b.world_id,
        b.status AS environment_status,
        rs.status AS source_status,
        r.status AS room_status,
        a.adapter_profile_id,
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
    throw new EnvironmentCommandAuthorityError(
      "command_environment_not_found",
      404,
      "The room environment was not found.",
    );
  }
  if (
    row.environment_status !== "active" ||
    row.source_status !== "active" ||
    row.room_status === "closed" ||
    row.adapter_admission_status !== "active"
  ) {
    throw new EnvironmentCommandAuthorityError(
      "command_environment_not_active",
      409,
      "The room environment is not active enough to grant command authority.",
    );
  }
  return row;
};

const readActiveAuthority = async (
  db: Queryable,
  environmentBindingId: string,
): Promise<AuthorityRow | null> => {
  const result = await db.query<AuthorityRow>(
    `
      SELECT *
      FROM helix_environment_command_authorities
      WHERE environment_binding_id = $1 AND status = 'active'
      ORDER BY policy_version DESC
      LIMIT 1;
    `,
    [environmentBindingId],
  );
  return result.rows[0] ?? null;
};

const readActiveGrant = async (
  db: Queryable,
  commandAuthorityId: string,
  participantId: string,
): Promise<GrantRow | null> => {
  const result = await db.query<GrantRow>(
    `
      SELECT *
      FROM helix_environment_command_member_grants
      WHERE command_authority_id = $1
        AND participant_id = $2
        AND status = 'active'
      LIMIT 1;
    `,
    [commandAuthorityId, participantId],
  );
  return result.rows[0] ?? null;
};

const readActiveGrants = async (
  db: Queryable,
  commandAuthorityId: string,
): Promise<GrantRow[]> => {
  const result = await db.query<GrantRow>(
    `
      SELECT *
      FROM helix_environment_command_member_grants
      WHERE command_authority_id = $1 AND status = 'active'
      ORDER BY created_at, participant_id;
    `,
    [commandAuthorityId],
  );
  return result.rows;
};

const assertFutureExpiry = (expiresAt: string | null): void => {
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    throw new EnvironmentCommandAuthorityError(
      "command_authority_expiry_invalid",
      400,
      "Command authority expiry must be in the future.",
    );
  }
};

const insertCommandEvent = async (input: {
  db: Queryable;
  authorityId: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<void> => {
  await input.db.query(
    `
      INSERT INTO helix_environment_command_events (
        event_id, command_authority_id, event_type, payload
      ) VALUES ($1, $2, $3, $4::jsonb);
    `,
    [
      `command_event:${crypto.randomUUID()}`,
      input.authorityId,
      input.eventType,
      JSON.stringify(input.payload),
    ],
  );
};

export const readEnvironmentCommandAuthority = async (input: {
  roomId: string;
  profileId: string;
  environmentBindingId: string;
}): Promise<{
  authority: HelixEnvironmentCommandAuthority | null;
  memberGrant: HelixEnvironmentCommandMemberGrant | null;
  memberGrants: HelixEnvironmentCommandMemberGrant[];
}> => {
  const membership = await requireMembership(input);
  const db = await readSharedRealtimeRoomDatabase();
  await readEnvironment(db, input.roomId, input.environmentBindingId);
  const authorityRow = await readActiveAuthority(db, input.environmentBindingId);
  if (!authorityRow) {
    return { authority: null, memberGrant: null, memberGrants: [] };
  }
  const grantRow = await readActiveGrant(
    db,
    authorityRow.command_authority_id,
    membership.participantId,
  );
  return {
    authority: projectAuthority(authorityRow),
    memberGrant: grantRow ? projectGrant(grantRow) : null,
    memberGrants: membership.role === "owner"
      ? (await readActiveGrants(db, authorityRow.command_authority_id)).map(
          projectGrant,
        )
      : grantRow
        ? [projectGrant(grantRow)]
        : [],
  };
};

export const configureEnvironmentCommandAuthority = async (input: {
  roomId: string;
  ownerProfileId: string;
  environmentBindingId: string;
  authorityProfile: HelixEnvironmentCommandAuthorityProfile;
  autonomyMode: HelixEnvironmentCommandAutonomyMode;
  approvedCategories: HelixEnvironmentCommandCategory[];
  expiresAt: string | null;
}): Promise<{
  authority: HelixEnvironmentCommandAuthority;
  ownerGrant: HelixEnvironmentCommandMemberGrant;
}> => {
  const owner = await requireMembership({
    roomId: input.roomId,
    profileId: input.ownerProfileId,
    owner: true,
  });
  assertFutureExpiry(input.expiresAt);
  return withSharedRealtimeRoomTransaction(async (db) => {
    const environment = await readEnvironment(
      db,
      input.roomId,
      input.environmentBindingId,
      true,
    );
    if (environment.owner_profile_id !== input.ownerProfileId) {
      throw new EnvironmentCommandAuthorityError(
        "command_authority_forbidden",
        404,
        "Only the environment owner may configure command authority.",
      );
    }
    const prior = await readActiveAuthority(db, input.environmentBindingId);
    const policyVersion = prior ? Number(prior.policy_version) + 1 : 1;
    if (prior) {
      await db.query(
        `
          UPDATE helix_environment_command_authorities
          SET status = 'revoked', revoked_at = now(), updated_at = now()
          WHERE command_authority_id = $1;
        `,
        [prior.command_authority_id],
      );
      await db.query(
        `
          UPDATE helix_environment_command_member_grants
          SET status = 'revoked', revoked_at = now(), updated_at = now()
          WHERE command_authority_id = $1 AND status = 'active';
        `,
        [prior.command_authority_id],
      );
      await db.query(
        `
          UPDATE helix_environment_command_connector_credentials
          SET status = 'revoked', revoked_at = now()
          WHERE command_authority_id = $1 AND status = 'active';
        `,
        [prior.command_authority_id],
      );
      await db.query(
        `
          UPDATE helix_environment_command_requests
          SET status = 'canceled', cancellation_reason = 'authority_reconfigured',
              updated_at = now(), completed_at = now()
          WHERE command_authority_id = $1 AND status IN ('pending', 'leased');
        `,
        [prior.command_authority_id],
      );
    }
    const authorityId = `command_authority:${crypto.randomUUID()}`;
    await db.query(
      `
        INSERT INTO helix_environment_command_authorities (
          command_authority_id, environment_binding_id,
          room_source_binding_id, owner_profile_id, room_id, source_id,
          world_id, adapter_profile_id, authority_profile, autonomy_mode,
          approved_categories, policy_version, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13
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
        environment.adapter_profile_id,
        input.authorityProfile,
        input.autonomyMode,
        JSON.stringify(input.approvedCategories),
        policyVersion,
        input.expiresAt,
      ],
    );
    const subject = await db.query<{ subject_binding_id: string }>(
      `
        SELECT subject_binding_id
        FROM helix_room_environment_subject_bindings
        WHERE room_id = $1 AND environment_binding_id = $2
          AND participant_id = $3 AND status = 'active'
        LIMIT 1;
      `,
      [input.roomId, input.environmentBindingId, owner.participantId],
    );
    const grantId = `command_grant:${crypto.randomUUID()}`;
    await db.query(
      `
        INSERT INTO helix_environment_command_member_grants (
          command_grant_id, command_authority_id, room_id, participant_id,
          profile_id, environment_binding_id, subject_binding_id,
          max_authority_profile, autonomy_override, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9);
      `,
      [
        grantId,
        authorityId,
        input.roomId,
        owner.participantId,
        input.ownerProfileId,
        input.environmentBindingId,
        subject.rows[0]?.subject_binding_id ?? null,
        input.authorityProfile,
        input.expiresAt,
      ],
    );
    await insertCommandEvent({
      db,
      authorityId,
      eventType: "authority_configured",
      payload: {
        actor_participant_id: owner.participantId,
        authority_profile: input.authorityProfile,
        autonomy_mode: input.autonomyMode,
        policy_version: policyVersion,
      },
    });
    const authorityRow = await readActiveAuthority(
      db,
      input.environmentBindingId,
    );
    const grantRow = await readActiveGrant(db, authorityId, owner.participantId);
    if (!authorityRow || !grantRow) {
      throw new Error("Environment command authority failed to materialize.");
    }
    return {
      authority: projectAuthority(authorityRow),
      ownerGrant: projectGrant(grantRow),
    };
  });
};

export const configureEnvironmentCommandMemberGrant = async (input: {
  roomId: string;
  ownerProfileId: string;
  environmentBindingId: string;
  participantId: string;
  maxAuthorityProfile: HelixEnvironmentCommandAuthorityProfile;
  autonomyOverride: HelixEnvironmentCommandAutonomyMode | null;
  expiresAt: string | null;
}): Promise<HelixEnvironmentCommandMemberGrant> => {
  const owner = await requireMembership({
    roomId: input.roomId,
    profileId: input.ownerProfileId,
    owner: true,
  });
  assertFutureExpiry(input.expiresAt);
  return withSharedRealtimeRoomTransaction(async (db) => {
    await readEnvironment(db, input.roomId, input.environmentBindingId, true);
    const authority = await readActiveAuthority(db, input.environmentBindingId);
    if (!authority) {
      throw new EnvironmentCommandAuthorityError(
        "command_authority_not_found",
        409,
        "Configure environment command authority before granting a room member access.",
      );
    }
    if (
      !environmentCommandProfileAtMost(
        input.maxAuthorityProfile,
        authority.authority_profile,
      )
    ) {
      throw new EnvironmentCommandAuthorityError(
        "command_authority_profile_exceeded",
        400,
        "A room member grant cannot exceed the owner-selected source authority.",
      );
    }
    const member = await db.query<{ profile_id: string }>(
      `
        SELECT profile_id
        FROM helix_shared_realtime_room_members
        WHERE room_id = $1 AND participant_id = $2 AND presence <> 'left'
        LIMIT 1;
      `,
      [input.roomId, input.participantId],
    );
    if (!member.rows[0]) {
      throw new EnvironmentCommandAuthorityError(
        "command_member_not_found",
        404,
        "The target room member is not active in this room.",
      );
    }
    await db.query(
      `
        UPDATE helix_environment_command_member_grants
        SET status = 'revoked', revoked_at = now(), updated_at = now()
        WHERE command_authority_id = $1 AND participant_id = $2
          AND status = 'active';
      `,
      [authority.command_authority_id, input.participantId],
    );
    const subject = await db.query<{ subject_binding_id: string }>(
      `
        SELECT subject_binding_id
        FROM helix_room_environment_subject_bindings
        WHERE room_id = $1 AND environment_binding_id = $2
          AND participant_id = $3 AND status = 'active'
        LIMIT 1;
      `,
      [input.roomId, input.environmentBindingId, input.participantId],
    );
    const grantId = `command_grant:${crypto.randomUUID()}`;
    await db.query(
      `
        INSERT INTO helix_environment_command_member_grants (
          command_grant_id, command_authority_id, room_id, participant_id,
          profile_id, environment_binding_id, subject_binding_id,
          max_authority_profile, autonomy_override, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
      `,
      [
        grantId,
        authority.command_authority_id,
        input.roomId,
        input.participantId,
        member.rows[0].profile_id,
        input.environmentBindingId,
        subject.rows[0]?.subject_binding_id ?? null,
        input.maxAuthorityProfile,
        input.autonomyOverride,
        input.expiresAt,
      ],
    );
    await insertCommandEvent({
      db,
      authorityId: authority.command_authority_id,
      eventType: "member_grant_configured",
      payload: {
        actor_participant_id: owner.participantId,
        target_participant_id: input.participantId,
        max_authority_profile: input.maxAuthorityProfile,
      },
    });
    const row = await readActiveGrant(
      db,
      authority.command_authority_id,
      input.participantId,
    );
    if (!row) throw new Error("Environment command member grant failed to materialize.");
    return projectGrant(row);
  });
};

export const emergencyStopEnvironmentCommandAuthority = async (input: {
  roomId: string;
  ownerProfileId: string;
  environmentBindingId: string;
}): Promise<HelixEnvironmentCommandAuthority> => {
  const owner = await requireMembership({
    roomId: input.roomId,
    profileId: input.ownerProfileId,
    owner: true,
  });
  const stopped = await withSharedRealtimeRoomTransaction(async (db) => {
    await readEnvironment(db, input.roomId, input.environmentBindingId, true);
    const authority = await readActiveAuthority(db, input.environmentBindingId);
    if (!authority) {
      throw new EnvironmentCommandAuthorityError(
        "command_authority_not_found",
        404,
        "No active environment command authority exists.",
      );
    }
    await insertCommandEvent({
      db,
      authorityId: authority.command_authority_id,
      eventType: "emergency_stop",
      payload: { actor_participant_id: owner.participantId },
    });
    await db.query(
      `
        UPDATE helix_environment_command_authorities
        SET status = 'suspended', updated_at = now()
        WHERE command_authority_id = $1;
      `,
      [authority.command_authority_id],
    );
    await db.query(
      `
        UPDATE helix_environment_command_member_grants
        SET status = 'suspended', updated_at = now()
        WHERE command_authority_id = $1 AND status = 'active';
      `,
      [authority.command_authority_id],
    );
    await db.query(
      `
        UPDATE helix_environment_command_connector_credentials
        SET status = 'revoked', revoked_at = now()
        WHERE command_authority_id = $1 AND status = 'active';
      `,
      [authority.command_authority_id],
    );
    await db.query(
      `
        UPDATE helix_environment_command_requests
        SET status = 'canceled', cancellation_reason = 'emergency_stop',
            updated_at = now(), completed_at = now()
        WHERE command_authority_id = $1 AND status IN ('pending', 'leased');
      `,
      [authority.command_authority_id],
    );
    const stopped = { ...authority, status: "suspended" as const };
    return projectAuthority(stopped);
  });
  void requestDesktopMcpTunnelReadOnlyForSafety(
    "environment_emergency_stop",
  ).catch(() => false);
  return stopped;
};
