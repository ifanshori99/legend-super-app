// legend-5ab0l (S6), unit test of the pure helper `outletOpenSince`
// (docs/design/edge-status-cloud.md section 8, D10, test T33). Written from the
// design, not from the implementation.
//
//   outletOpenSince(openingHours, timeZone, now): Date | null
//     = start of the outlet's CURRENT open window, or null when the outlet is
//       closed at `now`. Hours are read in `timeZone` (IANA); `null` day =
//       closed; `closes < opens` = the window runs past midnight into the next
//       local day.
//
// Assumptions (the design does not spell them out):
// - A window is [opens, closes): open exactly at `opens`, closed exactly at `closes`.
// - A past-midnight window belongs to the day it opened on: Wed 18:00-02:00 is
//   still open on Thursday 01:00 even when Thursday itself is closed (`null`),
//   and the answer is Wednesday 18:00. The week wraps (Sunday into Monday).
// - Seconds count: the result is the exact opening instant (HH:MM:00.000 local).
// - The Indonesian zones used have no DST. One zone with a half-hour offset and
//   one with a negative offset check that the zone, not UTC, picks the weekday.
import { describe, expect, it } from "vitest";
import type { OpeningHours } from "@starter/shared/platform";
import { outletOpenSince } from "../services/edge-offline-sweep.ts";

type Hours = { opens: string; closes: string } | null;
type Day = keyof OpeningHours;

/** A week where every day is closed, then the given days overridden. */
function week(days: Partial<Record<Day, Hours>>): OpeningHours {
  return {
    mon: null,
    tue: null,
    wed: null,
    thu: null,
    fri: null,
    sat: null,
    sun: null,
    ...days,
  };
}

function everyDay(hours: Hours): OpeningHours {
  return week({
    mon: hours,
    tue: hours,
    wed: hours,
    thu: hours,
    fri: hours,
    sat: hours,
    sun: hours,
  });
}

const iso = (value: Date | null) =>
  value === null ? null : value.toISOString();
const openSince = (hours: OpeningHours, zone: string, nowIso: string) =>
  outletOpenSince(hours, zone, new Date(nowIso));

const JAKARTA = "Asia/Jakarta"; // UTC+7
const JAYAPURA = "Asia/Jayapura"; // UTC+9

// 2026-03-04 is a Wednesday, 2026-03-08 a Sunday.

describe("legend-5ab0l outletOpenSince: a plain daily window", () => {
  const cafe = everyDay({ opens: "08:00", closes: "22:00" });

  it("T33 inside the window returns the opening instant, as a Date", () => {
    const result = openSince(cafe, JAKARTA, "2026-03-04T05:00:30.000Z"); // 12:00:30 WIB
    expect(result).toBeInstanceOf(Date);
    expect(iso(result)).toBe("2026-03-04T01:00:00.000Z"); // 08:00 WIB
  });

  it("T33 opens inclusive, closes exclusive", () => {
    expect(iso(openSince(cafe, JAKARTA, "2026-03-04T01:00:00.000Z"))).toBe(
      "2026-03-04T01:00:00.000Z",
    );
    expect(iso(openSince(cafe, JAKARTA, "2026-03-04T14:59:59.000Z"))).toBe(
      "2026-03-04T01:00:00.000Z",
    );
    expect(openSince(cafe, JAKARTA, "2026-03-04T15:00:00.000Z")).toBeNull(); // 22:00 WIB
  });

  it("T33 before opening and after closing is null", () => {
    expect(openSince(cafe, JAKARTA, "2026-03-04T00:59:59.000Z")).toBeNull(); // 07:59:59 WIB
    expect(openSince(cafe, JAKARTA, "2026-03-04T16:00:00.000Z")).toBeNull(); // 23:00 WIB
    expect(openSince(cafe, JAKARTA, "2026-03-04T20:00:00.000Z")).toBeNull(); // 03:00 WIB next day
  });

  it("T33 a null day is closed all day", () => {
    const noWednesday = week({
      mon: { opens: "08:00", closes: "22:00" },
      tue: { opens: "08:00", closes: "22:00" },
      wed: null,
      thu: { opens: "08:00", closes: "22:00" },
    });
    expect(
      openSince(noWednesday, JAKARTA, "2026-03-04T05:00:00.000Z"),
    ).toBeNull();
    // The next day (Thursday) is open again.
    expect(
      iso(openSince(noWednesday, JAKARTA, "2026-03-05T05:00:00.000Z")),
    ).toBe("2026-03-05T01:00:00.000Z");
  });

  it("T33 a week with every day closed is always null", () => {
    expect(
      openSince(everyDay(null), JAKARTA, "2026-03-04T05:00:00.000Z"),
    ).toBeNull();
  });
});

