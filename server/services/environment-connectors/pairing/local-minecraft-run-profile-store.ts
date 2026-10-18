import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const STORE_SCHEMA_V1 = "casimirbot.local_minecraft_run_profiles/1" as const;
const STORE_SCHEMA = "casimirbot.local_minecraft_run_profiles/2" as const;
const MAX_STORE_BYTES = 64 * 1024;
const DESKTOP_PROFILE_STORE_RELATIVE_PATH = path.join(
  "@casimirbot",
  "desktop",
  "state",
  "local-minecraft-run-profiles.json",
) as string;

type StoreEntry = Readonly<{
  owner_profile_id: string;
  run_directory: string;
  player_game_directory?: string | null;
  label: string;
}>;

const exactLocalWindowsDirectory = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 1_024) return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z]:[\\/]/u.test(trimmed) || trimmed.startsWith("\\\\")) {
    return null;
  }
  const resolved = path.win32.resolve(trimmed);
  if (resolved === path.win32.parse(resolved).root) return null;
  return resolved;
};

const resolveStorePath = (input: {
  storePath?: string | null;
  appDataPath?: string | null;
}): string | null => {
  const explicit = input.storePath?.trim();
  if (explicit) return explicit;
  const appDataPath = input.appDataPath?.trim();
  if (!appDataPath || !path.isAbsolute(appDataPath)) return null;
  return path.join(
    path.resolve(appDataPath),
    DESKTOP_PROFILE_STORE_RELATIVE_PATH,
  );
};

/** Resolve both directories from one saved revision before any OS effect. */
export const resolveProfileOwnedMinecraftLifecycleSelection = async (input: {
  ownerProfileId: string; storePath?: string | null; appDataPath?: string | null;
}): Promise<{ runDirectory: string; playerGameDirectory: string } | null> => {
  const storePath = resolveStorePath(input);
  if (!input.ownerProfileId.trim() || !storePath) return null;
  try {
    const details = await stat(storePath);
    if (!details.isFile() || details.size <= 0 || details.size > MAX_STORE_BYTES) return null;
    const parsed = JSON.parse(await readFile(storePath, "utf8"));
    if (parsed.schema !== STORE_SCHEMA || !Array.isArray(parsed.profiles)) return null;
    const matches = parsed.profiles.filter((entry: unknown): entry is StoreEntry =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry) &&
      (entry as StoreEntry).owner_profile_id === input.ownerProfileId.trim());
    if (matches.length !== 1) return null;
    const entry = matches[0] as StoreEntry;
    if (Object.keys(entry).length !== 4 || typeof entry.label !== "string" ||
        !entry.label.trim() || entry.label.length > 120) return null;
    const runDirectory = exactLocalWindowsDirectory(entry.run_directory);
    const playerGameDirectory = exactLocalWindowsDirectory(entry.player_game_directory);
    if (!runDirectory || !playerGameDirectory) return null;
    const dirs = await Promise.all([runDirectory, playerGameDirectory,
      path.join(runDirectory, "config"), path.join(playerGameDirectory, "config"),
      path.join(playerGameDirectory, "mods")].map(dir => stat(dir)));
    if (dirs.some(dir => !dir.isDirectory()) ||
        !(await stat(path.join(runDirectory, "server.properties"))).isFile()) return null;
    return { runDirectory, playerGameDirectory };
  } catch { return null; }
};

