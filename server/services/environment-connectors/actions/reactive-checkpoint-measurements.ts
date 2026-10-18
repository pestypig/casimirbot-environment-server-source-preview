import type { HelixMinecraftReactiveProgramArguments } from "@shared/helix-minecraft-reactive-program";

export function reactiveCheckpointMeasurementsValid(program: HelixMinecraftReactiveProgramArguments, measurements: Record<string, unknown>): boolean {
  const rows = measurements.checkpoint_settlements;
  if (rows === undefined) return true; // legacy absence is not checkpoint proof
  const satisfied = measurements.satisfied_checkpoint_ids;
  const observations = measurements.condition_observations;
  const now = measurements.tick_index;
  if (!Array.isArray(rows) || rows.length > program.lanes.reduce((n, lane) => n + lane.nodes.length, 0) ||
      !Array.isArray(satisfied) || new Set(satisfied).size !== satisfied.length ||
      !Array.isArray(observations) || typeof now !== "number" || !Number.isSafeInteger(now) || now < 0 || now > program.max_total_ticks + 1) return false;
  const seen = new Set<string>();
  let lastTick = -1;
  let lastNanos = -1;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    const lane = program.lanes.find(lane => lane.lane_id === row.lane_id);
    const node = lane?.nodes.find(node => node.node_id === row.node_id);
    if (!node || node.node_kind !== "checkpoint" || node.checkpoint_id !== row.checkpoint_id ||
        seen.has(row.checkpoint_id) || !satisfied.includes(row.checkpoint_id) ||
        !Number.isSafeInteger(row.tick_index) || row.tick_index < 0 || row.tick_index < lastTick || row.tick_index > now ||
        !Number.isSafeInteger(row.monotonic_elapsed_ns) || row.monotonic_elapsed_ns < 0 || row.monotonic_elapsed_ns < lastNanos ||
        !observations.some(fact => fact && typeof fact === "object" && fact.node_id === node.node_id &&
          fact.tick_index === row.tick_index && fact.condition_kind === node.condition.condition_kind && fact.satisfied === true)) return false;
    seen.add(row.checkpoint_id);
    lastTick = row.tick_index;
    lastNanos = row.monotonic_elapsed_ns;
  }
  return seen.size === satisfied.length;
}
