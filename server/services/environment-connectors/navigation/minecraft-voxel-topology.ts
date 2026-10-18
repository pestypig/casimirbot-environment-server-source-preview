import { z } from "zod";
import {
  buildHelixEnvironmentSpatialSnapshot,
  buildHelixEnvironmentTopologyGraph,
  helixEnvironmentNavigationIdentitySchema,
  helixEnvironmentSpatialSnapshotSchema,
  type HelixEnvironmentSpatialSnapshot,
  type HelixEnvironmentTopologyGraph,
} from "@shared/helix-environment-navigation";
import { helixEnvironmentThreeClockSchema, helixEnvironmentTimeSha256 } from "@shared/helix-environment-time";

// Offline NAV1-D adapter profile, NOT an admitted tool or native action.
// These are measured collision facts, never classifications inferred from IDs.
export const MINECRAFT_VOXEL_PROFILE = "minecraft:offline_full_cube_topology:v1";
const MAX_CELLS = 4096;
const MAX_BYTES = 2 * 1024 * 1024;
const id = z.string().min(1).max(240).regex(/^[a-zA-Z0-9:._/-]+$/u);
const position = z.tuple([
  z.number().int().min(-30_000_000).max(30_000_000),
  z.number().int().min(-4096).max(4096),
  z.number().int().min(-30_000_000).max(30_000_000),
]);
type Position = z.infer<typeof position>;
const collision = z.enum(["empty", "full_cube", "blocked", "hazard", "fluid", "unknown", "unsupported"]);
type Collision = z.infer<typeof collision>;
const inputSchema = z.object({
  snapshot_id: id,
  observation_ref: id,
  identity: helixEnvironmentNavigationIdentitySchema,
  clocks: helixEnvironmentThreeClockSchema,
  captured_at: z.string().datetime({ offset: true }),
  minimum: position,
  maximum: position,
  cells: z.array(z.object({ position, collision }).strict()).max(MAX_CELLS),
}).strict();
export type MinecraftVoxelFixtureInput = z.input<typeof inputSchema>;
const key = (p: readonly number[]) => p.join("/");
const nodeId = (p: readonly number[]) => `foothold:${key(p)}`;
const offset = (p: Position, dx: number, dy: number, dz: number): Position => [p[0] + dx, p[1] + dy, p[2] + dz];
const order = (a: readonly number[], b: readonly number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const fail = (reason: string): never => { throw new Error(`minecraft_topology:${reason}`); };
const assertBytes = (value: unknown) => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BYTES) fail("evidence_budget_exceeded");
};
const volume = (min: readonly number[], max: readonly number[]) => {
  let count = 1;
  for (let i = 0; i < 3; i++) {
    if (min[i] > max[i]) fail("invalid_bounds");
    count *= max[i] - min[i] + 1;
    if (!Number.isSafeInteger(count) || count > MAX_CELLS) fail("volume_budget_exceeded");
  }
  return count;
};
const inside = (p: readonly number[], min: readonly number[], max: readonly number[]) =>
  p.every((v, i) => v >= min[i] && v <= max[i]);

/** Normalize explicit fixture/replay facts into NAV0's existing neutral schema.
 * No current Fabric snapshot claims to export this stricter collision profile.
 */
export function buildMinecraftVoxelSnapshot(raw: MinecraftVoxelFixtureInput): HelixEnvironmentSpatialSnapshot {
  assertBytes(raw);
  const input = inputSchema.parse(raw);
  const count = volume(input.minimum, input.maximum);
  const cells = [...input.cells].sort((a, b) => order(a.position, b.position));
  const seen = new Set<string>();
  for (const cell of cells) {
    if (!inside(cell.position, input.minimum, input.maximum)) fail("cell_outside_bounds");
    if (seen.has(key(cell.position))) fail("duplicate_cell");
    seen.add(key(cell.position));
  }
  const incomplete = cells.length < count || cells.some(c => c.collision === "unknown" || c.collision === "unsupported");
  return buildHelixEnvironmentSpatialSnapshot({
    snapshot_id: input.snapshot_id, identity: input.identity, clocks: input.clocks,
    captured_at: input.captured_at,
    bounds: { axes: ["x", "y", "z"], minimum: input.minimum, maximum: input.maximum },
    coverage_state: incomplete ? "partial_with_unknown_regions" : "complete_within_bounds",
    unknown_region_ids: incomplete ? ["coverage:unobserved_or_unsupported"] : [],
    features: cells.map(cell => ({
      feature_id: `cell:${key(cell.position)}`, feature_kind: "minecraft:collision_cell",
      centroid: cell.position, geometry: { collision: cell.collision }, dynamic: false,
      traversability: cell.collision === "unknown" || cell.collision === "unsupported" ? "unknown" : "conditional",
      hazard_ids: cell.collision === "hazard" ? ["hazard:observed"] : [],
      evidence_refs: [input.observation_ref],
    })),
    frontiers: [], adapter_profile: { profile_id: MINECRAFT_VOXEL_PROFILE },
  });
}

