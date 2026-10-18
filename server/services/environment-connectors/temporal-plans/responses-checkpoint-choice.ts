import {
  helixEnvironmentCheckpointModelChoiceSchema,
  materializeHelixEnvironmentCheckpointDecision,
  type HelixEnvironmentCheckpointDecisionContext,
  type HelixEnvironmentCheckpointDecisionVerdict,
} from "@shared/helix-environment-checkpoint-decision";
import type { z } from "zod";

type Choice = z.infer<typeof helixEnvironmentCheckpointModelChoiceSchema>;

export type ResponsesCheckpointChoiceResult =
  | { ok: true; choice: Choice }
  | { ok: false; reason: "response_not_complete" | "response_error" |
      "refusal" | "unexpected_output" | "invalid_choice" };

export type ResponsesCheckpointDecisionResult =
  | ({ gate: "responses_output"; accepted: false; execution_authority: false } &
      Extract<ResponsesCheckpointChoiceResult, { ok: false }>)
  | ({ gate: "checkpoint_preflight" } & HelixEnvironmentCheckpointDecisionVerdict);

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/**
 * A provider boundary, not an execution boundary. Only one completed assistant
 * JSON message may become a model choice. Reasoning items are ignored; tool
 * calls, refusals, partials, and additional messages fail closed.
 */
export function extractResponsesCheckpointChoice(
  untrustedResponse: unknown,
): ResponsesCheckpointChoiceResult {
  const response = record(untrustedResponse);
  if (!response || response.object !== "response" || response.status !== "completed") {
    return { ok: false, reason: "response_not_complete" };
  }
  if (response.error != null || response.incomplete_details != null) {
    return { ok: false, reason: "response_error" };
  }
  if (!Array.isArray(response.output)) {
    return { ok: false, reason: "unexpected_output" };
  }

  let messageText: string | null = null;
  for (const untrustedItem of response.output) {
    const item = record(untrustedItem);
    if (!item) return { ok: false, reason: "unexpected_output" };
    if (item.type === "reasoning") continue;
    if (item.type !== "message" || item.role !== "assistant" ||
        item.status !== "completed" || !Array.isArray(item.content) ||
        messageText !== null || item.content.length !== 1) {
      return { ok: false, reason: "unexpected_output" };
    }
    const content = record(item.content[0]);
    if (content?.type === "refusal") return { ok: false, reason: "refusal" };
    if (content?.type !== "output_text" || typeof content.text !== "string" ||
        content.text.length > 1024) {
      return { ok: false, reason: "unexpected_output" };
    }
    messageText = content.text;
  }
  if (messageText === null) return { ok: false, reason: "unexpected_output" };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(messageText);
  } catch {
    return { ok: false, reason: "invalid_choice" };
  }
  const choice = helixEnvironmentCheckpointModelChoiceSchema.safeParse(parsedJson);
  return choice.success
    ? { ok: true, choice: choice.data }
    : { ok: false, reason: "invalid_choice" };
}

/**
 * The invocation context is frozen before provider sampling. Current context
 * must be read after the response settles; a late answer cannot inherit a new
 * observation, authority, or plan. This returns a proposal only, never an
 * admitted temporal successor or a native input.
 */
export function materializeResponsesCheckpointDecision(
  untrustedResponse: unknown,
  invocationContext: HelixEnvironmentCheckpointDecisionContext,
  currentContext: HelixEnvironmentCheckpointDecisionContext,
  hostDecisionId: string,
  requestedHorizonUnits: number,
  requestedLifetimeMs: number,
): ResponsesCheckpointDecisionResult {
  const extracted = extractResponsesCheckpointChoice(untrustedResponse);
  if (!extracted.ok) {
    return { ...extracted, gate: "responses_output", accepted: false,
      execution_authority: false };
  }
  return {
    ...materializeHelixEnvironmentCheckpointDecision(
      extracted.choice, invocationContext, currentContext, hostDecisionId,
      requestedHorizonUnits, requestedLifetimeMs,
    ),
    gate: "checkpoint_preflight",
  };
}
