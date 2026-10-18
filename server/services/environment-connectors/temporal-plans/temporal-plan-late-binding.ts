import {
  buildHelixEnvironmentTemporalPlan,
  type HelixEnvironmentAffordanceFrontier,
} from "@shared/helix-environment-time";
import { TemporalPlanError } from "./temporal-plan-error";

type PlanDraft = Parameters<typeof buildHelixEnvironmentTemporalPlan>[0];

/** Bind a principal-authored plan to measured clocks and frontier identity.
 * This does not observe, authorize, preflight, admit, or execute an action. */
export const bindTemporalPlanToFreshFrontier = (input: {
  draft: Omit<PlanDraft, "identity" | "clocks" | "monotonic_deadline_elapsed_ms">;
  frontier: HelixEnvironmentAffordanceFrontier;
  residentClock: {
    tick_index: number;
    monotonic: { origin_id: string; elapsed_ms: number };
  };
  deadlineAfterMs: number;
}) => {
  const { frontier, residentClock, deadlineAfterMs } = input;
  if (!Number.isSafeInteger(deadlineAfterMs) || deadlineAfterMs < 1_000 || deadlineAfterMs > 15_000 ||
      !Number.isSafeInteger(residentClock.tick_index) || residentClock.tick_index < 0 ||
      !Number.isFinite(residentClock.monotonic.elapsed_ms) ||
      residentClock.monotonic.elapsed_ms < 0 ||
      !residentClock.monotonic.origin_id ||
      residentClock.monotonic.elapsed_ms > Number.MAX_SAFE_INTEGER - deadlineAfterMs) {
    throw new TemporalPlanError("temporal_plan_late_binding_clock_invalid");
  }
  // The native Fabric clock measures elapsed milliseconds at sub-millisecond
  // precision. Plan clocks are integer milliseconds, so truncate the measured
  // value rather than rejecting a healthy resident heartbeat.
  const elapsedMs = Math.floor(residentClock.monotonic.elapsed_ms);
  // Discard even runtime-injected identity/clock fields in an untyped draft.
  // The compiler and broker still perform independent currentness checks.
  const { identity: _identity, clocks: _clocks, plan_hash: _planHash,
    monotonic_deadline_elapsed_ms: _deadline, ...authored } = input.draft as PlanDraft & { plan_hash?: string };
  return buildHelixEnvironmentTemporalPlan({
    ...authored,
    identity: frontier.identity,
    clocks: {
      environment: { kind: "tick", sequence: residentClock.tick_index,
        resolution_unit: "minecraft_tick", nominal_units_per_second: 20 },
      monotonic: { origin_id: residentClock.monotonic.origin_id, elapsed_ms: elapsedMs },
      audit_at: frontier.clocks.audit_at,
    },
    monotonic_deadline_elapsed_ms: elapsedMs + deadlineAfterMs,
  });
};
