import crypto from "node:crypto";
import { minecraftNavigationCollisionSchema } from "../navigation/minecraft-navigation-collision-schema";
import {
  HELIX_ENVIRONMENT_CAPABILITY_DESCRIPTOR_SCHEMA,
  HELIX_MINECRAFT_ACTOR_STATUS_READ_CAPABILITY,
  HELIX_MINECRAFT_CROP_STATE_READ_CAPABILITY,
  HELIX_MINECRAFT_HAZARDS_SCAN_CAPABILITY,
  HELIX_MINECRAFT_INVENTORY_CHECK_CAPABILITY,
  HELIX_MINECRAFT_LINE_OF_SIGHT_CHECK_CAPABILITY,
  HELIX_MINECRAFT_LOCAL_MAP_INSPECT_CAPABILITY,
  HELIX_MINECRAFT_NEARBY_ENTITIES_LIST_CAPABILITY,
  HELIX_MINECRAFT_PERCEPTION_SNAPSHOT_READ_CAPABILITY,
  HELIX_MINECRAFT_READ_ONLY_CAPABILITY_IDS,
  HELIX_MINECRAFT_RECIPE_FACT_READ_CAPABILITY,
  HELIX_MINECRAFT_REACHABILITY_CHECK_CAPABILITY,
  HELIX_MINECRAFT_REGISTRY_FACT_READ_CAPABILITY,
  HELIX_MINECRAFT_SPATIAL_REGION_INSPECT_CAPABILITY,
  HELIX_MINECRAFT_SITUATION_CAPABILITY_IDS,
  HELIX_SYNTHETIC_REACHABILITY_CAPABILITY,
  HELIX_SYSTEM_CLOCK_READ_CAPABILITY,
  helixEnvironmentCapabilityDescriptorSchema,
  type HelixEnvironmentCapabilityDescriptor,
  type HelixEnvironmentConstrainedJsonSchema,
} from "@shared/helix-environment-connector";
import {
  HELIX_MINECRAFT_ADAPTER_PROFILE_ID,
  HELIX_SYNTHETIC_GAME_ADAPTER_PROFILE_ID,
  HELIX_SYSTEM_CLOCK_ADAPTER_PROFILE_ID,
} from "@shared/helix-environment-adapter-profile";
import { HELIX_MINECRAFT_FABRIC_PLAYER_ACTION_PROFILE_ID } from "@shared/helix-environment-action-adapter-profile";
import { HELIX_ENVIRONMENT_ACTION_RESULT_DELIVERY_GRACE_MS } from "@shared/helix-environment-action";
import {
  HELIX_MINECRAFT_PLAYER_CAMERA_TRACK_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_COLLECT_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_CRAFT_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_CONSUME_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_EQUIP_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_EXECUTE_REACTIVE_PROGRAM_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_ARM_VIABILITY_GUARDIAN_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_DISARM_VIABILITY_GUARDIAN_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_FOLLOW_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_HOTBAR_SELECT_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_INVENTORY_TRANSFER_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_INTERACT_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_COMBAT_ATTACK_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_COMBAT_GUARD_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_JUMP_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_LOOK_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_MINE_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_NAVIGATE_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_PLACE_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_WALK_CAPABILITY,
} from "@shared/helix-minecraft-player-capabilities";
import {
  HELIX_MINECRAFT_PLAYER_EXECUTE_SEQUENCE_CAPABILITY,
  HELIX_MINECRAFT_PLAYER_SEQUENCE_SCHEMA,
} from "@shared/helix-minecraft-fluid-sequence";
import {
  HELIX_MINECRAFT_REACTIVE_LANE_KINDS,
  HELIX_MINECRAFT_REACTIVE_PROGRAM_SCHEMA,
  HELIX_MINECRAFT_REACTIVE_RESOURCES,
} from "@shared/helix-minecraft-reactive-program";
import { HELIX_MINECRAFT_VIABILITY_GUARDIAN_PROFILE_ID } from "@shared/helix-minecraft-viability-guardian";
import type { HelixEnvironmentProbeType } from "@shared/helix-environment-probe";

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
};

export const environmentConnectorSha256 = (
  value: unknown,
): `sha256:${string}` =>
  `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex")}`;

const descriptor = (input: {
  capabilityId: string;
  capabilityVersion?: number;
  domain: string;
  adapterProfileIds: string[];
  label: string;
  description: string;
  inputSchema: HelixEnvironmentConstrainedJsonSchema;
  outputSchema: HelixEnvironmentConstrainedJsonSchema;
  freshnessCeilingMs: number;
  timeoutCeilingMs: number;
}): HelixEnvironmentCapabilityDescriptor =>
  helixEnvironmentCapabilityDescriptorSchema.parse({
    schema: HELIX_ENVIRONMENT_CAPABILITY_DESCRIPTOR_SCHEMA,
    capability_id: input.capabilityId,
    capability_version: input.capabilityVersion ?? 1,
    capability_class: "probe",
    domain: input.domain,
    adapter_profile_ids: input.adapterProfileIds,
    trusted_model_label: input.label,
    trusted_model_description: input.description,
    input_schema: input.inputSchema,
    input_schema_hash: environmentConnectorSha256(input.inputSchema),
    output_schema: input.outputSchema,
    output_schema_hash: environmentConnectorSha256(input.outputSchema),
    freshness_ceiling_ms: input.freshnessCeilingMs,
    timeout_ceiling_ms: input.timeoutCeilingMs,
    read_only: true,
    side_effects_allowed: false,
    requires_current_turn_reentry: true,
    publisher_metadata_lane: "ui_only_untrusted",
    assistant_answer: false,
    raw_content_included: false,
  });

const actionDescriptor = (input: {
  capabilityId: string;
  label: string;
  description: string;
  inputSchema: HelixEnvironmentConstrainedJsonSchema;
  timeoutCeilingMs: number;
}): HelixEnvironmentCapabilityDescriptor =>
  helixEnvironmentCapabilityDescriptorSchema.parse({
    schema: HELIX_ENVIRONMENT_CAPABILITY_DESCRIPTOR_SCHEMA,
    capability_id: input.capabilityId,
    capability_version: 1,
    capability_class: "act",
    domain: "minecraft",
    adapter_profile_ids: [HELIX_MINECRAFT_FABRIC_PLAYER_ACTION_PROFILE_ID],
    trusted_model_label: input.label,
    trusted_model_description: input.description,
    input_schema: input.inputSchema,
    input_schema_hash: environmentConnectorSha256(input.inputSchema),
    output_schema: minecraftPlayerActionOutputSchema,
    output_schema_hash: environmentConnectorSha256(
      minecraftPlayerActionOutputSchema,
    ),
    freshness_ceiling_ms: 30_000,
    timeout_ceiling_ms: input.timeoutCeilingMs,
    read_only: false,
    side_effects_allowed: true,
    requires_current_turn_reentry: true,
    publisher_metadata_lane: "ui_only_untrusted",
    assistant_answer: false,
    raw_content_included: false,
  });

const semanticTargetSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    target: {
      type: "string",
      enum: ["current_actor"],
      description: "The authenticated actor already bound to the environment.",
    },
    freshness_requirement_ms: {
      type: "integer",
      minimum: 1_000,
      maximum: 120_000,
      description: "Maximum acceptable observation age.",
    },
  },
  required: ["target"],
  additionalProperties: false,
};

const minecraftPositionSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    x: { type: "number", minimum: -30_000_000, maximum: 30_000_000 },
    y: { type: "number", minimum: -2_048, maximum: 2_048 },
    z: { type: "number", minimum: -30_000_000, maximum: 30_000_000 },
  },
  required: ["x", "y", "z"],
  additionalProperties: false,
};

const minecraftBlockPositionSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    x: { type: "integer", minimum: -30_000_000, maximum: 30_000_000 },
    y: { type: "integer", minimum: -2_048, maximum: 2_048 },
    z: { type: "integer", minimum: -30_000_000, maximum: 30_000_000 },
  },
  required: ["x", "y", "z"],
  additionalProperties: false,
};

const minecraftPositionTargetSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    target: {
      type: "string",
      enum: ["position"],
      description:
        "A position in the current bound actor's exact Minecraft world.",
    },
    position: minecraftPositionSchema,
    freshness_requirement_ms: {
      type: "integer",
      minimum: 1_000,
      maximum: 120_000,
      description: "Maximum acceptable observation age.",
    },
  },
  required: ["target", "position"],
  additionalProperties: false,
};

const minecraftPerceptionSnapshotOutputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    navigation_collision: minecraftNavigationCollisionSchema,
    result_summary: { type: "string", maxLength: 2_000 },
    snapshot_schema: {
      type: "string",
      enum: ["helix.minecraft_perception_snapshot.v1"],
    },
    observation_revision: { type: "integer", minimum: 0 },
    game_tick: { type: "integer", minimum: 0 },
    capture_duration_ms: { type: "number", minimum: 0, maximum: 2_000 },
    dimension: { type: "string", minLength: 1, maxLength: 160 },
    actor: {
      type: "object",
      properties: {
        position: minecraftPositionSchema,
        velocity: minecraftPositionSchema,
        yaw: { type: "number", minimum: -360, maximum: 360 },
        pitch: { type: "number", minimum: -90, maximum: 90 },
        health: { type: "number", minimum: 0, maximum: 2_048 },
        max_health: { type: "number", minimum: 0, maximum: 2_048 },
        food_level: { type: "integer", minimum: 0, maximum: 20 },
        air: { type: "integer", minimum: -20, maximum: 100_000 },
        on_ground: { type: "boolean" },
        on_fire: { type: "boolean" },
        freezing: { type: "boolean" },
      },
      required: [
        "position", "velocity", "yaw", "pitch", "health", "max_health",
        "food_level", "air", "on_ground", "on_fire", "freezing",
      ],
      additionalProperties: false,
    },
    focus: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["miss", "block", "entity"] },
        distance_blocks: { type: "number", minimum: 0, maximum: 6 },
        line_of_sight: { type: "boolean" },
        occlusion: { type: "string", enum: ["none", "block", "unknown"] },
        block_id: { type: "string", minLength: 1, maxLength: 160 },
        position: minecraftBlockPositionSchema,
        aim_position: minecraftPositionSchema,
      },
      required: ["kind", "distance_blocks", "line_of_sight", "occlusion"],
      additionalProperties: false,
    },
    entities: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        properties: {
          entity_type: { type: "string", minLength: 1, maxLength: 160 },
          classification: {
            type: "string",
            enum: ["hostile", "player", "passive", "projectile", "item", "other"],
          },
          distance_blocks: { type: "number", minimum: 0, maximum: 512 },
          bearing_degrees: { type: "number", minimum: -180, maximum: 180 },
          relative_elevation_blocks: { type: "number", minimum: -512, maximum: 512 },
          closing_speed_blocks_per_second: { type: "number", minimum: -1_000, maximum: 1_000 },
          targeting_actor: { type: "boolean" },
          line_of_sight: { type: "boolean" },
          occlusion: { type: "string", enum: ["none", "block", "unknown"] },
        },
        required: [
          "entity_type", "classification", "distance_blocks",
          "bearing_degrees", "relative_elevation_blocks",
          "closing_speed_blocks_per_second", "targeting_actor",
          "line_of_sight", "occlusion",
        ],
        additionalProperties: false,
      },
    },
    projectiles: {
      type: "array",
      maxItems: 128,
      description:
        "Bounded, actor-relative projectile trajectory forecasts. Absence means the producer predates projectile forecasting; consult coverage.projectiles_complete before treating an empty array as complete evidence.",
      items: {
        type: "object",
        properties: {
          projectile_ref: { type: "string", minLength: 1, maxLength: 240 },
          incarnation_ref: { type: "string", minLength: 1, maxLength: 240 },
          projectile_type_id: { type: "string", minLength: 1, maxLength: 160 },
          owner_ref: { type: "string", minLength: 1, maxLength: 240 },
          position: minecraftPositionSchema,
          velocity: minecraftPositionSchema,
          acceleration: minecraftPositionSchema,
          support_ticks: { type: "integer", minimum: 1, maximum: 80 },
          predicted_collision_tick: { type: "integer", minimum: 0, maximum: 80 },
          predicted_impact_position: minecraftPositionSchema,
          threat_classification: {
            type: "string",
            enum: ["collision", "near_miss", "safe", "unknown"],
          },
          evidence_complete: { type: "boolean" },
          occluded: { type: "boolean" },
        },
        required: [
          "projectile_ref", "incarnation_ref", "projectile_type_id",
          "position", "velocity", "acceleration", "support_ticks",
          "threat_classification", "evidence_complete", "occluded",
        ],
        additionalProperties: false,
      },
    },
    hazards: {
      type: "array",
      maxItems: 128,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", minLength: 1, maxLength: 80 },
          position: minecraftBlockPositionSchema,
          distance_blocks: { type: "number", minimum: 0, maximum: 64 },
          bearing_degrees: { type: "number", minimum: -180, maximum: 180 },
          critical: { type: "boolean" },
        },
        required: ["kind", "position", "distance_blocks", "bearing_degrees", "critical"],
        additionalProperties: false,
      },
    },
    movement_candidates: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          cardinal_direction: { type: "string", enum: ["north", "south", "east", "west"] },
          relative_direction: { type: "string", enum: ["forward", "back", "left", "right"] },
          target_feet_position: minecraftBlockPositionSchema,
          support_position: minecraftBlockPositionSchema,
          support_block: { type: "string", minLength: 1, maxLength: 160 },
          evidence_complete: { type: "boolean" },
          feet_clear: { type: "boolean" },
          head_clear: { type: "boolean" },
          drop_depth_blocks: { type: "integer", minimum: 0, maximum: 7 },
          drop_scan_complete: { type: "boolean" },
          nearby_hazard_count: { type: "integer", minimum: 0, maximum: 1_000 },
          nearby_fluid_count: { type: "integer", minimum: 0, maximum: 1_000 },
          safe_candidate: { type: "boolean" },
        },
        required: [
          "cardinal_direction", "relative_direction", "target_feet_position",
          "support_position", "support_block", "evidence_complete",
          "feet_clear", "head_clear", "drop_depth_blocks",
          "drop_scan_complete", "nearby_hazard_count", "nearby_fluid_count",
          "safe_candidate",
        ],
        additionalProperties: false,
      },
    },
    navigation_frontier: {
      type: "object",
      properties: {
        frontier_schema: {
          type: "string",
          enum: ["helix.minecraft_navigation_frontier.v1"],
        },
        planner: {
          type: "string",
          enum: ["casimirbot_native_bounded_dijkstra"],
        },
        movement_model: {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: {
            type: "string",
            enum: ["walk", "diagonal", "ascend", "descend"],
          },
        },
        origin: minecraftBlockPositionSchema,
        horizontal_radius: { type: "integer", minimum: 1, maximum: 16 },
        vertical_radius: { type: "integer", minimum: 1, maximum: 16 },
        reachable_foothold_count: {
          type: "integer",
          minimum: 1,
          maximum: 10_000,
        },
        evidence_complete: { type: "boolean" },
        coverage_boundary_reached: { type: "boolean" },
        route_step_limit_reached: { type: "boolean" },
        ranked_frontiers: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              destination: minecraftBlockPositionSchema,
              steps: {
                type: "array",
                minItems: 1,
                maxItems: 32,
                items: {
                  type: "object",
                  properties: {
                    from: minecraftBlockPositionSchema,
                    to: minecraftBlockPositionSchema,
                    movement: {
                      type: "string",
                      enum: ["walk", "diagonal", "ascend", "descend"],
                    },
                    cost: { type: "integer", minimum: 1, maximum: 100 },
                  },
                  required: ["from", "to", "movement", "cost"],
                  additionalProperties: false,
                },
              },
              cost: { type: "integer", minimum: 1, maximum: 100_000 },
              displacement_blocks: { type: "number", minimum: 0, maximum: 64 },
              vertical_gain_blocks: { type: "integer", minimum: -16, maximum: 16 },
              coverage_boundary: { type: "boolean" },
            },
            required: [
              "destination", "steps", "cost", "displacement_blocks",
              "vertical_gain_blocks", "coverage_boundary",
            ],
            additionalProperties: false,
          },
        },
        selection_authority: {
          type: "string",
          enum: ["runtime_codex"],
        },
      },
      required: [
        "frontier_schema", "planner", "movement_model", "origin",
        "horizontal_radius", "vertical_radius", "reachable_foothold_count",
        "evidence_complete", "coverage_boundary_reached",
        "route_step_limit_reached", "ranked_frontiers", "selection_authority",
      ],
      additionalProperties: false,
    },
    inventory: {
      type: "object",
      properties: {
        item_count: { type: "integer", minimum: 0, maximum: 512 },
        slots: {
          type: "array",
          maxItems: 256,
          items: {
            type: "object",
            properties: {
              slot: { type: "integer", minimum: 0, maximum: 512 },
              item: { type: "string", minLength: 1, maxLength: 160 },
              count: { type: "integer", minimum: 0, maximum: 100_000 },
            },
            required: ["slot", "item", "count"],
            additionalProperties: false,
          },
        },
      },
      required: ["item_count", "slots"],
      additionalProperties: false,
    },
    coverage: {
      type: "object",
      properties: {
        horizontal_radius: { type: "integer", minimum: 1, maximum: 7 },
        vertical_radius: { type: "integer", minimum: 1, maximum: 16 },
        loaded_region_complete: { type: "boolean" },
        unknown_cell_count: { type: "integer", minimum: 0, maximum: 10_000 },
        entities_complete: { type: "boolean" },
        projectiles_complete: { type: "boolean" },
        hazards_complete: { type: "boolean" },
        omitted_categories: {
          type: "array",
          maxItems: 16,
          items: { type: "string", minLength: 1, maxLength: 80 },
        },
      },
      required: [
        "horizontal_radius", "vertical_radius", "loaded_region_complete",
        "unknown_cell_count", "entities_complete", "hazards_complete",
        "omitted_categories",
      ],
      additionalProperties: false,
    },
    ui_state: {
      type: "object",
      properties: {
        server_container_open: { type: "boolean" },
        same_revision: { type: "boolean" },
        client_screen_state: { type: "string", enum: ["open", "closed", "unobserved"] },
        input_capture_known: { type: "boolean" },
        input_activity: { type: "boolean" },
        client_game_tick: { type: "integer", minimum: 0 },
        server_received_tick: { type: "integer", minimum: 0 },
        age_ticks: { type: "integer", minimum: 0, maximum: 10 },
        freshness: { type: "string", enum: ["fresh", "unobserved"] },
        screen_kind: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: [
        "server_container_open", "same_revision", "client_screen_state",
        "input_capture_known", "input_activity", "freshness",
      ],
      additionalProperties: false,
    },
    world_rules: {
      type: "object",
      properties: {
        keep_inventory: { type: "boolean" },
      },
      required: ["keep_inventory"],
      additionalProperties: false,
    },
    semantic_fingerprint: { type: "string", minLength: 71, maxLength: 71 },
  },
  required: [
    "result_summary", "snapshot_schema", "observation_revision", "game_tick",
    "capture_duration_ms", "dimension", "actor", "focus", "entities",
    "hazards", "movement_candidates", "inventory", "coverage", "ui_state",
    "world_rules", "semantic_fingerprint",
  ],
  additionalProperties: false,
};

const minecraftPerceptionSnapshotInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    include_navigation_collision: {
      type: "boolean",
      description: "Opt in to a fixed 5x5x5 selected-player collision capture. Defaults to false. Unknown, unsupported and unavailable evidence never establishes a safe route.",
    },
    target: {
      type: "string",
      enum: ["current_actor"],
      description: "Capture the authenticated actor already selected in the room.",
    },
    horizontal_radius: {
      type: "integer",
      minimum: 1,
      maximum: 7,
      description: "Bounded horizontal terrain and hazard radius; defaults to 4.",
    },
    vertical_radius: {
      type: "integer",
      minimum: 2,
      maximum: 16,
      description: "Bounded vertical coverage and drop scan context; defaults to 8.",
    },
    freshness_requirement_ms: {
      type: "integer",
      minimum: 1_000,
      maximum: 30_000,
    },
  },
  required: ["target"],
  additionalProperties: false,
};

const minecraftCropTargetSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    target: {
      type: "string",
      enum: ["current_focus", "position"],
      description:
        "Inspect either the crop under the actor's current focus or an exact position in the bound world.",
    },
    position: minecraftPositionSchema,
    freshness_requirement_ms: {
      type: "integer",
      minimum: 1_000,
      maximum: 120_000,
      description: "Maximum acceptable observation age.",
    },
  },
  required: ["target"],
  additionalProperties: false,
};

const minecraftCrimsonCurseStateSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    properties: {
      mod_id: { type: "string", enum: ["mr_crimson_curse"] },
      mod_version: { type: "string", maxLength: 40 },
      state_source: {
        type: "string",
        enum: ["allowlisted_scoreboard_observation"],
      },
      raw_command_output_included: { type: "boolean" },
      raw_nbt_included: { type: "boolean" },
      status: { type: "string", enum: ["not_initialized", "observed"] },
      global_mass: {
        type: "integer",
        minimum: -2_147_483_648,
        maximum: 2_147_483_647,
      },
      global_points: {
        type: "integer",
        minimum: -2_147_483_648,
        maximum: 2_147_483_647,
      },
      infection_phase: { type: "integer", minimum: -1, maximum: 5 },
    },
    required: [
      "mod_id",
      "state_source",
      "raw_command_output_included",
      "raw_nbt_included",
      "status",
    ],
    additionalProperties: false,
  };

const minecraftActorStatusOutputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    properties: {
      result_summary: { type: "string", maxLength: 2_000 },
      health: { type: "number", minimum: 0, maximum: 2_048 },
      max_health: { type: "number", minimum: 0, maximum: 2_048 },
      food_level: { type: "integer", minimum: 0, maximum: 20 },
      saturation: { type: "number", minimum: 0, maximum: 20 },
      actor_label: { type: "string", maxLength: 160 },
      game_mode: { type: "string", maxLength: 64 },
      world: { type: "string", maxLength: 160 },
      position: minecraftPositionSchema,
      yaw: {
        type: "number",
        description:
          "Measured Minecraft view yaw in degrees; increasing values turn right.",
      },
      pitch: {
        type: "number",
        minimum: -90,
        maximum: 90,
        description:
          "Measured Minecraft view pitch in degrees; increasing values look down.",
      },
      looked_at_block: {
        type: "object",
        description:
          "Fresh read-only block focus measured from the actor's current view. Use aim_position for an evidence-grounded look_at position before a later looked_at_block interaction; movement or camera changes invalidate this focus.",
        properties: {
          block_id: { type: "string", maxLength: 160 },
          position: minecraftBlockPositionSchema,
          aim_position: minecraftPositionSchema,
          distance_blocks: { type: "number", minimum: 0, maximum: 6 },
          within_interaction_range: { type: "boolean" },
        },
        required: [
          "block_id",
          "position",
          "aim_position",
          "distance_blocks",
          "within_interaction_range",
        ],
        additionalProperties: false,
      },
      status_flags: {
        type: "array",
        maxItems: 32,
        items: { type: "string", maxLength: 80 },
      },
      active_effects: {
        type: "array",
        maxItems: 32,
        items: {
          type: "object",
          properties: {
            effect: { type: "string", maxLength: 160 },
            amplifier: { type: "integer", minimum: 0, maximum: 255 },
            duration_ticks: {
              type: "integer",
              minimum: 0,
              maximum: 2_147_483_647,
            },
          },
          required: ["effect", "amplifier", "duration_ticks"],
          additionalProperties: false,
        },
      },
      mechanics_state: minecraftCrimsonCurseStateSchema,
    },
    required: ["result_summary"],
    additionalProperties: false,
  };

const minecraftInventoryOutputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    result_summary: { type: "string", maxLength: 2_000 },
    item_count: { type: "integer", minimum: 0, maximum: 100_000 },
    slots: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        properties: {
          slot: { type: "integer", minimum: 0, maximum: 512 },
          item: { type: "string", maxLength: 160 },
          count: { type: "integer", minimum: 0, maximum: 100_000 },
        },
        required: ["slot", "item", "count"],
        additionalProperties: false,
      },
    },
  },
  required: ["result_summary"],
  additionalProperties: false,
};

const minecraftNearbyEntitiesOutputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    properties: {
      result_summary: { type: "string", maxLength: 2_000 },
      entity_count: { type: "integer", minimum: 0, maximum: 512 },
      entities: {
        type: "array",
        maxItems: 128,
        items: {
          type: "object",
          properties: {
            entity_type: { type: "string", maxLength: 160 },
            entity_label: { type: "string", maxLength: 160 },
            classification: {
              type: "string",
              enum: ["hostile", "player", "passive", "projectile", "other"],
            },
            distance_blocks: {
              type: "number",
              minimum: 0,
              maximum: 1_024,
            },
            targeting_actor: { type: "boolean" },
            health: { type: "number", minimum: 0, maximum: 2_147_483_647 },
            max_health: {
              type: "number",
              minimum: 0,
              maximum: 2_147_483_647,
            },
          },
          required: [
            "entity_type",
            "classification",
            "distance_blocks",
            "targeting_actor",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["result_summary"],
    additionalProperties: false,
  };

const minecraftRegistryFactInputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    properties: {
      registry_kind: {
        type: "string",
        enum: ["block", "item", "entity_type", "mob_effect"],
        description: "The exact live Minecraft registry to inspect.",
      },
      resource_id: {
        type: "string",
        minLength: 1,
        maxLength: 160,
        description: "An exact namespaced Minecraft resource identifier.",
      },
      freshness_requirement_ms: {
        type: "integer",
        minimum: 1_000,
        maximum: 300_000,
        description: "Maximum acceptable observation age.",
      },
    },
    required: ["registry_kind", "resource_id"],
    additionalProperties: false,
  };

const minecraftRegistryFactOutputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    properties: {
      result_summary: { type: "string", maxLength: 2_000 },
      game_version: { type: "string", maxLength: 80 },
      registry_kind: {
        type: "string",
        enum: ["block", "item", "entity_type", "mob_effect"],
      },
      requested_resource_id: { type: "string", maxLength: 160 },
      registered: { type: "boolean" },
      canonical_resource_id: { type: "string", maxLength: 160 },
    },
    required: [
      "result_summary",
      "game_version",
      "registry_kind",
      "requested_resource_id",
      "registered",
    ],
    additionalProperties: false,
  };

const minecraftRecipeFactInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    query_kind: {
      type: "string",
      enum: ["recipe_id", "output_item_id"],
      description:
        "Whether resource_id names an exact recipe or an output item.",
    },
    resource_id: {
      type: "string",
      minLength: 1,
      maxLength: 160,
      description: "An exact namespaced recipe or output-item identifier.",
    },
    max_results: {
      type: "integer",
      minimum: 1,
      maximum: 16,
      description: "Bounded number of matching recipe facts to return.",
    },
    freshness_requirement_ms: {
      type: "integer",
      minimum: 1_000,
      maximum: 300_000,
      description: "Maximum acceptable observation age.",
    },
  },
  required: ["query_kind", "resource_id"],
  additionalProperties: false,
};

const minecraftRecipeFactOutputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    result_summary: { type: "string", maxLength: 2_000 },
    game_version: { type: "string", maxLength: 80 },
    query_kind: {
      type: "string",
      enum: ["recipe_id", "output_item_id"],
    },
    requested_resource_id: { type: "string", maxLength: 160 },
    match_count: { type: "integer", minimum: 0, maximum: 100_000 },
    matches_complete: { type: "boolean" },
    matches: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        properties: {
          recipe_id: { type: "string", maxLength: 160 },
          recipe_type: { type: "string", maxLength: 160 },
          serializer_id: { type: "string", maxLength: 160 },
          group: { type: "string", maxLength: 160 },
          result_item_ids: {
            type: "array",
            maxItems: 16,
            items: { type: "string", maxLength: 160 },
          },
          result_resolution_complete: { type: "boolean" },
        },
        required: [
          "recipe_id",
          "recipe_type",
          "serializer_id",
          "group",
          "result_item_ids",
          "result_resolution_complete",
        ],
        additionalProperties: false,
      },
    },
  },
  required: [
    "result_summary",
    "game_version",
    "query_kind",
    "requested_resource_id",
    "match_count",
    "matches_complete",
    "matches",
  ],
  additionalProperties: false,
};

const minecraftHazardsOutputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    result_summary: { type: "string", maxLength: 2_000 },
    hazard_present: { type: "boolean" },
    hostile_entity_count: { type: "integer", minimum: 0, maximum: 512 },
    nearest_hostile_distance_blocks: {
      type: "number",
      minimum: 0,
      maximum: 1_024,
    },
    environmental_hazard_block_count: {
      type: "integer",
      minimum: 0,
      maximum: 65_536,
    },
    nearest_environmental_hazard_distance_blocks: {
      type: "number",
      minimum: 0,
      maximum: 1_024,
    },
    environmental_hazard_types: {
      type: "array",
      maxItems: 32,
      items: { type: "string", maxLength: 80 },
    },
    actor_on_fire: { type: "boolean" },
    actor_freezing: { type: "boolean" },
  },
  required: ["result_summary"],
  additionalProperties: false,
};

const minecraftLocalMapOutputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    result_summary: { type: "string", maxLength: 2_000 },
    sampled_floor_blocks: { type: "integer", minimum: 0, maximum: 65_536 },
    solid_floor_blocks: { type: "integer", minimum: 0, maximum: 65_536 },
    open_floor_blocks: { type: "integer", minimum: 0, maximum: 65_536 },
    hazardous_floor_blocks: {
      type: "integer",
      minimum: 0,
      maximum: 65_536,
    },
    liquid_floor_blocks: {
      type: "integer",
      minimum: 0,
      maximum: 65_536,
    },
  },
  required: ["result_summary"],
  additionalProperties: false,
};

const minecraftSpatialRegionInputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    properties: {
      target: {
        type: "string",
        enum: ["current_actor"],
        description:
          "Survey a bounded region centered on the selected Minecraft actor.",
      },
      horizontal_radius: {
        type: "integer",
        minimum: 1,
        maximum: 7,
        description: "Horizontal survey radius in blocks; defaults to 7.",
      },
      vertical_radius: {
        type: "integer",
        minimum: 1,
        maximum: 16,
        description:
          "Vertical survey radius in blocks; defaults to 6. Use up to 16 for bounded landing-safety inspection below an elevated actor.",
      },
      purpose: {
        type: "string",
        enum: [
          "general",
          "structure_planning",
          "build_planning",
          "structure_verification",
          "fire_safety",
          "landing_safety",
          "movement_safety",
        ],
        description:
          "The bounded survey purpose. Use structure_verification only with exact verification endpoints and an expected block.",
      },
      requested_length: {
        type: "integer",
        minimum: 3,
        maximum: 15,
        description:
          "Exact requested build-line length. When present, returned build-line candidates must have this length.",
      },
      requested_height: {
        type: "integer",
        minimum: 3,
        maximum: 8,
        description:
          "Exact requested clear build height. Returned build-line candidates must verify at least this many strict-air cells vertically.",
      },
      orientation: {
        type: "string",
        enum: ["north_south", "east_west"],
        description: "Requested build-line orientation.",
      },
      relative_side: {
        type: "string",
        enum: ["north", "south", "east", "west"],
        description: "Requested side of the selected actor.",
      },
      verification_from: {
        ...minecraftPositionSchema,
        description:
          "First inclusive corner of an exact post-action block footprint to verify.",
      },
      verification_to: {
        ...minecraftPositionSchema,
        description:
          "Opposite inclusive corner of an exact post-action block footprint to verify.",
      },
      expected_block: {
        type: "string",
        minLength: 1,
        maxLength: 160,
        description:
          "Canonical block identifier expected in every cell of the exact verification footprint.",
      },
      freshness_requirement_ms: {
        type: "integer",
        minimum: 1_000,
        maximum: 120_000,
        description: "Maximum acceptable observation age.",
      },
    },
    required: ["target"],
    additionalProperties: false,
  };

const minecraftSpatialRegionOutputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    properties: {
      result_summary: { type: "string", maxLength: 2_000 },
      purpose: {
        type: "string",
        enum: [
          "general",
          "structure_planning",
          "build_planning",
          "structure_verification",
          "fire_safety",
          "landing_safety",
          "movement_safety",
        ],
      },
      center: minecraftPositionSchema,
      horizontal_radius: { type: "integer", minimum: 1, maximum: 7 },
      vertical_radius: { type: "integer", minimum: 1, maximum: 16 },
      requested_length: { type: "integer", minimum: 3, maximum: 15 },
      requested_height: { type: "integer", minimum: 3, maximum: 8 },
      requested_orientation: {
        type: "string",
        enum: ["north_south", "east_west"],
      },
      requested_relative_side: {
        type: "string",
        enum: ["north", "south", "east", "west"],
      },
      sample_count: { type: "integer", minimum: 1, maximum: 10_000 },
      bounds: {
        type: "object",
        properties: {
          min: minecraftPositionSchema,
          max: minecraftPositionSchema,
        },
        required: ["min", "max"],
        additionalProperties: false,
      },
      palette: {
        type: "array",
        maxItems: 128,
        items: {
          type: "object",
          properties: {
            block: { type: "string", maxLength: 160 },
            count: { type: "integer", minimum: 1, maximum: 10_000 },
          },
          required: ["block", "count"],
          additionalProperties: false,
        },
      },
      palette_complete: { type: "boolean" },
      omitted_palette_block_types: {
        type: "integer",
        minimum: 0,
        maximum: 10_000,
      },
      column_encoding: {
        type: "string",
        enum: [
          "expanded_relative_xz_relative_y_palette_flags_v1",
          "absolute_xyz_verbose_v1",
        ],
      },
      block_position_samples: {
        type: "array",
        maxItems: 32,
        items: {
          type: "object",
          properties: {
            block: { type: "string", minLength: 1, maxLength: 160 },
            total_count: { type: "integer", minimum: 1, maximum: 10_000 },
            positions: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: minecraftPositionSchema,
            },
          },
          required: ["block", "total_count", "positions"],
          additionalProperties: false,
        },
      },
      columns: {
        type: "array",
        maxItems: 225,
        items: {
          type: "object",
          properties: {
            x: { type: "integer", minimum: -30_000_000, maximum: 30_000_000 },
            z: { type: "integer", minimum: -30_000_000, maximum: 30_000_000 },
            runs: {
              type: "array",
              maxItems: 17,
              items: {
                type: "object",
                properties: {
                  y_start: { type: "integer", minimum: -2_048, maximum: 2_048 },
                  y_end: { type: "integer", minimum: -2_048, maximum: 2_048 },
                  block: { type: "string", maxLength: 160 },
                  flags: {
                    type: "array",
                    maxItems: 7,
                    items: {
                      type: "string",
                      enum: [
                        "air",
                        "fluid",
                        "solid",
                        "flammable",
                        "replaceable",
                        "hazard",
                        "block_entity",
                      ],
                    },
                  },
                },
                required: ["y_start", "y_end", "block", "flags"],
                additionalProperties: false,
              },
            },
          },
          required: ["x", "z", "runs"],
          additionalProperties: false,
        },
      },
      columns_complete: { type: "boolean" },
      retained_column_count: { type: "integer", minimum: 0, maximum: 225 },
      omitted_column_count: { type: "integer", minimum: 0, maximum: 225 },
      omitted_run_count: { type: "integer", minimum: 0, maximum: 10_000 },
      wire_details_json_bytes: {
        type: "integer",
        minimum: 0,
        maximum: 34_000,
      },
      anchors: {
        type: "array",
        maxItems: 64,
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: [
                "door",
                "bed",
                "container",
                "workstation",
                "portal",
                "hearth_base",
              ],
            },
            block: { type: "string", maxLength: 160 },
            position: minecraftPositionSchema,
          },
          required: ["kind", "block", "position"],
          additionalProperties: false,
        },
      },
      anchors_complete: { type: "boolean" },
      retained_anchor_count: { type: "integer", minimum: 0, maximum: 10_000 },
      omitted_anchor_count: { type: "integer", minimum: 0, maximum: 10_000 },
      fireplace_candidates: {
        type: "array",
        maxItems: 16,
        items: {
          type: "object",
          properties: {
            base_position: minecraftPositionSchema,
            fire_position: minecraftPositionSchema,
            base_block: { type: "string", maxLength: 160 },
            flammable_within_two: { type: "integer", minimum: 0, maximum: 125 },
            solid_nonflammable_enclosure: {
              type: "integer",
              minimum: 0,
              maximum: 5,
            },
            replaceable_fire_cell: { type: "boolean" },
            safe_candidate: { type: "boolean" },
          },
          required: [
            "base_position",
            "fire_position",
            "base_block",
            "flammable_within_two",
            "solid_nonflammable_enclosure",
            "replaceable_fire_cell",
            "safe_candidate",
          ],
          additionalProperties: false,
        },
      },
      fireplace_candidates_complete: { type: "boolean" },
      retained_fireplace_candidate_count: {
        type: "integer",
        minimum: 0,
        maximum: 10_000,
      },
      omitted_fireplace_candidate_count: {
        type: "integer",
        minimum: 0,
        maximum: 10_000,
      },
      build_line_candidates: {
        type: "array",
        maxItems: 16,
        items: {
          type: "object",
          properties: {
            orientation: {
              type: "string",
              enum: ["north_south", "east_west"],
            },
            relative_side: {
              type: "string",
              enum: ["north", "south", "east", "west", "overlap"],
            },
            from: minecraftPositionSchema,
            to: minecraftPositionSchema,
            length: { type: "integer", minimum: 3, maximum: 15 },
            minimum_clear_height: {
              type: "integer",
              minimum: 3,
              maximum: 17,
            },
            minimum_actor_distance: {
              type: "integer",
              minimum: 2,
              maximum: 30,
            },
            nearest_anchor_distance: {
              type: "integer",
              minimum: 2,
              maximum: 1_000_000,
            },
            ground_blocks: {
              type: "array",
              maxItems: 16,
              items: { type: "string", maxLength: 160 },
            },
            target_cells_replaceable: { type: "boolean" },
            target_cells_air: { type: "boolean" },
            ground_solid_nonhazardous: { type: "boolean" },
            fluid_cells: { type: "integer", minimum: 0, maximum: 10_000 },
            flammable_cells: {
              type: "integer",
              minimum: 0,
              maximum: 10_000,
            },
            block_entity_cells: {
              type: "integer",
              minimum: 0,
              maximum: 10_000,
            },
            safe_candidate: { type: "boolean" },
          },
          required: [
            "orientation",
            "relative_side",
            "from",
            "to",
            "length",
            "minimum_clear_height",
            "minimum_actor_distance",
            "nearest_anchor_distance",
            "ground_blocks",
            "target_cells_replaceable",
            "target_cells_air",
            "ground_solid_nonhazardous",
            "fluid_cells",
            "flammable_cells",
            "block_entity_cells",
            "safe_candidate",
          ],
          additionalProperties: false,
        },
      },
      build_line_candidates_complete: { type: "boolean" },
      retained_build_line_candidate_count: {
        type: "integer",
        minimum: 0,
        maximum: 16,
      },
      omitted_build_line_candidate_count: {
        type: "integer",
        minimum: 0,
        maximum: 10_000,
      },
      walk_step_candidates: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            cardinal_direction: {
              type: "string",
              enum: ["north", "south", "east", "west"],
            },
            relative_direction: {
              type: "string",
              enum: ["forward", "back", "left", "right"],
            },
            target_feet_position: minecraftPositionSchema,
            target_head_position: minecraftPositionSchema,
            support_position: minecraftPositionSchema,
            support_block: { type: "string", minLength: 1, maxLength: 160 },
            evidence_complete: { type: "boolean" },
            feet_clear: { type: "boolean" },
            head_clear: { type: "boolean" },
            support_solid_nonhazardous: { type: "boolean" },
            nearby_hazard_count: {
              type: "integer",
              minimum: 0,
              maximum: 10_000,
            },
            nearby_fluid_count: {
              type: "integer",
              minimum: 0,
              maximum: 10_000,
            },
            safe_candidate: { type: "boolean" },
          },
          required: [
            "cardinal_direction",
            "relative_direction",
            "target_feet_position",
            "target_head_position",
            "support_position",
            "support_block",
            "evidence_complete",
            "feet_clear",
            "head_clear",
            "support_solid_nonhazardous",
            "nearby_hazard_count",
            "nearby_fluid_count",
            "safe_candidate",
          ],
          additionalProperties: false,
        },
      },
      walk_step_candidates_complete: { type: "boolean" },
      retained_walk_step_candidate_count: {
        type: "integer",
        minimum: 0,
        maximum: 4,
      },
      omitted_walk_step_candidate_count: {
        type: "integer",
        minimum: 0,
        maximum: 4,
      },
      target_geometry_verification: {
        type: "object",
        properties: {
          from: minecraftPositionSchema,
          to: minecraftPositionSchema,
          expected_block: { type: "string", minLength: 1, maxLength: 160 },
          total_cells: { type: "integer", minimum: 1, maximum: 4_096 },
          sampled_cells: { type: "integer", minimum: 0, maximum: 4_096 },
          matching_cells: { type: "integer", minimum: 0, maximum: 4_096 },
          mismatched_cells: { type: "integer", minimum: 0, maximum: 4_096 },
          unobserved_cells: { type: "integer", minimum: 0, maximum: 4_096 },
          mismatch_samples: {
            type: "array",
            maxItems: 32,
            items: {
              type: "object",
              properties: {
                position: minecraftPositionSchema,
                observed_block: {
                  type: "string",
                  minLength: 1,
                  maxLength: 160,
                },
              },
              required: ["position", "observed_block"],
              additionalProperties: false,
            },
          },
          within_survey_bounds: { type: "boolean" },
          complete: { type: "boolean" },
          all_match: { type: "boolean" },
        },
        required: [
          "from",
          "to",
          "expected_block",
          "total_cells",
          "sampled_cells",
          "matching_cells",
          "mismatched_cells",
          "unobserved_cells",
          "mismatch_samples",
          "within_survey_bounds",
          "complete",
          "all_match",
        ],
        additionalProperties: false,
      },
    },
    required: [
      "result_summary",
      "purpose",
      "center",
      "horizontal_radius",
      "vertical_radius",
      "sample_count",
      "bounds",
      "palette",
      "palette_complete",
      "omitted_palette_block_types",
      "column_encoding",
      "block_position_samples",
      "columns",
      "columns_complete",
      "retained_column_count",
      "omitted_column_count",
      "omitted_run_count",
      "wire_details_json_bytes",
      "anchors",
      "anchors_complete",
      "retained_anchor_count",
      "omitted_anchor_count",
      "fireplace_candidates",
      "fireplace_candidates_complete",
      "retained_fireplace_candidate_count",
      "omitted_fireplace_candidate_count",
      "build_line_candidates",
      "build_line_candidates_complete",
      "retained_build_line_candidate_count",
      "omitted_build_line_candidate_count",
    ],
    additionalProperties: false,
  };

const minecraftLineOfSightOutputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    properties: {
      result_summary: { type: "string", maxLength: 2_000 },
      line_of_sight: { type: "boolean" },
      distance_blocks: { type: "number", minimum: 0, maximum: 1_024 },
    },
    required: ["result_summary"],
    additionalProperties: false,
  };

const minecraftCropStateOutputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    result_summary: { type: "string", maxLength: 2_000 },
    crop_mature: { type: "boolean" },
    crop_type: { type: "string", maxLength: 160 },
  },
  required: ["result_summary"],
  additionalProperties: false,
};

const minecraftReachabilityOutputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    properties: {
      result_summary: { type: "string", maxLength: 2_000 },
      within_probe_radius: { type: "boolean" },
      within_interaction_range: { type: "boolean" },
      distance_blocks: { type: "number", minimum: 0, maximum: 1_000_000 },
    },
    required: ["result_summary"],
    additionalProperties: false,
  };

const syntheticReachabilityOutputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    properties: {
      result_summary: { type: "string", maxLength: 2_000 },
      reachable: { type: "boolean" },
      distance: { type: "number", minimum: 0, maximum: 1_000_000 },
    },
    required: ["result_summary", "reachable"],
    additionalProperties: false,
  };

const systemClockInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    clock: {
      type: "string",
      enum: ["monotonic"],
      description: "Read the connector host's monotonic process clock.",
    },
  },
  required: ["clock"],
  additionalProperties: false,
};

const systemClockOutputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    result_summary: { type: "string", maxLength: 2_000 },
    uptime_ms: { type: "integer", minimum: 0 },
  },
  required: ["result_summary", "uptime_ms"],
  additionalProperties: false,
};

const minecraftPlayerActionOutputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    properties: {
      workflow_id: { type: "string", minLength: 1, maxLength: 320 },
      outcome: {
        type: "string",
        enum: [
          "succeeded",
          "failed",
          "request_canceled",
          "manual_override",
          "emergency_stopped",
          "connector_offline",
          "workflow_timeout",
          "authority_stale",
          "precondition_failed",
          "postcondition_failed",
        ],
      },
      summary: { type: "string", minLength: 1, maxLength: 4_000 },
      postconditions_verified: { type: "boolean" },
      controls_released: { type: "boolean" },
      evidence_refs: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 320 },
        maxItems: 256,
      },
    },
    required: [
      "workflow_id",
      "outcome",
      "summary",
      "postconditions_verified",
      "controls_released",
      "evidence_refs",
    ],
    additionalProperties: false,
  };

const minecraftNavigateInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    action_kind: { type: "string", enum: ["navigate_to"] },
    destination: minecraftPositionSchema,
    arrival_radius: { type: "number", minimum: 0.25, maximum: 16 },
    allow_sprint: { type: "boolean" },
    allow_dig: { type: "boolean", enum: [false] },
    allow_place: { type: "boolean", enum: [false] },
    max_duration_ms: { type: "integer", minimum: 500, maximum: 300_000 },
    max_distance_blocks: { type: "number", minimum: 1, maximum: 128 },
    engine_preference: {
      type: "string",
      enum: ["adapter_selected", "native_fabric", "baritone"],
    },
  },
  required: [
    "action_kind",
    "destination",
    "arrival_radius",
    "allow_sprint",
    "allow_dig",
    "allow_place",
    "engine_preference",
  ],
  additionalProperties: false,
};

const minecraftLookInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    action_kind: { type: "string", enum: ["look_at"] },
    target_kind: {
      type: "string",
      enum: ["position", "current_focus", "relative_rotation"],
      description:
        "Look at an exact position, retain the current focus, or rotate relative to the current measured view.",
    },
    position: minecraftPositionSchema,
    yaw_delta_degrees: {
      type: "number",
      minimum: -180,
      maximum: 180,
      description:
        "For relative_rotation, positive degrees turn right and negative degrees turn left. Omit this axis to keep its current angle.",
    },
    pitch_delta_degrees: {
      type: "number",
      minimum: -180,
      maximum: 180,
      description:
        "For relative_rotation, positive degrees look down and negative degrees look up. Omit this axis to keep its current angle.",
    },
    max_turn_degrees_per_tick: { type: "number", minimum: 0.1, maximum: 180 },
  },
  required: ["action_kind", "target_kind", "max_turn_degrees_per_tick"],
  additionalProperties: false,
};

const minecraftCameraTrackInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    action_kind: { type: "string", enum: ["track_target"] },
    target_kind: {
      type: "string",
      enum: ["entity_type", "current_focus_entity", "particle_type"],
      description:
        "Acquire the nearest loaded entity or particle of one exact type, or lock the entity currently under the crosshair. Entity and single-instance identities remain stable; particle streams permit only declared same-type handoffs.",
    },
    entity_type_id: {
      type: "string",
      minLength: 3,
      maxLength: 320,
      description:
        "Required for entity_type. An exact Minecraft entity resource identifier such as minecraft:bat.",
    },
    particle_type_id: {
      type: "string",
      minLength: 3,
      maxLength: 320,
      description:
        "Required for particle_type. An exact Minecraft particle resource identifier such as minecraft:enchant.",
    },
    continuity: {
      type: "string",
      enum: ["single_instance", "same_type_stream"],
      description:
        "Required for particle_type. single_instance follows exactly one particle until expiry; same_type_stream permits bounded handoffs only to the same exact particle type.",
    },
    handoff_radius: {
      type: "number",
      minimum: 0,
      maximum: 8,
      description:
        "For a same_type_stream, the maximum distance in blocks from the last measured particle to an admitted successor. Use 0 for single_instance.",
    },
    max_handoffs: {
      type: "integer",
      minimum: 0,
      maximum: 1_000,
      description:
        "Maximum same-type particle handoffs during this workflow. Use 0 for single_instance.",
    },
    aim_point: {
      type: "string",
      enum: ["center", "render_center", "eyes", "feet"],
      description:
        "center follows the logical collision anchor; render_center follows a supported client-rendered visual anchor such as a dropped item's bob; eyes and feet use the corresponding entity anchors.",
    },
    max_acquisition_distance: { type: "number", minimum: 1, maximum: 128 },
    max_duration_ms: {
      type: "integer",
      minimum: 1_000,
      maximum: 5 * 60_000,
    },
    max_turn_degrees_per_tick: { type: "number", minimum: 0.1, maximum: 180 },
    max_angular_acceleration_degrees_per_tick_squared: {
      type: "number",
      minimum: 0.01,
      maximum: 180,
    },
    prediction_ticks: { type: "integer", minimum: 0, maximum: 10 },
    deadband_degrees: { type: "number", minimum: 0, maximum: 10 },
    reacquire_ticks: { type: "integer", minimum: 0, maximum: 200 },
    require_line_of_sight: { type: "boolean" },
    stop_below_health: { type: "number", minimum: 1, maximum: 20 },
  },
  required: [
    "action_kind",
    "target_kind",
    "aim_point",
    "max_acquisition_distance",
    "max_duration_ms",
    "max_turn_degrees_per_tick",
    "max_angular_acceleration_degrees_per_tick_squared",
    "prediction_ticks",
    "deadband_degrees",
    "reacquire_ticks",
    "require_line_of_sight",
    "stop_below_health",
  ],
  additionalProperties: false,
};

const minecraftWalkInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    action_kind: { type: "string", enum: ["walk"] },
    direction: { type: "string", enum: ["forward", "back", "left", "right"] },
    duration_ms: {
      type: "integer",
      minimum: 50,
      maximum: 10_000,
      description:
        "Bounded input duration. Inside the native 20 Hz reactive scheduler this normally occupies ceil(duration_ms / 50) ticks; coordinate observer wait windows with that causal duration.",
    },
    sprint: { type: "boolean" },
    jump: {
      type: "boolean",
      description:
        "When true, hold jump during the same bounded locomotion interval; useful for swimming upward through viscous hazards without creating another execution lane.",
    },
  },
  required: ["action_kind", "direction", "duration_ms", "sprint"],
  additionalProperties: false,
};

const minecraftJumpInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    action_kind: { type: "string", enum: ["jump"] },
    count: { type: "integer", minimum: 1, maximum: 10 },
  },
  required: ["action_kind", "count"],
  additionalProperties: false,
};

const minecraftInteractInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    action_kind: { type: "string", enum: ["interact"] },
    target: {
      type: "string",
      enum: ["current_focus", "looked_at_block", "looked_at_entity"],
    },
    hand: { type: "string", enum: ["main_hand", "off_hand"] },
    interaction: { type: "string", enum: ["use", "interact"] },
  },
  required: ["action_kind", "target", "hand", "interaction"],
  additionalProperties: false,
};

const minecraftCombatAttackInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    action_kind: { type: "string", enum: ["attack"] },
    target_ref: {
      type: "string",
      minLength: 1,
      maxLength: 320,
      description:
        "Opaque exact entity-incarnation reference from a prior target-lock receipt. The connector may not replace it with the nearest or crosshair entity.",
    },
    target_entity_type_id: { type: "string", minLength: 3, maxLength: 320 },
    target_classification: { type: "string", enum: ["hostile"] },
    max_acquisition_distance: { type: "number", minimum: 1, maximum: 16 },
    require_line_of_sight: { type: "boolean", enum: [true] },
    minimum_attack_cooldown: { type: "number", minimum: 0.1, maximum: 1 },
    max_attack_pulses: { type: "integer", minimum: 1, maximum: 64 },
    max_duration_ms: { type: "integer", minimum: 1_000, maximum: 60_000 },
    stop_below_health: { type: "number", minimum: 1, maximum: 20 },
    friendly_fire: { type: "boolean", enum: [false] },
  },
  required: [
    "action_kind",
    "target_ref",
    "target_entity_type_id",
    "target_classification",
    "max_acquisition_distance",
    "require_line_of_sight",
    "minimum_attack_cooldown",
    "max_attack_pulses",
    "max_duration_ms",
    "stop_below_health",
    "friendly_fire",
  ],
  additionalProperties: false,
};

const minecraftCombatGuardInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    action_kind: { type: "string", enum: ["combat_guard"] },
    hostile_entity_type_ids: {
      type: "array",
      items: { type: "string", minLength: 3, maxLength: 320 },
      minItems: 1,
      maxItems: 16,
    },
    combat_mode: {
      type: "string",
      enum: ["engage", "disengage_to_distance"],
      description:
        "engage permits admitted hostile attacks. disengage_to_distance suppresses attacks and succeeds only after every visible eligible hostile is at least retreat_stop_distance away.",
    },
    max_acquisition_distance: { type: "number", minimum: 2, maximum: 32 },
    require_line_of_sight: { type: "boolean", enum: [true] },
    minimum_attack_cooldown: { type: "number", minimum: 0.1, maximum: 1 },
    max_attack_pulses: { type: "integer", minimum: 1, maximum: 256 },
    max_target_switches: { type: "integer", minimum: 0, maximum: 64 },
    target_commit_ticks: { type: "integer", minimum: 0, maximum: 200 },
    retreat_start_distance: { type: "number", minimum: 1, maximum: 6 },
    retreat_stop_distance: { type: "number", minimum: 1, maximum: 8 },
    retreat_when_hostile_count_at_least: {
      type: "integer",
      minimum: 1,
      maximum: 16,
    },
    max_duration_ms: { type: "integer", minimum: 1_000, maximum: 120_000 },
    stop_below_health: { type: "number", minimum: 1, maximum: 20 },
    friendly_fire: { type: "boolean", enum: [false] },
    approach_policy: {
      type: "string",
      enum: ["none", "direct_bounded", "local_reroute_bounded"],
      description:
        "Optional admitted closing-distance repertoire. direct_bounded permits collision-checked forward input; local_reroute_bounded may fall back to one collision-checked lateral direction and its alternate. Either requires max_approach_ticks.",
    },
    max_approach_ticks: { type: "integer", minimum: 0, maximum: 1_200 },
    cover_policy: {
      type: "string",
      enum: ["none", "lateral_bounded"],
      description:
        "Optional cover-aware lateral movement. The resident controller admits a step only when its bounded lookahead finds collision-safe support and block occlusion from the projectile source.",
    },
    max_cover_ticks: { type: "integer", minimum: 0, maximum: 1_200 },
    projectile_response: {
      type: "string",
      enum: ["none", "sidestep", "shield_or_sidestep"],
      description:
        "Optional local response to a bounded predicted collision. It does not authorize attacks on projectiles or non-hostile entities.",
    },
    projectile_evasion_horizon_ticks: {
      type: "integer",
      minimum: 1,
      maximum: 20,
    },
    max_evasion_ticks: { type: "integer", minimum: 0, maximum: 1_200 },
    shield_hand: { type: "string", enum: ["none", "off_hand"] },
    max_shield_hold_ticks: { type: "integer", minimum: 0, maximum: 1_200 },
  },
  required: [
    "action_kind",
    "hostile_entity_type_ids",
    "max_acquisition_distance",
    "require_line_of_sight",
    "minimum_attack_cooldown",
    "max_attack_pulses",
    "max_target_switches",
    "target_commit_ticks",
    "retreat_start_distance",
    "retreat_stop_distance",
    "retreat_when_hostile_count_at_least",
    "max_duration_ms",
    "stop_below_health",
    "friendly_fire",
  ],
  additionalProperties: false,
};

const minecraftHotbarInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    action_kind: { type: "string", enum: ["hotbar_select"] },
    slot: { type: "integer", minimum: 0, maximum: 8 },
  },
  required: ["action_kind", "slot"],
  additionalProperties: false,
};

const minecraftEquipInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    action_kind: { type: "string", enum: ["equip"] },
    item_id: { type: "string", minLength: 3, maxLength: 320 },
    destination: {
      type: "string",
      enum: ["main_hand", "off_hand", "head", "chest", "legs", "feet"],
    },
  },
  required: ["action_kind", "item_id", "destination"],
  additionalProperties: false,
};

const minecraftFollowInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    action_kind: { type: "string", enum: ["follow"] },
    subject_ref: {
      type: "string",
      minLength: 1,
      maxLength: 320,
      description:
        "Exact visible subject_ref from the active room environment directory; Helix resolves its native identity server-side.",
    },
    distance: { type: "number", minimum: 1, maximum: 64 },
    max_duration_ms: {
      type: "integer",
      minimum: 1_000,
      maximum: 30 * 60_000,
    },
    stop_below_health: { type: "number", minimum: 1, maximum: 20 },
  },
  required: [
    "action_kind",
    "subject_ref",
    "distance",
    "max_duration_ms",
    "stop_below_health",
  ],
  additionalProperties: false,
};

const minecraftCollectInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    action_kind: { type: "string", enum: ["collect"] },
    item_or_block_id: {
      type: "string",
      minLength: 3,
      maxLength: 320,
      description:
        "Exact item identifier for a dropped item in loaded client range.",
    },
    count: { type: "integer", minimum: 1, maximum: 2_304 },
    search_radius: { type: "number", minimum: 1, maximum: 128 },
  },
  required: ["action_kind", "item_or_block_id", "count", "search_radius"],
  additionalProperties: false,
};

const minecraftMineInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    action_kind: { type: "string", enum: ["mine"] },
    block_id: { type: "string", minLength: 3, maxLength: 320 },
    count: { type: "integer", minimum: 1, maximum: 4_096 },
    search_radius: {
      type: "integer",
      minimum: 1,
      maximum: 32,
      description:
        "Bounded loaded-client search radius for the native Fabric engine.",
    },
    target_position: {
      ...minecraftBlockPositionSchema,
      description:
        "Optional exact loaded block to mine. Requires count 1 and a current block_id match inside search_radius.",
    },
  },
  required: ["action_kind", "block_id", "count", "search_radius"],
  additionalProperties: false,
};

const minecraftPlaceInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  description:
    "Place through a normal player action. Supply either exact integer positions or one bounded predicted_collision_cell position_binding. For bucket/fluid use, choose placement_method item_use and name the resulting block, exact source item, and hand.",
  properties: {
    action_kind: { type: "string", enum: ["place"] },
    block_id: { type: "string", minLength: 3, maxLength: 320 },
    positions: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: minecraftBlockPositionSchema,
    },
    position_binding: {
      type: "object",
      description:
        "Fabric-local binding for the replaceable cell above an already-applicable measured landing trajectory. It neither moves the player nor creates a fall. Codex must author any required locomotion and state-transition event in separate nodes or lanes; otherwise the binding can wait until timeout.",
      properties: {
        binding_kind: {
          type: "string",
          enum: ["predicted_collision_cell"],
        },
        horizon_ticks: { type: "integer", minimum: 1, maximum: 20 },
        max_distance_blocks: { type: "number", minimum: 0.01, maximum: 6 },
        require_replaceable: { type: "boolean", enum: [true] },
      },
      required: [
        "binding_kind",
        "horizon_ticks",
        "max_distance_blocks",
        "require_replaceable",
      ],
      additionalProperties: false,
    },
    placement_method: {
      type: "string",
      enum: ["block_item", "item_use"],
      description:
        "Use block_item for ordinary placeable blocks. Use item_use for a bucket or another item whose normal use creates block state.",
    },
    source_item_id: {
      type: "string",
      minLength: 3,
      maxLength: 320,
      description:
        "Required with item_use; for water placement this is minecraft:water_bucket.",
    },
    hand: {
      type: "string",
      enum: ["main_hand", "off_hand"],
      description:
        "Required with item_use; the exact hand holding the source item.",
    },
    cleanup_after_landing: {
      type: "boolean",
      enum: [true],
      description:
        "For a predicted-collision minecraft:water placement from minecraft:water_bucket only, recover the temporary source after measured landing before completing.",
    },
  },
  required: ["action_kind", "block_id"],
  additionalProperties: false,
};

const minecraftCraftInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    action_kind: { type: "string", enum: ["craft"] },
    output_item_id: { type: "string", minLength: 3, maxLength: 320 },
    count: { type: "integer", minimum: 1, maximum: 2_304 },
    recipe_id: {
      type: "string",
      minLength: 3,
      maxLength: 320,
      description:
        "Optional exact recipe resource key. Omit it to allow the client to select a known craftable recipe by output.",
    },
  },
  required: ["action_kind", "output_item_id", "count"],
  additionalProperties: false,
};

const minecraftConsumeInputSchema: HelixEnvironmentConstrainedJsonSchema = {
  type: "object",
  properties: {
    action_kind: { type: "string", enum: ["consume"] },
    item_id: { type: "string", minLength: 3, maxLength: 320 },
    count: { type: "integer", minimum: 1, maximum: 64 },
    hand: { type: "string", enum: ["main_hand"] },
    max_duration_ms: { type: "integer", minimum: 1_000, maximum: 60_000 },
    stop_below_health: { type: "number", minimum: 1, maximum: 20 },
    minimum_food_gain: { type: "integer", minimum: 0, maximum: 20 },
    expected_remainder_item_id: {
      type: "string",
      minLength: 3,
      maxLength: 320,
    },
  },
  required: [
    "action_kind",
    "item_id",
    "count",
    "hand",
    "max_duration_ms",
    "stop_below_health",
    "minimum_food_gain",
  ],
  additionalProperties: false,
};

const minecraftInventoryTransferInputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    properties: {
      action_kind: { type: "string", enum: ["inventory_transfer"] },
      direction: { type: "string", enum: ["deposit", "withdraw"] },
      item_id: { type: "string", minLength: 3, maxLength: 320 },
      count: { type: "integer", minimum: 1, maximum: 2_304 },
      container_target: {
        type: "string",
        enum: ["current_open_container", "looked_at_container"],
      },
    },
    required: [
      "action_kind",
      "direction",
      "item_id",
      "count",
      "container_target",
    ],
    additionalProperties: false,
  };

const exactObjectSchema = (
  properties: Record<string, HelixEnvironmentConstrainedJsonSchema>,
  required: string[],
  description?: string,
): HelixEnvironmentConstrainedJsonSchema => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  required,
  additionalProperties: false,
});

const literalStringSchema = (
  value: string,
): HelixEnvironmentConstrainedJsonSchema => ({
  type: "string",
  enum: [value],
});

const minecraftFluidConditionInputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    description:
      "One exact client-observable Minecraft-state condition selected by condition_kind. These conditions do not detect keyboard, mouse, screen, or other manual input; native connector manual-override handling already enforces the authority policy and releases controls, so do not invent a condition-based manual-input interrupt. Every alternative has its own required fields and rejects fields from other condition kinds.",
    oneOf: [
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("tick_at_least"),
          tick_index: { type: "integer", minimum: 0, maximum: 36_000 },
        },
        ["condition_kind", "tick_index"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("player_grounded"),
          expected: { type: "boolean" },
        },
        ["condition_kind", "expected"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("health_at_least"),
          health: { type: "number", minimum: 0, maximum: 20 },
        },
        ["condition_kind", "health"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("air_at_least"),
          air: { type: "integer", minimum: 0, maximum: 300 },
        },
        ["condition_kind", "air"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("submerged_is"),
          expected: { type: "boolean" },
        },
        ["condition_kind", "expected"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("swimming_is"),
          expected: { type: "boolean" },
        },
        ["condition_kind", "expected"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("on_fire_is"),
          expected: { type: "boolean" },
        },
        ["condition_kind", "expected"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("in_lava_is"),
          expected: { type: "boolean" },
        },
        ["condition_kind", "expected"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("food_at_least"),
          food: { type: "integer", minimum: 0, maximum: 20 },
        },
        ["condition_kind", "food"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("position_within"),
          position: minecraftPositionSchema,
          radius: { type: "number", minimum: 0.01, maximum: 64 },
        },
        ["condition_kind", "position", "radius"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("inventory_count_at_least"),
          item_id: { type: "string", minLength: 1, maxLength: 320 },
          count: { type: "integer", minimum: 0, maximum: 2_304 },
        },
        ["condition_kind", "item_id", "count"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("block_matches"),
          position: minecraftBlockPositionSchema,
          block_id: { type: "string", minLength: 1, maxLength: 320 },
        },
        ["condition_kind", "position", "block_id"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("focus_kind_is"),
          focus_kind: { type: "string", enum: ["miss", "block", "entity"] },
        },
        ["condition_kind", "focus_kind"],
        "Tests the current Minecraft crosshair hit-result kind only. miss means the crosshair currently hits neither a block nor an entity and is normal while looking into open air; it is not evidence of manual input or manual override.",
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("focus_reachable"),
          expected: { type: "boolean" },
          max_distance: { type: "number", minimum: 0.01, maximum: 6 },
        },
        ["condition_kind", "expected", "max_distance"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("vertical_velocity_at_most"),
          velocity_y: { type: "number", minimum: -16, maximum: 16 },
        },
        ["condition_kind", "velocity_y"],
        "Tests measured client delta-y, not grounded state. A grounded vanilla player may retain a small negative value near -0.0784, so a near-zero negative threshold can fire without a real fall. For airborne descent, first require player_grounded false or use a materially lower threshold supported by current evidence, such as -0.25.",
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("predicted_collision_within"),
          max_ticks: { type: "integer", minimum: 1, maximum: 20 },
          expected: { type: "boolean" },
        },
        ["condition_kind", "max_ticks", "expected"],
        "Tests the short-horizon collision forecast. Ground contact is excluded from future-collision evidence, but true alone still does not prove dangerous descent. Gate landing-sensitive work behind measured airborne/downward state before entering an action that acquires shared resources.",
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("placement_reachable_within"),
          position: minecraftBlockPositionSchema,
          horizon_ticks: { type: "integer", minimum: 1, maximum: 20 },
          expected: { type: "boolean" },
        },
        ["condition_kind", "position", "horizon_ticks", "expected"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("dimension_is"),
          dimension: { type: "string", minLength: 3, maxLength: 320 },
        },
        ["condition_kind", "dimension"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("equipment_item_is"),
          destination: {
            type: "string",
            enum: ["main_hand", "off_hand", "head", "chest", "legs", "feet"],
          },
          item_id: { type: "string", minLength: 1, maxLength: 320 },
        },
        ["condition_kind", "destination", "item_id"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("portal_nearby"),
          portal_kind: {
            type: "string",
            enum: ["nether_portal", "end_portal", "end_gateway"],
          },
          radius: { type: "integer", minimum: 1, maximum: 8 },
          expected: { type: "boolean" },
        },
        ["condition_kind", "portal_kind", "radius", "expected"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("hazard_clear"),
          hazard_kinds: {
            type: "array",
            minItems: 1,
            maxItems: 7,
            items: {
              type: "string",
              enum: [
                "lava",
                "fire",
                "magma",
                "cactus",
                "powder_snow",
                "hostile",
                "void_fall",
              ],
            },
          },
          radius: { type: "integer", minimum: 1, maximum: 8 },
        },
        ["condition_kind", "hazard_kinds", "radius"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("recipe_craftable"),
          output_item_id: { type: "string", minLength: 3, maxLength: 320 },
          expected: { type: "boolean" },
        },
        ["condition_kind", "output_item_id", "expected"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("node_outcome_is"),
          node_id: { type: "string", minLength: 1, maxLength: 160 },
          outcome: {
            type: "string",
            enum: ["succeeded", "failed", "timed_out", "canceled"],
          },
        },
        ["condition_kind", "node_id", "outcome"],
      ),
      exactObjectSchema(
        {
          condition_kind: literalStringSchema("checkpoint_satisfied"),
          checkpoint_id: { type: "string", minLength: 1, maxLength: 160 },
        },
        ["condition_kind", "checkpoint_id"],
      ),
    ],
  };

const minecraftFluidEmbeddedActionInputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    description:
      "One exact typed Player Embodiment action selected by action_kind. Each alternative advertises only fields accepted by the trusted action parser; programs cannot nest other programs.",
    oneOf: [
      exactObjectSchema(
        {
          action_kind: literalStringSchema("navigate_to"),
          destination: minecraftPositionSchema,
          arrival_radius: { type: "number", minimum: 0.25, maximum: 16 },
          allow_sprint: { type: "boolean" },
          allow_dig: { type: "boolean", enum: [false] },
          allow_place: { type: "boolean", enum: [false] },
          engine_preference: {
            type: "string",
            enum: ["adapter_selected", "native_fabric", "baritone"],
          },
        },
        [
          "action_kind",
          "destination",
          "arrival_radius",
          "allow_sprint",
          "allow_dig",
          "allow_place",
          "engine_preference",
        ],
      ),
      exactObjectSchema(
        {
          action_kind: literalStringSchema("look_at"),
          target: {
            type: "object",
            oneOf: [
              exactObjectSchema(
                {
                  target_kind: literalStringSchema("position"),
                  position: minecraftPositionSchema,
                },
                ["target_kind", "position"],
              ),
              exactObjectSchema(
                {
                  target_kind: literalStringSchema("current_focus"),
                },
                ["target_kind"],
              ),
              exactObjectSchema(
                {
                  target_kind: literalStringSchema("relative_rotation"),
                  yaw_delta_degrees: {
                    type: "number",
                    minimum: -180,
                    maximum: 180,
                  },
                  pitch_delta_degrees: {
                    type: "number",
                    minimum: -180,
                    maximum: 180,
                  },
                },
                ["target_kind", "yaw_delta_degrees", "pitch_delta_degrees"],
              ),
              exactObjectSchema(
                {
                  target_kind: literalStringSchema("environment_subject"),
                  subject_ref: { type: "string", minLength: 1, maxLength: 320 },
                },
                ["target_kind", "subject_ref"],
              ),
            ],
          },
          max_turn_degrees_per_tick: {
            type: "number",
            minimum: 0.1,
            maximum: 180,
          },
        },
        ["action_kind", "target", "max_turn_degrees_per_tick"],
      ),
      exactObjectSchema(
        {
          action_kind: literalStringSchema("track_target"),
          target: {
            type: "object",
            oneOf: [
              exactObjectSchema(
                {
                  target_kind: literalStringSchema("entity_type"),
                  entity_type_id: {
                    type: "string",
                    minLength: 3,
                    maxLength: 320,
                  },
                  selection: { type: "string", enum: ["nearest"] },
                },
                ["target_kind", "entity_type_id", "selection"],
              ),
              exactObjectSchema(
                {
                  target_kind: literalStringSchema("current_focus_entity"),
                },
                ["target_kind"],
              ),
              exactObjectSchema(
                {
                  target_kind: literalStringSchema("particle_type"),
                  particle_type_id: {
                    type: "string",
                    minLength: 3,
                    maxLength: 320,
                  },
                  selection: { type: "string", enum: ["nearest"] },
                  continuity: {
                    type: "string",
                    enum: ["single_instance", "same_type_stream"],
                  },
                  handoff_radius: { type: "number", minimum: 0, maximum: 8 },
                  max_handoffs: { type: "integer", minimum: 0, maximum: 1_000 },
                },
                [
                  "target_kind",
                  "particle_type_id",
                  "selection",
                  "continuity",
                  "handoff_radius",
                  "max_handoffs",
                ],
              ),
            ],
          },
          aim_point: {
            type: "string",
            enum: ["center", "render_center", "eyes", "feet"],
          },
          max_acquisition_distance: {
            type: "number",
            minimum: 1,
            maximum: 128,
          },
          max_duration_ms: {
            type: "integer",
            minimum: 1_000,
            maximum: 5 * 60_000,
          },
          max_turn_degrees_per_tick: {
            type: "number",
            minimum: 0.1,
            maximum: 180,
          },
          max_angular_acceleration_degrees_per_tick_squared: {
            type: "number",
            minimum: 0.01,
            maximum: 180,
          },
          prediction_ticks: { type: "integer", minimum: 0, maximum: 10 },
          deadband_degrees: { type: "number", minimum: 0, maximum: 10 },
          reacquire_ticks: { type: "integer", minimum: 0, maximum: 200 },
          require_line_of_sight: { type: "boolean" },
          stop_below_health: { type: "number", minimum: 1, maximum: 20 },
        },
        [
          "action_kind",
          "target",
          "aim_point",
          "max_acquisition_distance",
          "max_duration_ms",
          "max_turn_degrees_per_tick",
          "max_angular_acceleration_degrees_per_tick_squared",
          "prediction_ticks",
          "deadband_degrees",
          "reacquire_ticks",
          "require_line_of_sight",
          "stop_below_health",
        ],
      ),
      exactObjectSchema(
        {
          action_kind: literalStringSchema("walk"),
          direction: {
            type: "string",
            enum: ["forward", "back", "left", "right"],
          },
          duration_ms: {
            type: "integer",
            minimum: 50,
            maximum: 10_000,
            description:
              "Bounded input duration. Inside the native 20 Hz reactive scheduler this normally occupies ceil(duration_ms / 50) ticks; coordinate observer wait windows with that causal duration.",
          },
          sprint: { type: "boolean" },
          jump: {
            type: "boolean",
            description:
              "When true, hold jump during the same bounded locomotion interval.",
          },
        },
        ["action_kind", "direction", "duration_ms", "sprint"],
      ),
      exactObjectSchema(
        {
          action_kind: literalStringSchema("jump"),
          count: { type: "integer", minimum: 1, maximum: 10 },
        },
        ["action_kind", "count"],
      ),
      exactObjectSchema(
        {
          action_kind: literalStringSchema("interact"),
          target: {
            type: "string",
            enum: ["current_focus", "looked_at_block", "looked_at_entity"],
          },
          hand: { type: "string", enum: ["main_hand", "off_hand"] },
          interaction: { type: "string", enum: ["use", "interact"] },
        },
        ["action_kind", "target", "hand", "interaction"],
      ),
      exactObjectSchema(
        {
          action_kind: literalStringSchema("hotbar_select"),
          slot: { type: "integer", minimum: 0, maximum: 8 },
        },
        ["action_kind", "slot"],
      ),
      exactObjectSchema(
        {
          action_kind: literalStringSchema("equip"),
          item_id: { type: "string", minLength: 1, maxLength: 320 },
          destination: {
            type: "string",
            enum: ["main_hand", "off_hand", "head", "chest", "legs", "feet"],
          },
        },
        ["action_kind", "item_id", "destination"],
        "Equip may search and move an item between inventory, hotbar, either hand, or an armor slot. Its lane resource_ceiling must include hotbar, main_hand, off_hand, and inventory regardless of destination.",
      ),
      exactObjectSchema(
        {
          action_kind: literalStringSchema("follow"),
          subject_ref: { type: "string", minLength: 1, maxLength: 320 },
          distance: { type: "number", minimum: 1, maximum: 64 },
          max_duration_ms: {
            type: "integer",
            minimum: 1_000,
            maximum: 30 * 60_000,
          },
          stop_below_health: { type: "number", minimum: 1, maximum: 20 },
        },
        [
          "action_kind",
          "subject_ref",
          "distance",
          "max_duration_ms",
          "stop_below_health",
        ],
      ),
      exactObjectSchema(
        {
          action_kind: literalStringSchema("collect"),
          item_or_block_id: { type: "string", minLength: 1, maxLength: 320 },
          count: { type: "integer", minimum: 1, maximum: 2_304 },
          search_radius: { type: "number", minimum: 0.01, maximum: 128 },
        },
        ["action_kind", "item_or_block_id", "count", "search_radius"],
      ),
      exactObjectSchema(
        {
          action_kind: literalStringSchema("mine"),
          block_id: { type: "string", minLength: 1, maxLength: 320 },
          count: { type: "integer", minimum: 1, maximum: 4_096 },
          search_radius: { type: "integer", minimum: 1, maximum: 32 },
          target_position: minecraftBlockPositionSchema,
        },
        ["action_kind", "block_id", "count", "search_radius"],
      ),
      exactObjectSchema(
        {
          action_kind: literalStringSchema("place"),
          block_id: { type: "string", minLength: 1, maxLength: 320 },
          positions: {
            type: "array",
            minItems: 1,
            maxItems: 256,
            items: minecraftBlockPositionSchema,
          },
          placement_method: {
            type: "string",
            enum: ["block_item", "item_use"],
            description:
              "Use item_use for fluid buckets and include source_item_id plus hand. Omit these two fields for ordinary block_item placement.",
          },
          source_item_id: {
            type: "string",
            minLength: 1,
            maxLength: 320,
            description:
              "Required with item_use; for a water source use minecraft:water_bucket.",
          },
          hand: {
            type: "string",
            enum: ["main_hand", "off_hand"],
            description:
              "Required with item_use and identifies the source-item hand.",
          },
        },
        ["action_kind", "block_id", "positions"],
        "Exact typed placement. A water-bucket rescue may instead use the separate predicted_collision_cell alternative when the landing cell must be resolved from live trajectory.",
      ),
      exactObjectSchema(
        {
          action_kind: literalStringSchema("place"),
          block_id: { type: "string", minLength: 1, maxLength: 320 },
          position_binding: {
            type: "object",
            properties: {
              binding_kind: literalStringSchema("predicted_collision_cell"),
              horizon_ticks: { type: "integer", minimum: 1, maximum: 20 },
              max_distance_blocks: {
                type: "number",
                minimum: 0.01,
                maximum: 6,
              },
              require_replaceable: { type: "boolean", enum: [true] },
            },
            required: [
              "binding_kind",
              "horizon_ticks",
              "max_distance_blocks",
              "require_replaceable",
            ],
            additionalProperties: false,
          },
          placement_method: {
            type: "string",
            enum: ["block_item", "item_use"],
          },
          source_item_id: { type: "string", minLength: 1, maxLength: 320 },
          hand: { type: "string", enum: ["main_hand", "off_hand"] },
          cleanup_after_landing: { type: "boolean", enum: [true] },
        },
        ["action_kind", "block_id", "position_binding"],
        "Bounded live placement. predicted_collision_cell resolves one exact replaceable landing cell from an already-applicable trajectory when this action executes; it neither moves the player nor creates a fall. Author required locomotion and measured state-transition events separately, wait for a real downward trajectory, then wait until predicted_collision_within is true before executing place. A focus check is not trajectory evidence.",
      ),
      exactObjectSchema(
        {
          action_kind: literalStringSchema("craft"),
          output_item_id: { type: "string", minLength: 1, maxLength: 320 },
          count: { type: "integer", minimum: 1, maximum: 2_304 },
          recipe_id: { type: "string", minLength: 1, maxLength: 320 },
        },
        ["action_kind", "output_item_id", "count"],
      ),
      minecraftConsumeInputSchema,
      exactObjectSchema(
        {
          action_kind: literalStringSchema("inventory_transfer"),
          direction: { type: "string", enum: ["deposit", "withdraw"] },
          item_id: { type: "string", minLength: 1, maxLength: 320 },
          count: { type: "integer", minimum: 1, maximum: 2_304 },
          container_target: {
            type: "string",
            enum: ["current_open_container", "looked_at_container"],
          },
        },
        ["action_kind", "direction", "item_id", "count", "container_target"],
      ),
    ],
  };

const minecraftReactiveEmbeddedActionInputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    ...minecraftFluidEmbeddedActionInputSchema,
    description:
      "One exact typed Player Embodiment action selected by action_kind. Reactive programs additionally admit bounded hostile-only attack and combat-guard actions when mutation_scope.combat_allowed is true; programs cannot nest other programs.",
    oneOf: [
      ...(minecraftFluidEmbeddedActionInputSchema.oneOf ?? []),
      minecraftCombatAttackInputSchema,
      minecraftCombatGuardInputSchema,
    ],
  };

const minecraftFluidSequenceInputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    description:
      "A bounded acyclic tick-local Player Embodiment program authored by Codex and executed by the Fabric client. Helix admits identity, ruleset, lease, and effect ceilings; it does not invent the program.",
    properties: {
      action_kind: { type: "string", enum: ["execute_sequence"] },
      sequence_schema: {
        type: "string",
        enum: [HELIX_MINECRAFT_PLAYER_SEQUENCE_SCHEMA],
      },
      sequence_id: { type: "string", minLength: 1, maxLength: 160 },
      ruleset: { type: "string", enum: ["survival_tas"] },
      execution_plane: { type: "string", enum: ["player_embodiment"] },
      scheduler_engine: { type: "string", enum: ["native_fabric"] },
      optimization: {
        type: "object",
        properties: {
          primary: { type: "string", enum: ["minimize_world_ticks"] },
          record_wall_clock: { type: "boolean", enum: [true] },
          stop_on_first_verified_success: { type: "boolean", enum: [true] },
        },
        required: [
          "primary",
          "record_wall_clock",
          "stop_on_first_verified_success",
        ],
        additionalProperties: false,
      },
      start_node_id: { type: "string", minLength: 1, maxLength: 160 },
      max_total_ticks: { type: "integer", minimum: 1, maximum: 36_000 },
      required_checkpoint_ids: {
        type: "array",
        description:
          "Each value must equal the checkpoint_id field of a reachable checkpoint node exactly; values are not node_id references or descriptive labels.",
        maxItems: 64,
        items: { type: "string", minLength: 1, maxLength: 160 },
      },
      mutation_scope: {
        type: "object",
        properties: {
          world_mutation_allowed: { type: "boolean" },
          max_block_mutations: {
            type: "integer",
            minimum: 0,
            maximum: 100_000,
          },
          max_inventory_transfers: {
            type: "integer",
            minimum: 0,
            maximum: 10_000,
          },
          allowed_block_ids: {
            type: "array",
            maxItems: 64,
            items: { type: "string", minLength: 1, maxLength: 320 },
          },
          allowed_regions: {
            type: "array",
            maxItems: 16,
            items: {
              type: "object",
              properties: {
                min: minecraftBlockPositionSchema,
                max: minecraftBlockPositionSchema,
              },
              required: ["min", "max"],
              additionalProperties: false,
            },
          },
          combat_allowed: { type: "boolean", enum: [false] },
        },
        required: [
          "world_mutation_allowed",
          "max_block_mutations",
          "max_inventory_transfers",
          "allowed_block_ids",
          "allowed_regions",
          "combat_allowed",
        ],
        additionalProperties: false,
      },
      nodes: {
        type: "array",
        minItems: 2,
        maxItems: 256,
        items: {
          type: "object",
          description:
            "node_kind selects the required node fields. References must form a reachable acyclic graph and terminate in a typed success or failure node.",
          properties: {
            node_id: { type: "string", minLength: 1, maxLength: 160 },
            node_kind: {
              type: "string",
              enum: [
                "input_segment",
                "workflow_action",
                "checkpoint",
                "branch",
                "terminal",
              ],
            },
            earliest_tick: { type: "integer", minimum: 0, maximum: 36_000 },
            duration_ticks: { type: "integer", minimum: 1, maximum: 1_200 },
            controls: {
              type: "object",
              properties: {
                forward: { type: "integer", enum: [-1, 0, 1] },
                strafe: { type: "integer", enum: [-1, 0, 1] },
                sprint: { type: "boolean" },
                sneak: { type: "boolean", enum: [false] },
                jump: { type: "string", enum: ["idle", "pulse", "hold"] },
                use: { type: "string", enum: ["idle", "pulse"] },
                hotbar_slot: { type: "integer", minimum: 0, maximum: 8 },
                look_delta: {
                  type: "object",
                  properties: {
                    yaw_degrees: {
                      type: "number",
                      minimum: -360,
                      maximum: 360,
                    },
                    pitch_degrees: {
                      type: "number",
                      minimum: -180,
                      maximum: 180,
                    },
                    max_degrees_per_tick: {
                      type: "number",
                      minimum: 0.1,
                      maximum: 180,
                    },
                  },
                  required: [
                    "yaw_degrees",
                    "pitch_degrees",
                    "max_degrees_per_tick",
                  ],
                  additionalProperties: false,
                },
              },
              required: ["forward", "strafe", "sprint", "sneak", "jump", "use"],
              additionalProperties: false,
            },
            timeout_ticks: { type: "integer", minimum: 1, maximum: 36_000 },
            action: minecraftFluidEmbeddedActionInputSchema,
            checkpoint_id: { type: "string", minLength: 1, maxLength: 160 },
            condition: minecraftFluidConditionInputSchema,
            wait_up_to_ticks: { type: "integer", minimum: 0, maximum: 36_000 },
            on_complete: { type: "string", minLength: 1, maxLength: 160 },
            on_failure: { type: "string", minLength: 1, maxLength: 160 },
            on_success: { type: "string", minLength: 1, maxLength: 160 },
            on_satisfied: { type: "string", minLength: 1, maxLength: 160 },
            on_timeout: { type: "string", minLength: 1, maxLength: 160 },
            on_true: { type: "string", minLength: 1, maxLength: 160 },
            on_false: { type: "string", minLength: 1, maxLength: 160 },
            terminal_outcome: { type: "string", enum: ["succeeded", "failed"] },
            reason_code: { type: "string", minLength: 1, maxLength: 160 },
          },
          required: ["node_id", "node_kind"],
          additionalProperties: false,
        },
      },
    },
    required: [
      "action_kind",
      "sequence_schema",
      "sequence_id",
      "ruleset",
      "execution_plane",
      "scheduler_engine",
      "optimization",
      "start_node_id",
      "max_total_ticks",
      "required_checkpoint_ids",
      "mutation_scope",
      "nodes",
    ],
    additionalProperties: false,
  };

const minecraftReactiveProgramInputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    description:
      "Codex-authored concurrent graph. Read geometry/actor state first when timing or placement depends on it. Put a time-sensitive initiator and observer/reaction in separate immediate lanes; serial reaction can miss it. Node waits/timeouts begin on entry. Under all_required, a failed, timed-out, or canceled required lane terminates the program; every required lane must use activation immediate. reactive conditions describe Minecraft state, not manual input. Mutation ceilings include cleanup/retry.",
    properties: {
      action_kind: { type: "string", enum: ["execute_reactive_program"] },
      program_schema: {
        type: "string",
        enum: [HELIX_MINECRAFT_REACTIVE_PROGRAM_SCHEMA],
      },
      program_id: { type: "string", minLength: 1, maxLength: 160 },
      ruleset: { type: "string", enum: ["survival_tas"] },
      execution_plane: { type: "string", enum: ["player_embodiment"] },
      scheduler_engine: { type: "string", enum: ["native_fabric_concurrent"] },
      resident_guardian_coverage: {
        type: "array",
        maxItems: 2,
        items: {
          type: "string",
          enum: ["unsafe_landing_recovery", "fire_recovery"],
        },
        description:
          "Optional narrowly validated declaration that this already-admitted local program handles one resident-guardian invariant. unsafe_landing_recovery requires a predicted-collision water-bucket rescue with cleanup and mutation ceilings; fire_recovery requires a matched fire-or-lava onset/clearance pair, bounded locomotion, and an independent health-floor interrupt. A declaration does not expand authority.",
      },
      max_total_ticks: { type: "integer", minimum: 1, maximum: 36_000 },
      completion_policy: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["all_required", "first_success"],
            description:
              "all_required waits only for lanes with required true, and any required lane that fails, times out, or reaches a canceled terminal fails the program and cancels unfinished work. Interrupt-only lanes must be required false and do not delay normal completion unless an interrupt activates them.",
          },
          cancel_remaining_on_settle: { type: "boolean", enum: [true] },
        },
        required: ["mode", "cancel_remaining_on_settle"],
        additionalProperties: false,
      },
      mutation_scope: {
        type: "object",
        properties: {
          world_mutation_allowed: { type: "boolean" },
          max_block_mutations: {
            type: "integer",
            minimum: 0,
            maximum: 100_000,
            description:
              "A conservative ceiling covering every mine/place position or count multiplied by its maximum repeat/maintain iterations.",
          },
          max_inventory_transfers: {
            type: "integer",
            minimum: 0,
            maximum: 10_000,
            description:
              "A conservative ceiling covering every equip plus every mine/place/collect/craft/transfer count, multiplied by maximum repeat or maintain iterations. Item-use placement counts once per exact position because the held item transitions, for example water_bucket to bucket.",
          },
          allowed_block_ids: {
            type: "array",
            maxItems: 64,
            items: { type: "string", minLength: 1, maxLength: 320 },
          },
          allowed_regions: {
            type: "array",
            maxItems: 16,
            items: {
              type: "object",
              properties: {
                min: minecraftBlockPositionSchema,
                max: minecraftBlockPositionSchema,
              },
              required: ["min", "max"],
              additionalProperties: false,
            },
          },
          combat_allowed: { type: "boolean" },
        },
        required: [
          "world_mutation_allowed",
          "max_block_mutations",
          "max_inventory_transfers",
          "allowed_block_ids",
          "allowed_regions",
          "combat_allowed",
        ],
        additionalProperties: false,
      },
      lanes: {
        type: "array",
        description:
          "Model causal concurrency explicitly. If a downstream condition cannot become true from the current state by itself, another immediate lane must perform the bounded action that makes it true. Node wait windows start on node entry and must leave enough ticks for that causal action. Camera and observation work do not create locomotion, interaction, or mutation.",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          description:
            "One independently scheduled lane. Set required true only with activation immediate. Set required false with activation interrupt_only for a dormant lane that an interrupt may activate. Never repair an interrupt lane by changing it to immediate; repair its required flag instead.",
          properties: {
            lane_id: { type: "string", minLength: 1, maxLength: 160 },
            lane_kind: {
              type: "string",
              enum: [...HELIX_MINECRAFT_REACTIVE_LANE_KINDS],
            },
            priority: { type: "integer", minimum: 0, maximum: 255 },
            required: {
              type: "boolean",
              description:
                "Whether normal program completion must wait for this lane. Must be true for required immediate work and false for every interrupt_only lane.",
            },
            activation: {
              type: "string",
              enum: ["immediate", "interrupt_only"],
              description:
                "immediate starts with the program and is required when its completion is mandatory. interrupt_only stays dormant until named by an interrupt and therefore requires required false.",
            },
            resource_ceiling: {
              type: "array",
              maxItems: 9,
              items: {
                type: "string",
                enum: [...HELIX_MINECRAFT_REACTIVE_RESOURCES],
              },
              description:
                "Declare every resource any node in this lane may acquire. equip requires hotbar, main_hand, off_hand, and inventory. Embedded place with block_item or main-hand item_use requires camera, locomotion, hotbar, main_hand, inventory, world, and native_workflow; off-hand item_use uses off_hand instead of hotbar plus main_hand. This is a permission ceiling, not an instruction to use every resource continuously.",
            },
            start_node_id: { type: "string", minLength: 1, maxLength: 160 },
            nodes: {
              type: "array",
              minItems: 1,
              maxItems: 128,
              items: {
                type: "object",
                description:
                  "An exact node_kind alternative. The model-visible fields and required transitions match the trusted reactive-program parser.",
                oneOf: [
                  exactObjectSchema(
                    {
                      node_id: { type: "string", minLength: 1, maxLength: 160 },
                      node_kind: literalStringSchema("action"),
                      earliest_tick: {
                        type: "integer",
                        minimum: 0,
                        maximum: 36_000,
                      },
                      timeout_ticks: {
                        type: "integer",
                        minimum: 1,
                        maximum: 36_000,
                      },
                      action: minecraftReactiveEmbeddedActionInputSchema,
                      on_success: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                      on_failure: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                      on_timeout: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                    },
                    [
                      "node_id",
                      "node_kind",
                      "earliest_tick",
                      "timeout_ticks",
                      "action",
                      "on_success",
                      "on_failure",
                      "on_timeout",
                    ],
                  ),
                  exactObjectSchema(
                    {
                      node_id: { type: "string", minLength: 1, maxLength: 160 },
                      node_kind: literalStringSchema("repeat"),
                      earliest_tick: {
                        type: "integer",
                        minimum: 0,
                        maximum: 36_000,
                      },
                      action: minecraftReactiveEmbeddedActionInputSchema,
                      max_iterations: {
                        type: "integer",
                        minimum: 1,
                        maximum: 256,
                      },
                      timeout_ticks: {
                        type: "integer",
                        minimum: 1,
                        maximum: 36_000,
                      },
                      until_condition: minecraftFluidConditionInputSchema,
                      on_complete: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                      on_failure: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                      on_timeout: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                    },
                    [
                      "node_id",
                      "node_kind",
                      "earliest_tick",
                      "action",
                      "max_iterations",
                      "timeout_ticks",
                      "on_complete",
                      "on_failure",
                      "on_timeout",
                    ],
                  ),
                  exactObjectSchema(
                    {
                      node_id: { type: "string", minLength: 1, maxLength: 160 },
                      node_kind: literalStringSchema("maintain"),
                      earliest_tick: {
                        type: "integer",
                        minimum: 0,
                        maximum: 36_000,
                      },
                      action: minecraftReactiveEmbeddedActionInputSchema,
                      while_condition: minecraftFluidConditionInputSchema,
                      max_restarts: {
                        type: "integer",
                        minimum: 0,
                        maximum: 256,
                      },
                      max_duration_ticks: {
                        type: "integer",
                        minimum: 1,
                        maximum: 36_000,
                      },
                      on_condition_false: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                      on_failure: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                      on_timeout: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                    },
                    [
                      "node_id",
                      "node_kind",
                      "earliest_tick",
                      "action",
                      "while_condition",
                      "max_restarts",
                      "max_duration_ticks",
                      "on_condition_false",
                      "on_failure",
                      "on_timeout",
                    ],
                  ),
                  exactObjectSchema(
                    {
                      node_id: { type: "string", minLength: 1, maxLength: 160 },
                      node_kind: literalStringSchema("event"),
                      earliest_tick: {
                        type: "integer",
                        minimum: 0,
                        maximum: 36_000,
                      },
                      condition: minecraftFluidConditionInputSchema,
                      trigger_when: {
                        type: "string",
                        enum: ["satisfied", "not_satisfied"],
                      },
                      debounce_ticks: {
                        type: "integer",
                        minimum: 1,
                        maximum: 200,
                      },
                      wait_up_to_ticks: {
                        type: "integer",
                        minimum: 0,
                        maximum: 36_000,
                      },
                      on_event: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                      on_timeout: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                    },
                    [
                      "node_id",
                      "node_kind",
                      "earliest_tick",
                      "condition",
                      "trigger_when",
                      "debounce_ticks",
                      "wait_up_to_ticks",
                      "on_event",
                      "on_timeout",
                    ],
                  ),
                  exactObjectSchema(
                    {
                      node_id: { type: "string", minLength: 1, maxLength: 160 },
                      node_kind: literalStringSchema("checkpoint"),
                      earliest_tick: {
                        type: "integer",
                        minimum: 0,
                        maximum: 36_000,
                      },
                      checkpoint_id: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                      condition: minecraftFluidConditionInputSchema,
                      wait_up_to_ticks: {
                        type: "integer",
                        minimum: 0,
                        maximum: 36_000,
                      },
                      on_satisfied: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                      on_timeout: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                    },
                    [
                      "node_id",
                      "node_kind",
                      "earliest_tick",
                      "checkpoint_id",
                      "condition",
                      "wait_up_to_ticks",
                      "on_satisfied",
                      "on_timeout",
                    ],
                  ),
                  exactObjectSchema(
                    {
                      node_id: { type: "string", minLength: 1, maxLength: 160 },
                      node_kind: literalStringSchema("branch"),
                      earliest_tick: {
                        type: "integer",
                        minimum: 0,
                        maximum: 36_000,
                      },
                      condition: minecraftFluidConditionInputSchema,
                      on_true: { type: "string", minLength: 1, maxLength: 160 },
                      on_false: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                    },
                    [
                      "node_id",
                      "node_kind",
                      "earliest_tick",
                      "condition",
                      "on_true",
                      "on_false",
                    ],
                  ),
                  exactObjectSchema(
                    {
                      node_id: { type: "string", minLength: 1, maxLength: 160 },
                      node_kind: literalStringSchema("terminal"),
                      terminal_outcome: {
                        type: "string",
                        enum: ["succeeded", "failed", "canceled"],
                      },
                      reason_code: {
                        type: "string",
                        minLength: 1,
                        maxLength: 160,
                      },
                    },
                    ["node_id", "node_kind", "terminal_outcome", "reason_code"],
                  ),
                ],
              },
            },
          },
          required: [
            "lane_id",
            "lane_kind",
            "priority",
            "required",
            "activation",
            "resource_ceiling",
            "start_node_id",
            "nodes",
          ],
          additionalProperties: false,
        },
      },
      races: {
        type: "array",
        description:
          "Optional competing alternatives only. A settled race cancels every losing member. Leave this empty when concurrent required lanes must all complete.",
        maxItems: 8,
        items: {
          type: "object",
          description:
            "A competition among alternative lanes, never a synchronization group. With cancel_remaining true, the first qualifying member cancels the other members.",
          properties: {
            race_id: { type: "string", minLength: 1, maxLength: 160 },
            lane_ids: {
              type: "array",
              minItems: 2,
              maxItems: 8,
              items: { type: "string", minLength: 1, maxLength: 160 },
            },
            settle_on: {
              type: "string",
              enum: ["first_succeeded", "first_terminal"],
            },
            cancel_remaining: { type: "boolean", enum: [true] },
          },
          required: ["race_id", "lane_ids", "settle_on", "cancel_remaining"],
          additionalProperties: false,
        },
      },
      interrupts: {
        type: "array",
        description:
          "One-shot triggers for admitted Minecraft-state conditions only. Each activate_lane_id must name a required false, interrupt_only lane; never target the required immediate lane. Abort guards end failed/canceled; recovery lanes succeed only after verified postconditions. Manual control and open screens are enforced outside the program. Never add a manual-control interrupt: manual_override_detected is not admitted, and no world-state or checkpoint condition may stand in.",
        maxItems: 16,
        items: {
          type: "object",
          properties: {
            interrupt_id: { type: "string", minLength: 1, maxLength: 160 },
            priority: { type: "integer", minimum: 0, maximum: 255 },
            condition: minecraftFluidConditionInputSchema,
            trigger_when: {
              type: "string",
              enum: ["satisfied", "not_satisfied"],
            },
            debounce_ticks: { type: "integer", minimum: 1, maximum: 200 },
            activate_lane_id: {
              type: "string",
              minLength: 1,
              maxLength: 160,
              description:
                "Exact ID of a lane whose activation is interrupt_only and whose required field is false.",
            },
            cancel_lane_ids: {
              type: "array",
              maxItems: 8,
              items: { type: "string", minLength: 1, maxLength: 160 },
            },
            max_activations: { type: "integer", enum: [1] },
          },
          required: [
            "interrupt_id",
            "priority",
            "condition",
            "trigger_when",
            "debounce_ticks",
            "activate_lane_id",
            "cancel_lane_ids",
            "max_activations",
          ],
          additionalProperties: false,
        },
      },
    },
    required: [
      "action_kind",
      "program_schema",
      "program_id",
      "ruleset",
      "execution_plane",
      "scheduler_engine",
      "max_total_ticks",
      "completion_policy",
      "mutation_scope",
      "lanes",
      "races",
      "interrupts",
    ],
    additionalProperties: false,
  };

const minecraftArmViabilityGuardianInputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    description:
      "Arm the deterministic Minecraft-specific resident guardian across action boundaries for a bounded lease. It may swim upward for low-air submersion, release controls, or request semantic replanning. It cannot invent actions, mutate the world, call a model, or expand authority.",
    properties: {
      action_kind: { type: "string", enum: ["arm_viability_guardian"] },
      profile_id: {
        type: "string",
        enum: [HELIX_MINECRAFT_VIABILITY_GUARDIAN_PROFILE_ID],
      },
      duration_ticks: { type: "integer", minimum: 200, maximum: 36_000 },
      minimum_air: { type: "integer", minimum: 1, maximum: 300 },
      dangerous_vertical_velocity: {
        type: "number",
        minimum: -16,
        maximum: -0.01,
      },
      maximum_swim_ticks: { type: "integer", minimum: 1, maximum: 1_200 },
      maximum_observation_age_ticks: {
        type: "integer",
        minimum: 0,
        maximum: 20,
      },
      response_repertoire: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          type: "string",
          enum: ["swim_up", "release_controls", "request_semantic_replan"],
        },
      },
    },
    required: [
      "action_kind",
      "profile_id",
      "duration_ticks",
      "minimum_air",
      "dangerous_vertical_velocity",
      "maximum_swim_ticks",
      "maximum_observation_age_ticks",
      "response_repertoire",
    ],
    additionalProperties: false,
  };

const minecraftDisarmViabilityGuardianInputSchema: HelixEnvironmentConstrainedJsonSchema =
  {
    type: "object",
    description:
      "Disarm the exact deterministic resident guardian profile and release every guardian-owned control. This cannot arm another profile, mutate the world, or clear Emergency Stop.",
    properties: {
      action_kind: { type: "string", enum: ["disarm_viability_guardian"] },
      profile_id: {
        type: "string",
        enum: [HELIX_MINECRAFT_VIABILITY_GUARDIAN_PROFILE_ID],
      },
    },
    required: ["action_kind", "profile_id"],
    additionalProperties: false,
  };

const descriptors: HelixEnvironmentCapabilityDescriptor[] = [
  descriptor({
    capabilityId: HELIX_MINECRAFT_ACTOR_STATUS_READ_CAPABILITY,
    domain: "minecraft",
    adapterProfileIds: [HELIX_MINECRAFT_ADAPTER_PROFILE_ID],
    label: "Read current Minecraft actor status",
    description:
      "Read health, hunger, active effects, game mode, status flags, world, position, measured yaw/pitch, and an admitted allowlisted mod-mechanics state for the current bound Minecraft actor without changing the world.",
    inputSchema: semanticTargetSchema,
    outputSchema: minecraftActorStatusOutputSchema,
    freshnessCeilingMs: 120_000,
    timeoutCeilingMs: 30_000,
  }),
  descriptor({
    capabilityId: HELIX_MINECRAFT_INVENTORY_CHECK_CAPABILITY,
    domain: "minecraft",
    adapterProfileIds: [HELIX_MINECRAFT_ADAPTER_PROFILE_ID],
    label: "Check current Minecraft inventory",
    description:
      "Read the current bound Minecraft actor's inventory without executing commands or changing the world.",
    inputSchema: semanticTargetSchema,
    outputSchema: minecraftInventoryOutputSchema,
    freshnessCeilingMs: 120_000,
    timeoutCeilingMs: 30_000,
  }),
  descriptor({
    capabilityId: HELIX_MINECRAFT_NEARBY_ENTITIES_LIST_CAPABILITY,
    domain: "minecraft",
    adapterProfileIds: [HELIX_MINECRAFT_ADAPTER_PROFILE_ID],
    label: "List nearby Minecraft entities",
    description:
      "List a bounded set of nearby entities, classifications, distances, and whether a hostile mob is targeting the current bound actor.",
    inputSchema: semanticTargetSchema,
    outputSchema: minecraftNearbyEntitiesOutputSchema,
    freshnessCeilingMs: 120_000,
    timeoutCeilingMs: 30_000,
  }),
  descriptor({
    capabilityId: HELIX_MINECRAFT_HAZARDS_SCAN_CAPABILITY,
    domain: "minecraft",
    adapterProfileIds: [HELIX_MINECRAFT_ADAPTER_PROFILE_ID],
    label: "Scan immediate Minecraft hazards",
    description:
      "Count nearby hostile entities and bounded nearby hazardous blocks, including lava, fire, magma, campfires, cactus, powder snow, berry bushes, wither roses, and pointed dripstone, around the current bound actor.",
    inputSchema: semanticTargetSchema,
    outputSchema: minecraftHazardsOutputSchema,
    freshnessCeilingMs: 30_000,
    timeoutCeilingMs: 30_000,
  }),
  descriptor({
    capabilityId: HELIX_MINECRAFT_LOCAL_MAP_INSPECT_CAPABILITY,
    domain: "minecraft",
    adapterProfileIds: [HELIX_MINECRAFT_ADAPTER_PROFILE_ID],
    label: "Inspect the local Minecraft floor sample",
    description:
      "Inspect a bounded 9 by 9 floor sample around the current actor, including solid, open, liquid, and hazardous floor counts. This is local terrain evidence, not a route planner or complete map.",
    inputSchema: semanticTargetSchema,
    outputSchema: minecraftLocalMapOutputSchema,
    freshnessCeilingMs: 120_000,
    timeoutCeilingMs: 30_000,
  }),
  descriptor({
    capabilityId: HELIX_MINECRAFT_SPATIAL_REGION_INSPECT_CAPABILITY,
    capabilityVersion: 2,
    domain: "minecraft",
    adapterProfileIds: [HELIX_MINECRAFT_ADAPTER_PROFILE_ID],
    label: "Inspect a bounded Minecraft spatial region",
    description:
      "Read a compact, exact block-column survey around the current bound actor for structure, build, fireplace, or landing-safety planning, or verify an exact bounded post-action block footprint. Returns block palette, run-length encoded columns, semantic anchors, conservative fireplace candidates, non-authoritative safe straight-line build candidates, and exact material-match receipts without changing the world.",
    inputSchema: minecraftSpatialRegionInputSchema,
    outputSchema: minecraftSpatialRegionOutputSchema,
    freshnessCeilingMs: 30_000,
    timeoutCeilingMs: 30_000,
  }),
  descriptor({
    capabilityId: HELIX_MINECRAFT_LINE_OF_SIGHT_CHECK_CAPABILITY,
    domain: "minecraft",
    adapterProfileIds: [HELIX_MINECRAFT_ADAPTER_PROFILE_ID],
    label: "Check Minecraft line of sight",
    description:
      "Ray-trace from the current actor's eyes to a position in the same bound world without changing the world.",
    inputSchema: minecraftPositionTargetSchema,
    outputSchema: minecraftLineOfSightOutputSchema,
    freshnessCeilingMs: 30_000,
    timeoutCeilingMs: 30_000,
  }),
  descriptor({
    capabilityId: HELIX_MINECRAFT_CROP_STATE_READ_CAPABILITY,
    domain: "minecraft",
    adapterProfileIds: [HELIX_MINECRAFT_ADAPTER_PROFILE_ID],
    label: "Read Minecraft crop maturity",
    description:
      "Read whether the crop at the actor's current focus or an exact position is mature, without harvesting or opening anything.",
    inputSchema: minecraftCropTargetSchema,
    outputSchema: minecraftCropStateOutputSchema,
    freshnessCeilingMs: 120_000,
    timeoutCeilingMs: 30_000,
  }),
  descriptor({
    capabilityId: HELIX_MINECRAFT_REACHABILITY_CHECK_CAPABILITY,
    domain: "minecraft",
    adapterProfileIds: [HELIX_MINECRAFT_ADAPTER_PROFILE_ID],
    label: "Check Minecraft geometric reachability",
    description:
      "Measure straight-line distance from the current actor to a position and report probe-radius and interaction-range thresholds. This does not prove a navigable path.",
    inputSchema: minecraftPositionTargetSchema,
    outputSchema: minecraftReachabilityOutputSchema,
    freshnessCeilingMs: 30_000,
    timeoutCeilingMs: 30_000,
  }),
  descriptor({
    capabilityId: HELIX_MINECRAFT_PERCEPTION_SNAPSHOT_READ_CAPABILITY,
    capabilityVersion: 2,
    domain: "minecraft",
    adapterProfileIds: [HELIX_MINECRAFT_ADAPTER_PROFILE_ID],
    label: "Read one bounded Minecraft perception snapshot",
    description:
      "Capture actor, focus, inventory, directional terrain, drop/fluid hazards, nearby-entity bearings and motion, coverage gaps, and known UI state from one server-thread game revision. Client-only UI state remains explicitly unobserved until companion evidence is joined; unknown coverage never means safe.",
    inputSchema: minecraftPerceptionSnapshotInputSchema,
    outputSchema: minecraftPerceptionSnapshotOutputSchema,
    freshnessCeilingMs: 30_000,
    timeoutCeilingMs: 30_000,
  }),
  descriptor({
    capabilityId: HELIX_MINECRAFT_REGISTRY_FACT_READ_CAPABILITY,
    domain: "minecraft",
    adapterProfileIds: [HELIX_MINECRAFT_ADAPTER_PROFILE_ID],
    label: "Read a live Minecraft registry fact",
    description:
      "Check whether one exact block, item, entity type, or mob effect identifier exists in the registries of the currently paired Fabric server. Returns bounded versioned evidence and never lists the registry or changes the game.",
    inputSchema: minecraftRegistryFactInputSchema,
    outputSchema: minecraftRegistryFactOutputSchema,
    freshnessCeilingMs: 300_000,
    timeoutCeilingMs: 30_000,
  }),
  descriptor({
    capabilityId: HELIX_MINECRAFT_RECIPE_FACT_READ_CAPABILITY,
    domain: "minecraft",
    adapterProfileIds: [HELIX_MINECRAFT_ADAPTER_PROFILE_ID],
    label: "Read live Minecraft recipe facts",
    description:
      "Look up an exact recipe identifier or a bounded set of recipes producing one exact item in the currently paired Fabric server. Returns recipe identity, type, serializer, group, and conservatively resolved result items without crafting or changing the game.",
    inputSchema: minecraftRecipeFactInputSchema,
    outputSchema: minecraftRecipeFactOutputSchema,
    freshnessCeilingMs: 300_000,
    timeoutCeilingMs: 30_000,
  }),
  descriptor({
    capabilityId: HELIX_SYNTHETIC_REACHABILITY_CAPABILITY,
    domain: "synthetic",
    adapterProfileIds: [HELIX_SYNTHETIC_GAME_ADAPTER_PROFILE_ID],
    label: "Check synthetic reachability",
    description:
      "Read a deterministic synthetic environment fixture to test cross-adapter and cross-room isolation.",
    inputSchema: semanticTargetSchema,
    outputSchema: syntheticReachabilityOutputSchema,
    freshnessCeilingMs: 60_000,
    timeoutCeilingMs: 10_000,
  }),
  descriptor({
    capabilityId: HELIX_SYSTEM_CLOCK_READ_CAPABILITY,
    domain: "system",
    adapterProfileIds: [HELIX_SYSTEM_CLOCK_ADAPTER_PROFILE_ID],
    label: "Read connector process uptime",
    description:
      "Read a deterministic monotonic uptime value from a paired non-game connector.",
    inputSchema: systemClockInputSchema,
    outputSchema: systemClockOutputSchema,
    freshnessCeilingMs: 10_000,
    timeoutCeilingMs: 5_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_NAVIGATE_CAPABILITY,
    label: "Navigate the paired Minecraft player",
    description:
      "Move the separately paired player toward an exact position with bounded duration and distance. Native Fabric navigation never digs or places blocks; Baritone is selectable only when its manifest capability is live.",
    inputSchema: minecraftNavigateInputSchema,
    timeoutCeilingMs: 5 * 60_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_LOOK_CAPABILITY,
    label: "Turn the paired Minecraft player's view",
    description:
      "Turn the paired player's view toward a resolved position, rotate by an exact relative yaw/pitch delta, or retain the current focus, with manual input taking precedence. Positive relative yaw turns right; positive relative pitch looks down.",
    inputSchema: minecraftLookInputSchema,
    timeoutCeilingMs: 15_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_CAMERA_TRACK_CAPABILITY,
    label: "Track a Minecraft entity with the player's camera",
    description:
      "Lock one exact loaded entity and continuously turn the paired player's view toward its predicted position for a bounded interval. Reports measured angular error, target retention, reacquisition, and control release. Manual player input and Emergency Stop always win.",
    inputSchema: minecraftCameraTrackInputSchema,
    timeoutCeilingMs: 5 * 60_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_WALK_CAPABILITY,
    label: "Walk the paired Minecraft player",
    description:
      "Hold one movement direction for a bounded duration, optionally sprinting, and release every key on completion, cancellation, disconnect, or manual override.",
    inputSchema: minecraftWalkInputSchema,
    timeoutCeilingMs: 15_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_JUMP_CAPABILITY,
    label: "Jump with the paired Minecraft player",
    description:
      "Issue a bounded sequence of jump inputs for the separately paired player and report observed completion evidence.",
    inputSchema: minecraftJumpInputSchema,
    timeoutCeilingMs: 15_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_INTERACT_CAPABILITY,
    label: "Use the paired Minecraft player's current focus",
    description:
      "Use or interact with the block or entity currently under the paired player's crosshair using the selected hand.",
    inputSchema: minecraftInteractInputSchema,
    timeoutCeilingMs: 15_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_COMBAT_ATTACK_CAPABILITY,
    label: "Attack one exact hostile Minecraft entity",
    description:
      "Use the normal vanilla client attack path against one previously locked hostile entity incarnation. Requires current line of sight, reach and cooldown; refuses substitutions and friendly fire; reports hurt, health and death transitions.",
    inputSchema: minecraftCombatAttackInputSchema,
    timeoutCeilingMs:
      60_000 + HELIX_ENVIRONMENT_ACTION_RESULT_DELIVERY_GRACE_MS,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_COMBAT_GUARD_CAPABILITY,
    label: "Guard the paired player from bounded hostile Minecraft mobs",
    description:
      "Run a short resident hostile-PvE control lease that deterministically retains or switches among allowlisted hostile entity types, tracks the selected target, and issues only vanilla cooldown- and reach-gated attacks. Optional explicitly admitted repertoires add collision-checked direct closing, short-horizon projectile sidesteps, and off-hand shield holding within separate tick budgets. Players and non-hostile entities are never eligible targets.",
    inputSchema: minecraftCombatGuardInputSchema,
    timeoutCeilingMs:
      120_000 + HELIX_ENVIRONMENT_ACTION_RESULT_DELIVERY_GRACE_MS,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_HOTBAR_SELECT_CAPABILITY,
    label: "Select a Minecraft hotbar slot",
    description:
      "Select one exact zero-based hotbar slot for the separately paired player and verify the selected slot afterward.",
    inputSchema: minecraftHotbarInputSchema,
    timeoutCeilingMs: 10_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_EQUIP_CAPABILITY,
    label: "Equip an item for the paired Minecraft player",
    description:
      "Move an exact item identifier from the player's inventory into the requested hand or armor destination and verify the resulting equipment slot.",
    inputSchema: minecraftEquipInputSchema,
    timeoutCeilingMs: 15_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_FOLLOW_CAPABILITY,
    label: "Follow a bound Minecraft player",
    description:
      "Follow one exact active room subject for a bounded interval, maintain the requested distance, and stop if measured health crosses the admitted floor.",
    inputSchema: minecraftFollowInputSchema,
    timeoutCeilingMs: 30 * 60_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_COLLECT_CAPABILITY,
    label: "Collect dropped Minecraft items",
    description:
      "Move the paired player toward matching dropped items in loaded client range until the requested inventory increase is measured.",
    inputSchema: minecraftCollectInputSchema,
    timeoutCeilingMs: 10 * 60_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_MINE_CAPABILITY,
    label: "Mine matching Minecraft blocks",
    description:
      "Find and mine a bounded number of matching loaded blocks through the normal client game-mode controller, verifying each removed block. Requires explicit owner-granted world-mutation authority.",
    inputSchema: minecraftMineInputSchema,
    timeoutCeilingMs: 30 * 60_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_PLACE_CAPABILITY,
    label: "Place Minecraft blocks at exact positions",
    description:
      "Place the requested inventory block at exact integer positions through legitimate support-face interactions and verify every resulting block. Requires explicit owner-granted world-mutation authority.",
    inputSchema: minecraftPlaceInputSchema,
    timeoutCeilingMs: 30 * 60_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_CRAFT_CAPABILITY,
    label: "Craft a Minecraft item",
    description:
      "Select a known craftable client recipe in the active inventory or crafting-table grid, take server-presented results, and verify the output inventory increase.",
    inputSchema: minecraftCraftInputSchema,
    timeoutCeilingMs: 10 * 60_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_CONSUME_CAPABILITY,
    label: "Consume a Minecraft inventory item",
    description:
      "Equip and continuously use an exact admitted main-hand consumable, then verify item/remainder inventory deltas, food, saturation, health and released controls. It never infers direct healing from food use.",
    inputSchema: minecraftConsumeInputSchema,
    timeoutCeilingMs: 60_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_INVENTORY_TRANSFER_CAPABILITY,
    label: "Transfer Minecraft container inventory",
    description:
      "Deposit or withdraw an exact item count through an active or looked-at container menu and verify the player inventory delta.",
    inputSchema: minecraftInventoryTransferInputSchema,
    timeoutCeilingMs: 10 * 60_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_EXECUTE_SEQUENCE_CAPABILITY,
    label: "Execute a bounded Minecraft player sequence",
    description:
      "Execute one Codex-authored, acyclic survival_tas program locally on the paired Fabric client at Minecraft tick cadence. It combines tick-addressed input segments, the existing typed player workflows, observation-driven branches, and required checkpoints without a provider round trip per keypress. It never admits arbitrary code, host access, RCON, credentials, automatic replay, or command-assisted World Authority.",
    inputSchema: minecraftFluidSequenceInputSchema,
    timeoutCeilingMs: 30 * 60_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_EXECUTE_REACTIVE_PROGRAM_CAPABILITY,
    label: "Execute a concurrent Minecraft guardian program",
    description:
      "Run a Codex-authored concurrent survival_tas program. Read geometry/actor state first when timing or placement depends on it. Put a time-sensitive initiator and observer/reaction in separate immediate lanes; serial reaction can miss the state. Size duration from measured geometry and verify the transition. Under all_required, failed/timed-out/canceled required lanes end the program. predicted_collision_cell resolves geometry but never moves the player. Mutation ceilings cover placement, cleanup, and retry. Fabric returns bounded lane/event/interrupt evidence. Keyboard, mouse, or open screens override. Do not author manual-control or screen interrupts: manual_override_detected is not admitted, and world-state conditions cannot stand in. No code, commands, host access, or credentials.",
    inputSchema: minecraftReactiveProgramInputSchema,
    timeoutCeilingMs: 30 * 60_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_ARM_VIABILITY_GUARDIAN_CAPABILITY,
    label: "Arm persistent Minecraft viability guardian",
    description:
      "Arm the deterministic Fabric guardian for a bounded lease across individual action boundaries and Codex deliberation gaps. The fixed repertoire is swim upward, release controls, or request semantic replanning; every transition is measured and emitted as non-answer evidence.",
    inputSchema: minecraftArmViabilityGuardianInputSchema,
    timeoutCeilingMs: 15_000,
  }),
  actionDescriptor({
    capabilityId: HELIX_MINECRAFT_PLAYER_DISARM_VIABILITY_GUARDIAN_CAPABILITY,
    label: "Disarm persistent Minecraft viability guardian",
    description:
      "Disarm resident.minecraft.fabric-guardian.v1 through the trusted local arbiter and release every guardian-owned control without latching Emergency Stop.",
    inputSchema: minecraftDisarmViabilityGuardianInputSchema,
    timeoutCeilingMs: 15_000,
  }),
];

