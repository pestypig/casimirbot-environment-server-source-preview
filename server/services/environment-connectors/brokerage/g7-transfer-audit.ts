import {
  HELIX_BROKERAGE_SHADOW_MARKET_SESSION_CONTRACT,
  helixBrokerageObservationSchema,
  type HelixBrokerageObservation,
  type HelixRobinhoodReadOnlyUpstreamTool,
} from "@shared/helix-brokerage-environment";

export type G7BrokerageTransferStage =
  | "reference_execution"
  | "mcp_execution"
  | "ask_execution"
  | "evidence_reentry"
  | "terminal_authority"
  | "presentation";

export type G7BrokerageTransferCheck = Readonly<{
  stage: G7BrokerageTransferStage;
  check: string;
  ok: boolean;
  detail: string;
}>;

export type G7BrokerageTransferAudit = Readonly<{
  schema: "helix.g7_brokerage_transfer_audit.v1";
  ok: boolean;
  first_divergence_stage: G7BrokerageTransferStage | null;
  checks: readonly G7BrokerageTransferCheck[];
  projection_contradictions: readonly string[];
  canonical_ask_observation_id: string | null;
  canonical_terminal_text: string | null;
  mutation_tool_calls_made: number;
  market_session_contract: typeof HELIX_BROKERAGE_SHADOW_MARKET_SESSION_CONTRACT;
  answer_authority: false;
  assistant_answer: false;
  terminal_eligible: false;
}>;

type ExpectedIdentity = Readonly<{
  account_session_id: string;
  owner_profile_id: string;
  source_binding_id: string;
  connection_id: string;
  room_id: string;
  upstream_tool: HelixRobinhoodReadOnlyUpstreamTool;
  capability_id: string;
  producer_epoch_ref: string;
  input_hash: string;
}>;

type RouteAuthorityIdentity = Readonly<{
  account_session_id: string;
  owner_profile_id: string;
  source_binding_id: string;
}>;

type SupportingRoleAuthority = Readonly<{
  artifact_count: number;
  all_revision_current: boolean;
  mutation_authority_granted: boolean;
  terminal_authority_granted: boolean;
  financial_recommendation_authority_granted: boolean;
}>;

type CanonicalAskLifecycle = Readonly<{
  executed: boolean;
  normalized: boolean;
  reentered_observation_refs: readonly string[];
  reentered_observation_hashes: Readonly<Record<string, string>>;
  solver_completed: boolean;
  terminal_authority_granted: boolean;
  selected_terminal_support_refs: readonly string[];
  selected_terminal_support_hashes: Readonly<Record<string, string>>;
  terminal_text: string | null;
  api_text: string | null;
  voice_text?: string | null;
  mutation_tool_calls_made: number;
  supporting_role_authority?: SupportingRoleAuthority | null;
}>;

type DownstreamProjection = Readonly<{
  execution_status?: "executed" | "not_executed" | null;
  observation_reentered?: boolean | null;
  terminal_text?: string | null;
}>;

const MAX_FUTURE_SKEW_MS = 5_000;

