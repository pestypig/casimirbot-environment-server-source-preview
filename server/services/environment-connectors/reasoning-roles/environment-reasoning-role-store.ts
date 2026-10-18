import crypto from "node:crypto";
import {
  buildHelixEnvironmentReasoningRoleEvent,
  buildHelixEnvironmentReasoningRoleOutput,
  evaluateHelixEnvironmentReasoningRoleCurrentness,
  helixEnvironmentReasoningRoleSha256,
  HelixEnvironmentReasoningRoleReductionError,
  reduceHelixEnvironmentReasoningRoleEvents,
  type HelixEnvironmentReasoningRoleEvent,
  type HelixEnvironmentReasoningRoleEventPayload,
  type HelixEnvironmentReasoningRoleIdentity,
  type HelixEnvironmentReasoningRoleOutput,
  type HelixEnvironmentReasoningRolePayload,
  type HelixEnvironmentReasoningRoleProjection,
} from "@shared/helix-environment-reasoning-role";
import {
  readSharedRealtimeRoomDatabase,
  withSharedRealtimeRoomTransaction,
} from "../../helix-ask/realtime-room/room-store/database";
import type { Queryable } from "../../helix-ask/realtime-room/room-store/types";
import {
  resolveCurrentEnvironmentDurableGoalIdentity,
  resolveEnvironmentDurableGoalEvidence,
  type EnvironmentDurableGoalEvidenceResolution,
  type EnvironmentDurableGoalIdentityRequest,
  type EnvironmentDurableGoalIdentityResolver,
  type EnvironmentDurableGoalEvidenceResolver,
  type EnvironmentDurableGoalTransactionRunner,
  type EnvironmentDurableGoalDatabaseReader,
} from "../goals/durable-goal-store";

export type EnvironmentReasoningRoleErrorCode =
  | "reasoning_role_goal_not_found"
  | "reasoning_role_forbidden"
  | "reasoning_role_goal_terminal"
  | "reasoning_role_goal_revision_conflict"
  | "reasoning_role_ledger_revision_conflict"
  | "reasoning_role_evidence_missing"
  | "reasoning_role_evidence_identity_mismatch"
  | "reasoning_role_output_not_found"
  | "reasoning_role_output_stale"
  | "reasoning_role_principal_turn_mismatch"
  | "reasoning_role_capability_identity_mismatch"
  | "reasoning_role_event_invalid";

export class EnvironmentReasoningRoleError extends Error {
  constructor(
    readonly code: EnvironmentReasoningRoleErrorCode,
    readonly statusCode: number,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "EnvironmentReasoningRoleError";
  }
}

export const isEnvironmentReasoningRoleError = (
  value: unknown,
): value is EnvironmentReasoningRoleError =>
  value instanceof EnvironmentReasoningRoleError;

type GoalAuthorization = {
  goal_id: string;
  owner_profile_id: string;
  room_id: string;
  participant_id: string;
  subject_native_id: string;
  status: string;
  current_sequence: number | string;
  granted_scopes: unknown;
};

type LedgerRow = {
  goal_id: string;
  owner_profile_id: string;
  room_id: string;
  current_sequence: number | string;
  latest_event_hash: string | null;
};

type EventRow = {
  event_id: string;
  goal_id: string;
  sequence: number | string;
  event_hash: string;
  event_payload: unknown;
};

const parseJson = <T>(value: unknown): T =>
  typeof value === "string" ? (JSON.parse(value) as T) : (value as T);

const readRoleEvents = async (
  db: Queryable,
  goalId: string,
): Promise<HelixEnvironmentReasoningRoleEvent[]> => {
  const result = await db.query<EventRow>(
    `SELECT event_id, goal_id, sequence, event_hash, event_payload
       FROM helix_environment_reasoning_role_events
      WHERE goal_id=$1 ORDER BY sequence ASC;`,
    [goalId],
  );
  return result.rows.map((row) => {
    const event = parseJson<HelixEnvironmentReasoningRoleEvent>(row.event_payload);
    if (
      event.event_id !== row.event_id ||
      event.goal_id !== row.goal_id ||
      event.sequence !== Number(row.sequence) ||
      event.event_hash !== row.event_hash
    ) {
      throw new EnvironmentReasoningRoleError(
        "reasoning_role_event_invalid",
        409,
        `Stored reasoning role event ${row.event_id} contradicts its canonical payload.`,
      );
    }
    return event;
  });
};

