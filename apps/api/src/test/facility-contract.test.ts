// Pure checks of the facility schema against the contract (no database):
// FAC-02 constraint predicate and slot arithmetic, FAC-06 unit rules, the
// slot-grid time zone helper (bead legend-nm4f).
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  SLOT_HOLD_PREDICATE_SQL,
  SLOT_RELEASING_TICKET_STATUSES,
  accessTicketStatusSchema,
  slotFromStart,
  slotsOverlap,
  ticketHoldsSlot,
} from "@starter/shared/facility";
import {
  accessTickets,
  facilities,
  facilityAreas,
  facilityQueueEntries,
  facilityUnits,
} from "../db/schema/facility.ts";
import { unitIsBookable, zonedInstant } from "../services/facility-rules.ts";

const customSql = readFileSync(
  new URL("../db/schema/facility.custom.sql", import.meta.url),
  "utf8",
);

describe("FAC-02 exclusion constraint matches the contract", () => {
  it("[FAC-02] the constraint WHERE clause is SLOT_HOLD_PREDICATE_SQL verbatim", () => {
    expect(customSql).toContain(`WHERE (${SLOT_HOLD_PREDICATE_SQL})`);
    expect(customSql).toContain("EXCLUDE USING gist");
    expect(customSql).toContain(
      `tstzrange("starts_at", "cleaning_ends_at", '[)') WITH &&`,
    );
    expect(customSql).toContain('"unit_id" WITH =');
  });

  it("[FAC-02] the predicate releases exactly the statuses ticketHoldsSlot releases", () => {
    for (const status of accessTicketStatusSchema.options)
      expect(SLOT_HOLD_PREDICATE_SQL.includes(`'${status}'`), status).toBe(
        !ticketHoldsSlot(status),
      );
    expect([...SLOT_RELEASING_TICKET_STATUSES].sort()).toEqual([
      "cancelled",
      "no_show",
      "refunded",
    ]);
  });

  it("[FAC-02] the cleaning buffer is part of the occupied range, back-to-back is not an overlap", () => {
    const config = { sessionMinutes: 20, cleaningMinutes: 10 };
    const first = slotFromStart("2030-01-15T03:00:00.000Z", config);
    expect(
      slotsOverlap(first, slotFromStart("2030-01-15T03:20:00.000Z", config)),
    ).toBe(true);
    expect(
      slotsOverlap(first, slotFromStart("2030-01-15T03:30:00.000Z", config)),
    ).toBe(false);
  });

  it("[FAC-02] every table has RLS enforced in facility.custom.sql, outlet RLS for all (all are outlet-owned)", () => {
    for (const table of [
      "facilities",
      "facility_areas",
      "facility_units",
      "access_tickets",
      "facility_queue_entries",
    ]) {
      expect(customSql).toContain(
        `app.enforce_tenant_rls('public.${table}'::regclass)`,
      );
      expect(customSql).toContain(
        `app.enforce_outlet_rls('public.${table}'::regclass)`,
      );
    }
    expect(customSql).not.toContain("CREATE EXTENSION");
  });

  it("[TEN-01] every facility table carries NOT NULL tenant_id and outlet_id", () => {
    for (const table of [
      facilities,
      facilityAreas,
      facilityUnits,
      accessTickets,
      facilityQueueEntries,
    ]) {
      const columns = getTableConfig(table).columns;
      for (const name of ["tenant_id", "outlet_id"])
        expect(
          columns.find((column) => column.name === name)?.notNull,
          `${getTableConfig(table).name}.${name}`,
        ).toBe(true);
    }
  });
});

describe("FAC-06 unit state rules", () => {
  it("[FAC-06] needs_cleaning, cleaning and maintenance are not bookable", () => {
    expect(unitIsBookable("available")).toBe(true);
    expect(unitIsBookable("in_use")).toBe(true);
    for (const status of ["needs_cleaning", "cleaning", "maintenance"] as const)
      expect(unitIsBookable(status), status).toBe(false);
  });
});

describe("outlet time zone arithmetic", () => {
  it("converts an outlet wall clock to the UTC instant (Asia/Jakarta, UTC+7)", () => {
    expect(
      zonedInstant("2030-01-15", 6 * 60, "Asia/Jakarta").toISOString(),
    ).toBe("2030-01-14T23:00:00.000Z");
  });

  it("handles a zone behind UTC", () => {
    expect(
      zonedInstant("2030-01-15", 0, "America/New_York").toISOString(),
    ).toBe("2030-01-15T05:00:00.000Z");
  });
});