/** Read-only setup preview; the fixed OS provider rechecks configuration at execution. */
export const readProfileOwnedMinecraftLifecycleAddress = async (input: {
  ownerProfileId: string; storePath?: string | null; appDataPath?: string | null;
}): Promise<string | null> => {
  const selection = await resolveProfileOwnedMinecraftLifecycleSelection(input);
  if (!selection) return null;
  try {
    const file = path.join(selection.runDirectory, "server.properties");
    if ((await stat(file)).size > 65_536) return null;
    const rows = (await readFile(file, "utf8")).split(/\r?\n/u)
      .filter(row => row.trim() && !/^\s*[#!]/u.test(row));
    if (rows.some(row => !/^\s*[A-Za-z0-9_.-]+\s*=/u.test(row) || /(?<!\\)(\\\\)*\\$/u.test(row))) return null;
    const ips = rows.filter(row => /^\s*server-ip\s*=/u.test(row));
    const ports = rows.filter(row => /^\s*server-port\s*=/u.test(row));
    if (ips.length !== 1 || ports.length !== 1) return null;
    const ip = ips[0].slice(ips[0].indexOf("=") + 1).trim();
    const port = ports[0].slice(ports[0].indexOf("=") + 1).trim();
    if (!["127.0.0.1", "::1"].includes(ip) || !/^[0-9]{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
    return `${ip === "::1" ? "[::1]" : ip}:${Number(port)}`;
  } catch { return null; }
};

export const resolveProfileOwnedMinecraftRunDirectory = async (input: {
  ownerProfileId: string;
  storePath?: string | null;
  appDataPath?: string | null;
}): Promise<string | null> => {
  const ownerProfileId = input.ownerProfileId.trim();
  const storePath = resolveStorePath(input);
  if (!ownerProfileId || !storePath) return null;
  const storeStat = await stat(storePath).catch(() => null);
  if (!storeStat?.isFile() || storeStat.size <= 0 || storeStat.size > MAX_STORE_BYTES) {
    return null;
  }
  const parsed = JSON.parse(await readFile(storePath, "utf8")) as {
    schema?: unknown;
    profiles?: unknown;
  };
  if (
    (parsed.schema !== STORE_SCHEMA && parsed.schema !== STORE_SCHEMA_V1) ||
    !Array.isArray(parsed.profiles)
  ) {
    return null;
  }
  const matches = parsed.profiles.filter((candidate): candidate is StoreEntry => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return false;
    }
    const entry = candidate as Record<string, unknown>;
    const expectedKeys = parsed.schema === STORE_SCHEMA ? 4 : 3;
    return Object.keys(entry).length === expectedKeys &&
      entry.owner_profile_id === ownerProfileId &&
      typeof entry.label === "string" &&
      entry.label.trim().length > 0 &&
      entry.label.length <= 120 &&
      exactLocalWindowsDirectory(entry.run_directory) !== null;
  });
  if (matches.length !== 1) return null;
  const runDirectory = exactLocalWindowsDirectory(matches[0].run_directory);
  if (!runDirectory) return null;
  const [directory, config, properties] = await Promise.all([
    stat(runDirectory).catch(() => null),
    stat(path.join(runDirectory, "config")).catch(() => null),
    stat(path.join(runDirectory, "server.properties")).catch(() => null),
  ]);
  return directory?.isDirectory() && config?.isDirectory() && properties?.isFile()
    ? runDirectory
    : null;
};

export const resolveProfileOwnedMinecraftPlayerGameDirectory = async (input: {
  ownerProfileId: string;
  storePath?: string | null;
  appDataPath?: string | null;
}): Promise<string | null> => {
  const ownerProfileId = input.ownerProfileId.trim();
  const storePath = resolveStorePath(input);
  if (!ownerProfileId || !storePath) return null;
  const storeStat = await stat(storePath).catch(() => null);
  if (!storeStat?.isFile() || storeStat.size <= 0 || storeStat.size > MAX_STORE_BYTES) {
    return null;
  }
  const parsed = JSON.parse(await readFile(storePath, "utf8")) as {
    schema?: unknown;
    profiles?: unknown;
  };
  if (parsed.schema !== STORE_SCHEMA || !Array.isArray(parsed.profiles)) {
    return null;
  }
  const matches = parsed.profiles.filter((candidate): candidate is StoreEntry => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return false;
    }
    const entry = candidate as Record<string, unknown>;
    return Object.keys(entry).length === 4 &&
      entry.owner_profile_id === ownerProfileId &&
      typeof entry.label === "string" &&
      entry.label.trim().length > 0 &&
      entry.label.length <= 120 &&
      exactLocalWindowsDirectory(entry.run_directory) !== null &&
      exactLocalWindowsDirectory(entry.player_game_directory) !== null;
  });
  if (matches.length !== 1) return null;
  const gameDirectory = exactLocalWindowsDirectory(
    matches[0].player_game_directory,
  );
  if (!gameDirectory) return null;
  const [directory, config, mods] = await Promise.all([
    stat(gameDirectory).catch(() => null),
    stat(path.join(gameDirectory, "config")).catch(() => null),
    stat(path.join(gameDirectory, "mods")).catch(() => null),
  ]);
  return directory?.isDirectory() && config?.isDirectory() && mods?.isDirectory()
    ? gameDirectory
    : null;
};
