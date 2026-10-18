/** Offline observer of already verified lifecycle diagnostics. Never admission. */
import { mapTemporalServerMarkToRequest } from "./temporal-clock-envelope";
type RecordValue = Record<string, unknown>;
export function auditTemporalCorrelatedBudget(input: {
  admission: RecordValue;
  delivery: RecordValue;
  acceptance: RecordValue;
  /** Optional until the response-ready diagnostic is present in the trace. */
  frontierResponse?: RecordValue;
  source: "simulated" | "measured";
  /** Window measured from this same checkpoint, not remaining time at pickup. */
  checkpoint_to_stop_window_ms: number | null;
  safety_margin_ms: number;
}) {
  const { admission: a, delivery: d, acceptance: n } = input;
  const reasons: string[] = [];
  const integer = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0;
  for (const key of ["run_id", "producer_epoch_ref", "checkpoint_id"]) {
    if (!text(a[key]) || a[key] !== d[key] || a[key] !== n[key])
      reasons.push("identity_mismatch");
  }
  if (
    !text(a.action_request_id) ||
    a.action_request_id !== d.action_request_id ||
    a.action_request_id !== n.successor_action_request_id ||
    !text(d.resident_action_request_id) ||
    d.resident_action_request_id !== n.resident_action_request_id ||
    !text(a.plan_id) ||
    a.plan_id !== d.plan_id ||
    a.plan_id !== n.sequence_id ||
    !text(a.reasoning_binding_id) ||
    a.reasoning_binding_id !== d.reasoning_binding_id ||
    !integer(a.reasoning_binding_epoch) ||
    a.reasoning_binding_epoch < 1 ||
    a.reasoning_binding_epoch !== d.reasoning_binding_epoch
  )
    reasons.push("identity_mismatch");
  if (
    !text(a.clock_origin) ||
    a.clock_origin !== d.clock_origin ||
    n.clock_domain !== "native_process_monotonic"
  )
    reasons.push("clock_origin_mismatch");
  const marks = [
    a.proposal_received_ms,
    a.transaction_returned_ms,
    d.poll_received_ms,
    d.lease_sql_finished_ms,
    d.transaction_returned_ms,
  ];
  if (
    !marks.every(integer) ||
    marks.some(
      (mark, i) => i > 0 && (mark as number) < (marks[i - 1] as number),
    )
  )
    reasons.push("server_marks_invalid");
  if (d.configured_persistence_barrier_completed !== true)
    reasons.push("persistence_barrier_missing");
  if (
    !integer(n.checkpoint_to_acceptance_ms) ||
    !integer(n.accepted_client_tick) ||
    !integer(n.stop_client_tick) ||
    n.accepted_client_tick >= n.stop_client_tick
  )
    reasons.push("native_acceptance_invalid");
  if (!integer(a.frontier_publication_to_proposal_receipt_ms))
    reasons.push("publication_interval_missing");
  if (!integer(input.safety_margin_ms)) reasons.push("margin_invalid");
  const response = input.frontierResponse;
  let responseToProposalMs: number | null = null;
  let responsePreparationMs: number | null = null;
  if (response) {
    const identityMatches = ["frontier_id", "run_id", "producer_epoch_ref", "checkpoint_id"]
      .every(key => text(a[key]) && a[key] === response[key]);
    if (!identityMatches) reasons.push("frontier_response_identity_mismatch");
    const clockMatches = text(response.clock_origin) && response.clock_origin === a.clock_origin;
    if (!clockMatches) reasons.push("frontier_response_clock_mismatch");
    const ordered = integer(response.request_received_ms) && integer(response.response_ready_ms) &&
      integer(a.proposal_received_ms) && response.request_received_ms <= response.response_ready_ms &&
      response.response_ready_ms <= a.proposal_received_ms;
    if (!ordered) reasons.push("frontier_response_marks_invalid");
    if (identityMatches && clockMatches && ordered) {
      responseToProposalMs = (a.proposal_received_ms as number) - (response.response_ready_ms as number);
      responsePreparationMs = (response.response_ready_ms as number) - (response.request_received_ms as number);
    }
  }
  const fenceDuration = n.checkpoint_to_evidence_fence_observed_ms;
  const afterFenceDuration = n.evidence_fence_observed_to_acceptance_ms;
  const nativeSplitComplete = integer(fenceDuration) && integer(afterFenceDuration) &&
    integer(n.checkpoint_to_acceptance_ms) &&
    Number.isSafeInteger(fenceDuration + afterFenceDuration) &&
    fenceDuration + afterFenceDuration >= n.checkpoint_to_acceptance_ms &&
    fenceDuration + afterFenceDuration <= n.checkpoint_to_acceptance_ms + 1;
  if (!nativeSplitComplete) reasons.push("native_phase_coverage_missing_or_inconsistent");
  const transportPhases = [n.evidence_fence_observed_to_delivery_poll_ms,
    n.delivery_http_roundtrip_ms, n.delivery_response_to_acceptance_ms];
  const transportSum = transportPhases.every(integer)
    ? transportPhases.reduce<number>((sum, value) => sum + (value as number), 0) : null;
  const transportComplete = transportSum != null && integer(transportSum) && integer(afterFenceDuration) &&
    transportSum >= afterFenceDuration && transportSum <= afterFenceDuration + 2;
  if (!transportComplete) reasons.push("native_transport_coverage_missing_or_inconsistent");
  // This server interval executes inside the exact successor HTTP request.
  // Compare elapsed durations, never absolute timestamps across clock origins.
  // The one-ms tolerance covers server flooring versus native ceiling.
  if (integer(d.poll_received_ms) && integer(d.transaction_returned_ms) &&
    integer(n.delivery_http_roundtrip_ms) &&
    d.transaction_returned_ms - d.poll_received_ms > n.delivery_http_roundtrip_ms + 1)
    reasons.push("delivery_http_enclosure_inconsistent");
  const serverCovered = reasons.length
    ? null
    : (d.transaction_returned_ms as number) -
      (a.proposal_received_ms as number) +
      (a.frontier_publication_to_proposal_receipt_ms as number);
  // Nested durations must not be added to the native enclosing interval. One
  // millisecond tolerance reflects the server's floored/native ceiling marks.
  if (
    serverCovered != null &&
    (!integer(serverCovered) ||
      serverCovered > (n.checkpoint_to_acceptance_ms as number) + 1)
  )
    reasons.push("enclosing_interval_inconsistent");
  const serverPreparedInterval = responseToProposalMs != null && response && integer(d.transaction_returned_ms)
    ? d.transaction_returned_ms - (response.request_received_ms as number) : null;
  if (serverPreparedInterval != null && integer(n.checkpoint_to_acceptance_ms) &&
    (!integer(serverPreparedInterval) || serverPreparedInterval > n.checkpoint_to_acceptance_ms + 1))
    reasons.push("server_preparation_enclosure_inconsistent");
  const total = reasons.length
    ? null
    : (n.checkpoint_to_acceptance_ms as number) + input.safety_margin_ms;
  if (total != null && !integer(total))
    reasons.push("budget_arithmetic_invalid");
  const validTotal = reasons.length ? null : total;
  // Contiguous server-local partition. Snapshot completion belongs to the
  // lease transaction; admission return is not a durability-completion mark.
  const serverPhases = validTotal != null && responseToProposalMs != null && responsePreparationMs != null ? {
    frontier_response_preparation: responsePreparationMs,
    response_ready_to_proposal_receipt: responseToProposalMs,
    proposal_receipt_to_admission_return: (a.transaction_returned_ms as number) - (a.proposal_received_ms as number),
    admission_return_to_delivery_poll: (d.poll_received_ms as number) - (a.transaction_returned_ms as number),
    delivery_poll_to_lease_sql: (d.lease_sql_finished_ms as number) - (d.poll_received_ms as number),
    lease_sql_to_commit_and_persistence_return: (d.transaction_returned_ms as number) - (d.lease_sql_finished_ms as number),
  } : null;
  if (!integer(input.checkpoint_to_stop_window_ms))
    reasons.push("window_unmeasured");
  const margin =
    validTotal != null && integer(input.checkpoint_to_stop_window_ms)
      ? input.checkpoint_to_stop_window_ms - validTotal
      : null;
  if (margin != null && margin <= 0) reasons.push("budget_exhausted");
  return {
    source: input.source,
    enclosing_interval_verified: validTotal != null,
    stage_breakdown_complete: false as const,
    server_phase_partition_complete: serverPhases != null,
    server_phase_durations_ms: serverPhases,
    frontier_response_correlated: responseToProposalMs != null,
    // A bounded position within this HTTP request, not a synchronized timestamp.
    // One ms is the diagnostic quantization allowance, not a live drift study.
    delivery_server_return_request_relative: validTotal != null
      ? mapTemporalServerMarkToRequest({ nativeRoundtripMs: n.delivery_http_roundtrip_ms as number,
        serverReceivedMs: d.poll_received_ms as number, serverReturnedMs: d.transaction_returned_ms as number,
        serverMarkMs: d.transaction_returned_ms as number, errorBoundMs: 1 }) : null,
    frontier_response_preparation_ms: responsePreparationMs,
    // Includes outbound transport, provider work and inbound proposal transport.
    // Neither pure sampling time nor evidence of provider receipt.
    response_ready_to_proposal_receipt_ms: responseToProposalMs,
    native_phase_coverage_complete: nativeSplitComplete,
    native_transport_coverage_complete: transportComplete,
    native_transport_phases_ms: transportComplete ? {
      fence_observed_to_poll: transportPhases[0], http_roundtrip: transportPhases[1],
      response_to_acceptance: transportPhases[2],
    } : null,
    native_phases_ms: nativeSplitComplete ? {
      checkpoint_to_evidence_fence_observed: fenceDuration,
      evidence_fence_observed_to_acceptance: afterFenceDuration,
    } : null,
    total_budget_ms: validTotal,
    server_nested_duration_ms: serverCovered,
    margin_ms: margin,
    fits: reasons.length === 0,
    reasons: [...new Set(reasons)],
    execution_authority: false as const,
    live_acceptance: false as const,
  };
}
