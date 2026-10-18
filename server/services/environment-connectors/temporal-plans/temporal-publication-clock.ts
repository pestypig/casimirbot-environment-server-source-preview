import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

// Process-local publication clock. Never extrapolate resident ticks from it.
const origin = `frontier_publication_clock:${crypto.randomUUID()}`;
const start = performance.now();
export const readTemporalPublicationClock = () => ({
  origin_id: origin,
  elapsed_ms: Math.floor(performance.now() - start),
});

export function measureTemporalProposalReceipt(
  published: { origin_id: string; elapsed_ms: number } | null | undefined,
  received: { origin_id: string; elapsed_ms: number },
) {
  const valid =
    published != null &&
    published.origin_id === received.origin_id &&
    !!published.origin_id &&
    Number.isSafeInteger(published.elapsed_ms) &&
    Number.isSafeInteger(received.elapsed_ms) &&
    published.elapsed_ms >= 0 &&
    received.elapsed_ms >= published.elapsed_ms;
  return {
    frontier_publication_to_proposal_receipt_ms: valid
      ? received.elapsed_ms - published.elapsed_ms
      : null,
    reason_code: valid
      ? "same_process_publication_interval"
      : "publication_clock_unavailable",
    // Includes transport, polling, user delay and reasoning; not pure sampling.
    provider_sampling_latency_ms: null,
    execution_authority: false as const,
    live_acceptance: false as const,
  };
}
