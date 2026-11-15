import type { ResponsesActionProviderMenu } from
  "@shared/helix-responses-action-provider-request";
import type { ResponsesMonitorProviderInput } from
  "@shared/helix-responses-monitor-provider-request";
import type { ShelterProviderInput } from
  "@shared/helix-minecraft-shelter-provider-request";
import type { CompanionProgramMenu } from
  "@shared/helix-companion-child-provider-request";
import { buildCompanionProgramProviderRequest } from
  "@shared/helix-companion-child-provider-request";
import { buildCompanionResidentProviderRequest,
  type CompanionResidentProviderMenu } from
  "@shared/helix-companion-resident-provider-request";
import { responsesActionRequesterForProfile } from
  "@shared/helix-responses-action-requester";

export function readDesktopBrokerResponsesActionConfig(env: NodeJS.ProcessEnv):
  { brokerOrigin: string; brokerToken: string } | null {
  if (env.HELIX_NATIVE_OPENAI_RESPONSES_ACTION_BROKER_ENABLED !== "1") return null;
  const brokerOrigin = env.HELIX_PROVIDER_CREDENTIAL_BROKER_ORIGIN ?? "";
  const brokerToken = env.HELIX_PROVIDER_CREDENTIAL_BROKER_TOKEN ?? "";
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/u.test(brokerOrigin) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(brokerToken) ||
      Buffer.from(brokerToken, "base64url").length !== 32) return null;
  return { brokerOrigin, brokerToken };
}

/** A transport, not an action grant. Construct only from an authenticated
 * owner's profile. The native broker also checks the approving desktop
 * session, which never crosses into the MCP caller. */
export function createDesktopBrokerResponsesActionTransport(input: {
  ownerProfileId: string;
  brokerOrigin: string;
  brokerToken: string;
  fetchImpl?: typeof fetch;
}): (menu: ResponsesActionProviderMenu & { signal: AbortSignal }) => Promise<Response> {
  if (!input.ownerProfileId ||
      !/^http:\/\/127\.0\.0\.1:\d{2,5}$/u.test(input.brokerOrigin) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(input.brokerToken) ||
      Buffer.from(input.brokerToken, "base64url").length !== 32) {
    throw new Error("responses_action_broker_config_invalid");
  }
  const requesterRef = responsesActionRequesterForProfile(input.ownerProfileId);
  return (menu) => (input.fetchImpl ?? fetch)(
    `${input.brokerOrigin}/v1/openai/responses/action-choice`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.brokerToken}`,
        "Content-Type": "application/json" },
      body: JSON.stringify({ requesterRef, menu: {
        model: menu.model, observation_summary: menu.observation_summary,
        candidates: menu.candidates,
      } }),
      signal: menu.signal,
    },
  );
}

/** Monitoring shares the same native call/cost allowance but has a distinct,
 * fixed no-tools provider request and never returns an action candidate. */
export function createDesktopBrokerResponsesMonitorTransport(input: {
  ownerProfileId: string;
  brokerOrigin: string;
  brokerToken: string;
  fetchImpl?: typeof fetch;
}): (monitor: ResponsesMonitorProviderInput &
  { signal: AbortSignal }) => Promise<Response> {
  if (!input.ownerProfileId ||
      !/^http:\/\/127\.0\.0\.1:\d{2,5}$/u.test(input.brokerOrigin) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(input.brokerToken) ||
      Buffer.from(input.brokerToken, "base64url").length !== 32)
    throw new Error("responses_monitor_broker_config_invalid");
  const requesterRef = responsesActionRequesterForProfile(input.ownerProfileId);
  return (monitor) => (input.fetchImpl ?? fetch)(
    `${input.brokerOrigin}/v1/openai/responses/monitor`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.brokerToken}`,
        "Content-Type": "application/json" },
      body: JSON.stringify({ requesterRef, monitor: {
        model: monitor.model, observation_summary: monitor.observation_summary,
      } }), signal: monitor.signal,
    });
}

/** Shares the same finite owner session and cost ledger as action/monitor calls.
 * The native broker rebuilds the fixed no-tools schema from this typed menu. */
