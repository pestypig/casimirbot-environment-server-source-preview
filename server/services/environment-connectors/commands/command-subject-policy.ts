const SELECTED_SUBJECT_SELECTOR = /(?:^|\s)@s(?=\[|\s|$)/i;
const HELIX_GAMEPLAY_ROOT =
  /^\/?(?:[a-z0-9_.-]+:)?helixgame(?:\s|$)/i;

/**
 * Dispatch a standalone @s selector from the room member's verified player
 * source even when the command risk category is broader than player-only
 * categories (for example, playsound is server administration).
 */
export const commandUsesSelectedSubjectSelector = (command: string): boolean =>
  SELECTED_SUBJECT_SELECTOR.test(command.trim());

/**
 * Gameplay primitives such as rollback checkpoints and fall rescue resolve
 * their actor from the Minecraft command source. They therefore require the
 * room member's verified selected player even when their risk category is a
 * broader world operation and the command contains no explicit @s selector.
 */
export const commandRequiresSelectedSubjectSource = (command: string): boolean => {
  const normalized = command.trim();
  return (
    commandUsesSelectedSubjectSelector(normalized) ||
    HELIX_GAMEPLAY_ROOT.test(normalized)
  );
};
