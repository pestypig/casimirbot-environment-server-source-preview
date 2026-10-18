import {
  HELIX_MINECRAFT_COMPANION_CLEANUP_RECEIPT_SCHEMA,
  HELIX_MINECRAFT_COMPANION_PERSISTENCE_SCHEMA,
  HELIX_MINECRAFT_COMPANION_PRESENCE_SCHEMA,
  helixMinecraftCompanionPersistenceSchema,
  helixMinecraftCompanionPresenceSchema,
  helixMinecraftCompanionProfileSchema,
  type HelixMinecraftCompanionCleanupReceipt,
  type HelixMinecraftCompanionIncarnation,
  type HelixMinecraftCompanionPersistence,
  type HelixMinecraftCompanionPresence,
  type HelixMinecraftCompanionProfile,
} from "@shared/helix-minecraft-companion-presence";
import {
  helixMinecraftCompanionActionSchema,
  type HelixMinecraftCompanionAction,
} from "@shared/helix-minecraft-companion";

export class CompanionPresenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CompanionPresenceError";
  }
}

const clone = <T>(value: T): T => structuredClone(value);

const baseProjection = (input: {
  profile: HelixMinecraftCompanionProfile;
  state: HelixMinecraftCompanionPresence["state"];
  revision: number;
  incarnation: HelixMinecraftCompanionIncarnation | null;
  updatedAt: string;
  persistenceRestored?: boolean;
  cleanupReceipt?: HelixMinecraftCompanionCleanupReceipt | null;
}): HelixMinecraftCompanionPresence =>
  helixMinecraftCompanionPresenceSchema.parse({
    schema: HELIX_MINECRAFT_COMPANION_PRESENCE_SCHEMA,
    profile: input.profile,
    state: input.state,
    revision: input.revision,
    incarnation: input.incarnation,
    actor_lease_id: null,
    effect_lease_id: null,
    active_resource_keys: [],
    pending_proposal_ids: [],
    cleanup_receipt: input.cleanupReceipt ?? null,
    updated_at: input.updatedAt,
    evidence_refs: [],
    controls_may_be_asserted: false,
    persistence_restored: input.persistenceRestored ?? false,
    public_capability_exposed: false,
    execution_authority: false,
    answer_authority: false,
    assistant_answer: false,
    terminal_eligible: false,
  });

export class CompanionPresenceStore {
  private presence: HelixMinecraftCompanionPresence;
  private readonly priorIncarnations = new Set<string>();

  constructor(profile: HelixMinecraftCompanionProfile, now: string) {
    const parsedProfile = helixMinecraftCompanionProfileSchema.parse(profile);
    this.presence = baseProjection({
      profile: parsedProfile,
      state: "registered",
      revision: 1,
      incarnation: null,
      updatedAt: now,
    });
  }

  static restore(
    supplied: HelixMinecraftCompanionPersistence,
    now: string,
  ): CompanionPresenceStore {
    const snapshot = helixMinecraftCompanionPersistenceSchema.parse(supplied);
    const store = new CompanionPresenceStore(snapshot.profile, now);
    if (snapshot.previous_actor_incarnation_id) {
      store.priorIncarnations.add(snapshot.previous_actor_incarnation_id);
    }
    store.presence = baseProjection({
      profile: snapshot.profile,
      state: "registered",
      revision: snapshot.persistence_revision + 1,
      incarnation: null,
      updatedAt: now,
      persistenceRestored: true,
    });
    return store;
  }

  inspect(): HelixMinecraftCompanionPresence {
    return clone(this.presence);
  }

  spawn(input: {
    actorEntityId: string;
    actorIncarnationId: string;
    environmentId: string;
    worldId: string;
    connectorEpoch: string;
    spawnedAt: string;
    presenceExpiresAt: string;
    evidenceRefs: string[];
  }): HelixMinecraftCompanionPresence {
    if (!["registered", "despawned"].includes(this.presence.state)) {
      this.fail("companion_spawn_state_invalid", "Only registered or despawned companions may spawn.");
    }
    if (this.priorIncarnations.has(input.actorIncarnationId)) {
      this.fail("companion_incarnation_reused", "A previous actor incarnation cannot be reused.");
    }
    const incarnation: HelixMinecraftCompanionIncarnation = {
      actor_entity_id: input.actorEntityId,
      actor_incarnation_id: input.actorIncarnationId,
      environment_id: input.environmentId,
      world_id: input.worldId,
      connector_epoch: input.connectorEpoch,
      spawned_at: input.spawnedAt,
      presence_expires_at: input.presenceExpiresAt,
    };
    this.priorIncarnations.add(input.actorIncarnationId);
    this.presence = helixMinecraftCompanionPresenceSchema.parse({
      ...baseProjection({
        profile: this.presence.profile,
        state: "spawned",
        revision: this.presence.revision + 1,
        incarnation,
        updatedAt: input.spawnedAt,
      }),
      evidence_refs: input.evidenceRefs,
    });
    return this.inspect();
  }

