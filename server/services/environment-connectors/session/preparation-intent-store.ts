import { createHash } from "node:crypto";
import { z } from "zod";
import type { HelixLocalSupervisorPresence } from "@shared/helix-local-supervisor-coordination";

const ref = z.string().trim().min(1).max(320);
const requestSchema = z.object({
  requestId: ref, profileRef: ref, clientSessionRef: ref, continuationRef: ref,
  helixConversationId: ref, roomId: ref,
  requestedDurationSeconds: z.number().int().min(60).max(604800),
}).strict();
type Request = z.infer<typeof requestSchema>;
type Target = { profileRef: string; authenticatedMcpClientRef: string;
  clientSessionRef: string; continuationRef: string };
type Intent = Request & { intentId: string; serviceInstanceRef: string;
  authenticatedMcpClientRef: string; createdAt: string; expiresAt: string;
  origin: "authenticated_browser_setup"; chat_reference_basis: "browser_declared_profile_scoped"; status: "pending" | "run_prepared";
  preparedRunId?: string; preparedAt?: string;
  execution_authority: false; task_binding_authority: false; answer_authority: false;
  assistant_answer: false; terminal_eligible: false };

export const PREPARATION_INTENT_FAILURES = {
  preparation_target_unavailable: "Refresh this same task's authenticated supervisor presence before reading or preparing its session. This does not renew pairing or environment permission.",
  preparation_target_changed: "The reviewed task selection changed. Inspect the current exact task before preparing the session.",
  preparation_service_changed: "The preparation belongs to an earlier service. Inspect current preparation state before requesting setup again.",
  preparation_request_conflict: "This request ID already describes different setup. Reconcile the original request before changing the selection.",
  preparation_intent_expired: "The preparation request expired. Review current setup before requesting preparation again.",
  preparation_capacity_reached: "The preparation mailbox is full. Inspect outstanding setup requests before submitting more.",
  preparation_target_mismatch: "This preparation does not belong to the authenticated task. Use the exact intended task.",
  preparation_intent_unavailable: "No current preparation request matches this task and intent. Read this task's current preparation state before proceeding.",
  preparation_run_conflict: "The preparation is already associated with a different run. Reconcile its current run before proceeding.",
  preparation_run_selection_required: "Existing eligible runs require an explicit selection. Inspect the candidates and select the intended run.",
  preparation_room_unavailable: "The selected room is unavailable to this account. Review room access before preparing the session.",
} as const;
export class PreparationIntentError extends Error {
  constructor(readonly code: keyof typeof PREPARATION_INTENT_FAILURES) {
    super(code);
    this.name = "PreparationIntentError";
  }
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Setup mailbox only. No model loop, run creation, approval or acknowledgement
 * as completion. Callers must supply authenticated identities, never body owners. */
export class EnvironmentSessionPreparationIntentStore {
  private readonly requests = new Map<string, { fingerprint: string; selection: string; intent: Intent }>();
  private readonly preparations = new Map<string, {
    choice: string; runId?: string; pending?: Promise<Intent>;
  }>();
  constructor(
    private readonly presence: { serviceInstanceRef: string; listPresence(): HelixLocalSupervisorPresence[] },
    private readonly assertBrowserSelection: (input: Request) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  private currentTarget(input: Pick<Request, "profileRef" | "clientSessionRef" | "continuationRef">) {
    const now = this.now();
    const matches = this.presence.listPresence().filter(row =>
      row.active && row.service_instance_ref === this.presence.serviceInstanceRef &&
      row.authenticated_profile_ref === input.profileRef && row.client_session_ref === input.clientSessionRef &&
      row.conversation_thread_ref === input.continuationRef && row.authenticated_mcp_client_ref &&
      Date.parse(row.observed_at) <= now && Date.parse(row.heartbeat_expires_at) > now);
    if (matches.length !== 1) throw new PreparationIntentError("preparation_target_unavailable");
    return matches[0];
  }

  async request(raw: Request): Promise<Intent> {
    const input = requestSchema.parse(raw);
    const before = this.currentTarget(input);
    // Required port verifies current browser selection policy and room membership. Never
    // turn the presence's advisory room/run strings into selection proof.
    await this.assertBrowserSelection(input);
    const target = this.currentTarget(input);
    if (target.authenticated_mcp_client_ref !== before.authenticated_mcp_client_ref) {
      throw new PreparationIntentError("preparation_target_changed");
    }
    const key = hash([input.profileRef, input.requestId]);
    const fingerprint = hash([input, target.authenticated_mcp_client_ref]);
    const { requestId: _requestId, ...selectors } = input;
    const selection = hash([selectors, target.authenticated_mcp_client_ref, this.presence.serviceInstanceRef]);
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.intent.serviceInstanceRef !== this.presence.serviceInstanceRef) throw new PreparationIntentError("preparation_service_changed");
      if (previous.fingerprint !== fingerprint) throw new PreparationIntentError("preparation_request_conflict");
      if (Date.parse(previous.intent.expiresAt) <= this.now()) throw new PreparationIntentError("preparation_intent_expired");
      return structuredClone(previous.intent);
    }
    // Fail closed rather than evicting a dedupe record and permitting duplicates.
    if (this.requests.size >= 128) throw new PreparationIntentError("preparation_capacity_reached");
    const now = this.now();
    // Different browser windows have different retry IDs. Coalesce only an
    // identical, still-pending selection, and retain each retry ID as an alias
    // so an old request cannot later be reused with a different payload.
    const pending = [...this.requests.values()].find(row =>
      row.selection === selection && Date.parse(row.intent.expiresAt) > now);
    if (pending) {
      this.requests.set(key, { fingerprint, selection, intent: pending.intent });
      return structuredClone(pending.intent);
    }
    const intent: Intent = { ...input,
      intentId: `environment_preparation:${hash([this.presence.serviceInstanceRef, key]).slice(0,32)}`,
      serviceInstanceRef: this.presence.serviceInstanceRef,
      authenticatedMcpClientRef: target.authenticated_mcp_client_ref!,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString(),
      origin: "authenticated_browser_setup", chat_reference_basis: "browser_declared_profile_scoped", status: "pending",
      execution_authority: false, task_binding_authority: false, answer_authority: false,
      assistant_answer: false, terminal_eligible: false };
    this.requests.set(key, { fingerprint, selection, intent });
    return structuredClone(intent);
  }

