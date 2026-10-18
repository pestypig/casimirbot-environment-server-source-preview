import {
  helixEnvironmentDurableGoalSha256,
  type HelixEnvironmentDurableGoalIdentity,
  type HelixEnvironmentDurableGoalObjective,
  type HelixEnvironmentDurableGoalProjection,
} from "@shared/helix-environment-durable-goal";
import {
  withSharedRealtimeRoomTransaction,
} from "../../helix-ask/realtime-room/room-store/database";
import type { Queryable } from
  "../../helix-ask/realtime-room/room-store/types";
import {
  createPaperTradingAccount,
  type PaperTradingAccountProjection,
} from "../../trading/paper-trading-store";
import { readUsMarketClock } from "../../trading/us-market-clock";
import {
  EnvironmentDurableGoalError,
  EnvironmentDurableGoalStore,
  type EnvironmentDurableGoalIdentityRequest,
  type EnvironmentDurableGoalIdentityResolver,
} from "../goals/durable-goal-store";

export const HELIX_BROKERAGE_RESIDENT_OBSERVER_PROFILE_ID =
  "resident.brokerage.market_observer.v1" as const;
export const HELIX_BROKERAGE_RESIDENT_OBSERVER_WORLD_ID =
  "brokerage:robinhood:agentic" as const;

type BrokerageResidentIdentityRow = {
  owner_profile_id: string;
  room_status: string;
  active_members: number | string;
  participant_id: string;
  connection_id: string;
  connection_status: string;
  producer_epoch_ref: string;
  binding_id: string;
  binding_status: string;
  private_only: boolean;
  consent_capability_ids: unknown;
  account_id: string;
  paper_status: string;
  run_id: string;
  run_owner_profile_id: string;
  run_lifecycle_status: string;
  run_expires_at: Date | string;
  run_room_binding_status: string;
};

