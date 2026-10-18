import crypto from "node:crypto";
import {
  HELIX_PROFILE_ENVIRONMENT_CONNECTION_REF_SCHEMA,
  HELIX_ROOM_CAPABILITY_GRANT_SCHEMA,
  HELIX_ROOM_CAPABILITY_NON_AUTHORITATIVE_FIELDS,
  HELIX_ROOM_CAPABILITY_OBSERVATION_SCHEMA,
  HELIX_ROOM_CAPABILITY_REENTRY_SCHEMA,
  helixProfileEnvironmentConnectionRefSchema,
  helixRoomCapabilityGrantSchema,
  helixRoomCapabilityObservationSchema,
  helixRoomCapabilityReentrySchema,
  type HelixProfileEnvironmentConnectionRef,
  type HelixRoomCapabilityFact,
  type HelixRoomCapabilityGrant,
  type HelixRoomCapabilityObservation,
  type HelixRoomCapabilityReentry,
} from "@shared/helix-room-capability-grant";

export type RoomReadGrantErrorCode =
  | "room_read_participant_not_found"
  | "room_read_participant_not_in_room"
  | "room_read_owner_mismatch"
  | "room_read_connection_not_found"
  | "room_read_connection_inactive"
  | "room_read_connection_node_mismatch"
  | "room_read_connection_identity_mismatch"
  | "room_read_grant_not_found"
  | "room_read_grant_wrong_room"
  | "room_read_grant_inactive"
  | "room_read_grant_expired"
  | "room_read_capability_not_granted"
  | "room_read_observation_stale"
  | "room_read_observation_invalid";

export class RoomReadGrantError extends Error {
  constructor(readonly code: RoomReadGrantErrorCode, message: string) {
    super(message);
    this.name = "RoomReadGrantError";
  }
}

export type TrustedRoomParticipant = Readonly<{
  participantRef: string;
  profileRef: string;
  roomIds: readonly string[];
}>;

export type TrustedProfileConnection = Readonly<{
  connectionRef: string;
  ownerProfileRef: string;
  installedNodeRef: string;
  environmentRef: string;
  sourceRef: string;
  producerEpochRef: string;
  capabilityIds: readonly string[];
  status: "active" | "degraded" | "suspended" | "revoked";
  policyRevision: number;
  updatedAt: string;
}>;

export type MockReadResult = Readonly<{
  observedAt: string;
  freshnessDeadline: string;
  facts: readonly HelixRoomCapabilityFact[];
}>;

export type ExactMockReadDriver = Readonly<{
  connectionRef: string;
  capabilityId: string;
  read: () => MockReadResult;
}>;

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
};

const sha256 = (value: unknown): `sha256:${string}` =>
  `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex")}`;

const stableRef = (prefix: string, value: unknown): string =>
  `${prefix}:${sha256(value).slice("sha256:".length, "sha256:".length + 32)}`;

function fail(code: RoomReadGrantErrorCode, message: string): never {
  throw new RoomReadGrantError(code, message);
}

const privateFactKeyPattern =
  /(^|[._/-])(credential|password|passwd|secret|token|community|string|endpoint|url|uri|address|ip)([._/-]|$)/iu;
const privateFactValuePattern =
  /(?:https?:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|bearer\s+[a-z0-9._~+/-]+=*)/iu;

const factsContainPrivateMaterial = (
  facts: readonly HelixRoomCapabilityFact[],
): boolean =>
  facts.some(
    (fact) =>
      privateFactKeyPattern.test(fact.key) ||
      (typeof fact.value === "string" && privateFactValuePattern.test(fact.value)),
  );

export class RoomReadGrantLifecycle {
  private readonly participants = new Map<string, TrustedRoomParticipant>();
  private readonly connections = new Map<string, TrustedProfileConnection>();
  private readonly drivers = new Map<string, ExactMockReadDriver>();
  private readonly grants = new Map<string, HelixRoomCapabilityGrant>();
  private readonly observations = new Map<string, HelixRoomCapabilityObservation>();