  private ownedIntents(target: Target): Intent[] {
    const current = this.currentTarget(target);
    if (current.authenticated_mcp_client_ref !== target.authenticatedMcpClientRef) {
      throw new PreparationIntentError("preparation_target_mismatch");
    }
    const intents = new Map([...this.requests.values()].map(row => [row.intent.intentId, row.intent]));
    return [...intents.values()].filter(intent =>
      intent.serviceInstanceRef === this.presence.serviceInstanceRef &&
      intent.profileRef === target.profileRef && intent.clientSessionRef === target.clientSessionRef &&
      intent.continuationRef === target.continuationRef &&
      intent.authenticatedMcpClientRef === target.authenticatedMcpClientRef &&
      Date.parse(intent.expiresAt) > this.now()).map(intent => structuredClone(intent));
  }

  read(target: Target): Intent[] {
    return this.ownedIntents(target).filter(intent => intent.status === "pending");
  }

  /** Deterministic setup only. Existing run APIs own creation/idempotency; no
   * continuation, model sampling, binding consent or environment action occurs.
   * Partial creation is retained before attachment so a retry cannot rotate runs. */
  async prepareRun(target: Target, intentId: string,
    choice: { runId: string } | { objective: string }, ports: {
      discover: (roomId: string) => Promise<unknown[]>;
      create: (input: { idempotencyKey: string; objective: string; durationSeconds: number }) => Promise<string>;
      attach: (roomId: string, runId: string) => Promise<void>;
      verify: (selection: { roomId: string; runId: string }) => Promise<void>;
    }): Promise<Intent> {
    const assertCurrent = () => {
      const intent = this.ownedIntents(target).find(row => row.intentId === intentId);
      if (!intent) throw new PreparationIntentError("preparation_intent_unavailable");
      return intent;
    };
    const selected = assertCurrent();
    const fingerprint = hash(choice);
    let attempt = this.preparations.get(intentId);
    if (attempt && attempt.choice !== fingerprint) throw new PreparationIntentError("preparation_request_conflict");
    if (!attempt) {
      if (selected.preparedRunId && (!("runId" in choice) || choice.runId !== selected.preparedRunId)) {
        throw new PreparationIntentError("preparation_run_conflict");
      }
      // Refuse a new run when candidates exist; choosing task compatibility is
      // the caller's decision, never a "most recent" or first-row heuristic.
      if (!("runId" in choice)) {
        const candidates = await ports.discover(selected.roomId);
        assertCurrent();
        if (candidates.length) throw new PreparationIntentError("preparation_run_selection_required");
      }
      // Another same-task call may have completed discovery while we awaited it.
      attempt = this.preparations.get(intentId);
      if (attempt && attempt.choice !== fingerprint) throw new PreparationIntentError("preparation_request_conflict");
      if (!attempt) {
        attempt = { choice: fingerprint, runId: "runId" in choice ? choice.runId : undefined };
        this.preparations.set(intentId, attempt);
      }
    }
    if (attempt.pending) return structuredClone(await attempt.pending);
    const state = attempt;
    state.pending = (async () => {
      assertCurrent();
      if (!state.runId) {
        if (!("objective" in choice)) throw new PreparationIntentError("preparation_run_conflict");
        state.runId = await ports.create({ idempotencyKey: `preparation:${hash(intentId)}`,
          objective: choice.objective, durationSeconds: selected.requestedDurationSeconds });
      }
      assertCurrent();
      await ports.attach(selected.roomId, state.runId);
      assertCurrent();
      return this.acknowledgeRun(target, intentId, state.runId, ports.verify);
    })();
    try { return structuredClone(await state.pending); }
    finally { state.pending = undefined; }
  }

  /** Records only server-verified run preparation, never binding consent or
   * gameplay readiness. Validation is repeated even on an acknowledgement retry. */
  async acknowledgeRun(target: Target, intentId: string, runId: string,
    verifyRun: (selection: { roomId: string; runId: string }) => Promise<void>): Promise<Intent> {
    const selected = this.ownedIntents(target).find(intent => intent.intentId === intentId);
    if (!selected) throw new PreparationIntentError("preparation_intent_unavailable");
    if (selected.preparedRunId && selected.preparedRunId !== runId) {
      throw new PreparationIntentError("preparation_run_conflict");
    }
    await verifyRun({ roomId: selected.roomId, runId });
    const current = this.ownedIntents(target).find(intent => intent.intentId === intentId);
    if (!current) throw new PreparationIntentError("preparation_intent_unavailable");
    if (current.preparedRunId && current.preparedRunId !== runId) {
      throw new PreparationIntentError("preparation_run_conflict");
    }
    const stored = [...this.requests.values()].find(row => row.intent.intentId === intentId)!.intent;
    stored.status = "run_prepared";
    stored.preparedRunId = runId;
    stored.preparedAt ??= new Date(this.now()).toISOString();
    return structuredClone(stored);
  }
}
