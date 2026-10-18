import type { TemporalExecutionAssociation, TemporalExecutionAssociationVerifier } from "./temporal-execution-association";

type Entry = {
  association: TemporalExecutionAssociation;
  verify: TemporalExecutionAssociationVerifier;
  expiresAt: number;
};

// A process-local handoff from the admitted MCP call to the native successor
// publisher. A process replacement loses this association and fails closed;
// it must never reconstruct a provider task identity from a database row.
const entries = new Map<string, Entry>();
const MAX_HANDOFF_MS = 5 * 60_000;

export async function registerDirectMcpTemporalAssociation(input: {
  association: TemporalExecutionAssociation;
  verify: TemporalExecutionAssociationVerifier;
}) {
  if (input.association.kind !== "direct_mcp_client" ||
      !input.association.associationId.startsWith("direct_mcp_context:") ||
      !input.association.continuationRef.startsWith("direct_mcp_session:")) return false;
  await input.verify(input.association);
  const now = Date.now();
  for (const [id, entry] of entries) if (entry.expiresAt <= now) entries.delete(id);
  const existing = entries.get(input.association.associationId);
  if (existing && JSON.stringify(existing.association) !== JSON.stringify(input.association)) return false;
  entries.set(input.association.associationId, {
    association: structuredClone(input.association), verify: input.verify,
    expiresAt: now + MAX_HANDOFF_MS,
  });
  return true;
}

export async function verifyRegisteredDirectMcpTemporalAssociation(input: {
  associationId: string;
  associationEpoch: number;
  continuationRef: string;
  profileRef: string;
  runId: string;
  roomId: string;
  participantId: string;
}): Promise<boolean> {
  const entry = entries.get(input.associationId);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(input.associationId);
    return false;
  }
  const association = entry.association;
  if (association.kind !== "direct_mcp_client" ||
      association.associationId !== input.associationId ||
      association.associationEpoch !== input.associationEpoch ||
      association.continuationRef !== input.continuationRef ||
      association.profileRef !== input.profileRef ||
      association.runId !== input.runId ||
      association.roomId !== input.roomId ||
      association.participantId !== input.participantId) return false;
  try {
    await entry.verify(association);
    return true;
  } catch {
    return false;
  }
}

/** Test and explicit shutdown hook; never interprets a missing entry as access. */
export function revokeDirectMcpTemporalAssociation(associationId: string): void {
  entries.delete(associationId);
}
