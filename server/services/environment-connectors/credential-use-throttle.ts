const DEFAULT_TOUCH_INTERVAL_MS = 60_000;
const DEFAULT_MAX_TRACKED_CREDENTIALS = 1_024;

export type CredentialUseTouch = () => Promise<void>;

/**
 * Coalesces audit-only `last_used_at` writes without weakening authentication.
 * Callers still validate the credential, scope, expiry, and authority on every
 * request; only the redundant database timestamp mutation is rate-limited.
 */
export const createCredentialUseTouchThrottle = (input: {
  intervalMs?: number;
  maxTrackedCredentials?: number;
  now?: () => number;
} = {}) => {
  const intervalMs = Math.max(
    1_000,
    Math.floor(input.intervalMs ?? DEFAULT_TOUCH_INTERVAL_MS),
  );
  const maxTrackedCredentials = Math.max(
    16,
    Math.floor(
      input.maxTrackedCredentials ?? DEFAULT_MAX_TRACKED_CREDENTIALS,
    ),
  );
  const now = input.now ?? Date.now;
  const touchedAtByCredential = new Map<string, number>();

  const trim = (): void => {
    while (touchedAtByCredential.size > maxTrackedCredentials) {
      const oldest = touchedAtByCredential.keys().next().value;
      if (oldest === undefined) break;
      touchedAtByCredential.delete(oldest);
    }
  };

  return async (
    credentialId: string,
    touch: CredentialUseTouch,
  ): Promise<boolean> => {
    const timestamp = now();
    const previous = touchedAtByCredential.get(credentialId);
    if (previous !== undefined && timestamp - previous < intervalMs) {
      return false;
    }

    // Reserve before awaiting so concurrent polls share the same write.
    touchedAtByCredential.delete(credentialId);
    touchedAtByCredential.set(credentialId, timestamp);
    trim();
    try {
      await touch();
      return true;
    } catch (error) {
      if (touchedAtByCredential.get(credentialId) === timestamp) {
        touchedAtByCredential.delete(credentialId);
      }
      throw error;
    }
  };
};

