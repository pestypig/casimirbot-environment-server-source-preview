import crypto from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  helixMinecraftCompanionPresenceEvidenceSchema,
  type HelixMinecraftCompanionPresenceEvidence,
  type HelixMinecraftCompanionPresenceEvidenceReadRequest,
} from "@shared/helix-minecraft-companion-mcp";

export const PRIVATE_COMPANION_C0_A1_CONFIG_RELATIVE_PATH =
  "artifacts/eh-mc-companion-survival-party-v1/A1/runtime/private-mcp-config.json";
export const PRIVATE_COMPANION_C0_A1_EVIDENCE_RELATIVE_PATH =
  "artifacts/eh-mc-companion-survival-party-v1/A1/runtime/current-presence-evidence.json";

const configSchema = z.object({
  schema: z.literal("casimirbot.private_companion_c0_a1_mcp_config.v1"),
  enabled: z.literal(true),
  authorized_account_profile_id: z.string().trim().min(1).max(320),
  evidence_path: z.literal(PRIVATE_COMPANION_C0_A1_EVIDENCE_RELATIVE_PATH),
  evidence_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  expires_at: z.string().datetime({ offset: true }),
  public_capability_exposed: z.literal(false),
  execution_authority: z.literal(false),
  mining_authorized: z.literal(false),
  credential_included: z.literal(false),
  terminal_eligible: z.literal(false),
}).strict();

type PrivateCompanionC0A1Config = z.infer<typeof configSchema>;

export class PrivateCompanionPresenceEvidenceError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "PrivateCompanionPresenceEvidenceError";
  }
}

const readBoundedRegularFile = (filePath: string, maxBytes: number): Buffer => {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new PrivateCompanionPresenceEvidenceError(
      "companion_presence_evidence_file_invalid",
      500,
      "The private companion evidence input is not a regular file.",
    );
  }
  if (stat.size <= 0 || stat.size > maxBytes) {
    throw new PrivateCompanionPresenceEvidenceError(
      "companion_presence_evidence_file_size_invalid",
      500,
      "The private companion evidence input is empty or exceeds its bounded size.",
    );
  }
  return readFileSync(filePath);
};

const resolveContainedFile = (
  workspaceRoot: string,
  relativePath: string,
): string => {
  const canonicalRoot = realpathSync(workspaceRoot);
  const resolved = path.resolve(canonicalRoot, relativePath);
  const relative = path.relative(canonicalRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PrivateCompanionPresenceEvidenceError(
      "companion_presence_evidence_path_outside_workspace",
      500,
      "The private companion evidence path escaped the canonical workspace.",
    );
  }
  return resolved;
};

const parseConfig = (input: {
  workspaceRoot: string;
  configPath?: string;
  now: Date;
}): PrivateCompanionC0A1Config => {
  const configPath = input.configPath ?? resolveContainedFile(
    input.workspaceRoot,
    PRIVATE_COMPANION_C0_A1_CONFIG_RELATIVE_PATH,
  );
  const parsed = configSchema.parse(JSON.parse(
    readBoundedRegularFile(configPath, 16_384).toString("utf8"),
  ));
  if (Date.parse(parsed.expires_at) <= input.now.getTime()) {
    throw new PrivateCompanionPresenceEvidenceError(
      "companion_presence_private_mcp_config_expired",
      410,
      "The private C0 A1 MCP configuration has expired.",
    );
  }
  return parsed;
};

export type PrivateCompanionPresenceMcpRuntime = Readonly<{
  enabled: boolean;
  reader?: (input: {
    ownerProfileId: string;
    request: HelixMinecraftCompanionPresenceEvidenceReadRequest;
  }) => Promise<HelixMinecraftCompanionPresenceEvidence>;
  disabledReason: string | null;
}>;

export const resolvePrivateCompanionPresenceMcpRuntime = (input: {
  ownerProfileId: string;
  workspaceRoot?: string;
  configPath?: string;
  now?: () => Date;
}): PrivateCompanionPresenceMcpRuntime => {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const now = input.now ?? (() => new Date());
  let config: PrivateCompanionC0A1Config;
  try {
    config = parseConfig({
      workspaceRoot,
      configPath: input.configPath,
      now: now(),
    });
  } catch (error) {
    return {
      enabled: false,
      disabledReason: error instanceof PrivateCompanionPresenceEvidenceError
        ? error.code
        : "companion_presence_private_mcp_config_unavailable",
    };
  }
  if (config.authorized_account_profile_id !== input.ownerProfileId) {
    return {
      enabled: false,
      disabledReason: "companion_presence_private_mcp_owner_mismatch",
    };
  }

  const evidencePath = resolveContainedFile(
    workspaceRoot,
    config.evidence_path,
  );
  return {
    enabled: true,
    disabledReason: null,
    reader: async ({ ownerProfileId }) => {
      const currentConfig = parseConfig({
        workspaceRoot,
        configPath: input.configPath,
        now: now(),
      });
      if (
        currentConfig.authorized_account_profile_id !== input.ownerProfileId ||
        ownerProfileId !== input.ownerProfileId
      ) {
        throw new PrivateCompanionPresenceEvidenceError(
          "companion_presence_private_mcp_owner_mismatch",
          403,
          "The private companion evidence belongs to another authenticated profile.",
        );
      }
      const bytes = readBoundedRegularFile(evidencePath, 256_000);
      const actualHash = `sha256:${crypto
        .createHash("sha256")
        .update(bytes)
        .digest("hex")}`;
      if (actualHash !== currentConfig.evidence_sha256) {
        throw new PrivateCompanionPresenceEvidenceError(
          "companion_presence_evidence_integrity_mismatch",
          409,
          "The private companion evidence no longer matches its admitted hash.",
        );
      }
      return helixMinecraftCompanionPresenceEvidenceSchema.parse(
        JSON.parse(bytes.toString("utf8")),
      );
    },
  };
};
