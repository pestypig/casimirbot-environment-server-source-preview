// One bounded planning-evidence window. This is not a native execution lease:
// action-specific conditions and controller safety checks remain mandatory.
export const TEMPORAL_OBSERVATION_MAX_AGE_MS = 5_000;
export const MINECRAFT_TEMPORAL_TICKS_PER_SECOND = 20;
export const MINECRAFT_TEMPORAL_FRONTIER_WINDOW_TICKS =
  TEMPORAL_OBSERVATION_MAX_AGE_MS * MINECRAFT_TEMPORAL_TICKS_PER_SECOND / 1_000;
