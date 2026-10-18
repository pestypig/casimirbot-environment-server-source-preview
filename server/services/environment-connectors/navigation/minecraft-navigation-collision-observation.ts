import { z } from "zod";
import { validateMinecraftNativeCollisionReplay } from "./minecraft-native-collision-replay";

export const navigationCollisionFailureReasons = [
  "radius_out_of_bounds", "cell_budget_exceeded", "wrong_thread",
  "selected_player_unavailable", "coordinate_bounds", "payload_budget_exceeded",
  "capture_identity_or_tick_changed", "elapsed_budget_exceeded", "sensor_extension_unavailable",
] as const;

const unavailable = z.object({ status: z.literal("unavailable"), reason: z.enum(navigationCollisionFailureReasons) }).strict();
const captured = z.object({ status: z.literal("captured"), replay: z.unknown() }).strict();
const snapshotIdentity = z.object({
  snapshot_schema: z.literal("helix.minecraft_perception_snapshot.v1"),
  dimension: z.string().min(1).max(160),
  observation_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  game_tick: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  actor: z.object({ position: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }) }),
});

/** Called inside the existing broker, after exact request/connector correlation.
 * Subject UUID comes from the admitted request row, never the submitted payload.
 * Mutates only this normalized observation. Outer consent, epoch, freshness,
 * cancellation, hashing and re-entry gates remain owned by that broker.
 */
export function normalizeMinecraftNavigationCollisionObservation(result: Record<string, unknown>, context: {
  requested: boolean;
  expected_subject_native_id: string | null;
}): void {
  const extension = result.navigation_collision;
  if (!context.requested) {
    if (extension !== undefined) throw new Error("navigation_capture_not_requested");
    return;
  }
  // A failed base probe remains a failed base probe; do not create a success envelope.
  if (result.snapshot_schema === undefined && extension === undefined) return;
  const identity = snapshotIdentity.parse(result);
  if (identity.observation_revision !== identity.game_tick) throw new Error("native_capture_clock_mismatch");
  if (extension === undefined) {
    result.navigation_collision = { status: "unavailable", reason: "sensor_extension_unavailable" };
    return;
  }
  const serialized = JSON.stringify(extension);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 64 * 1024) throw new Error("native_capture_budget_exceeded");
  if (unavailable.safeParse(extension).success) {
    result.navigation_collision = unavailable.parse(extension);
    return;
  }
  const wire = captured.parse(extension);
  const subject = z.string().uuid().parse(context.expected_subject_native_id);
  const replay = validateMinecraftNativeCollisionReplay(wire.replay, {
    expected_dimension: identity.dimension, expected_subject_native_id: subject, expected_tick: identity.game_tick,
  });
  // Fixed 5x5x5 profile keeps this extension inside the existing bounded catalog
  // (256 items). No silent clamping, truncation, expansion or invented coverage.
  for (let axis = 0; axis < 3; axis++) {
    const limit = axis === 1 ? 4096 : 30_000_000;
    if (replay.minimum[axis] < -limit || replay.maximum[axis] > limit ||
        replay.maximum[axis] - replay.minimum[axis] !== 4) throw new Error("native_capture_bounds_mismatch");
    const position = [identity.actor.position.x, identity.actor.position.y, identity.actor.position.z][axis];
    const origin = replay.minimum[axis] + 2;
    // Public actor coordinates round to milliblocks; permit only that rounding margin.
    if (position < origin - 0.001 || position > origin + 1.001) throw new Error("native_capture_origin_mismatch");
  }
  if (replay.cells.length !== 125) throw new Error("native_capture_coverage_mismatch");
  const seen = new Set<string>();
  for (const cell of replay.cells) {
    if (cell.position.some((n, axis) => n < replay.minimum[axis] || n > replay.maximum[axis])) throw new Error("native_capture_bounds_mismatch");
    const key = cell.position.join(",");
    if (seen.has(key)) throw new Error("native_capture_coverage_mismatch");
    seen.add(key);
  }
  result.navigation_collision = { status: "captured", replay };
}