const checkObservation = (input: {
  stage: Extract<
    G7BrokerageTransferStage,
    "reference_execution" | "mcp_execution" | "ask_execution"
  >;
  value: unknown;
  authority: RouteAuthorityIdentity;
  expected: ExpectedIdentity;
  nowMs: number;
  maxAgeMs: number;
}): {
  checks: G7BrokerageTransferCheck[];
  observation: HelixBrokerageObservation | null;
} => {
  const checks: G7BrokerageTransferCheck[] = [];
  const parsed = helixBrokerageObservationSchema.safeParse(input.value);
  checks.push({
    stage: input.stage,
    check: "canonical_observation_schema",
    ok: parsed.success,
    detail: parsed.success
      ? "Observation matches helix.brokerage_observation.v1."
      : "Observation is outside the canonical brokerage schema.",
  });
  if (!parsed.success) return { checks, observation: null };

  const observation = parsed.data;
  const authorityIdentityOk =
    input.authority.account_session_id === input.expected.account_session_id &&
    input.authority.owner_profile_id === input.expected.owner_profile_id &&
    input.authority.source_binding_id === input.expected.source_binding_id;
  checks.push({
    stage: input.stage,
    check: "exact_server_authority_identity",
    ok: authorityIdentityOk,
    detail: authorityIdentityOk
      ? "The server-derived account session, owner profile, and private-room source binding match."
      : "The route used a different or missing account, owner, or source-binding authority identity.",
  });
  const identityOk =
    observation.connection_id === input.expected.connection_id &&
    observation.room_id === input.expected.room_id &&
    observation.upstream_tool === input.expected.upstream_tool &&
    observation.capability_id === input.expected.capability_id &&
    observation.producer_epoch_ref === input.expected.producer_epoch_ref &&
    observation.input_hash === input.expected.input_hash;
  checks.push({
    stage: input.stage,
    check: "exact_identity_and_input_hash",
    ok: identityOk,
    detail: identityOk
      ? "Connection, room, tool, capability, producer epoch, and input hash match."
      : "At least one required identity or input-hash field diverged.",
  });

  const observedMs = Date.parse(observation.observed_at);
  const fresh = Number.isFinite(observedMs) &&
    observedMs <= input.nowMs + MAX_FUTURE_SKEW_MS &&
    input.nowMs - observedMs <= input.maxAgeMs;
  checks.push({
    stage: input.stage,
    check: "current_observation_freshness",
    ok: fresh,
    detail: fresh
      ? "Observation is inside the accepted current-state window."
      : "Observation is stale or future-dated.",
  });

  const boundaryOk = observation.read_only &&
    !observation.live_order_execution_enabled &&
    !observation.credential_included &&
    !observation.account_numbers_included &&
    !observation.raw_provider_payload_included &&
    !observation.answer_authority &&
    !observation.assistant_answer &&
    !observation.terminal_eligible;
  checks.push({
    stage: input.stage,
    check: "read_only_nonterminal_boundary",
    ok: boundaryOk,
    detail: boundaryOk
      ? "Observation is redacted, read-only, and nonterminal."
      : "Observation crossed a credential, mutation, or answer-authority boundary.",
  });
  return { checks, observation };
};

export type G7BrokerageTransferAuditInput = Readonly<{
  expected: ExpectedIdentity;
  reference_observation: unknown;
  reference_authority: RouteAuthorityIdentity;
  mcp_observation: unknown;
  mcp_authority: RouteAuthorityIdentity;
  ask_observation: unknown;
  ask_authority: RouteAuthorityIdentity;
  ask_lifecycle: CanonicalAskLifecycle;
  downstream_projection?: DownstreamProjection | null;
  now?: Date;
  max_observation_age_ms?: number;
}>;