const reduceRoleEvents = (
  events: HelixEnvironmentReasoningRoleEvent[],
): HelixEnvironmentReasoningRoleProjection => {
  try {
    return reduceHelixEnvironmentReasoningRoleEvents(events);
  } catch (error) {
    if (error instanceof HelixEnvironmentReasoningRoleReductionError) {
      throw new EnvironmentReasoningRoleError(
        "reasoning_role_event_invalid",
        409,
        error.message,
        [error.code],
      );
    }
    throw error;
  }
};

const unique = (values: string[]): string[] => [...new Set(values)];

const mismatchReasons = (
  evidence: EnvironmentDurableGoalEvidenceResolution,
  identity: HelixEnvironmentReasoningRoleIdentity,
): string[] => [
  ...(evidence.roomId !== identity.room_id ? ["wrong_room"] : []),
  ...(evidence.sourceId !== identity.source_id ? ["wrong_source"] : []),
  ...(evidence.worldId !== identity.world_id ? ["wrong_world"] : []),
  ...(evidence.producerPlane !== "world_authority" &&
  evidence.producerEpochRef !== null &&
  evidence.producerEpochRef !== identity.producer_epoch_ref
    ? ["wrong_producer_epoch"]
    : []),
  ...(evidence.subjectNativeId !== null &&
  evidence.subjectNativeId !== identity.subject_native_id
    ? ["wrong_subject"]
    : []),
];

export type EnvironmentReasoningRoleIdentityRequest =
  EnvironmentDurableGoalIdentityRequest & {
    goalId: string;
    expectedGoalRevision: number;
    observationRevision: number;
    principalTurnId: string;
  };

export class EnvironmentReasoningRoleStore {
  constructor(
    private readonly transaction: EnvironmentDurableGoalTransactionRunner =
      withSharedRealtimeRoomTransaction,
    private readonly readDatabase: EnvironmentDurableGoalDatabaseReader =
      readSharedRealtimeRoomDatabase,
    private readonly resolveIdentity: EnvironmentDurableGoalIdentityResolver =
      resolveCurrentEnvironmentDurableGoalIdentity,
    private readonly resolveEvidence: EnvironmentDurableGoalEvidenceResolver =
      resolveEnvironmentDurableGoalEvidence,
  ) {}

  async inspect(input: {
    goalId: string;
    profileId: string;
    participantId: string;
  }): Promise<HelixEnvironmentReasoningRoleProjection | null> {
    const db = await this.readDatabase();
    await this.requireGoalAccess(db, input, false);
    const events = await readRoleEvents(db, input.goalId);
    return events.length > 0 ? reduceRoleEvents(events) : null;
  }

  async recordOutput(
    input: EnvironmentReasoningRoleIdentityRequest & {
      expectedLedgerRevision: number;
      producer: HelixEnvironmentReasoningRoleOutput["producer"];
      inputEvidenceRefs: string[];
      payload: HelixEnvironmentReasoningRolePayload;
      expiresAt: string;
      occurredAt?: string;
    },
  ): Promise<HelixEnvironmentReasoningRoleProjection> {
    return this.transaction(async (db) => {
      const goal = await this.requireGoalAccess(
        db,
        {
          goalId: input.goalId,
          profileId: input.ownerProfileId,
          participantId: input.participantId,
        },
        true,
      );
      this.requireGoalRevision(goal, input.expectedGoalRevision);
      const ledger = await this.lockLedger(db, goal, input.expectedLedgerRevision);
      const identityValue = await this.resolveRoleIdentity(db, goal, input);
      await this.requireEvidenceIdentity(
        db,
        identityValue,
        input.inputEvidenceRefs,
      );
      if (Date.parse(input.expiresAt) > Date.parse(identityValue.authority_expires_at)) {
        throw new EnvironmentReasoningRoleError(
          "reasoning_role_output_stale",
          409,
          "A role output cannot outlive its exact action authority.",
          ["expiry_exceeds_authority"],
        );
      }
      const output = buildHelixEnvironmentReasoningRoleOutput({
        roleOutputId: `environment_reasoning_role_output:${crypto.randomUUID()}`,
        identity: identityValue,
        producer: input.producer,
        inputEvidenceRefs: input.inputEvidenceRefs,
        payload: input.payload,
        createdAt: input.occurredAt,
        expiresAt: input.expiresAt,
      });
      return this.appendLockedEvent(db, ledger, {
        kind: "role_output_recorded",
        output,
      }, input.occurredAt);
    });
  }

