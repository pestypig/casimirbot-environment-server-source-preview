import { createHash } from "node:crypto";
import { TemporalPlanError } from "./temporal-plan-error";
import type { TemporalExecutionAssociation, TemporalExecutionAssociationVerifier } from "./temporal-execution-association";

const digest = (parts: readonly string[]) =>
  createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");

/**
 * A server-derived client-session association, not an authenticated provider
 * thread or a Helix chat binding. The caller cannot choose its ID or epoch.
 * Room/run membership is rechecked by the supplied server-owned reader at
 * every asynchronous admission boundary; environment authority remains with
 * the normal goal and action broker.
 */
export function createDirectMcpTemporalContext(input: {
  serviceInstanceRef: string;
  profileRef: string;
  authenticatedMcpClientRef: string;
  accountSessionId: string;
  roomId: string;
  runId: string;
  participantId: string;
  authorizationExpiresAt: string | null;
  verifyCurrent: () => Promise<void>;
  now?: () => Date;
}): { association: TemporalExecutionAssociation; verifyAssociation: TemporalExecutionAssociationVerifier } {
  const now = input.now ?? (() => new Date());
  if (Object.values(input).some(value => value === "") ||
      (input.authorizationExpiresAt !== null &&
        !Number.isFinite(Date.parse(input.authorizationExpiresAt)))) {
    throw new TemporalPlanError("temporal_direct_context_identity_mismatch");
  }
  const clientSessionRef = `direct_mcp_session:${digest([
    input.profileRef, input.authenticatedMcpClientRef, input.accountSessionId,
  ])}`;
  const association: TemporalExecutionAssociation = Object.freeze({
    kind: "direct_mcp_client",
    associationId: `direct_mcp_context:${digest([
      input.serviceInstanceRef, clientSessionRef, input.roomId, input.runId,
      input.participantId,
    ])}`,
    associationEpoch: 1,
    profileRef: input.profileRef,
    runId: input.runId,
    roomId: input.roomId,
    participantId: input.participantId,
    // This is authenticated-client provenance, never a claimed Codex thread.
    continuationRef: clientSessionRef,
  });
  const verifyAssociation: TemporalExecutionAssociationVerifier = async candidate => {
    if (candidate.kind !== association.kind ||
        candidate.associationId !== association.associationId ||
        candidate.associationEpoch !== association.associationEpoch ||
        candidate.profileRef !== association.profileRef ||
        candidate.runId !== association.runId || candidate.roomId !== association.roomId ||
        candidate.participantId !== association.participantId ||
        candidate.continuationRef !== association.continuationRef) {
      throw new TemporalPlanError("temporal_direct_context_identity_mismatch");
    }
    if (input.authorizationExpiresAt !== null &&
        Date.parse(input.authorizationExpiresAt) <= now().getTime()) {
      throw new TemporalPlanError("temporal_direct_context_unavailable");
    }
    await input.verifyCurrent();
  };
  return { association, verifyAssociation };
}
