import {
  materializeHelixEnvironmentActionChoice,
  verifiedHelixEnvironmentActionChoiceSourceSchema,
  type HelixEnvironmentActionChoiceProposal,
  type HelixEnvironmentActionChoiceVerdict,
  type VerifiedHelixEnvironmentActionChoiceSource,
} from "@shared/helix-environment-action-choice";
import { buildResponsesActionProviderRequest,
  type ResponsesActionProviderMenu } from
  "@shared/helix-responses-action-provider-request";

const MAX_RESPONSE_BYTES = 65_536;
const ref = /^[a-zA-Z0-9:._/-]{1,320}$/u;

export type ResponsesActionActorReceipt =
  | { status: "proposed"; proposal: HelixEnvironmentActionChoiceProposal;
      provider_response_ref: string | null; execution_authority: false }
  | { status: "rejected"; reason: Extract<HelixEnvironmentActionChoiceVerdict,
      { accepted: false }>["reason"] | "response_not_complete" | "response_error" |
      "response_refusal" | "response_output_invalid";
      checkpoint_event_id: string; execution_authority: false }
  | { status: "unavailable"; reason: "source_unavailable" | "provider_http_error" |
      "provider_network_error" | "provider_timeout" | "provider_canceled" |
      "provider_response_oversize" | "provider_response_invalid" |
      "owner_approval_required" | "credential_unavailable";
      execution_authority: false };

const unavailable = (reason: Extract<ResponsesActionActorReceipt,
  { status: "unavailable" }>["reason"]): ResponsesActionActorReceipt =>
  ({ status: "unavailable", reason, execution_authority: false });

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

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

type Extracted = { ok: true; choice: unknown; responseRef: string | null } |
  { ok: false; reason: Extract<ResponsesActionActorReceipt,
    { status: "rejected" }>["reason"] };

/** Ignore reasoning items; one completed assistant JSON message is required.
 * Tool calls, refusals, duplicate messages and partial results are not choices. */
export function extractResponsesActionChoice(payload: unknown): Extracted {
  const response = object(payload);
  if (!response || response.object !== "response" || response.status !== "completed")
    return { ok: false, reason: "response_not_complete" };
  if (response.error != null || response.incomplete_details != null)
    return { ok: false, reason: "response_error" };
  if (!Array.isArray(response.output)) return { ok: false, reason: "response_output_invalid" };
  let messageText: string | null = null;
  for (const value of response.output) {
    const item = object(value);
    if (item?.type === "reasoning") continue;
    if (!item || item.type !== "message" || item.role !== "assistant" ||
        item.status !== "completed" || !Array.isArray(item.content) ||
        item.content.length !== 1 || messageText !== null)
      return { ok: false, reason: "response_output_invalid" };
    const content = object(item.content[0]);
    if (content?.type === "refusal") return { ok: false, reason: "response_refusal" };
    if (content?.type !== "output_text" || typeof content.text !== "string" ||
        content.text.length > 1_024)
      return { ok: false, reason: "response_output_invalid" };
    messageText = content.text;
  }
  if (messageText === null) return { ok: false, reason: "response_output_invalid" };
  try {
    return { ok: true, choice: JSON.parse(messageText) as unknown,
      responseRef: typeof response.id === "string" && ref.test(response.id)
        ? response.id : null };
  } catch {
    return { ok: false, reason: "response_output_invalid" };
  }
}

/** One optional short action-selection call. The caller supplies only a
 * protected, declassified, exact-task source loader and must re-run temporal
 * preflight on any selected plan. This function never dispatches actions or
 * publishes user-visible activity by itself. */