export const auditG7BrokerageTransfer = (
  input: G7BrokerageTransferAuditInput,
): G7BrokerageTransferAudit => {
  const nowMs = (input.now ?? new Date()).getTime();
  const maxAgeMs = input.max_observation_age_ms ?? 30_000;
  const checks: G7BrokerageTransferCheck[] = [];
  const observations = [
    checkObservation({
      stage: "reference_execution",
      value: input.reference_observation,
      authority: input.reference_authority,
      expected: input.expected,
      nowMs,
      maxAgeMs,
    }),
    checkObservation({
      stage: "mcp_execution",
      value: input.mcp_observation,
      authority: input.mcp_authority,
      expected: input.expected,
      nowMs,
      maxAgeMs,
    }),
    checkObservation({
      stage: "ask_execution",
      value: input.ask_observation,
      authority: input.ask_authority,
      expected: input.expected,
      nowMs,
      maxAgeMs,
    }),
  ];
  for (const result of observations) checks.push(...result.checks);
  const askObservation = observations[2].observation;

  const reentryOk = Boolean(
    askObservation &&
    input.ask_lifecycle.executed &&
    input.ask_lifecycle.normalized &&
    input.ask_lifecycle.reentered_observation_refs.includes(
      askObservation.observation_id,
    ) &&
    input.ask_lifecycle.reentered_observation_hashes[
      askObservation.observation_id
    ] === askObservation.output_hash,
  );
  checks.push({
    stage: "evidence_reentry",
    check: "exact_ask_observation_reentered",
    ok: reentryOk,
    detail: reentryOk
      ? "The exact current Ask observation and output hash re-entered the principal solver."
      : "Ask execution, normalization, exact observation re-entry, or output-hash continuity is missing.",
  });

  const supportingRoleAuthority = input.ask_lifecycle.supporting_role_authority;
  const supportingRolesOk = !supportingRoleAuthority || Boolean(
    supportingRoleAuthority.artifact_count >= 0 &&
    supportingRoleAuthority.all_revision_current &&
    !supportingRoleAuthority.mutation_authority_granted &&
    !supportingRoleAuthority.terminal_authority_granted &&
    !supportingRoleAuthority.financial_recommendation_authority_granted,
  );
  checks.push({
    stage: "evidence_reentry",
    check: "supporting_roles_remain_current_non_authoritative_shadow",
    ok: supportingRolesOk,
    detail: supportingRolesOk
      ? "Any supporting reasoning-role artifacts are current, non-mutating, nonterminal, and non-recommending."
      : "A supporting role is stale or acquired mutation, recommendation, or terminal authority.",
  });

  const terminalOk = Boolean(
    askObservation &&
    input.ask_lifecycle.solver_completed &&
    input.ask_lifecycle.terminal_authority_granted &&
    input.ask_lifecycle.terminal_text?.trim() &&
    input.ask_lifecycle.selected_terminal_support_refs.includes(
      askObservation.observation_id,
    ) &&
    input.ask_lifecycle.selected_terminal_support_hashes[
      askObservation.observation_id
    ] === askObservation.output_hash &&
    input.ask_lifecycle.mutation_tool_calls_made === 0,
  );
  checks.push({
    stage: "terminal_authority",
    check: "supported_principal_terminal_candidate",
    ok: terminalOk,
    detail: terminalOk
      ? "Principal synthesis cites the exact Ask observation and output hash, and no mutation ran."
      : "Terminal authority, exact support/hash continuity, or zero-mutation proof is missing.",
  });

  const presentationOk = Boolean(
    input.ask_lifecycle.terminal_text &&
    input.ask_lifecycle.api_text === input.ask_lifecycle.terminal_text &&
    (input.ask_lifecycle.voice_text === undefined ||
      input.ask_lifecycle.voice_text === null ||
      input.ask_lifecycle.voice_text === input.ask_lifecycle.terminal_text),
  );
  checks.push({
    stage: "presentation",
    check: "text_api_voice_terminal_equivalence",
    ok: presentationOk,
    detail: presentationOk
      ? "Applicable presentation surfaces preserve the selected terminal text."
      : "API, text, or applicable voice presentation diverged.",
  });

  const projectionContradictions: string[] = [];
  const projection = input.downstream_projection;
  if (projection?.execution_status === "not_executed" &&
      input.ask_lifecycle.executed) {
    projectionContradictions.push("projection_regressed_executed_fact");
  }
  if (projection?.observation_reentered === false && reentryOk) {
    projectionContradictions.push("projection_regressed_reentry_fact");
  }
  if (projection?.terminal_text && input.ask_lifecycle.terminal_text &&
      projection.terminal_text !== input.ask_lifecycle.terminal_text) {
    projectionContradictions.push("projection_substituted_terminal_text");
  }

  const firstFailed = checks.find((check) => !check.ok) ?? null;
  return {
    schema: "helix.g7_brokerage_transfer_audit.v1",
    ok: !firstFailed,
    first_divergence_stage: firstFailed?.stage ?? null,
    checks,
    projection_contradictions: projectionContradictions,
    canonical_ask_observation_id: askObservation?.observation_id ?? null,
    canonical_terminal_text: !firstFailed && terminalOk
      ? input.ask_lifecycle.terminal_text
      : null,
    mutation_tool_calls_made: input.ask_lifecycle.mutation_tool_calls_made,
    market_session_contract: HELIX_BROKERAGE_SHADOW_MARKET_SESSION_CONTRACT,
    answer_authority: false,
    assistant_answer: false,
    terminal_eligible: false,
  };
};