const parseStringArray = (value: unknown): string[] => {
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
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export const buildBrokerageResidentObserverObjective =
  (): HelixEnvironmentDurableGoalObjective => ({
    objective_text:
      "Observe the profile-owned Robinhood environment through fresh read-only evidence, process only deterministic local paper state, and prove ordered delivery, acknowledgement, reconnect deduplication, revocation, and stale-epoch rejection before any live-order qualification.",
    goal_kind: "robinhood_shadow_observation",
    domain: "brokerage",
    provider: "robinhood",
    controller_profile_id: HELIX_BROKERAGE_RESIDENT_OBSERVER_PROFILE_ID,
    reaction_requirement: "monitor_only",
    milestones: [
      {
        milestone_id: "brokerage_observer:identity_bound",
        description:
          "Bind the exact profile, private room, Robinhood connection epoch, paper account, durable run, and monitor continuation.",
        dependency_milestone_ids: [],
        required_postcondition_ids: [
          "brokerage_observer:exact_identity_bound",
        ],
      },
      {
        milestone_id: "brokerage_observer:semantic_delivery",
        description:
          "Deliver and acknowledge one material deterministic paper observation while suppressing an equivalent no-change cycle.",
        dependency_milestone_ids: [
          "brokerage_observer:identity_bound",
        ],
        required_postcondition_ids: [
          "brokerage_observer:material_delivery_acknowledged",
          "brokerage_observer:no_change_suppressed",
        ],
      },
      {
        milestone_id: "brokerage_observer:recovery_verified",
        description:
          "Reconnect without duplicate processing or wake, then prove revocation and stale producer epochs fail closed.",
        dependency_milestone_ids: [
          "brokerage_observer:semantic_delivery",
        ],
        required_postcondition_ids: [
          "brokerage_observer:reconnect_deduplicated",
          "brokerage_observer:revocation_fail_closed",
          "brokerage_observer:stale_epoch_rejected",
        ],
      },
    ],
  });

export const resolveBrokerageResidentGoalIdentity:
  EnvironmentDurableGoalIdentityResolver = async (db, request) => {
    if (!request.runId) {
      throw new EnvironmentDurableGoalError(
        "durable_goal_identity_unavailable",
        409,
        "The brokerage resident goal requires an owner-scoped durable run.",
      );
    }
    const result = await db.query<BrokerageResidentIdentityRow>(
      `SELECT r.owner_profile_id, r.status AS room_status,
              room_member_count.active_members,
              member.participant_id,
              connection.connection_id,
              connection.status AS connection_status,
              connection.producer_epoch_ref,
              binding.binding_id,
              binding.status AS binding_status,
              binding.private_only,
              binding.consent_capability_ids,
              paper.account_id,
              paper.status AS paper_status,
              run.run_id,
              run.account_profile_id AS run_owner_profile_id,
              run.lifecycle_status AS run_lifecycle_status,
              run.expires_at AS run_expires_at,
              run_binding.status AS run_room_binding_status
         FROM helix_shared_realtime_rooms r
         INNER JOIN helix_shared_realtime_room_members member
           ON member.room_id=r.room_id
          AND member.profile_id=r.owner_profile_id
          AND member.member_role='owner'
          AND member.presence <> 'left'
         INNER JOIN (
           SELECT room_id, count(*) AS active_members
             FROM helix_shared_realtime_room_members
            WHERE presence <> 'left'
            GROUP BY room_id
         ) room_member_count
           ON room_member_count.room_id=r.room_id
         INNER JOIN helix_brokerage_connections connection
           ON connection.owner_profile_id=r.owner_profile_id
          AND connection.connection_id=$5
         INNER JOIN helix_brokerage_room_bindings binding
           ON binding.connection_id=connection.connection_id
          AND binding.owner_profile_id=connection.owner_profile_id
          AND binding.room_id=r.room_id
          AND binding.binding_id=$1
         INNER JOIN helix_paper_trading_accounts paper
           ON paper.owner_profile_id=connection.owner_profile_id
          AND paper.connection_id=connection.connection_id
          AND paper.room_id=r.room_id
          AND paper.account_id=$6
         INNER JOIN helix_agent_runs run
           ON run.run_id=$7
         INNER JOIN helix_agent_run_room_bindings run_binding
           ON run_binding.run_id=run.run_id
          AND run_binding.room_id=r.room_id
          AND run_binding.account_profile_id=r.owner_profile_id
        WHERE r.room_id=$2 AND r.owner_profile_id=$3
          AND member.participant_id=$4
        LIMIT 1;`,
      [
        request.environmentBindingId,
        request.roomId,
        request.ownerProfileId,
        request.participantId,
        request.subjectNativeId,
        request.actionAuthorityId,
        request.runId,
      ],
    );
    const row = result.rows[0];
    const runExpiresAt = row ? Date.parse(iso(row.run_expires_at)) : NaN;
    const readCapabilities = row
      ? parseStringArray(row.consent_capability_ids)
      : [];
    const mismatchReasons = [
      !row && "brokerage_identity_not_found",
      row?.owner_profile_id !== request.ownerProfileId && "owner_profile_id",
      row?.room_status === "closed" && "room_status",
      Number(row?.active_members ?? 0) !== 1 && "room_privacy",
      row?.participant_id !== request.participantId && "participant_id",
      row?.connection_id !== request.subjectNativeId && "connection_id",
      row?.connection_status !== "connected" && "connection_status",
      row?.binding_id !== request.environmentBindingId && "binding_id",
      row?.binding_status !== "active" && "binding_status",
      row?.private_only !== true && "binding_privacy",
      !readCapabilities.includes("brokerage.robinhood.market_data.read") &&
        "market_data_read_capability",
      row?.account_id !== request.actionAuthorityId && "paper_account_id",
      row?.paper_status !== "active" && "paper_account_status",
      row?.run_id !== request.runId && "run_id",
      row?.run_owner_profile_id !== request.ownerProfileId &&
        "run_owner_profile_id",
      !["queued", "running", "waiting"].includes(
        row?.run_lifecycle_status ?? "",
      ) && "run_lifecycle_status",
      (!Number.isFinite(runExpiresAt) || runExpiresAt <= Date.now()) &&
        "run_expiry",
      row?.run_room_binding_status !== "active" && "run_room_binding_status",
    ].filter((entry): entry is string => Boolean(entry));
    if (!row || mismatchReasons.length > 0) {
      throw new EnvironmentDurableGoalError(
        "durable_goal_identity_mismatch",
        409,
        "The brokerage resident goal identity is absent, stale, non-private, or inconsistent with its owner-scoped run.",
        [],
        mismatchReasons,
      );
    }
    return {
      owner_profile_id: row.owner_profile_id,
      host_ref: "brokerage_host:robinhood",
      connector_installation_id: row.connection_id,
      device_id: row.connection_id,
      environment_binding_id: row.binding_id,
      room_source_binding_id: row.binding_id,
      room_id: request.roomId,
      goal_owner_participant_id:
        request.goalOwnerParticipantId ?? row.participant_id,
      participant_id: request.participantId,
      authority_participant_id:
        request.authorityParticipantId ?? row.participant_id,
      // The resident observer's measured subject is the local simulated paper
      // account. The Robinhood room binding remains the environment boundary.
      subject_binding_id: row.account_id,
      subject_native_id: row.connection_id,
      source_id: row.connection_id,
      world_id: row.account_id,
      producer_epoch_ref: row.producer_epoch_ref,
      action_authority_id: row.account_id,
      authority_policy_version: 1,
      authority_expires_at: iso(row.run_expires_at),
      run_id: row.run_id,
      turn_id: request.turnId,
    } satisfies HelixEnvironmentDurableGoalIdentity;
  };

export type BrokerageResidentBootstrapInput = {
  ownerProfileId: string;
  roomId: string;
  participantId: string;
  connectionId: string;
  runId: string;
  turnId: string;
  startingEquityCents: number;
  now?: Date;
};

export type BrokerageResidentBootstrapResult = {
  paperAccount: PaperTradingAccountProjection;
  goal: HelixEnvironmentDurableGoalProjection;
  idempotencyReplayed: boolean;
};

const readExistingGoalId = async (input: {
  db: Queryable;
  ownerProfileId: string;
  roomId: string;
  participantId: string;
  connectionId: string;
  bindingId: string;
  paperAccountId: string;
  runId: string;
  objectiveHash: string;
}): Promise<string | null> => {
  const result = await input.db.query<{ goal_id: string }>(
    `SELECT goal.goal_id
       FROM helix_environment_durable_goals goal
       INNER JOIN helix_environment_durable_goal_events event
         ON event.goal_id=goal.goal_id AND event.sequence=1
      WHERE goal.owner_profile_id=$1 AND goal.room_id=$2
        AND goal.participant_id=$3
        AND goal.environment_binding_id=$4
        AND goal.subject_native_id=$5
        AND goal.objective_hash=$6
        AND event.action_authority_id=$7
        AND event.run_id=$8
      ORDER BY event.occurred_at ASC
      LIMIT 1;`,
    [
      input.ownerProfileId,
      input.roomId,
      input.participantId,
      input.bindingId,
      input.connectionId,
      input.objectiveHash,
      input.paperAccountId,
      input.runId,
    ],
  );
  return result.rows[0]?.goal_id ?? null;
};

export const bootstrapBrokerageResidentObserver = async (
  input: BrokerageResidentBootstrapInput,
): Promise<BrokerageResidentBootstrapResult> => {
  const now = input.now ?? new Date();
  const paperAccount = await createPaperTradingAccount({
    ownerProfileId: input.ownerProfileId,
    connectionId: input.connectionId,
    roomId: input.roomId,
    startingEquityCents: input.startingEquityCents,
    tradingDay: readUsMarketClock(now).tradingDate,
    now,
  });
  const objective = buildBrokerageResidentObserverObjective();
  const objectiveHash = helixEnvironmentDurableGoalSha256(objective);
  return withSharedRealtimeRoomTransaction(async (db) => {
    const locked = await db.query<{
      account_id: string;
      starting_equity_cents: number | string;
    }>(
      `SELECT account_id, starting_equity_cents
         FROM helix_paper_trading_accounts
        WHERE account_id=$1 AND owner_profile_id=$2 AND connection_id=$3
          AND room_id=$4 AND status='active'
        LIMIT 1 FOR UPDATE;`,
      [
        paperAccount.account_id,
        input.ownerProfileId,
        input.connectionId,
        input.roomId,
      ],
    );
    if (!locked.rows[0]) {
      throw new EnvironmentDurableGoalError(
        "durable_goal_identity_unavailable",
        409,
        "The room-scoped paper account became unavailable during resident-goal creation.",
      );
    }
    if (Number(locked.rows[0].starting_equity_cents) !==
        input.startingEquityCents) {
      throw new EnvironmentDurableGoalError(
        "durable_goal_identity_mismatch",
        409,
        "The existing room-scoped paper account was initialized with a different starting equity.",
        [],
        ["paper_starting_equity_conflict"],
      );
    }
    const binding = await db.query<{ binding_id: string }>(
      `SELECT binding_id FROM helix_brokerage_room_bindings
        WHERE connection_id=$1 AND owner_profile_id=$2 AND room_id=$3
          AND status='active' AND private_only=true
        LIMIT 1;`,
      [input.connectionId, input.ownerProfileId, input.roomId],
    );
    const bindingId = binding.rows[0]?.binding_id;
    if (!bindingId) {
      throw new EnvironmentDurableGoalError(
        "durable_goal_identity_unavailable",
        409,
        "The active private Robinhood room binding became unavailable during resident-goal creation.",
      );
    }
    const readDatabase = async (): Promise<Queryable> => db;
    const transaction = async <T>(
      handler: (transactionDb: Queryable) => Promise<T>,
    ): Promise<T> => handler(db);
    const store = new EnvironmentDurableGoalStore(
      transaction,
      resolveBrokerageResidentGoalIdentity,
      undefined,
      readDatabase,
    );
    const identityRequest: EnvironmentDurableGoalIdentityRequest = {
      ownerProfileId: input.ownerProfileId,
      roomId: input.roomId,
      participantId: input.participantId,
      environmentBindingId: bindingId,
      subjectNativeId: input.connectionId,
      actionAuthorityId: paperAccount.account_id,
      runId: input.runId,
      turnId: input.turnId,
    };
    const existingGoalId = await readExistingGoalId({
      db,
      ownerProfileId: input.ownerProfileId,
      roomId: input.roomId,
      participantId: input.participantId,
      connectionId: input.connectionId,
      bindingId: identityRequest.environmentBindingId,
      paperAccountId: paperAccount.account_id,
      runId: input.runId,
      objectiveHash,
    });
    if (existingGoalId) {
      return {
        paperAccount,
        goal: await store.inspect({
          goalId: existingGoalId,
          profileId: input.ownerProfileId,
          participantId: input.participantId,
        }),
        idempotencyReplayed: true,
      };
    }
    return {
      paperAccount,
      goal: await store.create({
        ...identityRequest,
        objective,
        occurredAt: now.toISOString(),
      }),
      idempotencyReplayed: false,
    };
  });
};
