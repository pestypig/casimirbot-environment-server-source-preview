import { z } from "zod";
import { buildMinecraftVoxelSnapshot, type MinecraftVoxelFixtureInput } from "./minecraft-voxel-topology";

// Shared native replay validation; no RPC, pairing, producer registration or IO.
const point = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
const facts = z.object({
  loaded: z.boolean(), collision_empty: z.boolean(), collision_full_cube: z.boolean(),
  air: z.boolean(), reviewed_support: z.boolean(), hazard: z.boolean(), fluid: z.boolean(),
  collision: z.enum(["unknown", "empty", "full_cube", "hazard", "fluid", "unsupported"]),
}).strict().superRefine((v, c) => {
  const expected = !v.loaded ? "unknown" : v.hazard ? "hazard" : v.fluid ? "fluid"
    : v.air && v.collision_empty ? "empty" : v.reviewed_support && v.collision_full_cube ? "full_cube" : "unsupported";
  if (v.collision !== expected || (v.collision_empty && v.collision_full_cube) ||
      (!v.loaded && (v.collision_empty || v.collision_full_cube || v.air || v.reviewed_support || v.hazard || v.fluid))) {
    c.addIssue({ code: "custom", message: "native_collision_facts_inconsistent" });
  }
});
const capture = z.object({
  schema: z.literal("minecraft.native_collision_replay.v1"),
  dimension: z.string().min(1).max(160),
  subject_native_id: z.string().uuid(),
  tick_start: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  tick_end: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  minimum: point, maximum: point,
  cells: z.array(z.object({ position: point, facts }).strict()).max(4096),
}).strict();

/** Identity/time are supplied by the trusted observation envelope, not inferred
 * from a replay's self-description. No provenance or live readiness is granted
 * by successful parsing. Caller must separately authenticate a real capture.
 */
export function validateMinecraftNativeCollisionReplay(raw: unknown, envelope: {
  expected_dimension: string;
  expected_subject_native_id: string;
  expected_tick: number;
}) {
  const serialized = JSON.stringify(raw);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) throw new Error("native_capture_budget_exceeded");
  const data = capture.parse(raw);
  if (data.dimension !== envelope.expected_dimension || data.subject_native_id !== envelope.expected_subject_native_id) {
    throw new Error("native_capture_identity_mismatch");
  }
  if (data.tick_start !== data.tick_end || data.tick_start !== envelope.expected_tick) {
    throw new Error("native_capture_clock_mismatch");
  }
  return data;
}

export function normalizeMinecraftNativeCollisionReplay(raw: unknown, envelope: {
  expected_dimension: string;
  expected_subject_native_id: string;
  expected_tick: number;
  snapshot: Omit<MinecraftVoxelFixtureInput, "cells" | "minimum" | "maximum">;
}) {
  const data = validateMinecraftNativeCollisionReplay(raw, envelope);
  if (envelope.snapshot.clocks.environment.sequence !== data.tick_start ||
      envelope.snapshot.clocks.environment.resolution_unit !== "minecraft_world_tick") {
    throw new Error("native_capture_clock_mismatch");
  }
  return buildMinecraftVoxelSnapshot({ ...envelope.snapshot, minimum: data.minimum, maximum: data.maximum,
    cells: data.cells.map(c => ({ position: c.position, collision: c.facts.collision })),
  });
}