const descriptorById = new Map(
  descriptors.map((entry) => [entry.capability_id, entry] as const),
);

export type BuiltinEnvironmentConnectorPackage = {
  packageVersionId: string;
  packageId: string;
  packageVersion: string;
  publisherId: "publisher:casimirbot";
  adapterProfileId: string;
  hostCompatibility: string[];
  capabilityDescriptors: HelixEnvironmentCapabilityDescriptor[];
};

const builtinPackages: BuiltinEnvironmentConnectorPackage[] = [
  {
    packageVersionId:
      "connector_package_version:com.casimirbot.minecraft.paper:1.1.0",
    packageId: "com.casimirbot.minecraft.paper",
    packageVersion: "1.1.0",
    publisherId: "publisher:casimirbot",
    adapterProfileId: HELIX_MINECRAFT_ADAPTER_PROFILE_ID,
    hostCompatibility: ["paper:1.21.x", "java:21"],
    capabilityDescriptors: descriptors.filter(
      (entry) =>
        (
          HELIX_MINECRAFT_SITUATION_CAPABILITY_IDS as readonly string[]
        ).includes(entry.capability_id) &&
        entry.capability_id !==
          HELIX_MINECRAFT_SPATIAL_REGION_INSPECT_CAPABILITY &&
        entry.capability_id !==
          HELIX_MINECRAFT_PERCEPTION_SNAPSHOT_READ_CAPABILITY,
    ),
  },
  {
    packageVersionId:
      "connector_package_version:com.casimirbot.minecraft.fabric:0.3.0",
    packageId: "com.casimirbot.minecraft.fabric",
    packageVersion: "0.3.0",
    publisherId: "publisher:casimirbot",
    adapterProfileId: HELIX_MINECRAFT_ADAPTER_PROFILE_ID,
    hostCompatibility: [
      "fabric:1.21.8",
      "fabric-loader:0.18.4+",
      "fabric-api:0.136.1+1.21.8",
      "java:21",
    ],
    capabilityDescriptors: descriptors.filter((entry) =>
      (HELIX_MINECRAFT_READ_ONLY_CAPABILITY_IDS as readonly string[]).includes(
        entry.capability_id,
      ),
    ),
  },
  {
    packageVersionId:
      "connector_package_version:com.casimirbot.minecraft.fabric-player:0.4.0",
    packageId: "com.casimirbot.minecraft.fabric-player",
    packageVersion: "0.4.0",
    publisherId: "publisher:casimirbot",
    adapterProfileId: HELIX_MINECRAFT_FABRIC_PLAYER_ACTION_PROFILE_ID,
    hostCompatibility: [
      "fabric-client:1.21.8",
      "fabric-loader:0.18.4+",
      "fabric-api:0.136.1+1.21.8",
      "java:21",
    ],
    capabilityDescriptors: descriptors.filter((entry) =>
      entry.adapter_profile_ids.includes(
        HELIX_MINECRAFT_FABRIC_PLAYER_ACTION_PROFILE_ID,
      ),
    ),
  },
  {
    packageVersionId:
      "connector_package_version:com.casimirbot.synthetic.fixture:1.0.0",
    packageId: "com.casimirbot.synthetic.fixture",
    packageVersion: "1.0.0",
    publisherId: "publisher:casimirbot",
    adapterProfileId: HELIX_SYNTHETIC_GAME_ADAPTER_PROFILE_ID,
    hostCompatibility: ["node:20+"],
    capabilityDescriptors: descriptors.filter(
      (entry) =>
        entry.capability_id === HELIX_SYNTHETIC_REACHABILITY_CAPABILITY,
    ),
  },
  {
    packageVersionId:
      "connector_package_version:com.casimirbot.system.clock:1.0.0",
    packageId: "com.casimirbot.system.clock",
    packageVersion: "1.0.0",
    publisherId: "publisher:casimirbot",
    adapterProfileId: HELIX_SYSTEM_CLOCK_ADAPTER_PROFILE_ID,
    hostCompatibility: ["node:20+", "windows", "linux", "macos"],
    capabilityDescriptors: descriptors.filter(
      (entry) => entry.capability_id === HELIX_SYSTEM_CLOCK_READ_CAPABILITY,
    ),
  },
];

export const listBuiltinEnvironmentConnectorPackages =
  (): BuiltinEnvironmentConnectorPackage[] => structuredClone(builtinPackages);

export const readBuiltinEnvironmentConnectorPackage = (
  packageVersionId: string,
): BuiltinEnvironmentConnectorPackage | null => {
  const value =
    builtinPackages.find(
      (entry) => entry.packageVersionId === packageVersionId.trim(),
    ) ?? null;
  return value ? structuredClone(value) : null;
};

export const listEnvironmentConnectorCapabilityDescriptors = (input?: {
  adapterProfileId?: string | null;
}): HelixEnvironmentCapabilityDescriptor[] =>
  descriptors
    .filter(
      (entry) =>
        !input?.adapterProfileId ||
        entry.adapter_profile_ids.includes(input.adapterProfileId),
    )
    .map((entry) => structuredClone(entry));

export const readEnvironmentConnectorCapabilityDescriptor = (
  capabilityId: string,
): HelixEnvironmentCapabilityDescriptor | null => {
  const value = descriptorById.get(capabilityId.trim()) ?? null;
  return value ? structuredClone(value) : null;
};

export const legacyProbeTypeForEnvironmentCapability = (
  capabilityId: string,
): HelixEnvironmentProbeType | null => {
  switch (capabilityId.trim()) {
    case HELIX_MINECRAFT_ACTOR_STATUS_READ_CAPABILITY:
      return "actor_status";
    case HELIX_MINECRAFT_INVENTORY_CHECK_CAPABILITY:
      return "inventory_check";
    case HELIX_MINECRAFT_NEARBY_ENTITIES_LIST_CAPABILITY:
      return "nearby_entities";
    case HELIX_MINECRAFT_HAZARDS_SCAN_CAPABILITY:
      return "hazard_check";
    case HELIX_MINECRAFT_LOCAL_MAP_INSPECT_CAPABILITY:
      return "local_map_summary";
    case HELIX_MINECRAFT_SPATIAL_REGION_INSPECT_CAPABILITY:
      return "spatial_region";
    case HELIX_MINECRAFT_LINE_OF_SIGHT_CHECK_CAPABILITY:
      return "line_of_sight";
    case HELIX_MINECRAFT_CROP_STATE_READ_CAPABILITY:
      return "crop_state";
    case HELIX_MINECRAFT_REACHABILITY_CHECK_CAPABILITY:
    case HELIX_SYNTHETIC_REACHABILITY_CAPABILITY:
      return "reachability";
    case HELIX_MINECRAFT_PERCEPTION_SNAPSHOT_READ_CAPABILITY:
      return "perception_snapshot";
    case HELIX_MINECRAFT_REGISTRY_FACT_READ_CAPABILITY:
      return "registry_fact";
    case HELIX_MINECRAFT_RECIPE_FACT_READ_CAPABILITY:
      return "recipe_fact";
    default:
      return null;
  }
};