  constructor(input: {
    participants: readonly TrustedRoomParticipant[];
    connections: readonly TrustedProfileConnection[];
    drivers: readonly ExactMockReadDriver[];
  }) {
    input.participants.forEach((item) => this.participants.set(item.participantRef, item));
    input.connections.forEach((item) => this.connections.set(item.connectionRef, item));
    input.drivers.forEach((item) => {
      this.drivers.set(`${item.connectionRef}\n${item.capabilityId}`, item);
    });
  }

  projectConnection(connectionRef: string): HelixProfileEnvironmentConnectionRef {
    const connection = this.connections.get(connectionRef);
    if (!connection) fail("room_read_connection_not_found", "Connection was not found.");
    return helixProfileEnvironmentConnectionRefSchema.parse({
      schema: HELIX_PROFILE_ENVIRONMENT_CONNECTION_REF_SCHEMA,
      connection_ref: connection.connectionRef,
      owner_profile_ref: connection.ownerProfileRef,
      installed_node_ref: connection.installedNodeRef,
      environment_ref: connection.environmentRef,
      source_ref: connection.sourceRef,
      producer_epoch_ref: connection.producerEpochRef,
      capability_ids: [...connection.capabilityIds].sort(),
      status: connection.status,
      read_only: true,
      policy_revision: connection.policyRevision,
      updated_at: connection.updatedAt,
      ...HELIX_ROOM_CAPABILITY_NON_AUTHORITATIVE_FIELDS,
    });
  }

  /**
   * Applies a server-owned lifecycle transition to one exact connection. The
   * owner/node/source identity is immutable, so a health, epoch, rotation, or
   * recovery change cannot drift onto a similarly named connection.
   */
  transitionConnection(input: {
    connectionRef: string;
    ownerProfileRef: string;
    installedNodeRef: string;
    expectedProducerEpochRef: string;
    next: Pick<TrustedProfileConnection,
      "producerEpochRef" | "status" | "policyRevision" | "updatedAt">;
  }): HelixProfileEnvironmentConnectionRef {
    const current = this.connections.get(input.connectionRef);
    if (!current) fail("room_read_connection_not_found", "Connection was not found.");
    if (
      current.ownerProfileRef !== input.ownerProfileRef ||
      current.installedNodeRef !== input.installedNodeRef ||
      current.producerEpochRef !== input.expectedProducerEpochRef
    ) {
      fail(
        "room_read_connection_identity_mismatch",
        "Connection lifecycle identity did not match the current connection.",
      );
    }
    if (input.next.policyRevision < current.policyRevision) {
      fail(
        "room_read_connection_identity_mismatch",
        "Connection policy revision cannot move backward.",
      );
    }
    this.connections.set(current.connectionRef, {
      ...current,
      ...input.next,
    });
    return this.projectConnection(current.connectionRef);
  }

  createGrant(input: {
    ownerParticipantRef: string;
    roomId: string;
    connectionRef: string;
    installedNodeRef: string;
    capabilityIds: readonly string[];
    createdAt: string;
    expiresAt: string;
  }): HelixRoomCapabilityGrant {
    const owner = this.requireParticipantInRoom(input.ownerParticipantRef, input.roomId);
    const connection = this.connections.get(input.connectionRef);
    if (!connection) fail("room_read_connection_not_found", "Connection was not found.");
    if (owner.profileRef !== connection.ownerProfileRef) {
      fail("room_read_owner_mismatch", "Only the owning profile may grant this connection.");
    }
    if (connection.installedNodeRef !== input.installedNodeRef) {
      fail("room_read_connection_node_mismatch", "Installed-node identity did not match the connection.");
    }
    if (connection.status !== "active") {
      fail("room_read_connection_inactive", "Connection is not active.");
    }
    const capabilityIds = [...new Set(input.capabilityIds)].sort();
    if (!capabilityIds.length || capabilityIds.some((id) => !connection.capabilityIds.includes(id))) {
      fail("room_read_capability_not_granted", "Grant requested an unavailable capability.");
    }
    const identity = {
      connectionRef: connection.connectionRef,
      roomId: input.roomId,
      capabilityIds,
      policyRevision: connection.policyRevision,
      createdAt: input.createdAt,
    };
    const grant = helixRoomCapabilityGrantSchema.parse({
      schema: HELIX_ROOM_CAPABILITY_GRANT_SCHEMA,
      grant_ref: stableRef("room_capability_grant", identity),
      connection_ref: connection.connectionRef,
      owner_profile_ref: connection.ownerProfileRef,
      installed_node_ref: connection.installedNodeRef,
      room_id: input.roomId,
      environment_ref: connection.environmentRef,
      source_ref: connection.sourceRef,
      producer_epoch_ref: connection.producerEpochRef,
      capability_ids: capabilityIds,
      grant_mode: "read",
      status: "active",
      policy_revision: connection.policyRevision,
      created_at: input.createdAt,
      expires_at: input.expiresAt,
      revoked_at: null,
      ...HELIX_ROOM_CAPABILITY_NON_AUTHORITATIVE_FIELDS,
    });
    this.grants.set(grant.grant_ref, grant);
    return grant;
  }

