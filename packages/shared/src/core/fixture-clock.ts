/** Shared, fixed clock for demo data; fixtures never age with the host clock. */
export const FIXTURE_CLOCK_NOW = "2026-11-01T00:00:00.000Z";

/** Expiry dates must describe their duration from the fixture clock. */
export function fixtureTimeAfter(
  offset: { days?: number; hours?: number; minutes?: number; seconds?: number },
  clock = FIXTURE_CLOCK_NOW,
): string {
  const seconds =
    (offset.days ?? 0) * 86_400 +
    (offset.hours ?? 0) * 3_600 +
    (offset.minutes ?? 0) * 60 +
    (offset.seconds ?? 0);
  return new Date(Date.parse(clock) + seconds * 1_000).toISOString();
}
