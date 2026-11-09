// legend-ws09 W3(b)/(c): the facility list row merge after a General save keeps
// the list-only counts, and the General tab refills from the refetched row
// after a 412 only (never after a plain refetch or a 409).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isStaleStampStatus,
  mergeFacilityRow,
  shouldRefillAfterConflict,
} from "../apps/web/src/features/facility-admin/admin-conflict.ts";

const row = (id, extra = {}) => ({
  id,
  name: `Facility ${id}`,
  sessionMinutes: 30,
  updatedAt: "2026-01-01T00:00:00.000Z",
  areaCount: 2,
  unitCount: 6,
  activeUnitCount: 5,
  productCount: 3,
  ...extra,
});

describe("facility list row merge after a General save (legend-ws09)", () => {
  test("the saved fields replace the row and the list-only counts survive", () => {
    const page = { data: [row("a"), row("b")], nextCursor: null };
    // A saved Facility DTO carries no count fields.
    const saved = {
      id: "a",
      name: "Renamed",
      sessionMinutes: 45,
      updatedAt: "2026-02-02T00:00:00.000Z",
    };
    const merged = mergeFacilityRow(page, saved);
    assert.deepEqual(merged.data[0], {
      ...row("a"),
      ...saved,
      areaCount: 2,
      unitCount: 6,
      activeUnitCount: 5,
      productCount: 3,
    });
    assert.equal(merged.data[0].name, "Renamed");
    assert.equal(merged.data[0].areaCount, 2);
  });

  test("other rows and page fields stay the same, input is not mutated", () => {
    const page = { data: [row("a"), row("b")], nextCursor: "c1" };
    const other = page.data[1];
    const merged = mergeFacilityRow(page, { id: "a", name: "X" });
    assert.equal(merged.data[1], other);
    assert.equal(merged.nextCursor, "c1");
    assert.equal(page.data[0].name, "Facility a");
  });

  test("an unknown facility leaves every row alone; no cached page stays undefined", () => {
    const page = { data: [row("a")], nextCursor: null };
    assert.deepEqual(mergeFacilityRow(page, { id: "zzz", name: "X" }).data, [
      row("a"),
    ]);
    assert.equal(mergeFacilityRow(undefined, { id: "a" }), undefined);
  });
});

describe("General tab refill after a conflict (legend-ws09)", () => {
  const formStamp = "2026-01-01T00:00:00.000Z";
  const newer = "2026-03-03T00:00:00.000Z";

  test("only a 412 counts as a stale stamp; 409 and other errors do not", () => {
    assert.equal(isStaleStampStatus(412), true);
    for (const status of [400, 404, 409, 422, 500])
      assert.equal(isStaleStampStatus(status), false);
  });

  test("refills once a conflict is pending and the refetched row is newer", () => {
    assert.equal(shouldRefillAfterConflict(true, newer, formStamp), true);
  });

  test("waits while a conflict is pending and the row still has the form stamp", () => {
    assert.equal(shouldRefillAfterConflict(true, formStamp, formStamp), false);
  });

  test("a plain refetch with no conflict never refills, so unsaved edits survive", () => {
    assert.equal(shouldRefillAfterConflict(false, newer, formStamp), false);
    assert.equal(shouldRefillAfterConflict(false, formStamp, formStamp), false);
  });
});