export function createDesktopBrokerMinecraftShelterTransport(input: {
  ownerProfileId: string; brokerOrigin: string; brokerToken: string;
  fetchImpl?: typeof fetch;
}): (shelter: ShelterProviderInput & { signal: AbortSignal }) => Promise<Response> {
  if (!input.ownerProfileId ||
      !/^http:\/\/127\.0\.0\.1:\d{2,5}$/u.test(input.brokerOrigin) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(input.brokerToken) ||
      Buffer.from(input.brokerToken, "base64url").length !== 32)
    throw new Error("responses_shelter_broker_config_invalid");
  const requesterRef = responsesActionRequesterForProfile(input.ownerProfileId);
  return shelter => (input.fetchImpl ?? fetch)(
    `${input.brokerOrigin}/v1/openai/responses/minecraft-shelter`, {
      method: "POST", headers: { Authorization: `Bearer ${input.brokerToken}`,
        "Content-Type": "application/json" },
      body: JSON.stringify({ requesterRef, shelter: {
        model: shelter.model, observation_ref: shelter.observation_ref,
        world_id: shelter.world_id, site: shelter.site,
        actor_relative_side: shelter.actor_relative_side,
        dimension: shelter.dimension,
        allowed_doorway_sides: shelter.allowed_doorway_sides,
        supported_cells: shelter.supported_cells,
        clear_cells: shelter.clear_cells,
      } }), signal: shelter.signal,
    });
}

/** The native broker reconstructs the fixed program request and spends from
 * the same owner-reviewed call/cost ledger as the existing Responses lanes. */
export function createDesktopBrokerCompanionProgramTransport(input: {
  ownerProfileId: string; brokerOrigin: string; brokerToken: string;
  fetchImpl?: typeof fetch;
}): (program: CompanionProgramMenu & { signal: AbortSignal }) => Promise<Response> {
  if (!input.ownerProfileId ||
      !/^http:\/\/127\.0\.0\.1:\d{2,5}$/u.test(input.brokerOrigin) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(input.brokerToken) ||
      Buffer.from(input.brokerToken, "base64url").length !== 32)
    throw new Error("responses_companion_broker_config_invalid");
  const requesterRef = responsesActionRequesterForProfile(input.ownerProfileId);
  return program => {
    const { signal, ...menu } = program;
    buildCompanionProgramProviderRequest(menu);
    return (input.fetchImpl ?? fetch)(
      `${input.brokerOrigin}/v1/openai/responses/companion-program`, {
        method: "POST", headers: { Authorization: `Bearer ${input.brokerToken}`,
          "Content-Type": "application/json" },
        body: JSON.stringify({ requesterRef, program: menu }), signal,
      });
  };
}

/** Resident programs use a distinct fixed provider request, but the same
 * native own-key cost ledger and exact setup-contract validation. */
export function createDesktopBrokerCompanionResidentProgramTransport(input: {
  ownerProfileId: string; brokerOrigin: string; brokerToken: string;
  fetchImpl?: typeof fetch;
}): (program: CompanionResidentProviderMenu &
  { signal: AbortSignal }) => Promise<Response> {
  if (!input.ownerProfileId ||
      !/^http:\/\/127\.0\.0\.1:\d{2,5}$/u.test(input.brokerOrigin) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(input.brokerToken) ||
      Buffer.from(input.brokerToken, "base64url").length !== 32)
    throw new Error("responses_resident_broker_config_invalid");
  const requesterRef = responsesActionRequesterForProfile(input.ownerProfileId);
  return program => {
    const { signal, ...menu } = program;
    buildCompanionResidentProviderRequest(menu);
    return (input.fetchImpl ?? fetch)(
      `${input.brokerOrigin}/v1/openai/responses/companion-resident-program`, {
        method: "POST", headers: { Authorization: `Bearer ${input.brokerToken}`,
          "Content-Type": "application/json" },
        body: JSON.stringify({ requesterRef, residentProgram: menu }), signal,
      });
  };
}
