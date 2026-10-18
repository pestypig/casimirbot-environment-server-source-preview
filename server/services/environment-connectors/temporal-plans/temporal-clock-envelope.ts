/** Offline causal enclosure, not clock synchronization or execution authority.
 * Requires an already identity-correlated single request. All durations use ms.
 * errorBoundMs must cover clock-rate error and measurement quantization over
 * this request; callers must not treat the returned interval as an exact time.
 */
export function mapTemporalServerMarkToRequest(input: {
  nativeRoundtripMs: number;
  serverReceivedMs: number;
  serverReturnedMs: number;
  serverMarkMs: number;
  errorBoundMs: number;
}) {
  const values = Object.values(input);
  const invalid = values.some(value => !Number.isSafeInteger(value) || value < 0) ||
    input.serverReceivedMs > input.serverMarkMs || input.serverMarkMs > input.serverReturnedMs;
  if (invalid) return { available: false, reason: "clock_envelope_invalid", lower_ms: null, upper_ms: null };
  if (input.serverReturnedMs - input.serverReceivedMs - input.nativeRoundtripMs > input.errorBoundMs)
    return { available: false, reason: "clock_envelope_impossible", lower_ms: null, upper_ms: null };
  const elapsedBefore = input.serverMarkMs - input.serverReceivedMs;
  const elapsedAfter = input.serverReturnedMs - input.serverMarkMs;
  const lower = Math.max(0, elapsedBefore - input.errorBoundMs);
  const upperCandidate = input.nativeRoundtripMs - elapsedAfter + input.errorBoundMs;
  if (!Number.isSafeInteger(upperCandidate))
    return { available: false, reason: "clock_envelope_arithmetic_invalid", lower_ms: null, upper_ms: null };
  const upper = Math.min(input.nativeRoundtripMs, upperCandidate);
  if (lower > upper) return { available: false, reason: "clock_envelope_impossible", lower_ms: null, upper_ms: null };
  return { available: true, reason: "bounded_request_relative_mark", lower_ms: lower, upper_ms: upper };
}
