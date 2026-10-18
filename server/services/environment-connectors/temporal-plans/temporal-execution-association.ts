/**
 * Temporal admission can be initiated either by an exact room-steering binding
 * or by an authenticated MCP client acting directly. A direct client session is
 * deliberately not a provider-thread/Helix-chat binding. Neither association
 * grants environment authority; the goal, participant, source and action lease
 * are checked separately by the normal preflight and broker.
 */
export type TemporalExecutionAssociation = Readonly<{
  kind: "reasoning_binding" | "direct_mcp_client";
  associationId: string;
  associationEpoch: number;
  profileRef: string;
  runId: string;
  roomId: string;
  participantId: string;
  /** Server-derived client-session ref for direct MCP; exact thread for binding. */
  continuationRef: string;
}>;

export type TemporalExecutionAssociationVerifier = (
  association: TemporalExecutionAssociation,
) => void | Promise<void>;
