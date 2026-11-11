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
   * True when, at boot, the wall clock was more than 5 minutes behind the
   * persisted high water, until the wall clock catches up to it. Once false it
   * stays false.
   */
  regressed(): boolean;
  /**
   * A reboot at or behind the persisted high water cannot prove how long the
   * device was powered off. This stays true: the running monotonic clock only
   * measures time since this boot. Fresh catalog syncs provide separate proof
   * of catalog age; they do not prove the missing powered-off time.
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

  const read = (): number => {
    const monoNow = mono();
    const value = Math.max(
      wall().getTime(),
      anchorWall + (monoNow - anchorMono),
    );
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
      if (regressedUntil === null) return false;
      if (wall().getTime() >= regressedUntil) regressedUntil = null;
      return regressedUntil !== null;
    },
    elapsedTimeUnproven: () => unproven,
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
    proveWithServerTime: (serverTime) => {
      const serverMs = serverTime.getTime();
      if (!Number.isFinite(serverMs)) return;
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
