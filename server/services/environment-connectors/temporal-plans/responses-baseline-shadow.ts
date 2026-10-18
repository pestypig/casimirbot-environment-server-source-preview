import { buildResponsesActionProviderRequest, type ResponsesActionProviderMenu } from
  "@shared/helix-responses-action-provider-request";
import { extractResponsesActionChoice } from "./responses-action-actor";

const directions = ["forward", "back", "left", "right"] as const;
type Direction = typeof directions[number];
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : {};
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const boundedText = (value: unknown, limit: number): string =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";

async function readBrokerError(response: Response): Promise<string | null> {
  if (Number(response.headers.get("content-length")) > 1_024 || !response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1_024) { await reader.cancel(); return null; }
      body += decoder.decode(part.value, { stream: true });
    }
    const error = record(JSON.parse(body + decoder.decode())).error;
    return error === "responses_action_owner_approval_required" ? "owner_approval_required" :
      error === "responses_action_credential_unavailable" ? "credential_unavailable" : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export type ResponsesBaselineMenu = ResponsesActionProviderMenu & {
  observationRef: string;
  goalId: string;
  goalRevision: number;
};

/** A slow planning menu from measured, exact-player perception. Never include
 * player chat, NBT, raw source prose, credentials, or unsafe movement options. */
export function createResponsesBaselineMenu(input: {
  model: string;
  observationRef: string;
  snapshot: unknown;
  goalId: string;
  goalRevision: number;
  objectiveText: string;
}): ResponsesBaselineMenu | null {
  const snapshot = record(input.snapshot);
  const actor = record(snapshot.actor);
  const position = record(actor.position);
  const rows = Array.isArray(snapshot.movement_candidates)
    ? snapshot.movement_candidates.map(record) : [];
  const safe = directions.flatMap(direction => {
    const row = rows.find(candidate => candidate.relative_direction === direction);
    if (!row || row.safe_candidate !== true || row.evidence_complete !== true) return [];
    const target = record(row.target_feet_position);
    const x = finite(target.x), y = finite(target.y), z = finite(target.z);
    if (x === null || y === null || z === null) return [];
    return [{ direction, target: { x, y, z } }];
  });
  if (!input.observationRef || !input.goalId || !Number.isSafeInteger(input.goalRevision) ||
      input.goalRevision < 0 || actor.on_ground !== true ||
      (finite(actor.health) ?? 0) <= 0 || safe.length === 0) return null;
  const candidates = safe.map(candidate => ({
    candidate_id: `walk_${candidate.direction}`,
    action_code: `walk_${candidate.direction}`,
    target_ref: null,
    estimated_units: 4,
  }));
  const menu = {
    model: input.model,
    observation_summary: JSON.stringify({
      goal: boundedText(input.objectiveText, 400),
      game_tick: Number.isSafeInteger(snapshot.game_tick) ? snapshot.game_tick : null,
      position: { x: finite(position.x), y: finite(position.y), z: finite(position.z) },
      health: finite(actor.health), on_ground: true,
      critical_hazard_count: Array.isArray(snapshot.hazards)
        ? snapshot.hazards.filter(value => record(value).critical === true).length : null,
      safe_directions: safe,
    }),
    candidates,
    observationRef: input.observationRef,
    goalId: input.goalId,
    goalRevision: input.goalRevision,
  };
  try { buildResponsesActionProviderRequest({ model: menu.model,
    observation_summary: menu.observation_summary, candidates: menu.candidates }); }
  catch { return null; }
  return menu;
}

export type ResponsesBaselineReceipt =
  | { status: "proposed" | "hold" | "escalated";
      choice_id: string; decision_id: string; observation_ref: string;
      goal_id: string; goal_revision: number; provider_response_ref: string | null;
      action_performed: false; execution_authority: false }
  | { status: "unavailable" | "rejected"; reason: string;
      action_performed: false; execution_authority: false };

/** One bounded own-key choice. The result is never a native plan or authority
 * to execute; the subsequent action needs a new perception and full preflight. */
export async function chooseResponsesBaseline(input: {
  menu: ResponsesBaselineMenu;
  decisionId: string;
  transport: (menu: ResponsesActionProviderMenu & { signal: AbortSignal }) => Promise<Response>;
  verifyCurrent: () => Promise<boolean>;
  timeoutMs?: number;
}): Promise<ResponsesBaselineReceipt> {
  const noEffect = { action_performed: false as const, execution_authority: false as const };
  const timeoutMs = input.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
    throw new Error("responses_baseline_timeout_invalid");
  try { buildResponsesActionProviderRequest({ model: input.menu.model,
    observation_summary: input.menu.observation_summary,
    candidates: input.menu.candidates }); }
  catch { return { status: "rejected", reason: "menu_invalid", ...noEffect }; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let payload: unknown;
  try {
    if (!await input.verifyCurrent())
      return { status: "unavailable", reason: "binding_or_goal_stale", ...noEffect };
    const response = await input.transport({ model: input.menu.model,
      observation_summary: input.menu.observation_summary,
      candidates: input.menu.candidates, signal: controller.signal });
    if (!response.ok) {
      const brokerError = response.status === 409 ? await readBrokerError(response) : null;
      return { status: "unavailable", reason: brokerError ?? `provider_http_${response.status}`,
        ...noEffect };
    }
    const declared = Number(response.headers.get("content-length"));
    if (declared > 65_536)
      return { status: "rejected", reason: "provider_response_oversize", ...noEffect };
    if (!response.body)
      return { status: "rejected", reason: "provider_response_invalid", ...noEffect };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 65_536) {
          await reader.cancel();
          return { status: "rejected", reason: "provider_response_oversize", ...noEffect };
        }
        body += decoder.decode(part.value, { stream: true });
      }
      body += decoder.decode();
    } finally { reader.releaseLock(); }
    try { payload = JSON.parse(body) as unknown; }
    catch { return { status: "rejected", reason: "provider_response_invalid", ...noEffect }; }
  } catch {
    return { status: "unavailable", reason: controller.signal.aborted
      ? "provider_timeout" : "provider_network_error", ...noEffect };
  } finally { clearTimeout(timeout); }
  if (!await input.verifyCurrent())
    return { status: "unavailable", reason: "binding_or_goal_stale", ...noEffect };
  const extracted = extractResponsesActionChoice(payload);
  if (!extracted.ok) return { status: "rejected", reason: extracted.reason, ...noEffect };
  const choice = record(extracted.choice);
  if (typeof choice.choice_id !== "string" ||
      typeof choice.rationale_code !== "string" ||
      choice.rationale_code.length > 160 ||
      Object.keys(choice).some(key => !["choice_id", "rationale_code"].includes(key)))
    return { status: "rejected", reason: "choice_invalid", ...noEffect };
  const choiceId = choice.choice_id;
  if (!input.menu.candidates.some(candidate => candidate.candidate_id === choiceId) &&
      choiceId !== "hold_safe" && choiceId !== "escalate_to_codex")
    return { status: "rejected", reason: "choice_not_offered", ...noEffect };
  return { status: choiceId === "hold_safe" ? "hold" :
    choiceId === "escalate_to_codex" ? "escalated" : "proposed",
    choice_id: choiceId, decision_id: input.decisionId,
    observation_ref: input.menu.observationRef,
    goal_id: input.menu.goalId, goal_revision: input.menu.goalRevision,
    provider_response_ref: extracted.responseRef, ...noEffect };
}