  async recordPrincipalDisposition(input: {
    goalId: string;
    profileId: string;
    participantId: string;
    expectedLedgerRevision: number;
    roleOutputId: string;
    principalTurnId: string;
    disposition: "adopted" | "revised" | "ignored" | "rejected";
    adoptedCapabilityId: string | null;
    adoptedCapabilityArgumentsHash: string | null;
    rationaleSummary: string;
    occurredAt?: string;
  }): Promise<HelixEnvironmentReasoningRoleProjection> {
    return this.transaction(async (db) => {
      const goal = await this.requireGoalAccess(db, input, true);
      const ledger = await this.lockLedger(db, goal, input.expectedLedgerRevision);
      const events = await readRoleEvents(db, input.goalId);
      const output = this.requireOutput(events, input.roleOutputId);
      if (
        output.identity.principal_turn_id !== input.principalTurnId ||
        output.identity.participant_id !== input.participantId
      ) {
        throw new EnvironmentReasoningRoleError(
          "reasoning_role_principal_turn_mismatch",
          409,
          "Only the exact bound principal Runtime Codex turn may dispose this role output.",
        );
      }
      return this.appendLockedEvent(db, ledger, {
        kind: "principal_disposition_recorded",
        role_output_id: input.roleOutputId,
        disposition: input.disposition,
        principal_turn_id: input.principalTurnId,
        adopted_capability_id: input.adoptedCapabilityId,
        adopted_capability_arguments_hash: input.adoptedCapabilityArgumentsHash,
        rationale_summary: input.rationaleSummary,
      }, input.occurredAt);
    });
  }

  async arbitrate(input: EnvironmentReasoningRoleIdentityRequest & {
    expectedLedgerRevision: number;
    consideredRoleOutputIds: string[];
    selectedRoleOutputId: string | null;
    reason: string;
    now?: string;
  }): Promise<HelixEnvironmentReasoningRoleProjection> {
    return this.transaction(async (db) => {
      const goal = await this.requireGoalAccess(
        db,
        {
          goalId: input.goalId,
          profileId: input.ownerProfileId,
          participantId: input.participantId,
        },
        true,
      );
      this.requireGoalRevision(goal, input.expectedGoalRevision);
      let ledger = await this.lockLedger(db, goal, input.expectedLedgerRevision);
      let events = await readRoleEvents(db, input.goalId);
      const currentIdentity = await this.resolveRoleIdentity(db, goal, input);
      const considered = unique(input.consideredRoleOutputIds).map((id) =>
        this.requireOutput(events, id),
      );
      const currentOutputs: string[] = [];
      for (const output of considered) {
        const currentness = evaluateHelixEnvironmentReasoningRoleCurrentness({
          output,
          currentIdentity,
          now: input.now,
        });
        if (currentness.current) {
          currentOutputs.push(output.role_output_id);
          continue;
        }
        if (
          events.some(
            (event) =>
              event.payload.kind === "role_output_invalidated" &&
              event.payload.role_output_id === output.role_output_id,
          )
        ) continue;
        const invalidationReason =
          currentness.reason === "goal_revision_stale"
            ? "goal_revision_advanced"
            : currentness.reason === "observation_revision_stale"
              ? "observation_revision_advanced"
              : currentness.reason === "authority_mismatch" ||
                  currentness.reason === "authority_expired"
                ? "authority_changed"
                : currentness.reason === "role_output_expired"
                  ? "expired"
                  : "identity_changed";
        const projection = await this.appendLockedEvent(db, ledger, {
          kind: "role_output_invalidated",
          role_output_id: output.role_output_id,
          reason: invalidationReason,
          superseding_goal_revision: currentIdentity.goal_revision,
          superseding_observation_revision:
            currentIdentity.observation_revision,
          evidence_refs: [],
        }, input.now);
        ledger = {
          ...ledger,
          current_sequence: projection.revision,
          latest_event_hash: projection.latest_event_hash,
        };
        events = await readRoleEvents(db, input.goalId);
      }

      if (
        input.selectedRoleOutputId &&
        !currentOutputs.includes(input.selectedRoleOutputId)
      ) {
        throw new EnvironmentReasoningRoleError(
          "reasoning_role_output_stale",
          409,
          "The selected supporting-role output is not current.",
        );
      }
      const status = input.selectedRoleOutputId
        ? "selected_one"
        : currentOutputs.length === 0
          ? "none_current"
          : "conflict_rejected";
      return this.appendLockedEvent(db, ledger, {
        kind: "proposal_arbitrated",
        arbitration_id: `environment_reasoning_arbitration:${crypto.randomUUID()}`,
        considered_role_output_ids: unique(input.consideredRoleOutputIds),
        selected_role_output_id: input.selectedRoleOutputId,
        status,
        reason: input.reason,
      }, input.now);
    });
  }

