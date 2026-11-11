// Contract between the access fixtures and the menu fixtures (bead legend-7art;
// brief section D). Pure fixture test, no DB: every access station must exist
// in the menu fixture stations, with the same id and the same outlet, so that
// station-scoped RBAC grants line up with real menu stations.
import { describe, expect, it } from "vitest";
import {
  accessUserSchema,
  cafeLegendAccessFixtures,
} from "@starter/shared/access";
import { cafeLegendIdentityFixtures } from "@starter/shared/identity";
import { cafeLegendMenuFixtures } from "@starter/shared/menu";

describe("access fixtures vs menu fixtures stations", () => {
  const menuStations = cafeLegendMenuFixtures.stations;

  it("has access stations to check", () => {
    expect(cafeLegendAccessFixtures.stations.length).toBeGreaterThan(0);
  });

  it.each(cafeLegendAccessFixtures.stations.map((s) => [s.code, s] as const))(
    "access station %s exists in menu fixtures with the same outletId",
    (_code, accessStation) => {
      const match = menuStations.find((s) => s.id === accessStation.id);
      expect(match, `menu station ${accessStation.id} missing`).toBeDefined();
      expect(match?.outletId).toBe(accessStation.outletId);
    },
  );
});

// legend-i6ff: GET /api/access/users rows come from the identity fixtures and
// must stay valid and resolvable against the access fixtures users.
describe("identity fixtures accessUsers vs access fixtures users", () => {
  const rows = cafeLegendIdentityFixtures.accessUsers;
  const accessUserIds = new Set(
    Object.values(cafeLegendAccessFixtures.users).map((u) => u.id),
  );

  it("has access user rows to check", () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it.each(rows.map((r) => [r.displayName, r] as const))(
    "accessUsers row %s parses with accessUserSchema",
    (_name, row) => {
      expect(accessUserSchema.safeParse(row).success).toBe(true);
    },
  );

  it("has unique userIds", () => {
    const ids = rows.map((r) => r.userId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every userId appears in access fixtures users", () => {
    const missing = rows
      .map((r) => r.userId)
      .filter((id) => !accessUserIds.has(id));
    expect(missing).toEqual([]);
  });
});