export async function invokeResponsesActionActor(input: {
  model: string;
  apiKey?: string;
  /** Native broker transport keeps the saved own-key outside the server. */
  providerTransport?: (menu: ResponsesActionProviderMenu &
    { signal: AbortSignal }) => Promise<Response>;
  hostDecisionId: string;
  requestedHorizonUnits: number;
  requestedLifetimeMs: number;
  loadVerifiedSource: () => Promise<VerifiedHelixEnvironmentActionChoiceSource | null>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ResponsesActionActorReceipt> {
  if (!ref.test(input.model) || !ref.test(input.hostDecisionId))
    throw new Error("responses_action_actor_input_invalid");
  if (!input.providerTransport && !input.apiKey?.trim())
    throw new Error("responses_action_actor_credential_unavailable");
  const timeoutMs = input.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
    throw new Error("responses_action_actor_timeout_invalid");
  if (input.signal?.aborted) return unavailable("provider_canceled");
  let first: VerifiedHelixEnvironmentActionChoiceSource | null;
  try { first = await input.loadVerifiedSource(); }
  catch { return unavailable("source_unavailable"); }
  const parsedFirst = verifiedHelixEnvironmentActionChoiceSourceSchema.safeParse(first);
  if (!parsedFirst.success) return unavailable("source_unavailable");
  const invocation = parsedFirst.data;
  if (invocation.context.interruption_pending) return unavailable("source_unavailable");
  if (input.signal?.aborted) return unavailable("provider_canceled");

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let payload: unknown;
  try {
    const menu: ResponsesActionProviderMenu = {
      model: input.model, observation_summary: invocation.observation_summary,
      candidates: invocation.candidates.map(candidate => ({
        candidate_id: candidate.candidate_id, action_code: candidate.action_code,
        target_ref: candidate.target_ref, estimated_units: candidate.estimated_units,
      })),
    };
    const response = input.providerTransport
      ? await input.providerTransport({ ...menu, signal: controller.signal })
      : await (input.fetchImpl ?? fetch)("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
        signal: controller.signal,
        body: JSON.stringify(buildResponsesActionProviderRequest(menu)),
      });
    if (!response.ok) {
      if (input.providerTransport && response.status === 409) {
        const errorBody = await readBoundedResponse(response);
        let brokerError: unknown = null;
        try { brokerError = errorBody ? object(JSON.parse(errorBody))?.error : null; }
        catch { /* Malformed broker errors remain generic. */ }
        if (brokerError === "responses_action_owner_approval_required")
          return unavailable("owner_approval_required");
        if (brokerError === "responses_action_credential_unavailable")
          return unavailable("credential_unavailable");
      }
      return unavailable("provider_http_error");
    }
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
  let rawCurrent: VerifiedHelixEnvironmentActionChoiceSource | null;
  try { rawCurrent = await input.loadVerifiedSource(); }
  catch { return unavailable("source_unavailable"); }
  if (input.signal?.aborted) return unavailable("provider_canceled");
  const parsedCurrent = verifiedHelixEnvironmentActionChoiceSourceSchema.safeParse(rawCurrent);
  if (!parsedCurrent.success) return unavailable("source_unavailable");
  const current = parsedCurrent.data;
  // Even refusal/status events must not be presented as the current decision
  // if the source changed while the provider call was in flight.
  const currentness = materializeHelixEnvironmentActionChoice({
    untrustedChoice: { choice_id: "hold_safe", rationale_code: "currentness_check" },
    invocationSource: invocation, currentSource: current,
    hostDecisionId: input.hostDecisionId,
    requestedHorizonUnits: input.requestedHorizonUnits,
    requestedLifetimeMs: input.requestedLifetimeMs,
  });
  if (!currentness.accepted) return { status: "rejected", reason: currentness.reason,
    checkpoint_event_id: invocation.context.checkpoint_event_id, execution_authority: false };
  const extracted = extractResponsesActionChoice(payload);
  if (!extracted.ok) return { status: "rejected", reason: extracted.reason,
    checkpoint_event_id: invocation.context.checkpoint_event_id, execution_authority: false };
  const verdict = materializeHelixEnvironmentActionChoice({
    untrustedChoice: extracted.choice, invocationSource: invocation,
    currentSource: current, hostDecisionId: input.hostDecisionId,
    requestedHorizonUnits: input.requestedHorizonUnits,
    requestedLifetimeMs: input.requestedLifetimeMs,
  });
  return verdict.accepted
    ? { status: "proposed", proposal: verdict.proposal,
      provider_response_ref: extracted.responseRef, execution_authority: false }
    : { status: "rejected", reason: verdict.reason,
      checkpoint_event_id: invocation.context.checkpoint_event_id, execution_authority: false };
}
