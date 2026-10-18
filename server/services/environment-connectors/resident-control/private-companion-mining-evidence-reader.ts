import crypto from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  helixMinecraftCompanionMiningEvidenceSchema,
  type HelixMinecraftCompanionMiningEvidence,
  type HelixMinecraftCompanionMiningEvidenceReadRequest,
} from "@shared/helix-minecraft-companion-mining-mcp";

export const PRIVATE_COMPANION_C3_A1_CONFIG_RELATIVE_PATH =
  "artifacts/eh-mc-companion-survival-party-v1/A1/runtime/private-mining-mcp-config.json";
export const PRIVATE_COMPANION_C3_A1_EVIDENCE_RELATIVE_PATH =
  "artifacts/eh-mc-companion-survival-party-v1/A1/runtime/current-mining-evidence.json";
export const PRIVATE_COMPANION_C3_WORKSPACE_ROOT_ENV =
  "HELIX_PRIVATE_COMPANION_C3_WORKSPACE_ROOT" as const;

const configSchema = z.object({
  schema: z.literal("casimirbot.private_companion_c3_a1_mcp_config.v1"),
  enabled: z.literal(true),
  authorized_account_profile_id: z.string().trim().min(1).max(320),
  evidence_path: z.literal(PRIVATE_COMPANION_C3_A1_EVIDENCE_RELATIVE_PATH),
  evidence_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  expires_at: z.string().datetime({ offset: true }),
  public_capability_exposed: z.literal(false),
  execution_authority: z.literal(false),
  mining_execution_authority: z.literal(false),
  crafting_authority: z.literal(false),
  combat_authority: z.literal(false),
  world_authority: z.literal(false),
  credential_included: z.literal(false),
  terminal_eligible: z.literal(false),
}).strict();

type PrivateCompanionC3A1Config = z.infer<typeof configSchema>;

export class PrivateCompanionMiningEvidenceError extends Error {
  constructor(readonly code: string, readonly statusCode: number, message: string) {
    super(message);
    this.name = "PrivateCompanionMiningEvidenceError";
  }
}

const containedPath = (root: string, relativePath: string): string => {
  const canonicalRoot = realpathSync(root);
  const resolved = path.resolve(canonicalRoot, relativePath);
  const relative = path.relative(canonicalRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PrivateCompanionMiningEvidenceError(
      "companion_mining_evidence_path_outside_workspace", 500,
      "The private C3 evidence path escaped the canonical workspace.",
    );
  }
  return resolved;
};

const boundedRegularFile = (filePath: string, maxBytes: number): Buffer => {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBytes) {
    throw new PrivateCompanionMiningEvidenceError(
      "companion_mining_evidence_file_invalid", 500,
      "The private C3 input is not a bounded regular file.",
    );
  }
  return readFileSync(filePath);
};

const parseConfig = (input: {
  workspaceRoot: string;
  configPath?: string;
  now: Date;
}): PrivateCompanionC3A1Config => {
  const configPath = input.configPath ?? containedPath(
    input.workspaceRoot, PRIVATE_COMPANION_C3_A1_CONFIG_RELATIVE_PATH,
  );
  const parsed = configSchema.parse(JSON.parse(
    boundedRegularFile(configPath, 16_384).toString("utf8"),
  ));
  if (Date.parse(parsed.expires_at) <= input.now.getTime()) {
    throw new PrivateCompanionMiningEvidenceError(
      "companion_mining_private_mcp_config_expired", 410,
      "The private C3 A1 configuration has expired.",
    );
  }
  return parsed;
};

export type PrivateCompanionMiningMcpRuntime = Readonly<{
  enabled: boolean;
  reader?: (input: {
    ownerProfileId: string;
    request: HelixMinecraftCompanionMiningEvidenceReadRequest;
  }) => Promise<HelixMinecraftCompanionMiningEvidence>;
  disabledReason: string | null;
}>;

export const resolvePrivateCompanionMiningMcpRuntime = (input: {
  ownerProfileId: string;
  workspaceRoot?: string;
  configPath?: string;
  now?: () => Date;
}): PrivateCompanionMiningMcpRuntime => {
  const configuredWorkspaceRoot =
    process.env[PRIVATE_COMPANION_C3_WORKSPACE_ROOT_ENV]?.trim();
  const workspaceRoot = input.workspaceRoot ?? configuredWorkspaceRoot ?? process.cwd();
  const now = input.now ?? (() => new Date());
  let config: PrivateCompanionC3A1Config;
  try {
    config = parseConfig({ workspaceRoot, configPath: input.configPath, now: now() });
  } catch (error) {
    return {
      enabled: false,
      disabledReason: error instanceof PrivateCompanionMiningEvidenceError
        ? error.code : "companion_mining_private_mcp_config_unavailable",
    };
  }
  if (config.authorized_account_profile_id !== input.ownerProfileId) {
    return { enabled: false, disabledReason: "companion_mining_private_mcp_owner_mismatch" };
  }
  const evidencePath = containedPath(workspaceRoot, config.evidence_path);
  return {
    enabled: true,
    disabledReason: null,
    reader: async ({ ownerProfileId, request }) => {
      const current = parseConfig({ workspaceRoot, configPath: input.configPath, now: now() });
      if (ownerProfileId !== input.ownerProfileId
        || current.authorized_account_profile_id !== input.ownerProfileId) {
        throw new PrivateCompanionMiningEvidenceError(
          "companion_mining_private_mcp_owner_mismatch", 403,
          "The private C3 evidence belongs to another authenticated profile.",
        );
      }
      const bytes = boundedRegularFile(evidencePath, 512_000);
      const actual = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
      if (actual !== current.evidence_sha256) {
        throw new PrivateCompanionMiningEvidenceError(
          "companion_mining_evidence_integrity_mismatch", 409,
          "The private C3 evidence no longer matches its admitted hash.",
        );
      }
      const evidence = helixMinecraftCompanionMiningEvidenceSchema.parse(
        JSON.parse(bytes.toString("utf8")),
      );
      if (JSON.stringify(evidence.identity) !== JSON.stringify(request.identity)
        || evidence.controller_artifact_hash !== request.controller_artifact_hash
        || evidence.custody_revision !== request.custody_revision) {
        throw new PrivateCompanionMiningEvidenceError(
          "companion_mining_identity_or_revision_mismatch", 409,
          "The requested C3 identity, controller artifact, or custody revision is stale.",
        );
      }
      return evidence;
    },
  };
};
