import type {
  HelixEnvironmentCommandAuthority,
  HelixEnvironmentCommandAuthorityProfile,
  HelixEnvironmentCommandAutonomyMode,
  HelixEnvironmentCommandCategory,
  HelixEnvironmentCommandEffectClass,
  HelixEnvironmentCommandMemberGrant,
} from "@shared/helix-environment-command";

export type EnvironmentCommandAdmissionErrorCode =
  | "command_authority_inactive"
  | "command_authority_expired"
  | "command_grant_inactive"
  | "command_grant_expired"
  | "command_grant_identity_mismatch"
  | "command_profile_forbidden"
  | "command_category_forbidden"
  | "command_effect_forbidden"
  | "command_confirmation_required"
  | "command_dispatcher_verification_required"
  | "command_host_escape_rejected";

export type EnvironmentCommandAdmissionDecision = {
  ok: boolean;
  code: EnvironmentCommandAdmissionErrorCode | null;
  message: string;
  effective_profile: HelixEnvironmentCommandAuthorityProfile;
  effective_autonomy: HelixEnvironmentCommandAutonomyMode;
  confirmation_required: boolean;
};

const profileRank: Record<HelixEnvironmentCommandAuthorityProfile, number> = {
  observe: 0,
  player_assistant: 1,
  world_operator: 2,
  server_administrator: 3,
};

const autonomyRank: Record<HelixEnvironmentCommandAutonomyMode, number> = {
  approve_each: 0,
  approved_categories: 1,
  autonomous: 2,
};

const leastPowerfulProfile = (
  left: HelixEnvironmentCommandAuthorityProfile,
  right: HelixEnvironmentCommandAuthorityProfile,
): HelixEnvironmentCommandAuthorityProfile =>
  profileRank[left] <= profileRank[right] ? left : right;

export const environmentCommandProfileAtMost = (
  candidate: HelixEnvironmentCommandAuthorityProfile,
  ceiling: HelixEnvironmentCommandAuthorityProfile,
): boolean => profileRank[candidate] <= profileRank[ceiling];

const leastPermissiveAutonomy = (
  left: HelixEnvironmentCommandAutonomyMode,
  right: HelixEnvironmentCommandAutonomyMode | null,
): HelixEnvironmentCommandAutonomyMode =>
  !right || autonomyRank[left] <= autonomyRank[right] ? left : right;

const activeAt = (
  status: string,
  expiresAt: string | null,
  nowMs: number,
): "active" | "inactive" | "expired" => {
  if (status !== "active") return "inactive";
  if (expiresAt && Date.parse(expiresAt) <= nowMs) return "expired";
  return "active";
};

const categoryAllowed = (
  profile: HelixEnvironmentCommandAuthorityProfile,
  category: HelixEnvironmentCommandCategory,
): boolean => {
  switch (profile) {
    case "observe":
      return category === "query";
    case "player_assistant":
      return (
        category === "query" ||
        category === "player_state" ||
        category === "player_inventory" ||
        category === "player_movement"
      );
    case "world_operator":
      return category !== "server_administration";
    case "server_administrator":
      return true;
  }
};

const effectAllowed = (
  profile: HelixEnvironmentCommandAuthorityProfile,
  effect: HelixEnvironmentCommandEffectClass,
): boolean => {
  switch (profile) {
    case "observe":
      return effect === "read_only";
    case "player_assistant":
      return effect === "read_only" || effect === "player_mutation";
    case "world_operator":
      return (
        effect === "read_only" ||
        effect === "player_mutation" ||
        effect === "world_mutation"
      );
    case "server_administrator":
      return true;
  }
};

const confirmationRequired = (input: {
  autonomy: HelixEnvironmentCommandAutonomyMode;
  category: HelixEnvironmentCommandCategory;
  effect: HelixEnvironmentCommandEffectClass;
  approvedCategories: HelixEnvironmentCommandCategory[];
}): boolean => {
  if (input.effect === "read_only") return false;
  if (input.autonomy === "autonomous") return false;
  if (input.autonomy === "approve_each") return true;
  return !input.approvedCategories.includes(input.category);
};

const denied = (input: {
  code: EnvironmentCommandAdmissionErrorCode;
  message: string;
  profile: HelixEnvironmentCommandAuthorityProfile;
  autonomy: HelixEnvironmentCommandAutonomyMode;
  confirmationRequired?: boolean;
}): EnvironmentCommandAdmissionDecision => ({
  ok: false,
  code: input.code,
  message: input.message,
  effective_profile: input.profile,
  effective_autonomy: input.autonomy,
  confirmation_required: input.confirmationRequired ?? false,
});

