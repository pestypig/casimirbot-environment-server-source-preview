import { z } from "zod";
import {
  helixEnvironmentCheckpointDecisionSchema,
  type HelixEnvironmentCheckpointDecisionContext,
} from "@shared/helix-environment-checkpoint-decision";
import type { HelixEnvironmentCheckpointPublicOutcome } from
  "@shared/helix-environment-checkpoint-public-outcome";
import { materializeResponsesCheckpointDecision } from "./responses-checkpoint-choice";
import { projectResponsesCheckpointPublicOutcome } from "./responses-checkpoint-public-outcome";

const ref = z.string().trim().min(1).max(320).regex(/^[a-zA-Z0-9:._/-]+$/u);
const contextSchema = helixEnvironmentCheckpointDecisionSchema.pick({
  environment_id: true, source_id: true, subject_id: true, goal_id: true,
  goal_revision: true, predecessor_plan_id: true, predecessor_plan_hash: true,
  checkpoint_id: true, observation_ref: true, observation_revision: true,
  affordance_revision: true, producer_epoch: true, authority_id: true,
  authority_revision: true, monotonic_origin_id: true,
}).extend({
  current_unit: z.number().int().nonnegative(),
  current_monotonic_ms: z.number().int().nonnegative(),
  maximum_proposal_horizon_units: z.number().int().positive(),
  maximum_proposal_lifetime_ms: z.number().int().positive(),
  interruption_pending: z.boolean(),
}).strict();

/** Shape for a protected canonical checkpoint-evidence read. This schema
 * validates shape, not provenance; the future caller must obtain it from the
 * trusted database reader, never a room, model, browser, or display receipt. */
export const verifiedResponsesCheckpointSourceSchema = z.object({
  run_id: ref,
  checkpoint_event_id: ref,
  checkpoint_event_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  context: contextSchema,
  observation_summary: z.string().trim().min(1).max(2_000),
}).strict();
export type VerifiedResponsesCheckpointSource = z.infer<
  typeof verifiedResponsesCheckpointSourceSchema
>;

export type ResponsesCheckpointWorkerReceipt =
  | { status: "projected"; outcome: HelixEnvironmentCheckpointPublicOutcome;
      checkpoint_event_id: string; checkpoint_event_hash: string;
      provider_response_ref: string | null; execution_authority: false }
  | { status: "unavailable"; reason: "checkpoint_source_unavailable" |
      "checkpoint_source_changed" | "provider_http_error" | "provider_network_error" |
      "provider_timeout" | "provider_canceled" | "provider_response_oversize" |
      "provider_response_invalid" | "outcome_not_publishable";
      execution_authority: false };

const unavailable = (reason: Extract<ResponsesCheckpointWorkerReceipt, { status: "unavailable" }>["reason"])
  : ResponsesCheckpointWorkerReceipt => ({ status: "unavailable", reason, execution_authority: false });

const sameSource = (left: VerifiedResponsesCheckpointSource,
  right: VerifiedResponsesCheckpointSource) =>
  left.run_id === right.run_id &&
  left.checkpoint_event_id === right.checkpoint_event_id &&
  left.checkpoint_event_hash === right.checkpoint_event_hash &&
  left.observation_summary === right.observation_summary;

const MAX_RESPONSE_BYTES = 65_536;
async function readBoundedResponse(response: Response): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** One bounded advisory Responses call. The worker cannot call tools, enact a
 * successor, publish a room answer, or grant itself action authority. The
 * source reader must validate the canonical checkpoint event/hash and current
 * task/authority both before and after sampling. This transport does not
 * itself persist or publish canonical activity. */