  async linkExecution(input: {
    goalId: string;
    profileId: string;
    participantId: string;
    expectedLedgerRevision: number;
    arbitrationId: string;
    roleOutputId: string;
    environmentActionRequestId: string;
    capabilityId: string;
    occurredAt?: string;
  }): Promise<HelixEnvironmentReasoningRoleProjection> {
    return this.appendInternalLink(input, {
      kind: "execution_link_recorded",
      arbitration_id: input.arbitrationId,
      role_output_id: input.roleOutputId,
      environment_action_request_id: input.environmentActionRequestId,
      capability_id: input.capabilityId,
    });
  }

  async linkMeasuredResult(input: {
    goalId: string;
    profileId: string;
    participantId: string;
    expectedLedgerRevision: number;
    environmentActionRequestId: string;
    environmentActionResultRef: string;
    principalTurnId: string;
    reentryObservationRef: string;
    occurredAt?: string;
  }): Promise<HelixEnvironmentReasoningRoleProjection> {
    return this.appendInternalLink(input, {
      kind: "measured_result_link_recorded",
      environment_action_request_id: input.environmentActionRequestId,
      environment_action_result_ref: input.environmentActionResultRef,
      principal_turn_id: input.principalTurnId,
      reentry_observation_ref: input.reentryObservationRef,
    });
  }

