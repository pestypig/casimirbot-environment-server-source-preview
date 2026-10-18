import crypto from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveProfileOwnedMinecraftPlayerGameDirectory } from
  "./local-minecraft-run-profile-store";

const PLAYER_PAIRING_INBOX =
  "helix-fabric-player-agent.pairing-inbox" as const;
const PLAYER_PAIRING_COMMAND =
  /^\/helix-player\s+pair\s+[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}(?:\s+\S+)?\s*$/u;

export class LocalPlayerPairingHandoffError extends Error {
  constructor(
    readonly code:
      | "local_player_pairing_root_unavailable"
      | "local_player_pairing_command_invalid"
      | "local_player_pairing_game_directory_invalid"
      | "local_player_pairing_path_invalid",
    message: string,
  ) {
    super(message);
    this.name = "LocalPlayerPairingHandoffError";
  }
}

export const stageLocalMinecraftPlayerPairing = async (input: {
  command: string;
  appDataPath?: string | null;
  minecraftGameDirectoryPath?: string | null;
  ownerProfileId?: string | null;
}): Promise<{ status: "player_pairing_inbox_staged" }> => {
  const command = input.command.trim();
  if (
    !PLAYER_PAIRING_COMMAND.test(command) ||
    Buffer.byteLength(command, "utf8") > 512
  ) {
    throw new LocalPlayerPairingHandoffError(
      "local_player_pairing_command_invalid",
      "The generated player-pairing command failed the bounded local handoff contract.",
    );
  }

  const appDataPath = input.appDataPath?.trim() || process.env.APPDATA?.trim();
  if (!appDataPath) {
    throw new LocalPlayerPairingHandoffError(
      "local_player_pairing_root_unavailable",
      "The same-host Minecraft instance root is unavailable.",
    );
  }
  const profileOwnedGameDirectory = input.ownerProfileId?.trim()
    ? await resolveProfileOwnedMinecraftPlayerGameDirectory({
        ownerProfileId: input.ownerProfileId,
        storePath: process.env.HELIX_DESKTOP_MINECRAFT_PROFILE_STORE,
        appDataPath,
      })
    : null;
  const configuredGameDirectory =
    input.minecraftGameDirectoryPath?.trim() ||
    profileOwnedGameDirectory ||
    process.env.HELIX_MINECRAFT_PLAYER_GAME_DIR?.trim();
  if (configuredGameDirectory && !path.isAbsolute(configuredGameDirectory)) {
    throw new LocalPlayerPairingHandoffError(
      "local_player_pairing_game_directory_invalid",
      "The configured Minecraft player game directory must be absolute.",
    );
  }
  const minecraftRoot = configuredGameDirectory
    ? path.resolve(configuredGameDirectory)
    : path.resolve(appDataPath, ".minecraft");
  if (minecraftRoot === path.parse(minecraftRoot).root) {
    throw new LocalPlayerPairingHandoffError(
      "local_player_pairing_game_directory_invalid",
      "The configured Minecraft player game directory cannot be a filesystem root.",
    );
  }
  const configDirectory = path.resolve(minecraftRoot, "config");
  const relativeConfig = path.relative(minecraftRoot, configDirectory);
  if (relativeConfig.startsWith("..") || path.isAbsolute(relativeConfig)) {
    throw new LocalPlayerPairingHandoffError(
      "local_player_pairing_path_invalid",
      "The local pairing inbox resolved outside the Minecraft instance.",
    );
  }

  await mkdir(configDirectory, { recursive: true });
  const inboxPath = path.join(configDirectory, PLAYER_PAIRING_INBOX);
  const pendingPath = path.join(
    configDirectory,
    `${PLAYER_PAIRING_INBOX}.pending.${process.pid}.${crypto.randomUUID()}`,
  );
  try {
    await writeFile(pendingPath, command, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rm(inboxPath, { force: true });
    await rename(pendingPath, inboxPath);
  } finally {
    await rm(pendingPath, { force: true }).catch(() => undefined);
  }
  return { status: "player_pairing_inbox_staged" };
};
