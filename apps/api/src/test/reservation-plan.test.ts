// Pure reservation planning rules (PRD v1.7 §3.22; RSV-01): outlet-zone time,
// opening windows, slot generation, table picking, idempotency fingerprints.
import { describe, expect, it } from "vitest";
import {
  candidateStarts,
  localDate,
  pickTables,
  requestFingerprint,
  slotInsideHours,
  zonedInstant,
} from "../services/reservation-plan.ts";

const WIB = "Asia/Jakarta";
const hours = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "10:00", end: "22:00" },
];

describe("reservation planning", () => {
  it("RSV-01 converts an outlet-local date and time to the UTC instant", () => {
    expect(zonedInstant("2026-11-07", "19:00", WIB).toISOString()).toBe(
      "2026-11-07T12:00:00.000Z",
    );
    expect(localDate(new Date("2026-11-07T18:00:00Z"), WIB)).toBe("2026-11-08");
  });

  it("RSV-01 offers starts only where the whole slot fits the opening window", () => {
    const starts = candidateStarts("2026-11-07", hours, 90, 30, WIB);
    expect(starts[0]?.toISOString()).toBe("2026-11-07T03:00:00.000Z"); // 10:00 WIB
    expect(starts.at(-1)?.toISOString()).toBe("2026-11-07T13:30:00.000Z"); // 20:30 WIB
    expect(
      slotInsideHours(zonedInstant("2026-11-07", "21:00", WIB), 90, hours, WIB),
    ).toBe(false);
    expect(
      slotInsideHours(zonedInstant("2026-11-07", "20:30", WIB), 90, hours, WIB),
    ).toBe(true);
  });

  it("RSV-01 picks the smallest single table, else the fewest tables of one zone", () => {
    const free = [
      { id: "a", zoneId: "z1", capacity: 6 },
      { id: "b", zoneId: "z1", capacity: 2 },
      { id: "c", zoneId: "z1", capacity: 4 },
    ];
    expect(pickTables(free, 3)?.map((t) => t.id)).toEqual(["c"]);
    expect(pickTables(free, 8)?.map((t) => t.id)).toEqual(["a", "c"]);
    expect(pickTables(free, 20)).toBeNull();
  });

  it("binds an idempotency key to the canonical request", () => {
    const one = requestFingerprint("reservation.create", { a: 1, b: [2, 3] });
    expect(requestFingerprint("reservation.create", { b: [2, 3], a: 1 })).toBe(
      one,
    );
    expect(
      requestFingerprint("reservation.create", { a: 2, b: [2, 3] }),
    ).not.toBe(one);
    expect(
      requestFingerprint("reservation.cancel", { a: 1, b: [2, 3] }),
    ).not.toBe(one);
  });
});