  async linkCompletedPrincipalExecution(input: {
    profileId: string;
    participantId: string;
    roomId: string;
    principalTurnId: string;
    capabilityId: string;
    capabilityArguments: Record<string, unknown>;
    environmentActionRequestId: string;
    environmentActionResultRef: string;
    reentryObservationRef: string;
    occurredAt?: string;
  }): Promise<HelixEnvironmentReasoningRoleProjection | null> {
    return this.transaction(async (db) => {
      const ledgers = await db.query<{ goal_id: string }>(
        `SELECT l.goal_id
           FROM helix_environment_reasoning_role_ledgers l
           INNER JOIN helix_environment_durable_goals g ON g.goal_id=l.goal_id
           INNER JOIN helix_environment_durable_goal_participants p ON p.goal_id=g.goal_id
          WHERE g.room_id=$1 AND p.profile_id=$2 AND p.participant_id=$3
            AND p.status='active' AND g.status='active'
          ORDER BY l.updated_at DESC LIMIT 16;`,
        [input.roomId, input.profileId, input.participantId],
      );
      const argumentsHash = helixEnvironmentReasoningRoleSha256(
        input.capabilityArguments,
      );
      const candidates: Array<{
        goalId: string;
        projection: HelixEnvironmentReasoningRoleProjection;
        arbitrationId: string;
        roleOutputId: string;
      }> = [];
      for (const row of ledgers.rows) {
        await this.requireGoalAccess(
          db,
          {
            goalId: row.goal_id,
            profileId: input.profileId,
            participantId: input.participantId,
          },
          true,
        );
        const events = await readRoleEvents(db, row.goal_id);
        if (events.length === 0) continue;
        const projection = reduceRoleEvents(events);
        const dispositions = new Map(
          projection.principal_dispositions.map((entry) => [
            entry.role_output_id,
            entry,
          ]),
        );
        const outputs = new Map(
          projection.outputs.map((entry) => [entry.role_output_id, entry]),
        );
        const linked = new Set(
          projection.execution_links.map((entry) => entry.arbitration_id),
        );
        for (const arbitration of [...projection.arbitrations].reverse()) {
          const roleOutputId = arbitration.selected_role_output_id;
          if (
            arbitration.status !== "selected_one" ||
            !roleOutputId ||
            linked.has(arbitration.arbitration_id) ||
            projection.invalidated_output_ids.includes(roleOutputId)
          ) {
            continue;
          }
          const output = outputs.get(roleOutputId);
          const disposition = dispositions.get(roleOutputId);
          if (
            !output ||
            output.identity.principal_turn_id !== input.principalTurnId ||
            output.payload.role_kind !== "prospective_planning" ||
            !["adopted", "revised"].includes(disposition?.disposition ?? "") ||
            disposition?.adopted_capability_id !== input.capabilityId ||
            disposition.adopted_capability_arguments_hash !== argumentsHash
          ) {
            continue;
          }
          candidates.push({
            goalId: row.goal_id,
            projection,
            arbitrationId: arbitration.arbitration_id,
            roleOutputId,
          });
          break;
        }
      }
      if (candidates.length === 0) return null;
      if (candidates.length > 1) {
        throw new EnvironmentReasoningRoleError(
          "reasoning_role_event_invalid",
          409,
          "More than one current G6 arbitration matches this principal action.",
        );
      }
      const selected = candidates[0];
      const goal = await this.requireGoalAccess(
        db,
        {
          goalId: selected.goalId,
          profileId: input.profileId,
          participantId: input.participantId,
        },
        true,
      );
      const ledger = await this.lockLedger(
        db,
        goal,
        selected.projection.revision,
      );
      const executionProjection = await this.appendLockedEvent(
        db,
        ledger,
        {
          kind: "execution_link_recorded",
          arbitration_id: selected.arbitrationId,
          role_output_id: selected.roleOutputId,
          environment_action_request_id: input.environmentActionRequestId,
          capability_id: input.capabilityId,
        },
        input.occurredAt,
      );
      return this.appendLockedEvent(
        db,
        {
          ...ledger,
          current_sequence: executionProjection.revision,
          latest_event_hash: executionProjection.latest_event_hash,
        },
        {
          kind: "measured_result_link_recorded",
          environment_action_request_id: input.environmentActionRequestId,
          environment_action_result_ref: input.environmentActionResultRef,
          principal_turn_id: input.principalTurnId,
          reentry_observation_ref: input.reentryObservationRef,
        },
        input.occurredAt,
      );
    });
  }

  private async appendInternalLink(
    input: {
      goalId: string;
      profileId: string;
      participantId: string;
      expectedLedgerRevision: number;
      occurredAt?: string;
    },
    payload: HelixEnvironmentReasoningRoleEventPayload,
  ): Promise<HelixEnvironmentReasoningRoleProjection> {
    return this.transaction(async (db) => {
      const goal = await this.requireGoalAccess(db, input, true);
      const ledger = await this.lockLedger(db, goal, input.expectedLedgerRevision);
      return this.appendLockedEvent(db, ledger, payload, input.occurredAt);
    });
  }