/**
 * Evaluates the durable owner policy and member grant. For execution, callers
 * must set dispatcherVerified only after the bound Fabric server parsed the
 * exact command against its live Brigadier tree. A root-name hint is never
 * enough to authorize execution.
 */
export const evaluateEnvironmentCommandAdmission = (input: {
  authority: HelixEnvironmentCommandAuthority;
  grant: HelixEnvironmentCommandMemberGrant;
  category: HelixEnvironmentCommandCategory;
  effect: HelixEnvironmentCommandEffectClass;
  confirmationState: "not_required" | "pending" | "approved" | "rejected";
  dispatcherVerified: boolean;
  phase?: "preflight" | "execution";
  hostEscapeRequested: boolean;
  now?: Date;
}): EnvironmentCommandAdmissionDecision => {
  const profile = leastPowerfulProfile(
    input.authority.authority_profile,
    input.grant.max_authority_profile,
  );
  const autonomy = leastPermissiveAutonomy(
    input.authority.autonomy_mode,
    input.grant.autonomy_override,
  );
  const nowMs = (input.now ?? new Date()).getTime();
  const authorityState = activeAt(
    input.authority.status,
    input.authority.expires_at,
    nowMs,
  );
  if (authorityState !== "active") {
    return denied({
      code:
        authorityState === "expired"
          ? "command_authority_expired"
          : "command_authority_inactive",
      message:
        authorityState === "expired"
          ? "The environment command authority lease expired."
          : "The environment command authority is not active.",
      profile,
      autonomy,
    });
  }
  const grantState = activeAt(input.grant.status, input.grant.expires_at, nowMs);
  if (grantState !== "active") {
    return denied({
      code:
        grantState === "expired"
          ? "command_grant_expired"
          : "command_grant_inactive",
      message:
        grantState === "expired"
          ? "The room member command grant expired."
          : "The room member command grant is not active.",
      profile,
      autonomy,
    });
  }
  if (
    input.grant.command_authority_id !==
      input.authority.command_authority_id ||
    input.grant.environment_binding_id !==
      input.authority.environment_binding_id ||
    input.grant.room_id !== input.authority.room_id
  ) {
    return denied({
      code: "command_grant_identity_mismatch",
      message: "The room member grant belongs to a different command authority.",
      profile,
      autonomy,
    });
  }
  if (input.hostEscapeRequested) {
    return denied({
      code: "command_host_escape_rejected",
      message:
        "Minecraft command authority never grants filesystem, process, credential, or operating-system access.",
      profile,
      autonomy,
    });
  }
  if (!categoryAllowed(profile, input.category)) {
    return denied({
      code: "command_category_forbidden",
      message: `The ${profile} profile does not grant the ${input.category} command category.`,
      profile,
      autonomy,
    });
  }
  if (!effectAllowed(profile, input.effect)) {
    return denied({
      code: "command_effect_forbidden",
      message: `The ${profile} profile does not grant ${input.effect} effects.`,
      profile,
      autonomy,
    });
  }
  const needsConfirmation = confirmationRequired({
    autonomy,
    category: input.category,
    effect: input.effect,
    approvedCategories: input.authority.approved_categories,
  });
  if (
    needsConfirmation &&
    input.confirmationState !== "approved"
  ) {
    return denied({
      code: "command_confirmation_required",
      message: "This command requires explicit approval under the active autonomy policy.",
      profile,
      autonomy,
      confirmationRequired: true,
    });
  }
  if ((input.phase ?? "execution") === "execution" && !input.dispatcherVerified) {
    return denied({
      code: "command_dispatcher_verification_required",
      message:
        "The bound Minecraft server must parse the exact command against its live Brigadier dispatcher before execution.",
      profile,
      autonomy,
      confirmationRequired: needsConfirmation,
    });
  }
  return {
    ok: true,
    code: null,
    message: "The command is admitted by the active owner policy and member grant.",
    effective_profile: profile,
    effective_autonomy: autonomy,
    confirmation_required: needsConfirmation,
  };
};

export const evaluateEnvironmentCommandPreflightAdmission = (
  input: Omit<
    Parameters<typeof evaluateEnvironmentCommandAdmission>[0],
    "dispatcherVerified" | "phase"
  >,
): EnvironmentCommandAdmissionDecision =>
  evaluateEnvironmentCommandAdmission({
    ...input,
    dispatcherVerified: false,
    phase: "preflight",
  });
