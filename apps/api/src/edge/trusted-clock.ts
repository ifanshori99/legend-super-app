// Trusted clock for the catalog sales gate (legend-10nex). Ages and override
// expiry must not shrink when someone sets the wall clock backwards:
//
//   trustedNow = max(wallNow, anchorWall + (monoNow - anchorMono))
//
// At creation `anchorWall = max(wallNow, persistedHighWater)` and
// `anchorMono = monoNow`. The monotonic clock is not affected by wall clock
// changes, so a backward wall clock (while running, or across a restart via
// the persisted high water) never reduces `now()`. A wall clock set forward is
// accepted and reanchors both clocks, so rolling it back cannot freeze an
// override's remaining lifetime. A persisted stamp cannot prove the time spent
// powered off when a reboot's wall clock is still at that stamp.
export type TrustedClock = {
  now(): Date;
  /**
   * True while the wall clock is more than 5 minutes behind trusted time:
   * at boot (behind the persisted high water) or set back while running
   * (a jump back of more than 5 minutes against the previous reading plus the
   * monotonic time elapsed, 533c). Every call re-checks the wall clock, so a
   * set-back is seen on the first read. It latches until the wall clock catches up with the trusted
   * time reached when the regression was seen, then clears. Detecting it also
   * makes `elapsedTimeUnproven()` true until the next restart: a server time
   * proof cannot clear it, as it cannot tell a wall step from real time.
   */
  regressed(): boolean;
  /**
   * A reboot at or behind the persisted high water cannot prove how long the
   * device was powered off. This stays true: the running monotonic clock only
   * measures time since this boot. Fresh catalog syncs provide separate proof
   * of catalog age; they do not prove the missing powered-off time. Also
   * becomes true when a wall clock set back while running is detected (533c).
   */
  elapsedTimeUnproven(): boolean;
  /** Highest trusted time returned so far; persist this. */
  highWater(): Date;
  /**
   * Late load of the persisted high water (the local database was down at
   * boot). Never lowers the clock; a wall clock more than 5 minutes behind it
   * counts as regressed, like at boot.
   */
  adoptHighWater(persisted: Date): void;
  /**
   * The cloud's server time (HTTP `Date` of the link upgrade or a catalog
   * pull, 533 A2). Clears `elapsedTimeUnproven()` when it is at or after the
   * boot high water and within 5 minutes of where a clock that kept real time
   * since boot would be: the boot wall clock plus the monotonic time elapsed
   * since boot (533b). It is not compared with the current wall clock: a
   * chrony step or hand edit after boot proves nothing about the time spent
   * powered off. Never touches `regressed()`, `now()` or `highWater()`.
   */
  proveWithServerTime(serverTime: Date): void;
  /**
   * The highest stamp known from before this boot (persisted, or adopted
   * late); null when there was none. Evidence stamped strictly after it was
   * written since the boot (533 A3).
   */
  bootHighWater(): Date | null;
  /**
   * legend-4sesc: the time a purge may cut off at. The lower of the wall clock
   * and the last cloud server time seen (`proveWithServerTime`, whatever its
   * outcome) aged by the monotonic time since it was seen. A wall clock set
   * forward cannot push it past what the cloud last said; a wall clock set back
   * lowers it. Null until the cloud has been heard since boot: no purge then.
   * Unlike `now()` it never trusts a forward wall step by itself.
   */
  purgeSafeNow(): Date | null;
};

/** A wall clock this far behind the persisted high water at boot is a regression. */
export const CLOCK_REGRESSION_TOLERANCE_MS = 5 * 60_000;