describe("legend-5ab0l outletOpenSince: windows that run past midnight", () => {
  const eveningWed = week({ wed: { opens: "18:00", closes: "02:00" } });

  it("T33 evening part: open since the same evening", () => {
    expect(
      iso(openSince(eveningWed, JAKARTA, "2026-03-04T13:00:00.000Z")),
    ).toBe(
      "2026-03-04T11:00:00.000Z", // Wed 20:00 WIB -> Wed 18:00 WIB
    );
    expect(
      iso(openSince(eveningWed, JAKARTA, "2026-03-04T11:00:00.000Z")),
    ).toBe(
      "2026-03-04T11:00:00.000Z", // exactly 18:00 WIB
    );
    expect(
      openSince(eveningWed, JAKARTA, "2026-03-04T10:59:00.000Z"),
    ).toBeNull(); // 17:59 WIB
  });

  it("T33 after midnight: still open, counted from the previous day's opening", () => {
    // Thu 01:00 WIB, Thursday itself is closed (null): Wednesday's window still runs.
    expect(
      iso(openSince(eveningWed, JAKARTA, "2026-03-04T18:00:00.000Z")),
    ).toBe("2026-03-04T11:00:00.000Z");
    // Closes at 02:00 sharp.
    expect(
      iso(openSince(eveningWed, JAKARTA, "2026-03-04T18:59:59.000Z")),
    ).toBe("2026-03-04T11:00:00.000Z");
    expect(
      openSince(eveningWed, JAKARTA, "2026-03-04T19:00:00.000Z"),
    ).toBeNull(); // 02:00 WIB
    expect(
      openSince(eveningWed, JAKARTA, "2026-03-04T19:30:00.000Z"),
    ).toBeNull();
  });

  it("T33 the next day's own window starts fresh after the past-midnight one ended", () => {
    const both = week({
      wed: { opens: "18:00", closes: "02:00" },
      thu: { opens: "10:00", closes: "20:00" },
    });
    // Thu 01:00 WIB: Wednesday's window.
    expect(iso(openSince(both, JAKARTA, "2026-03-04T18:00:00.000Z"))).toBe(
      "2026-03-04T11:00:00.000Z",
    );
    // Thu 05:00 WIB: between the two windows, closed.
    expect(openSince(both, JAKARTA, "2026-03-04T22:00:00.000Z")).toBeNull();
    // Thu 10:30 WIB: Thursday's own opening, not Wednesday's.
    expect(iso(openSince(both, JAKARTA, "2026-03-05T03:30:00.000Z"))).toBe(
      "2026-03-05T03:00:00.000Z",
    );
  });

  it("T33 the week wraps: Sunday night is open on Monday morning", () => {
    const sundayNight = week({ sun: { opens: "20:00", closes: "03:00" } });
    // Mon 2026-03-09 01:00 WIB = Sun 2026-03-08 18:00Z; opened Sun 20:00 WIB = 13:00Z.
    expect(
      iso(openSince(sundayNight, JAKARTA, "2026-03-08T18:00:00.000Z")),
    ).toBe("2026-03-08T13:00:00.000Z");
    expect(
      openSince(sundayNight, JAKARTA, "2026-03-08T20:00:00.000Z"),
    ).toBeNull(); // Mon 03:00 WIB
  });
});