  private async requireGoalAccess(
    db: Queryable,
    input: { goalId: string; profileId: string; participantId: string },
    requireSteer: boolean,
  ): Promise<GoalAuthorization> {
    const result = await db.query<GoalAuthorization>(
      `SELECT g.*, p.scopes AS granted_scopes
         FROM helix_environment_durable_goals g
         INNER JOIN helix_environment_durable_goal_participants p
           ON p.goal_id=g.goal_id
        WHERE g.goal_id=$1 AND p.profile_id=$2 AND p.participant_id=$3
          AND p.status='active' LIMIT 1;`,
      [input.goalId, input.profileId, input.participantId],
    );
    const goal = result.rows[0];
    if (!goal) {
      throw new EnvironmentReasoningRoleError(
        "reasoning_role_goal_not_found",
        404,
        "The durable environment goal was not found.",
      );
    }
    const scopes = parseJson<string[]>(goal.granted_scopes ?? []);
    if (!scopes.includes("read") || (requireSteer && !scopes.includes("steer"))) {
      throw new EnvironmentReasoningRoleError(
        "reasoning_role_forbidden",
        403,
        "This participant lacks the required durable-goal scope.",
      );
    }
    if (requireSteer && ["completed", "canceled"].includes(goal.status)) {
      throw new EnvironmentReasoningRoleError(
        "reasoning_role_goal_terminal",
        409,
        "A terminal durable goal cannot accept new concurrent reasoning work.",
      );
    }
    return goal;
  }

  private requireGoalRevision(goal: GoalAuthorization, expected: number): void {
    if (Number(goal.current_sequence) !== expected) {
      throw new EnvironmentReasoningRoleError(
        "reasoning_role_goal_revision_conflict",
        409,
        `Expected durable-goal revision ${expected}; current revision is ${Number(goal.current_sequence)}.`,
      );
    }
  }

  private async lockLedger(
    db: Queryable,
    goal: GoalAuthorization,
    expectedRevision: number,
  ): Promise<LedgerRow> {
    let result = await db.query<LedgerRow>(
      `SELECT * FROM helix_environment_reasoning_role_ledgers
        WHERE goal_id=$1 FOR UPDATE;`,
      [goal.goal_id],
    );
    if (!result.rows[0]) {
      if (expectedRevision !== 0) {
        throw new EnvironmentReasoningRoleError(
          "reasoning_role_ledger_revision_conflict",
          409,
          "The reasoning role ledger has not been created.",
        );
      }
      await db.query(
        `INSERT INTO helix_environment_reasoning_role_ledgers(
           goal_id, owner_profile_id, room_id
         ) VALUES ($1,$2,$3);`,
        [goal.goal_id, goal.owner_profile_id, goal.room_id],
      );
      result = await db.query<LedgerRow>(
        `SELECT * FROM helix_environment_reasoning_role_ledgers
          WHERE goal_id=$1 FOR UPDATE;`,
        [goal.goal_id],
      );
    }
    const ledger = result.rows[0]!;
    if (Number(ledger.current_sequence) !== expectedRevision) {
      throw new EnvironmentReasoningRoleError(
        "reasoning_role_ledger_revision_conflict",
        409,
        `Expected reasoning-role revision ${expectedRevision}; current revision is ${Number(ledger.current_sequence)}.`,
      );
    }
    return ledger;
  }

  private async resolveRoleIdentity(
    db: Queryable,
    goal: GoalAuthorization,
    input: EnvironmentReasoningRoleIdentityRequest,
  ): Promise<HelixEnvironmentReasoningRoleIdentity> {
    const durableIdentity = await this.resolveIdentity(db, {
      ...input,
      ownerProfileId: goal.owner_profile_id,
      goalOwnerParticipantId: goal.participant_id,
      authorityParticipantId: goal.participant_id,
      subjectNativeId: goal.subject_native_id,
      turnId: input.principalTurnId,
    });
    return {
      owner_profile_id: durableIdentity.owner_profile_id,
      room_id: durableIdentity.room_id,
      participant_id: input.participantId,
      environment_binding_id: durableIdentity.environment_binding_id,
      room_source_binding_id: durableIdentity.room_source_binding_id,
      source_id: durableIdentity.source_id,
      world_id: durableIdentity.world_id,
      producer_epoch_ref: durableIdentity.producer_epoch_ref,
      subject_binding_id: durableIdentity.subject_binding_id,
      subject_native_id: durableIdentity.subject_native_id,
      action_authority_id: durableIdentity.action_authority_id,
      authority_policy_version: durableIdentity.authority_policy_version,
      authority_expires_at: durableIdentity.authority_expires_at,
      goal_id: input.goalId,
      goal_revision: input.expectedGoalRevision,
      observation_revision: input.observationRevision,
      principal_turn_id: input.principalTurnId,
    };
  }

