import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { helixMinecraftLocalServerLifecycleSchema,
  type HelixMinecraftLocalServerLifecycle } from "@shared/helix-minecraft-local-lifecycle";

const execFileAsync = promisify(execFile);
const resultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), server: helixMinecraftLocalServerLifecycleSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.string().regex(/^minecraft_[a-z0-9_]{1,100}$/),
    server: helixMinecraftLocalServerLifecycleSchema.nullable() }).strict(),
]);

export class MinecraftLocalServerLifecycleError extends Error {
  constructor(readonly code: string, readonly observation: HelixMinecraftLocalServerLifecycle | null = null) {
    super(code);
  }
}

export const parseMinecraftLocalServerResult = (stdout: string): HelixMinecraftLocalServerLifecycle => {
  for (const line of stdout.split(/\r?\n/u).reverse()) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    const parsed = resultSchema.safeParse(raw);
    if (!parsed.success) continue;
    if (!parsed.data.ok) throw new MinecraftLocalServerLifecycleError(parsed.data.error, parsed.data.server);
    if (parsed.data.server.status !== "listening") throw new MinecraftLocalServerLifecycleError(
      "minecraft_server_not_ready", parsed.data.server);
    return parsed.data.server;
  }
  throw new MinecraftLocalServerLifecycleError("minecraft_server_receipt_missing");
};

/** Internal fixed OS provider. Directory comes only from the authenticated
 * profile's saved selection; this function is not an HTTP/MCP input surface. */
export const startSavedMinecraftFabricServer = async (input: {
  runDirectory: string; address: string; signal?: AbortSignal;
}): Promise<HelixMinecraftLocalServerLifecycle> => {
  if (process.platform !== "win32") throw new MinecraftLocalServerLifecycleError("minecraft_windows_runtime_required");
  const windowsRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim();
  if (!windowsRoot || !path.win32.isAbsolute(windowsRoot)) {
    throw new MinecraftLocalServerLifecycleError("minecraft_windows_runtime_unavailable");
  }
  const script = path.resolve(process.cwd(), "scripts", "helix-minecraft-start-fabric-server.ps1");
  await access(script).catch(() => { throw new MinecraftLocalServerLifecycleError("minecraft_server_script_missing"); });
  try {
    const { stdout } = await execFileAsync(path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
        "-ServerRunDirectory", input.runDirectory, "-Address", input.address],
      { cwd: process.cwd(), windowsHide: true, timeout: 90_000, maxBuffer: 64 * 1024,
        encoding: "utf8", signal: input.signal });
    return parseMinecraftLocalServerResult(stdout);
  } catch (error) {
    if (error instanceof MinecraftLocalServerLifecycleError) throw error;
    // A killed/failed wrapper is not evidence that its server child exited.
    // The script's durable process state reconciles the next explicit call.
    throw new MinecraftLocalServerLifecycleError("minecraft_server_start_outcome_unknown");
  }
};