describe("legend-5ab0l outletOpenSince: the outlet's own time zone decides", () => {
  const nineToNine = everyDay({ opens: "09:00", closes: "21:00" });

  it("T33 one instant, two zones: open in Jakarta, already closed in Jayapura", () => {
    const instant = "2026-03-04T13:30:00.000Z"; // 20:30 WIB, 22:30 WIT
    expect(iso(openSince(nineToNine, JAKARTA, instant))).toBe(
      "2026-03-04T02:00:00.000Z", // 09:00 WIB
    );
    expect(openSince(nineToNine, JAYAPURA, instant)).toBeNull();
    // And the other way: 09:00 WIT is 07:00 WIB.
    expect(
      iso(openSince(nineToNine, JAYAPURA, "2026-03-04T01:00:00.000Z")),
    ).toBe("2026-03-04T00:00:00.000Z");
    expect(
      iso(openSince(nineToNine, JAKARTA, "2026-03-04T01:00:00.000Z")),
    ).toBeNull(); // 08:00 WIB
  });

  it("T33 a half-hour offset zone (Asia/Kolkata, UTC+5:30)", () => {
    const office = everyDay({ opens: "09:00", closes: "17:00" });
    expect(
      iso(openSince(office, "Asia/Kolkata", "2026-03-04T05:00:00.000Z")),
    ).toBe(
      "2026-03-04T03:30:00.000Z", // 10:30 IST, opened 09:00 IST
    );
    expect(
      openSince(office, "Asia/Kolkata", "2026-03-04T03:00:00.000Z"),
    ).toBeNull(); // 08:30 IST
  });

  it("T33 the local weekday, not the UTC weekday, picks the day's hours", () => {
    // Open on Thursday only.
    const thursdayOnly = week({ thu: { opens: "08:00", closes: "12:00" } });
    // 2026-03-04T17:30Z is still Wednesday in UTC but Thursday 00:30 in Jakarta:
    // Thursday hours apply, and it is before opening.
    expect(
      openSince(thursdayOnly, JAKARTA, "2026-03-04T17:30:00.000Z"),
    ).toBeNull();
    // Thu 09:00 WIB = Thu 02:00Z: open since 08:00 WIB = 01:00Z.
    expect(
      iso(openSince(thursdayOnly, JAKARTA, "2026-03-05T02:00:00.000Z")),
    ).toBe("2026-03-05T01:00:00.000Z");
    // 2026-03-05T02:00Z is still Wednesday evening in New York (UTC-5): closed.
    expect(
      openSince(thursdayOnly, "America/New_York", "2026-03-05T02:00:00.000Z"),
    ).toBeNull();
  });

  it("T33 past midnight in the outlet's zone, not in UTC", () => {
    const eveningWed = week({ wed: { opens: "18:00", closes: "02:00" } });
    // 2026-03-04T18:30Z = Thu 01:30 WIB: open (Wednesday's window), opened 11:00Z.
    expect(
      iso(openSince(eveningWed, JAKARTA, "2026-03-04T18:30:00.000Z")),
    ).toBe("2026-03-04T11:00:00.000Z");
    // Same instant in Jayapura is Thu 03:30 WIT: window ended at 02:00 WIT.
    expect(
      openSince(eveningWed, JAYAPURA, "2026-03-04T18:30:00.000Z"),
    ).toBeNull();
  });
});

describe("legend-l83d2 outletOpenSince: DST transitions", () => {
  // Conversion policy: an ambiguous opening uses its first occurrence; an
  // opening in a DST gap shifts forward by the gap (02:30 becomes 03:30).
  it("spring forward uses the offset at opening, before the clock jumped", () => {
    const sunday = week({ sun: { opens: "01:50", closes: "05:00" } });
    expect(
      iso(openSince(sunday, "America/New_York", "2026-03-08T07:10:00.000Z")),
    ).toBe("2026-03-08T06:50:00.000Z");
  });

  it("autumn fallback uses the opening offset before the repeated hour", () => {
    const sunday = week({ sun: { opens: "00:50", closes: "05:00" } });
    expect(
      iso(openSince(sunday, "America/New_York", "2026-11-01T06:10:00.000Z")),
    ).toBe("2026-11-01T04:50:00.000Z");
  });

  it("an ambiguous opening stays open during the repeated hour even before its wall-clock time repeats", () => {
    const sunday = week({ sun: { opens: "01:50", closes: "05:00" } });
    // The first 01:50 was at 05:50Z; 06:10Z is the second 01:10.
    expect(
      iso(openSince(sunday, "America/New_York", "2026-11-01T06:10:00.000Z")),
    ).toBe("2026-11-01T05:50:00.000Z");
  });

  it("a nonexistent spring opening shifts forward by the gap and stays closed until that instant", () => {
    const sunday = week({ sun: { opens: "02:30", closes: "05:00" } });
    expect(
      openSince(sunday, "America/New_York", "2026-03-08T07:10:00.000Z"),
    ).toBeNull();
    expect(
      iso(openSince(sunday, "America/New_York", "2026-03-08T07:30:00.000Z")),
    ).toBe("2026-03-08T07:30:00.000Z");
  });
});