  private async requireEvidenceIdentity(
    db: Queryable,
    identity: HelixEnvironmentReasoningRoleIdentity,
    refs: string[],
  ): Promise<void> {
    const uniqueRefs = unique(refs);
    if (uniqueRefs.length === 0) {
      throw new EnvironmentReasoningRoleError(
        "reasoning_role_evidence_missing",
        409,
        "A concurrent reasoning role requires current environment evidence.",
      );
    }
    const resolved = await this.resolveEvidence(db, uniqueRefs);
    const missing = resolved.filter((entry) => !entry.found).map((entry) => entry.ref);
    if (missing.length > 0) {
      throw new EnvironmentReasoningRoleError(
        "reasoning_role_evidence_missing",
        409,
        "One or more role input evidence refs were not found.",
        missing,
      );
    }
    const mismatched = resolved.filter(
      (entry) => mismatchReasons(entry, identity).length > 0,
    );
    if (mismatched.length > 0) {
      throw new EnvironmentReasoningRoleError(
        "reasoning_role_evidence_identity_mismatch",
        409,
        "Role input evidence belongs to another room, source, world, epoch, or subject.",
        unique(mismatched.flatMap((entry) => mismatchReasons(entry, identity))),
      );
    }
    if (!resolved.some((entry) => entry.observationRevision === identity.observation_revision)) {
      throw new EnvironmentReasoningRoleError(
        "reasoning_role_evidence_identity_mismatch",
        409,
        "The claimed observation revision is absent from the admitted evidence.",
        ["observation_revision_missing"],
      );
    }
  }

  private requireOutput(
    events: HelixEnvironmentReasoningRoleEvent[],
    roleOutputId: string,
  ): HelixEnvironmentReasoningRoleOutput {
    const output = events.find(
      (event) =>
        event.payload.kind === "role_output_recorded" &&
        event.payload.output.role_output_id === roleOutputId,
    );
    if (!output || output.payload.kind !== "role_output_recorded") {
      throw new EnvironmentReasoningRoleError(
        "reasoning_role_output_not_found",
        404,
        "The concurrent reasoning role output was not found.",
      );
    }
    return output.payload.output;
  }

  private async appendLockedEvent(
    db: Queryable,
    ledger: LedgerRow,
    payload: HelixEnvironmentReasoningRoleEventPayload,
    occurredAt?: string,
  ): Promise<HelixEnvironmentReasoningRoleProjection> {
    const existingEvents = await readRoleEvents(db, ledger.goal_id);
    const event = buildHelixEnvironmentReasoningRoleEvent({
      eventId: `environment_reasoning_role_event:${crypto.randomUUID()}`,
      goalId: ledger.goal_id,
      sequence: Number(ledger.current_sequence) + 1,
      previousEventHash: ledger.latest_event_hash,
      payload,
      occurredAt,
    });
    const projection = reduceRoleEvents([...existingEvents, event]);
    await db.query(
      `INSERT INTO helix_environment_reasoning_role_events(
         event_id, goal_id, sequence, event_kind, previous_event_hash,
         event_hash, event_payload, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8);`,
      [
        event.event_id,
        event.goal_id,
        event.sequence,
        event.payload.kind,
        event.previous_event_hash,
        event.event_hash,
        JSON.stringify(event),
        event.occurred_at,
      ],
    );
    await db.query(
      `UPDATE helix_environment_reasoning_role_ledgers
          SET current_sequence=$2, latest_event_hash=$3, updated_at=now()
        WHERE goal_id=$1;`,
      [ledger.goal_id, projection.revision, projection.latest_event_hash],
    );
    return projection;
  }
}

export const environmentReasoningRoleStore =
  new EnvironmentReasoningRoleStore();