  revokeGrant(input: {
    ownerParticipantRef: string;
    roomId: string;
    grantRef: string;
    revokedAt: string;
  }): HelixRoomCapabilityGrant {
    const owner = this.requireParticipantInRoom(input.ownerParticipantRef, input.roomId);
    const grant = this.grants.get(input.grantRef);
    if (!grant) fail("room_read_grant_not_found", "Grant was not found.");
    if (grant.room_id !== input.roomId) {
      fail("room_read_grant_wrong_room", "Grant belongs to a different room.");
    }
    if (grant.owner_profile_ref !== owner.profileRef) {
      fail("room_read_owner_mismatch", "Only the owning profile may revoke this grant.");
    }
    const revoked = helixRoomCapabilityGrantSchema.parse({
      ...grant,
      status: "revoked",
      revoked_at: input.revokedAt,
    });
    this.grants.set(revoked.grant_ref, revoked);
    return revoked;
  }

  executeRead(input: {
    requestingParticipantRef: string;
    roomId: string;
    grantRef: string;
    connectionRef: string;
    installedNodeRef: string;
    capabilityId: string;
    now: string;
  }): HelixRoomCapabilityObservation {
    const requester = this.requireParticipantInRoom(input.requestingParticipantRef, input.roomId);
    const grant = this.grants.get(input.grantRef);
    if (!grant) fail("room_read_grant_not_found", "Grant was not found.");
    if (grant.room_id !== input.roomId) {
      fail("room_read_grant_wrong_room", "Grant belongs to a different room.");
    }
    if (grant.status !== "active") {
      fail("room_read_grant_inactive", "Grant is not active.");
    }
    if (Date.parse(input.now) >= Date.parse(grant.expires_at)) {
      fail("room_read_grant_expired", "Grant has expired.");
    }
    if (grant.connection_ref !== input.connectionRef) {
      fail("room_read_connection_not_found", "Grant does not reference that connection.");
    }
    if (grant.installed_node_ref !== input.installedNodeRef) {
      fail("room_read_connection_node_mismatch", "Installed-node identity did not match the grant.");
    }
    if (!grant.capability_ids.includes(input.capabilityId)) {
      fail("room_read_capability_not_granted", "Capability is outside the grant.");
    }
    const connection = this.connections.get(grant.connection_ref);
    if (!connection) fail("room_read_connection_not_found", "Connection was not found.");
    if (connection.status !== "active") {
      fail("room_read_connection_inactive", "Connection is not active.");
    }
    if (
      connection.ownerProfileRef !== grant.owner_profile_ref ||
      connection.installedNodeRef !== grant.installed_node_ref ||
      connection.environmentRef !== grant.environment_ref ||
      connection.sourceRef !== grant.source_ref ||
      connection.producerEpochRef !== grant.producer_epoch_ref ||
      connection.policyRevision !== grant.policy_revision
    ) {
      fail("room_read_connection_inactive", "Connection authority no longer matches the grant.");
    }
    const driver = this.drivers.get(`${connection.connectionRef}\n${input.capabilityId}`);
    if (!driver) fail("room_read_capability_not_granted", "No exact read driver is registered.");
    const result = driver.read();
    const nowMs = Date.parse(input.now);
    const observedAtMs = Date.parse(result.observedAt);
    const freshnessDeadlineMs = Date.parse(result.freshnessDeadline);
    if (
      !Number.isFinite(nowMs) ||
      !Number.isFinite(observedAtMs) ||
      !Number.isFinite(freshnessDeadlineMs) ||
      observedAtMs > nowMs ||
      freshnessDeadlineMs < observedAtMs ||
      nowMs > freshnessDeadlineMs
    ) {
      fail("room_read_observation_stale", "Mock observation is stale.");
    }
    if (factsContainPrivateMaterial(result.facts)) {
      fail("room_read_observation_invalid", "Mock observation contained private material.");
    }
    const observationIdentity = {
      grantRef: grant.grant_ref,
      requester: requester.profileRef,
      participant: requester.participantRef,
      capabilityId: input.capabilityId,
      observedAt: result.observedAt,
      facts: result.facts,
    };
    const outputHash = sha256(observationIdentity);
    try {
      const observation = helixRoomCapabilityObservationSchema.parse({
        schema: HELIX_ROOM_CAPABILITY_OBSERVATION_SCHEMA,
        observation_ref: stableRef("room_capability_observation", observationIdentity),
        grant_ref: grant.grant_ref,
        connection_ref: connection.connectionRef,
        requesting_profile_ref: requester.profileRef,
        requesting_participant_ref: requester.participantRef,
        installed_node_ref: connection.installedNodeRef,
        room_id: input.roomId,
        environment_ref: connection.environmentRef,
        source_ref: connection.sourceRef,
        producer_epoch_ref: connection.producerEpochRef,
        capability_id: input.capabilityId,
        policy_revision: connection.policyRevision,
        observed_at: result.observedAt,
        freshness_deadline: result.freshnessDeadline,
        freshness_state: "fresh",
        facts: result.facts,
        output_hash: outputHash,
        commands_executed: 0,
        side_effects: false,
        environment_mutated: false,
        content_role: "environment_observation_not_assistant_answer",
        ...HELIX_ROOM_CAPABILITY_NON_AUTHORITATIVE_FIELDS,
      });
      this.observations.set(observation.observation_ref, observation);
      return observation;
    } catch {
      fail("room_read_observation_invalid", "Mock observation failed normalization.");
    }
  }

