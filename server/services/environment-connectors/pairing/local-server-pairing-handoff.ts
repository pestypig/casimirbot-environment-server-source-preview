import crypto from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveProfileOwnedMinecraftRunDirectory } from
  "./local-minecraft-run-profile-store";

const SERVER_PAIRING_INBOX = "helix-fabric-sensor.pairing-inbox" as const;
const SERVER_PAIRING_ENVELOPE_SCHEMA =
  "casimirbot.local_server_pairing_handoff.v1" as const;
const PAIRING_REDEEM_PATH =
  "/api/environment-connectors/v1/pairing/redeem" as const;
const SERVER_PAIRING_COMMAND =
  /^\/helix\s+pair\s+[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\s*$/u;

export class LocalServerPairingHandoffError extends Error {
  constructor(
    readonly code:
      | "local_server_pairing_root_unavailable"
      | "local_server_pairing_command_invalid"
      | "local_server_pairing_endpoint_invalid"
      | "local_server_pairing_path_invalid",
    message: string,
  ) {
    super(message);
    this.name = "LocalServerPairingHandoffError";
  }
}

const loopbackRedeemEndpointFromBaseUrl = (
  value?: string | null,
): string | null => {
  if (!value?.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      !parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) return null;
    return `${parsed.origin}${PAIRING_REDEEM_PATH}`;
  } catch {
    return null;
  }
};

/**
 * Resolves the same-host redeem API independently from a forwarded request's
 * Host header. Desktop MCP requests enter through a native broker port, while
 * the connector redeem route is served by the adjacent local service port.
 */
export const resolveLocalMinecraftPairingEndpoint = (input: {
  serviceBaseUrl?: string | null;
  requestBaseUrl?: string | null;
}): string => {
  const endpoint =
    loopbackRedeemEndpointFromBaseUrl(input.serviceBaseUrl) ??
    loopbackRedeemEndpointFromBaseUrl(input.requestBaseUrl);
  if (!endpoint) {
    throw new LocalServerPairingHandoffError(
      "local_server_pairing_endpoint_invalid",
      "The local server pairing endpoint must resolve to the exact current loopback service.",
    );
  }
  return endpoint;
};

export const stageLocalMinecraftServerPairing = async (input: {
  command: string;
  pairingEndpoint?: string | null;
  workspaceRoot?: string | null;
  serverRunDirectory?: string | null;
  ownerProfileId?: string | null;
  appDataPath?: string | null;
}): Promise<{ status: "server_pairing_inbox_staged" }> => {
  const command = input.command.trim();
  if (
    !SERVER_PAIRING_COMMAND.test(command) ||
    Buffer.byteLength(command, "utf8") > 512
  ) {
    throw new LocalServerPairingHandoffError(
      "local_server_pairing_command_invalid",
      "The generated server-pairing command failed the bounded local handoff contract.",
    );
  }
  let pairingEndpoint: string | null = null;
  if (input.pairingEndpoint?.trim()) {
    try {
      const parsed = new URL(input.pairingEndpoint.trim());
      if (
        parsed.protocol !== "http:" ||
        parsed.hostname !== "127.0.0.1" ||
        !parsed.port ||
        parsed.pathname !== PAIRING_REDEEM_PATH ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) throw new Error("pairing endpoint outside bounded loopback contract");
      pairingEndpoint = parsed.toString();
    } catch {
      throw new LocalServerPairingHandoffError(
        "local_server_pairing_endpoint_invalid",
        "The local server pairing endpoint must be the exact current loopback redeem route.",
      );
    }
  }

  const workspaceRoot = path.resolve(
    input.workspaceRoot?.trim() || process.cwd(),
  );
  if (!workspaceRoot) {
    throw new LocalServerPairingHandoffError(
      "local_server_pairing_root_unavailable",
      "The same-host Fabric server workspace is unavailable.",
    );
  }
  const fixedRunRoot = path.resolve(
    workspaceRoot,
    "minecraft",
    "helix-fabric-sensor",
    "run",
  );
  const profileOwnedServerRoot = input.ownerProfileId?.trim()
    ? await resolveProfileOwnedMinecraftRunDirectory({
        ownerProfileId: input.ownerProfileId,
        storePath: process.env.HELIX_DESKTOP_MINECRAFT_PROFILE_STORE,
        appDataPath: input.appDataPath?.trim() || process.env.APPDATA,
      })
    : null;
  const configuredServerRoot =
    input.serverRunDirectory?.trim() ||
    profileOwnedServerRoot ||
    process.env.HELIX_MINECRAFT_SERVER_RUN_DIR?.trim() ||
    fixedRunRoot;
  const serverRoot = path.isAbsolute(configuredServerRoot)
    ? path.resolve(configuredServerRoot)
    : path.resolve(workspaceRoot, configuredServerRoot);
  const relativeServerRoot = path.relative(fixedRunRoot, serverRoot);
  const relativeSegments = relativeServerRoot
    .split(path.sep)
    .filter(Boolean);
  if (!profileOwnedServerRoot &&
    (
    relativeServerRoot.startsWith("..") ||
    path.isAbsolute(relativeServerRoot) ||
    relativeSegments.length > 1
    )) {
    throw new LocalServerPairingHandoffError(
      "local_server_pairing_path_invalid",
      "The selected local server profile must be the fixed Fabric run root or one direct child profile.",
    );
  }
  const configDirectory = path.resolve(serverRoot, "config");
  const relativeConfig = path.relative(workspaceRoot, configDirectory);
  if (!profileOwnedServerRoot &&
    (
    relativeConfig.startsWith("..") ||
    path.isAbsolute(relativeConfig)
    )) {
    throw new LocalServerPairingHandoffError(
      "local_server_pairing_path_invalid",
      "The local server pairing inbox resolved outside the fixed repository Fabric server profile.",
    );
  }

  await mkdir(configDirectory, { recursive: true });
  const inboxPath = path.join(configDirectory, SERVER_PAIRING_INBOX);
  const pendingPath = path.join(
    configDirectory,
    `${SERVER_PAIRING_INBOX}.pending.${process.pid}.${crypto.randomUUID()}`,
  );
  const payload = pairingEndpoint
    ? JSON.stringify({
        schema: SERVER_PAIRING_ENVELOPE_SCHEMA,
        command,
        pairing_endpoint: pairingEndpoint,
      })
    : command;
  if (Buffer.byteLength(payload, "utf8") > 512) {
    throw new LocalServerPairingHandoffError(
      "local_server_pairing_command_invalid",
      "The generated local server pairing envelope exceeded its bounded size.",
    );
  }
  try {
    await writeFile(pendingPath, payload, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rm(inboxPath, { force: true });
    await rename(pendingPath, inboxPath);
  } finally {
    await rm(pendingPath, { force: true }).catch(() => undefined);
  }
  return { status: "server_pairing_inbox_staged" };
};