export function createTrustedClock(
  options: {
    wall?: () => Date;
    /** Monotonic milliseconds (default `performance.now()`). */
    mono?: () => number;
    persistedHighWater?: Date | null;
  } = {},
): TrustedClock {
  const wall = options.wall ?? (() => new Date());
  const mono = options.mono ?? (() => performance.now());
  const persisted = options.persistedHighWater?.getTime();
  const bootWall = wall().getTime();
  const persistedMs =
    persisted !== undefined && Number.isFinite(persisted) ? persisted : null;
  let anchorWall = Math.max(bootWall, persistedMs ?? -Infinity);
  let regressedUntil =
    persistedMs !== null &&
    bootWall < persistedMs - CLOCK_REGRESSION_TOLERANCE_MS
      ? persistedMs
      : null;
  let unproven =
    persistedMs !== null &&
    bootWall <= persistedMs + CLOCK_REGRESSION_TOLERANCE_MS;
  // The highest stamp known from before this boot (persisted or adopted late).
  let bootHighWater = persistedMs;
  const bootMono = mono();
  let anchorMono = bootMono;
  let high = anchorWall;

  // The previous wall reading and its monotonic stamp: a wall clock that kept
  // real time since then is at lastWall + elapsed. Comparing with the previous
  // reading (not with the anchor) detects a step back once, as an event; a wall
  // clock that stays behind afterwards is not a new regression.
  let lastWall = bootWall;
  let lastMono = bootMono;
  // Set once a wall clock step back is seen while running. The server time
  // proof compares with boot wall + monotonic, which a wall step does not move,
  // so it could not tell the step from real time and would erase the owner
  // alarm; elapsed time stays unproven until the next restart (533c).
  let steppedBack = false;
  // The last cloud server time seen and its monotonic stamp (legend-4sesc).
  let lastServer: { ms: number; mono: number } | null = null;

  const read = (): number => {
    const monoNow = mono();
    const wallNow = wall().getTime();
    // Where a wall clock that kept real time since the last anchor would be.
    // Taken before any reanchor below, so a forward jump never hides a set-back.
    const expected = anchorWall + (monoNow - anchorMono);
    if (
      wallNow <
      lastWall + (monoNow - lastMono) - CLOCK_REGRESSION_TOLERANCE_MS
    ) {
      // The wall clock was set back while running (533c). Hold until it catches
      // up with the trusted time. Time spent with a wrong clock cannot be
      // proven, so elapsed time is unproven too (owner alarm, promos off).
      regressedUntil = Math.max(regressedUntil ?? 0, expected);
      unproven = true;
      steppedBack = true;
    }
    lastWall = wallNow;
    lastMono = monoNow;
    const value = Math.max(wallNow, expected);
    if (value > high) {
      high = value;
      // A forward wall jump becomes the new origin for elapsed real time.
      // Keeping only `high` would freeze time until the old origin caught up.
      anchorWall = value;
      anchorMono = monoNow;
    }
    return high;
  };

  return {
    now: () => new Date(read()),
    regressed: () => {
      // Detect a wall clock set back while running before judging the latch.
      read();
      if (regressedUntil === null) return false;
      if (wall().getTime() >= regressedUntil) regressedUntil = null;
      return regressedUntil !== null;
    },
    elapsedTimeUnproven: () => {
      read();
      return unproven;
    },
    highWater: () => new Date(read()),
    adoptHighWater: (late) => {
      const lateMs = late.getTime();
      if (!Number.isFinite(lateMs)) return;
      // Compare with the original boot wall, even if DB recovery takes hours.
      if (bootWall <= lateMs + CLOCK_REGRESSION_TOLERANCE_MS) unproven = true;
      bootHighWater = Math.max(bootHighWater ?? -Infinity, lateMs);
      const current = read();
      if (lateMs > current) {
        anchorWall = lateMs;
        anchorMono = mono();
        high = lateMs;
      }
      if (wall().getTime() < lateMs - CLOCK_REGRESSION_TOLERANCE_MS)
        regressedUntil = Math.max(regressedUntil ?? 0, lateMs);
    },
    bootHighWater: () =>
      bootHighWater === null ? null : new Date(bootHighWater),
    purgeSafeNow: () => {
      if (lastServer === null) return null;
      const aged = lastServer.ms + (mono() - lastServer.mono);
      return new Date(Math.min(wall().getTime(), aged));
    },
    proveWithServerTime: (serverTime) => {
      const serverMs = serverTime.getTime();
      if (!Number.isFinite(serverMs)) return;
      // Recorded before any early return below: a purge cuts off at server
      // time even when the proof itself is refused or already given.
      lastServer = { ms: serverMs, mono: mono() };
      // Observe a wall clock set back first, so the proof below can clear it.
      read();
      if (steppedBack) return;
      if (!unproven) return;
      if (bootHighWater !== null && serverMs < bootHighWater) return;
      // Where the clock stands if it kept real time since boot, whatever the
      // wall clock was set to afterwards.
      const expectedMs = bootWall + (mono() - bootMono);
      if (Math.abs(serverMs - expectedMs) > CLOCK_REGRESSION_TOLERANCE_MS)
        return;
      unproven = false;
    },
  };
}
