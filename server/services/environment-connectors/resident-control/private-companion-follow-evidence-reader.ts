import crypto from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  helixMinecraftCompanionFollowEvidenceSchema,
  type HelixMinecraftCompanionFollowEvidence,
  type HelixMinecraftCompanionFollowEvidenceReadRequest,
} from "@shared/helix-minecraft-companion-follow-mcp";

export const PRIVATE_COMPANION_C1_A1_CONFIG_RELATIVE_PATH =
  "artifacts/eh-mc-companion-survival-party-v1/A1/runtime/private-follow-mcp-config.json";
export const PRIVATE_COMPANION_C1_A1_EVIDENCE_RELATIVE_PATH =
  "artifacts/eh-mc-companion-survival-party-v1/A1/runtime/current-follow-evidence.json";

const configSchema = z.object({
  schema: z.literal("casimirbot.private_companion_c1_a1_mcp_config.v1"),
  enabled: z.literal(true),
  authorized_account_profile_id: z.string().trim().min(1).max(320),
  evidence_path: z.literal(PRIVATE_COMPANION_C1_A1_EVIDENCE_RELATIVE_PATH),
  evidence_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  expires_at: z.string().datetime({ offset: true }),
  public_capability_exposed: z.literal(false),
  execution_authority: z.literal(false),
  mutation_authority: z.literal(false),
  inventory_authority: z.literal(false),
  mining_authorized: z.literal(false),
  combat_authorized: z.literal(false),
  credential_included: z.literal(false),
  terminal_eligible: z.literal(false),
}).strict();

type PrivateCompanionC1A1Config = z.infer<typeof configSchema>;

export class PrivateCompanionFollowEvidenceError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "PrivateCompanionFollowEvidenceError";
  }
}

const readBoundedRegularFile = (filePath: string, maxBytes: number): Buffer => {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new PrivateCompanionFollowEvidenceError(
      "companion_follow_evidence_file_invalid", 500,
      "The private C1 evidence input is not a regular file.",
    );
  }
  if (stat.size <= 0 || stat.size > maxBytes) {
    throw new PrivateCompanionFollowEvidenceError(
      "companion_follow_evidence_file_size_invalid", 500,
      "The private C1 evidence input is empty or exceeds its bounded size.",
    );
  }
  return readFileSync(filePath);
};

const resolveContainedFile = (workspaceRoot: string, relativePath: string): string => {
  const canonicalRoot = realpathSync(workspaceRoot);
  const resolved = path.resolve(canonicalRoot, relativePath);
  const relative = path.relative(canonicalRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PrivateCompanionFollowEvidenceError(
      "companion_follow_evidence_path_outside_workspace", 500,
      "The private C1 evidence path escaped the canonical workspace.",
    );
  }
  return resolved;
};

const parseConfig = (input: {
  workspaceRoot: string;
  configPath?: string;
  now: Date;
}): PrivateCompanionC1A1Config => {
  const configPath = input.configPath ?? resolveContainedFile(
    input.workspaceRoot,
    PRIVATE_COMPANION_C1_A1_CONFIG_RELATIVE_PATH,
  );
  const parsed = configSchema.parse(JSON.parse(
    readBoundedRegularFile(configPath, 16_384).toString("utf8"),
  ));
  if (Date.parse(parsed.expires_at) <= input.now.getTime()) {
    throw new PrivateCompanionFollowEvidenceError(
      "companion_follow_private_mcp_config_expired", 410,
      "The private C1 A1 MCP configuration has expired.",
    );
  }
  return parsed;
};

export type PrivateCompanionFollowMcpRuntime = Readonly<{
  enabled: boolean;
  reader?: (input: {
    ownerProfileId: string;
    request: HelixMinecraftCompanionFollowEvidenceReadRequest;
  }) => Promise<HelixMinecraftCompanionFollowEvidence>;
  disabledReason: string | null;
}>;

export const resolvePrivateCompanionFollowMcpRuntime = (input: {
  ownerProfileId: string;
  workspaceRoot?: string;
  configPath?: string;
  now?: () => Date;
}): PrivateCompanionFollowMcpRuntime => {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const now = input.now ?? (() => new Date());
  let config: PrivateCompanionC1A1Config;
  try {
    config = parseConfig({ workspaceRoot, configPath: input.configPath, now: now() });
  } catch (error) {
    return {
      enabled: false,
      disabledReason: error instanceof PrivateCompanionFollowEvidenceError
        ? error.code
        : "companion_follow_private_mcp_config_unavailable",
    };
  }
  if (config.authorized_account_profile_id !== input.ownerProfileId) {
    return { enabled: false, disabledReason: "companion_follow_private_mcp_owner_mismatch" };
  }
  const evidencePath = resolveContainedFile(workspaceRoot, config.evidence_path);
  return {
    enabled: true,
    disabledReason: null,
    reader: async ({ ownerProfileId, request }) => {
      const currentConfig = parseConfig({
        workspaceRoot,
        configPath: input.configPath,
        now: now(),
      });
      if (
        currentConfig.authorized_account_profile_id !== input.ownerProfileId ||
        ownerProfileId !== input.ownerProfileId
      ) {
        throw new PrivateCompanionFollowEvidenceError(
          "companion_follow_private_mcp_owner_mismatch", 403,
          "The private C1 evidence belongs to another authenticated profile.",
        );
      }
      const bytes = readBoundedRegularFile(evidencePath, 256_000);
      const actualHash = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
      if (actualHash !== currentConfig.evidence_sha256) {
        throw new PrivateCompanionFollowEvidenceError(
          "companion_follow_evidence_integrity_mismatch", 409,
          "The private C1 evidence no longer matches its admitted hash.",
        );
      }
      const evidence = helixMinecraftCompanionFollowEvidenceSchema.parse(
        JSON.parse(bytes.toString("utf8")),
      );
      if (
        JSON.stringify(evidence.identity) !== JSON.stringify(request.identity) ||
        evidence.controller_artifact_hash !== request.controller_artifact_hash
      ) {
        throw new PrivateCompanionFollowEvidenceError(
          "companion_follow_identity_mismatch", 409,
          "The requested identity or controller artifact is stale.",
        );
      }
      return evidence;
    },
  };
};