type Rejection = { position: Position; reason: "unknown" | "blocked" | "unsupported_support" | "hazard_margin" };
type Result = {
  status: "compiled" | "no_supported_footholds";
  graph: HelixEnvironmentTopologyGraph | null;
  rejected: Rejection[];
  cell_count: number;
  transition_checks: number;
  execution_authority: false;
};
const contextSchema = z.object({
  expected_identity: helixEnvironmentNavigationIdentitySchema,
  expected_snapshot_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  now: z.string().datetime({ offset: true }),
  maximum_age_ms: z.number().int().min(0).max(120_000),
  maximum_nodes: z.number().int().min(1).max(1024),
  maximum_edges: z.number().int().min(0).max(16_384),
}).strict();
export type MinecraftTopologyContext = z.input<typeof contextSchema>;

/** Pure topology only: no destination selection, graph search, broker, IO or
 * controller. Complete output or typed budget failure; never truncate silently.
 * Unit full-cube support and a two-cell standing body are conservative limits,
 * not a general Minecraft collision/trajectory model or permission to execute.
 */
export function compileMinecraftVoxelTopology(raw: unknown, rawContext: MinecraftTopologyContext): Result {
  assertBytes(raw);
  const snapshot = helixEnvironmentSpatialSnapshotSchema.parse(raw);
  const context = contextSchema.parse(rawContext);
  if (helixEnvironmentTimeSha256(snapshot.identity) !== helixEnvironmentTimeSha256(context.expected_identity)) fail("identity_mismatch");
  if (snapshot.snapshot_hash !== context.expected_snapshot_hash) fail("snapshot_mismatch");
  const age = Date.parse(context.now) - Date.parse(snapshot.captured_at);
  if (age < 0 || age > context.maximum_age_ms) fail("stale_or_future_snapshot");
  if (JSON.stringify(snapshot.adapter_profile) !== JSON.stringify({ profile_id: MINECRAFT_VOXEL_PROFILE }) ||
      snapshot.bounds.axes.join("/") !== "x/y/z") fail("unsupported_profile");
  const min = position.parse(snapshot.bounds.minimum), max = position.parse(snapshot.bounds.maximum);
  const count = volume(min, max);
  const cells = new Map<string, Collision>();
  const candidates: Position[] = [];
  for (const feature of snapshot.features) {
    const p = position.parse(feature.centroid);
    if (feature.feature_kind !== "minecraft:collision_cell" || feature.dynamic) fail("unsupported_feature");
    if (!inside(p, min, max)) fail("cell_outside_bounds");
    if (cells.has(key(p))) fail("duplicate_cell");
    const kind = z.object({ collision }).strict().parse(feature.geometry).collision;
    if (feature.feature_id !== `cell:${key(p)}` ||
        feature.traversability !== (kind === "unknown" || kind === "unsupported" ? "unknown" : "conditional")) fail("cell_evidence_mismatch");
    if ((feature.hazard_ids.length > 0) !== (kind === "hazard")) fail("hazard_evidence_mismatch");
    cells.set(key(p), kind);
    if (kind === "empty") candidates.push(p);
  }
  if (snapshot.coverage_state === "complete_within_bounds" &&
      (cells.size !== count || [...cells.values()].some(c => c === "unknown" || c === "unsupported"))) fail("false_complete_coverage");
  const cell = (p: Position): Collision => cells.get(key(p)) ?? "unknown";
  const unknown = (c: Collision) => c === "unknown" || c === "unsupported";
  const stance = (p: Position): Rejection["reason"] | null => {
    const body = [cell(p), cell(offset(p, 0, 1, 0))];
    if (body.some(unknown)) return "unknown";
    if (body.some(c => c !== "empty")) return "blocked";
    const support = cell(offset(p, 0, -1, 0));
    if (unknown(support)) return "unknown";
    if (support !== "full_cube") return "unsupported_support";
    // Match the native frontier's conservative one-cell hazard/coverage halo.
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -1; dz <= 1; dz++) {
      const c = cell(offset(p, dx, dy, dz));
      if (unknown(c)) return "unknown";
      if (c === "hazard" || c === "fluid") return "hazard_margin";
    }
    return null;
  };
  const rejected: Rejection[] = [];
  const safe = new Map<string, Position>();
  for (const p of candidates.sort(order)) {
    const reason = stance(p);
    if (reason) rejected.push({ position: p, reason });
    else {
      if (safe.size === context.maximum_nodes) fail("node_budget_exceeded");
      safe.set(key(p), p);
    }
  }
  const flags = { cell_count: cells.size, execution_authority: false as const };
  if (!safe.size) return { status: "no_supported_footholds", graph: null, rejected, transition_checks: 0, ...flags };
  const refs = [`snapshot:${snapshot.snapshot_hash}`];
  const nodes: HelixEnvironmentTopologyGraph["nodes"] = [...safe.values()].map(p => ({
    node_id: nodeId(p), position: [p[0] + 0.5, p[1], p[2] + 0.5],
    node_class: "state:grounded", state: { pose: "standing", geometry_profile: MINECRAFT_VOXEL_PROFILE }, evidence_refs: refs,
  }));
  const edges: HelixEnvironmentTopologyGraph["edges"] = [];
  const frontiers: HelixEnvironmentTopologyGraph["frontiers"] = [];
  let checks = 0;
  for (const from of safe.values()) {
    let atUnknown = false;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      const diagonal = dx !== 0 && dz !== 0;
      for (const dy of diagonal ? [0] : [0, 1, -1]) {
        checks++;
        const to = offset(from, dx, dy, dz);
        const reason = stance(to);
        if (reason === "unknown") atUnknown = true;
        if (!safe.has(key(to))) continue;
        // Full standing sweep: no corner cutting or drop through an overhang.
        if (diagonal && (!safe.has(key(offset(from, dx, 0, 0))) || !safe.has(key(offset(from, 0, 0, dz))))) continue;
        if (dy === 1 && cell(offset(from, 0, 2, 0)) !== "empty") continue;
        if (dy === -1 && cell(offset(to, 0, 2, 0)) !== "empty") continue;
        if (edges.length === context.maximum_edges) fail("edge_budget_exceeded");
        const traversal = diagonal ? "diagonal" : dy === 1 ? "ascend" : dy === -1 ? "descend" : "walk";
        edges.push({
          edge_id: `edge:${key(from)}:to:${key(to)}`, from_node_id: nodeId(from), to_node_id: nodeId(to),
          traversal_class: `traversal:${traversal}`,
          estimated_costs: { distance: Math.hypot(dx, dy, dz) }, risk_score: 0,
          reversible: false, required_effects: [{ effect_kind: "locomotion", maximum_count: 1 }],
          valid_from_observation_revision: snapshot.identity.observation_revision,
          valid_through_observation_revision: snapshot.identity.observation_revision, evidence_refs: refs,
        });
      }
    }
    if (atUnknown) frontiers.push({ frontier_id: `frontier:${key(from)}`, at_node_id: nodeId(from), reason: "coverage_boundary", evidence_refs: refs });
  }
  const pairs = new Set(edges.map(e => `${e.from_node_id}>${e.to_node_id}`));
  for (const edge of edges) edge.reversible = pairs.has(`${edge.to_node_id}>${edge.from_node_id}`);
  const graph = buildHelixEnvironmentTopologyGraph({
    graph_id: `graph:${snapshot.snapshot_hash}`, graph_revision: snapshot.identity.observation_revision,
    identity: snapshot.identity, snapshot_id: snapshot.snapshot_id, snapshot_hash: snapshot.snapshot_hash,
    previous_graph_hash: null, axes: snapshot.bounds.axes, nodes, edges, frontiers,
    adapter_profile_id: MINECRAFT_VOXEL_PROFILE,
  });
  return { status: "compiled", graph, rejected, transition_checks: checks, ...flags };
}