export async function invokeResponsesCheckpointWorker(input: {
  model: string;
  apiKey: string;
  hostDecisionId: string;
  requestedHorizonUnits: number;
  requestedLifetimeMs: number;
  loadVerifiedSource: () => Promise<VerifiedResponsesCheckpointSource | null>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}): Promise<ResponsesCheckpointWorkerReceipt> {
  const model = ref.parse(input.model);
  const hostDecisionId = ref.parse(input.hostDecisionId);
  if (!input.apiKey.trim()) throw new Error("checkpoint_worker_credential_unavailable");
  const timeoutMs = input.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
    throw new Error("checkpoint_worker_timeout_invalid");
  if (input.signal?.aborted) return unavailable("provider_canceled");
  let rawInvocation: VerifiedResponsesCheckpointSource | null;
  try { rawInvocation = await input.loadVerifiedSource(); }
  catch { return unavailable("checkpoint_source_unavailable"); }
  if (!rawInvocation) return unavailable("checkpoint_source_unavailable");
  const parsedInvocation = verifiedResponsesCheckpointSourceSchema.safeParse(rawInvocation);
  if (!parsedInvocation.success) return unavailable("checkpoint_source_unavailable");
  const invocation = parsedInvocation.data;
  if (input.signal?.aborted) return unavailable("provider_canceled");
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let payload: unknown;
  try {
    const response = await (input.fetchImpl ?? fetch)("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model, store: false, tools: [], parallel_tool_calls: false,
        max_output_tokens: 128,
        input: [
          { role: "system", content: "Choose one bounded checkpoint disposition. Return only the specified JSON object. This proposal cannot execute actions or answer the user." },
          { role: "user", content: `Verified checkpoint observation: ${invocation.observation_summary}` },
        ],
        text: { format: { type: "json_schema", name: "helix_checkpoint_choice",
          strict: true, schema: { type: "object", properties: {
            disposition: { type: "string", enum: ["continue_same_goal", "repair_same_goal", "hold_safe", "escalate_to_codex"] },
            rationale_code: { type: "string" },
          }, required: ["disposition", "rationale_code"], additionalProperties: false } } },
      }),
    });
    if (!response.ok) return unavailable("provider_http_error");
    const body = await readBoundedResponse(response);
    if (body === null) return unavailable("provider_response_oversize");
    try { payload = JSON.parse(body) as unknown; }
    catch { return unavailable("provider_response_invalid"); }
  } catch {
    return unavailable(input.signal?.aborted ? "provider_canceled" :
      timedOut ? "provider_timeout" : "provider_network_error");
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
  if (input.signal?.aborted) return unavailable("provider_canceled");
  let rawCurrent: VerifiedResponsesCheckpointSource | null;
  try { rawCurrent = await input.loadVerifiedSource(); }
  catch { return unavailable("checkpoint_source_unavailable"); }
  if (input.signal?.aborted) return unavailable("provider_canceled");
  if (!rawCurrent) return unavailable("checkpoint_source_unavailable");
  const parsedCurrent = verifiedResponsesCheckpointSourceSchema.safeParse(rawCurrent);
  if (!parsedCurrent.success) return unavailable("checkpoint_source_unavailable");
  const current = parsedCurrent.data;
  if (!sameSource(invocation, current)) return unavailable("checkpoint_source_changed");
  const result = materializeResponsesCheckpointDecision(payload,
    invocation.context as HelixEnvironmentCheckpointDecisionContext,
    current.context as HelixEnvironmentCheckpointDecisionContext,
    hostDecisionId, input.requestedHorizonUnits, input.requestedLifetimeMs);
  const outcome = projectResponsesCheckpointPublicOutcome({
    result, invocationContext: invocation.context, currentContext: current.context,
    scope: { run_id: invocation.run_id, goal_id: invocation.context.goal_id,
      checkpoint_id: invocation.context.checkpoint_id,
      observation_ref: invocation.context.observation_ref,
      producer_epoch: invocation.context.producer_epoch },
    observedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  if (!outcome) return unavailable("outcome_not_publishable");
  const responseRef = payload && typeof payload === "object" &&
    "id" in payload && typeof payload.id === "string" && ref.safeParse(payload.id).success
    ? payload.id : null;
  return { status: "projected", outcome,
    checkpoint_event_id: invocation.checkpoint_event_id,
    checkpoint_event_hash: invocation.checkpoint_event_hash,
    provider_response_ref: responseRef,
    execution_authority: false };
}
