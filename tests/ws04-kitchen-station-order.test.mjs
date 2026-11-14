// Station config editor logic (bead legend-sonf). PRD v1.7 §3 F12 "KDS per
// Stasiun": reorder the KDS tabs, active toggle, print fallback per station.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStationRows,
  moveStation,
  rankLabel,
  setStationFlag,
  stationsDirty,
  toStationUpdates,
} from "../apps/web/src/features/ws04-kitchen-config/station-order.ts";

const configs = [
  {
    stationId: "c",
    displayOrder: 2,
    isActive: false,
    autoPrintFallback: false,
  },
  { stationId: "a", displayOrder: 0, isActive: true, autoPrintFallback: true },
  { stationId: "b", displayOrder: 1, isActive: true, autoPrintFallback: false },
];
const menu = [
  { id: "a", name: "Bar kopi", type: "coffee_bar" },
  { id: "b", name: "Dapur panas", type: "hot_kitchen" },
];

test("rows follow displayOrder and take names from the menu stations", () => {
  const rows = buildStationRows(configs, menu);
  assert.deepEqual(
    rows.map((row) => row.stationId),
    ["a", "b", "c"],
  );
  assert.equal(rows[0].name, "Bar kopi");
  assert.equal(rows[2].name, null);
  assert.equal(rows[2].type, null);
});

test("moving swaps neighbours and ignores the ends", () => {
  const rows = buildStationRows(configs, menu);
  const down = moveStation(rows, 0, "down");
  assert.deepEqual(
    down.map((row) => row.stationId),
    ["b", "a", "c"],
  );
  const up = moveStation(rows, 2, "up");
  assert.deepEqual(
    up.map((row) => row.stationId),
    ["a", "c", "b"],
  );
  assert.deepEqual(moveStation(rows, 0, "up"), rows);
  assert.deepEqual(moveStation(rows, 2, "down"), rows);
  assert.notEqual(moveStation(rows, 0, "up"), rows);
});

test("dirty only when order or a flag differs from the saved rows", () => {
  const saved = buildStationRows(configs, menu);
  assert.equal(stationsDirty(saved, saved), false);
  assert.equal(stationsDirty(saved, moveStation(saved, 0, "down")), true);
  const flipped = setStationFlag(saved, "b", "autoPrintFallback", true);
  assert.equal(stationsDirty(saved, flipped), true);
  // Moving a row and moving it back is clean again.
  const restored = moveStation(moveStation(saved, 0, "down"), 1, "up");
  assert.equal(stationsDirty(saved, restored), false);
  assert.equal(
    stationsDirty(
      saved,
      setStationFlag(flipped, "b", "autoPrintFallback", false),
    ),
    false,
  );
});

test("the save body numbers every station by its position", () => {
  const rows = moveStation(buildStationRows(configs, menu), 0, "down");
  assert.deepEqual(toStationUpdates(rows), [
    {
      stationId: "b",
      displayOrder: 0,
      isActive: true,
      autoPrintFallback: false,
    },
    {
      stationId: "a",
      displayOrder: 1,
      isActive: true,
      autoPrintFallback: true,
    },
    {
      stationId: "c",
      displayOrder: 2,
      isActive: false,
      autoPrintFallback: false,
    },
  ]);
});

test("rank labels are two digits", () => {
  assert.equal(rankLabel(0), "01");
  assert.equal(rankLabel(11), "12");
});
