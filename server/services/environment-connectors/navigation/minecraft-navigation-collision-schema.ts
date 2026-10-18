import type { HelixEnvironmentConstrainedJsonSchema as Schema } from "@shared/helix-environment-connector";
import { navigationCollisionFailureReasons } from "./minecraft-navigation-collision-observation";

const point: Schema = { type: "array", minItems: 3, maxItems: 3, items: { type: "integer", minimum: -30_000_000, maximum: 30_000_000 } };
const flags: Schema = { type: "boolean" };
export const minecraftNavigationCollisionSchema: Schema = {
  type: "object",
  oneOf: [
    { type: "object", properties: {
      status: { type: "string", enum: ["unavailable"] },
      reason: { type: "string", enum: [...navigationCollisionFailureReasons] },
    }, required: ["status", "reason"], additionalProperties: false },
    { type: "object", properties: {
      status: { type: "string", enum: ["captured"] },
      replay: { type: "object", properties: {
        schema: { type: "string", enum: ["minecraft.native_collision_replay.v1"] },
        dimension: { type: "string", minLength: 1, maxLength: 160 },
        subject_native_id: { type: "string", minLength: 36, maxLength: 36 },
        tick_start: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        tick_end: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        minimum: point, maximum: point,
        cells: { type: "array", minItems: 125, maxItems: 125, items: {
          type: "object", properties: {
            position: point,
            facts: { type: "object", properties: {
              loaded: flags, collision_empty: flags, collision_full_cube: flags,
              air: flags, reviewed_support: flags, hazard: flags, fluid: flags,
              collision: { type: "string", enum: ["unknown", "empty", "full_cube", "hazard", "fluid", "unsupported"] },
            }, required: ["loaded", "collision_empty", "collision_full_cube", "air", "reviewed_support", "hazard", "fluid", "collision"], additionalProperties: false },
          }, required: ["position", "facts"], additionalProperties: false,
        } },
      }, required: ["schema", "dimension", "subject_native_id", "tick_start", "tick_end", "minimum", "maximum", "cells"], additionalProperties: false },
    }, required: ["status", "replay"], additionalProperties: false },
  ],
};
