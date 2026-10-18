/** Offline trace audit only. This does not admit plans or authorize effects. */
export const temporalTimingStages = [
  "checkpoint_to_verified_evidence", "evidence_to_proposal",
  "proposal_to_admission_and_snapshot", "admission_to_delivery",
  "delivery_to_scheduler_pickup",
] as const;

type Identity = { run_id: string; plan_id: string; checkpoint_id: string };
type Span = Identity & {
  stage: typeof temporalTimingStages[number];
  clock_origin: string;
  start_ms: number;
  end_ms: number;
};

export function auditTemporalTimingBudget(input: {
  identity: Identity;
  source: "simulated" | "measured";
  spans: Span[];
  remaining_window_ms: number | null;
  safety_margin_ms: number;
}) {
  const reasons: string[] = [];
  const finite = (n: number) => Number.isFinite(n) && n >= 0;
  if (Object.values(input.identity).some(value => !value?.trim())) reasons.push("identity_missing");
  if (!finite(input.safety_margin_ms)) reasons.push("margin_invalid");
  if (input.remaining_window_ms == null || !finite(input.remaining_window_ms)) reasons.push("window_unmeasured");
  for (const stage of temporalTimingStages) {
    const spans = input.spans.filter(span => span.stage === stage);
    if (spans.length !== 1) reasons.push(`stage_missing_or_duplicate:${stage}`);
  }
  for (const span of input.spans) {
    if (!temporalTimingStages.includes(span.stage)) reasons.push("stage_unknown");
    if (Object.entries(input.identity).some(([key, value]) => span[key as keyof Identity] !== value)) reasons.push("identity_mismatch");
    if (!span.clock_origin?.trim() || !finite(span.start_ms) || !finite(span.end_ms) || span.end_ms < span.start_ms) reasons.push("clock_invalid");
  }
  // No cross-origin subtraction. Each supplied span must already represent a
  // contiguous local measurement; cross-host gaps require explicit mapping.
  const origins = new Set(input.spans.map(span => span.clock_origin));
  if (origins.size > 1) reasons.push("clock_mapping_required");
  const ordered = temporalTimingStages.map(stage => input.spans.find(span => span.stage === stage));
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i - 1] && ordered[i] && ordered[i - 1]!.end_ms !== ordered[i]!.start_ms) reasons.push("trace_gap_or_overlap");
  }
  const calculatedTotal = reasons.length ? null : input.spans.reduce((sum, span) => sum + (span.end_ms - span.start_ms), input.safety_margin_ms);
  if (calculatedTotal != null && !finite(calculatedTotal)) reasons.push("budget_arithmetic_invalid");
  const total = calculatedTotal != null && finite(calculatedTotal) ? calculatedTotal : null;
  const margin = total == null || input.remaining_window_ms == null ? null : input.remaining_window_ms - total;
  if (margin != null && margin <= 0) reasons.push("budget_exhausted");
  return { source: input.source, complete: total != null, fits: reasons.length === 0,
    total_budget_ms: total, margin_ms: margin, reasons: [...new Set(reasons)],
    live_acceptance: false as const, execution_authority: false as const };
}
