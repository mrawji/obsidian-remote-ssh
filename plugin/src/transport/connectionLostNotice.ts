/**
 * What to tell the user when a session goes down.
 *
 * This is the part of `startReconnect` that had shipped with nothing
 * exercising it — `vitest.coverage.ts` excludes `main.ts`, so the gap went
 * unmeasured — and it is the part worth stating once: the guards around it are
 * three lines each with their own side effects, and they read better next to
 * those effects than as a decision object the caller then branches on.
 *
 * Whether the plugin asks at the right moments is pinned in
 * `tests/startReconnect.wiring.test.ts`, which is the half a pure function
 * cannot cover.
 */
export function connectionLostNotice(cause: Error | undefined, autoReconnect: boolean): string {
  // Say WHY, not just that. The transports go to some trouble to keep the
  // reason a session died; discarding it here is what made every drop read as
  // the same contentless line. A cause with a blank message is no reason at
  // all — it must not render as "connection lost ()".
  const lost = cause?.message ? `connection lost (${cause.message})` : 'connection lost';
  return autoReconnect
    ? `Remote SSH: ${lost} — reconnecting…`
    : `Remote SSH: ${lost}. Auto-reconnect is off.`;
}