  reenterObservation(input: {
    observation: HelixRoomCapabilityObservation;
    principalRuntimeRef: string;
    turnRef: string;
  }): HelixRoomCapabilityReentry {
    const observation = helixRoomCapabilityObservationSchema.parse(input.observation);
    const issued = this.observations.get(observation.observation_ref);
    if (
      !issued ||
      issued.output_hash !== observation.output_hash ||
      JSON.stringify(stableValue(issued)) !== JSON.stringify(stableValue(observation))
    ) {
      fail(
        "room_read_observation_invalid",
        "Only the exact observation issued by this lifecycle may re-enter.",
      );
    }
    return helixRoomCapabilityReentrySchema.parse({
      schema: HELIX_ROOM_CAPABILITY_REENTRY_SCHEMA,
      reentry_ref: stableRef("room_capability_reentry", {
        observationRef: observation.observation_ref,
        turnRef: input.turnRef,
      }),
      principal_runtime_ref: input.principalRuntimeRef,
      turn_ref: input.turnRef,
      observation_ref: observation.observation_ref,
      observation_hash: observation.output_hash,
      current_turn: true,
      exact_observation_reentered: true,
      principal_runtime_count: 1,
      terminal_writer_count: 1,
      content_role: "runtime_evidence_reentry_not_assistant_answer",
      ...HELIX_ROOM_CAPABILITY_NON_AUTHORITATIVE_FIELDS,
    });
  }

  private requireParticipantInRoom(participantRef: string, roomId: string): TrustedRoomParticipant {
    const participant = this.participants.get(participantRef);
    if (!participant) {
      fail("room_read_participant_not_found", "Authenticated participant was not found.");
    }
    if (!participant.roomIds.includes(roomId)) {
      fail("room_read_participant_not_in_room", "Participant is not a member of this room.");
    }
    return participant;
  }
}
