// Clock formatting for the leave clock-in review screens. Hour and minute only
// (08.02), in the outlet time zone, so it agrees with the business date the
// API uses (D-CORE-6); the id-ID locale matches the catalog.
const clock = (timeZone: string) =>
  new Intl.DateTimeFormat("id-ID", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/** 08.02 in the outlet time zone. */
export function formatClockMinutes(iso: string, timeZone: string): string {
  return clock(timeZone).format(new Date(iso));
}
