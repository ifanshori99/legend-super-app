// Trusted clock for the catalog sales gate (legend-10nex). Ages and override
// expiry must not shrink when someone sets the wall clock backwards:
//
//   trustedNow = max(wallNow, anchorWall + (monoNow - anchorMono))
//
// At creation `anchorWall = max(wallNow, persistedHighWater)` and
// `anchorMono = monoNow`. The monotonic clock is not affected by wall clock
// changes, so a backward wall clock (while running, or across a restart via
// the persisted high water) never reduces `now()`. A wall clock set forward is
// accepted: it can only block earlier, and an owner override still works.
export type TrustedClock = {
  now(): Date;
  /**
   * True when, at boot, the wall clock was more than 5 minutes behind the
   * persisted high water, until the wall clock catches up to it. Once false it
   * stays false.
   */
  regressed(): boolean;
  /** Highest trusted time returned so far; persist this. */
  highWater(): Date;
  /**
   * Late load of the persisted high water (the local database was down at
   * boot). Never lowers the clock; a wall clock more than 5 minutes behind it
   * counts as regressed, like at boot.
   */
  adoptHighWater(persisted: Date): void;
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
  let anchorMono = mono();
  let high = anchorWall;

  const read = (): number => {
    const value = Math.max(
      wall().getTime(),
      anchorWall + (mono() - anchorMono),
    );
    // Never goes down, even if the wall clock jumped forward and back.
    if (value > high) high = value;
    return high;
  };

  return {
    now: () => new Date(read()),
    regressed: () => {
      if (regressedUntil === null) return false;
      if (wall().getTime() >= regressedUntil) regressedUntil = null;
      return regressedUntil !== null;
    },
    highWater: () => new Date(read()),
    adoptHighWater: (late) => {
      const lateMs = late.getTime();
      if (!Number.isFinite(lateMs)) return;
      const current = read();
      if (lateMs > current) {
        anchorWall = lateMs;
        anchorMono = mono();
        high = lateMs;
      }
      if (wall().getTime() < lateMs - CLOCK_REGRESSION_TOLERANCE_MS)
        regressedUntil = Math.max(regressedUntil ?? 0, lateMs);
    },
  };
}
