import type { ResponsesActionProviderMenu } from
  "@shared/helix-responses-action-provider-request";
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