  bind(input: { observedAt: string; evidenceRefs: string[] }) {
    this.requireState("spawned", "companion_bind_state_invalid");
    return this.advance({ state: "bound", updatedAt: input.observedAt, evidenceRefs: input.evidenceRefs });
  }

  admit(input: {
    actorLeaseId: string;
    effectLeaseId: string;
    resourceKeys: string[];
    admittedAt: string;
    evidenceRefs: string[];
  }) {
    this.requireState("bound", "companion_admit_state_invalid");
    return this.advance({
      state: "admitted",
      updatedAt: input.admittedAt,
      evidenceRefs: input.evidenceRefs,
      actorLeaseId: input.actorLeaseId,
      effectLeaseId: input.effectLeaseId,
      resourceKeys: input.resourceKeys,
    });
  }

  activate(input: { activatedAt: string; evidenceRefs: string[] }) {
    this.requireState("admitted", "companion_activate_state_invalid");
    return this.advance({ state: "active", updatedAt: input.activatedAt, evidenceRefs: input.evidenceRefs });
  }

  suspend(input: { suspendedAt: string; evidenceRefs: string[] }) {
    this.requireState("active", "companion_suspend_state_invalid");
    return this.advance({ state: "suspended", updatedAt: input.suspendedAt, evidenceRefs: input.evidenceRefs });
  }

  queueProposal(proposalId: string, now: string) {
    this.requireState("active", "companion_proposal_state_invalid");
    if (this.presence.pending_proposal_ids.includes(proposalId)) return this.inspect();
    return this.advance({
      state: "active",
      updatedAt: now,
      evidenceRefs: this.presence.evidence_refs,
      pendingProposalIds: [...this.presence.pending_proposal_ids, proposalId],
    });
  }

  assertActionCurrent(
    supplied: HelixMinecraftCompanionAction,
    now: string,
  ): HelixMinecraftCompanionAction {
    const action = helixMinecraftCompanionActionSchema.parse(supplied);
    if (this.presence.state !== "active" || !this.presence.incarnation) {
      this.fail("companion_not_active", "The companion has no active admitted incarnation.");
    }
    const incarnation = this.presence.incarnation;
    const mismatched =
      action.identity.companion_id !== this.presence.profile.companion_id ||
      action.identity.actor_entity_id !== incarnation.actor_entity_id ||
      action.identity.actor_incarnation_id !== incarnation.actor_incarnation_id ||
      action.identity.environment_id !== incarnation.environment_id ||
      action.identity.world_id !== incarnation.world_id ||
      action.identity.connector_epoch !== incarnation.connector_epoch ||
      action.identity.observation_revision !== this.presence.revision ||
      action.actor_lease_id !== this.presence.actor_lease_id ||
      action.effect_lease_id !== this.presence.effect_lease_id;
    if (mismatched) {
      this.fail("companion_action_identity_stale", "Action identity does not match current companion presence.");
    }
    if (Date.parse(action.expires_at) <= Date.parse(now)) {
      this.fail("companion_action_expired", "The companion action has expired.");
    }
    return action;
  }

  release(input: {
    cleanupId: string;
    reason: HelixMinecraftCompanionCleanupReceipt["reason"];
    completedAt: string;
    evidenceRefs: string[];
  }): HelixMinecraftCompanionPresence {
    if (!["admitted", "active", "suspended", "releasing"].includes(this.presence.state)) {
      if (this.presence.state === "released" && this.presence.cleanup_receipt) return this.inspect();
      this.fail("companion_release_state_invalid", "Only an admitted or running companion may release.");
    }
    return this.settleCleanup({ ...input, terminalState: "released" });
  }

  invalidate(input: {
    cleanupId: string;
    reason: HelixMinecraftCompanionCleanupReceipt["reason"];
    completedAt: string;
    evidenceRefs: string[];
  }): HelixMinecraftCompanionPresence {
    if (this.presence.state === "invalidated" && this.presence.cleanup_receipt) {
      return this.inspect();
    }
    if (!this.presence.incarnation || ["released", "despawned"].includes(this.presence.state)) {
      this.fail("companion_invalidate_state_invalid", "Only a current runtime incarnation may be invalidated.");
    }
    return this.settleCleanup({ ...input, terminalState: "invalidated" });
  }

