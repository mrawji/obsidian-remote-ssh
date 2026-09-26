/**
 * What to do about a session that just went down.
 *
 * Pulled out of `main.ts` so the decision can be stated once and read back.
 * Both halves of the fix it encodes — one notice per disconnect, and saying
 * what died rather than that something did — had shipped with nothing
 * exercising them, because `vitest.coverage.ts` excludes `main.ts` and so the
 * gap went unmeasured.
 *
 * Unmeasured, not unreachable: the plugin class constructs fine under the
 * obsidian mock, and `tests/startReconnect.wiring.test.ts` drives this from
 * there. Extracting the decision does not by itself pin anything — the caller
 * still has to ask, and asking wrongly is what that suite covers. The Notice
 * and the state transition stay Obsidian's business.
 */
export type ReconnectDecision =
  /** Nothing to reconnect to. The caller reports an error state. */
  | { kind: 'no-profile' }
  /** A reconnect is already running; say so in the log and stop. */
  | { kind: 'already-reconnecting'; log: string }
  /** The user turned auto-reconnect off. Tell them, and stand down. */
  | { kind: 'disabled'; notice: string }
  | { kind: 'start'; notice: string; maxRetries: number };

export function decideReconnect(input: {
  hasActiveProfile: boolean;
  alreadyReconnecting: boolean;
  maxRetries: number;
  cause?: Error;
}): ReconnectDecision {
  if (!input.hasActiveProfile) return { kind: 'no-profile' };

  // One failure, one notice. Both close paths lead here, and on the RPC
  // transport a dropped SSH connection takes the tunnel with it, so both fire
  // for the same event — announcing from the callers stacked two toasts on
  // the most ordinary disconnect there is.
  if (input.alreadyReconnecting) {
    const why = input.cause ? ` (${input.cause.message})` : '';
    return { kind: 'already-reconnecting', log: `startReconnect: already reconnecting${why}` };
  }

  // Say WHY, not just that. The transports go to some trouble to keep the
  // reason a session died; discarding it here is what made every drop read as
  // the same contentless line.
  const lost = input.cause?.message
    ? `connection lost (${input.cause.message})`
    : 'connection lost';

  if (input.maxRetries <= 0) {
    return { kind: 'disabled', notice: `Remote SSH: ${lost}. Auto-reconnect is off.` };
  }
  return {
    kind: 'start',
    notice: `Remote SSH: ${lost} — reconnecting…`,
    maxRetries: input.maxRetries,
  };
}
