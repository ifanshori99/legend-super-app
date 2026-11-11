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
  /** Highest trusted time returned so far; persist this. */
  highWater(): Date;
};

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
  const anchorWall = Math.max(
    wall().getTime(),
    persisted !== undefined && Number.isFinite(persisted)
      ? persisted
      : -Infinity,
  );
  const anchorMono = mono();
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
    highWater: () => new Date(read()),
  };
}