  private settleCleanup(input: {
    cleanupId: string;
    reason: HelixMinecraftCompanionCleanupReceipt["reason"];
    completedAt: string;
    evidenceRefs: string[];
    terminalState: "released" | "invalidated";
  }): HelixMinecraftCompanionPresence {
    const incarnation = this.presence.incarnation!;
    const receipt: HelixMinecraftCompanionCleanupReceipt = {
      schema: HELIX_MINECRAFT_COMPANION_CLEANUP_RECEIPT_SCHEMA,
      cleanup_id: input.cleanupId,
      companion_id: this.presence.profile.companion_id,
      actor_incarnation_id: incarnation.actor_incarnation_id,
      reason: input.reason,
      released_actor_lease_id: this.presence.actor_lease_id,
      released_effect_lease_id: this.presence.effect_lease_id,
      released_resource_keys: [...this.presence.active_resource_keys],
      navigation_cleared: true,
      transient_effects_cleared: true,
      chunk_claims_released: true,
      outstanding_proposals_canceled: true,
      controls_released: true,
      late_effect_count: 0,
      duplicate_effect_count: 0,
      completed_at: input.completedAt,
      evidence_refs: input.evidenceRefs,
      credential_included: false,
      answer_authority: false,
      assistant_answer: false,
      terminal_eligible: false,
    };
    this.presence = helixMinecraftCompanionPresenceSchema.parse({
      ...this.presence,
      state: input.terminalState,
      revision: this.presence.revision + 1,
      actor_lease_id: null,
      effect_lease_id: null,
      active_resource_keys: [],
      pending_proposal_ids: [],
      cleanup_receipt: receipt,
      updated_at: input.completedAt,
      evidence_refs: input.evidenceRefs,
      controls_may_be_asserted: false,
      persistence_restored: false,
    });
    return this.inspect();
  }

  enforcePresenceExpiry(input: { now: string; cleanupId: string; evidenceRefs: string[] }) {
    if (!this.presence.incarnation) return this.inspect();
    if (Date.parse(input.now) < Date.parse(this.presence.incarnation.presence_expires_at)) {
      return this.inspect();
    }
    if (["spawned", "bound"].includes(this.presence.state)) {
      return this.invalidate({
        cleanupId: input.cleanupId,
        reason: "lease_expired",
        completedAt: input.now,
        evidenceRefs: input.evidenceRefs,
      });
    }
    return this.release({
      cleanupId: input.cleanupId,
      reason: "lease_expired",
      completedAt: input.now,
      evidenceRefs: input.evidenceRefs,
    });
  }

  despawn(input: { despawnedAt: string; evidenceRefs: string[] }) {
    this.requireState("released", "companion_despawn_state_invalid");
    const cleanup = this.presence.cleanup_receipt;
    this.presence = helixMinecraftCompanionPresenceSchema.parse({
      ...this.presence,
      state: "despawned",
      revision: this.presence.revision + 1,
      incarnation: null,
      updated_at: input.despawnedAt,
      evidence_refs: input.evidenceRefs,
      cleanup_receipt: cleanup,
    });
    return this.inspect();
  }

  snapshot(savedAt: string): HelixMinecraftCompanionPersistence {
    return helixMinecraftCompanionPersistenceSchema.parse({
      schema: HELIX_MINECRAFT_COMPANION_PERSISTENCE_SCHEMA,
      profile: this.presence.profile,
      persistence_revision: this.presence.revision,
      previous_actor_incarnation_id:
        this.presence.incarnation?.actor_incarnation_id ??
        this.presence.cleanup_receipt?.actor_incarnation_id ??
        null,
      saved_at: savedAt,
      active_incarnation_persisted: false,
      actor_lease_persisted: false,
      effect_lease_persisted: false,
      resource_claims_persisted: false,
      pending_proposals_persisted: false,
      credentials_persisted: false,
      answer_authority: false,
      assistant_answer: false,
      terminal_eligible: false,
    });
  }

  private advance(input: {
    state: HelixMinecraftCompanionPresence["state"];
    updatedAt: string;
    evidenceRefs: string[];
    actorLeaseId?: string | null;
    effectLeaseId?: string | null;
    resourceKeys?: string[];
    pendingProposalIds?: string[];
  }) {
    this.presence = helixMinecraftCompanionPresenceSchema.parse({
      ...this.presence,
      state: input.state,
      revision: this.presence.revision + 1,
      actor_lease_id: input.actorLeaseId ?? this.presence.actor_lease_id,
      effect_lease_id: input.effectLeaseId ?? this.presence.effect_lease_id,
      active_resource_keys: input.resourceKeys ?? this.presence.active_resource_keys,
      pending_proposal_ids:
        input.pendingProposalIds ?? this.presence.pending_proposal_ids,
      updated_at: input.updatedAt,
      evidence_refs: input.evidenceRefs,
      controls_may_be_asserted: input.state === "active",
      persistence_restored: false,
    });
    return this.inspect();
  }

  private requireState(
    expected: HelixMinecraftCompanionPresence["state"],
    code: string,
  ) {
    if (this.presence.state !== expected) {
      this.fail(code, `Expected companion state ${expected}, received ${this.presence.state}.`);
    }
  }

  private fail(code: string, message: string): never {
    throw new CompanionPresenceError(code, message);
  }
}
