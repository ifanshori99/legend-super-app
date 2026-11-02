// Floor editor tests (bead legend-th7). PRD v1.7 §3 F9 "Denah & Meja":
// zones carry pay mode, service charge, minimum spend and hours; a table
// carries number, capacity, type, place on the plan and a signed QR.
//
// Two halves: the contract the screens are built on (write inputs, TEN-02) and
// the pure editor helpers in apps/web/src/features/ws03-floor-editor/lib.ts. The
// screens themselves are exercised by e2e/legend-th7.mock.spec.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as qr from "../packages/shared/src/qr-order/index.ts";
import {
  PLAN_HEIGHT,
  PLAN_WIDTH,
  basisPointsOfPercent,
  changedPlacements,
  clampLayout,
  describeZoneHours,
  findFreeSpot,
  formatRupiahInput,
  formatTimeOfDay,
  fromZoneHours,
  hasOpenDay,
  matchesTableQuery,
  moveLayout,
  percentOfBasisPoints,
  rotateLayout,
  rupiahOf,
  sortZones,
  suggestTableCode,
  tablesOfZone,
  toZoneHours,
} from "../apps/web/src/features/ws03-floor-editor/lib.ts";

const fixtures = qr.qrOrderFixtures;
const zone = fixtures.zones[0];
const table = fixtures.tables[0];
const labels = {
  days: ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"],
  everyDay: "Setiap hari",
  more: "+{count} jadwal lain",
};

test("F9 floor write endpoints exist with session-scoped paths", () => {
  const expected = [
    "GET /api/floor",
    "POST /api/floor/zones",
    "PATCH /api/floor/zones/:zoneId",
    "DELETE /api/floor/zones/:zoneId",
    "POST /api/floor/tables",
    "PATCH /api/floor/tables/:tableId",
    "DELETE /api/floor/tables/:tableId",
    "PUT /api/floor/layout",
    "POST /api/tables/:tableId/qr",
  ];
  for (const id of expected) assert.ok(id in IDS, `missing endpoint ${id}`);
  // The manager routes carry no outlet id: the server takes it from the
  // session scope, so a client cannot pick another outlet (TEN-02).
  for (const endpoint of expected
    .filter((entry) => entry.startsWith("GET /api/floor"))
    .map((entry) => IDS[entry]))
    assert.equal(endpoint.path.includes(":outletId"), false);
  assert.equal(qr.getCurrentFloor.response.shape.data, qr.floorBoardSchema);
});

const IDS = Object.fromEntries(
  Object.values(qr)
    .filter(
      (value) =>
        value &&
        typeof value === "object" &&
        typeof value.id === "string" &&
        typeof value.path === "string",
    )
    .map((endpoint) => [endpoint.id, endpoint]),
);

test("F9 a zone input takes settings only, never ids or scope", () => {
  const input = {
    name: zone.name,
    paymentMode: zone.paymentMode,
    serviceChargeBp: zone.serviceChargeBp,
    minimumSpendIdr: zone.minimumSpendIdr,
    hours: zone.hours,
  };
  const parsed = qr.createFloorZoneInputSchema.safeParse(input);
  assert.equal(parsed.success, true);
  // Defaults keep the form short: a new zone is active and sorts last.
  assert.equal(parsed.data.status, "active");
  assert.equal(parsed.data.sortOrder, 0);
  // TEN-02: a submitted tenant or outlet is rejected outright.
  assert.equal(
    qr.createFloorZoneInputSchema.safeParse({
      ...input,
      tenantId: zone.tenantId,
    }).success,
    false,
  );
  assert.equal(
    qr.createFloorZoneInputSchema.safeParse({
      ...input,
      outletId: zone.outletId,
    }).success,
    false,
  );
  // §3 F9: at least one opening window, and a service charge above 100% is not
  // a service charge.
  assert.equal(
    qr.createFloorZoneInputSchema.safeParse({ ...input, hours: [] }).success,
    false,
  );
  assert.equal(
    qr.createFloorZoneInputSchema.safeParse({
      ...input,
      serviceChargeBp: 20_000,
    }).success,
    false,
  );
});

test("F9 a zone patch changes only what it sends", () => {
  const parsed = qr.updateFloorZoneInputSchema.safeParse({
    paymentMode: "open_bill",
    minimumSpendIdr: 250_000,
  });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data, {
    paymentMode: "open_bill",
    minimumSpendIdr: 250_000,
  });
  assert.equal(qr.updateFloorZoneInputSchema.safeParse({}).success, false);
});

test("F9 a table input keeps number, capacity, type and placement", () => {
  const input = {
    zoneId: table.zoneId,
    code: table.code,
    capacity: table.capacity,
    type: table.type,
    layout: table.layout,
  };
  const parsed = qr.createTableInputSchema.safeParse(input);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.status, "available");
  assert.equal(
    qr.createTableInputSchema.safeParse({ ...input, code: "a03" }).success,
    false,
  );
  assert.equal(
    qr.createTableInputSchema.safeParse({ ...input, capacity: 0 }).success,
    false,
  );
  assert.equal(
    qr.createTableInputSchema.safeParse({
      ...input,
      layout: { ...input.layout, rotation: 45 },
    }).success,
    false,
  );
  assert.equal(
    qr.createTableInputSchema.safeParse({ ...input, tenantId: table.tenantId })
      .success,
    false,
  );
  // The whole-plan save refuses an empty list: there is nothing to save.
  assert.equal(
    qr.saveFloorLayoutInputSchema.safeParse({ placements: [] }).success,
    false,
  );
  assert.equal(
    qr.saveFloorLayoutInputSchema.safeParse({
      placements: [{ tableId: table.id, layout: table.layout }],
    }).success,
    true,
  );
});

test("F9 dragging keeps a table inside the plan and on the grid", () => {
  const moved = moveLayout(table.layout, 13, -400);
  assert.equal(moved.x % 10, 0);
  assert.equal(moved.y, 0);
  const right = moveLayout(table.layout, 99_999, 0);
  assert.equal(right.x + right.width, PLAN_WIDTH);
  const resized = clampLayout({ ...table.layout, width: 10_000, height: 1 });
  assert.equal(resized.width, PLAN_WIDTH);
  assert.equal(resized.height, 10);
  assert.ok(resized.y + resized.height <= PLAN_HEIGHT);
});

test("F9 rotating a table swaps its sides without leaving the plan", () => {
  const rotated = rotateLayout({ ...table.layout, width: 120, height: 60 });
  assert.equal(rotated.width, 60);
  assert.equal(rotated.height, 120);
  assert.equal(rotated.shape, table.layout.shape);
});

test("F9 only moved tables are saved, and unchanged ones are skipped", () => {
  const untouched = fixtures.tables[1];
  const drafts = {
    [table.id]: { ...table.layout, x: table.layout.x + 20 },
    [untouched.id]: { ...untouched.layout },
  };
  const changed = changedPlacements(drafts, fixtures.tables);
  assert.deepEqual(
    changed.map((placement) => placement.tableId),
    [table.id],
  );
  assert.deepEqual(changedPlacements({}, fixtures.tables), []);
});

test("F9 a new table lands in the first free slot of the plan", () => {
  const size = { width: 60, height: 60 };
  const spot = findFreeSpot(fixtures.tables, size);
  const overlaps = fixtures.tables.some(
    (entry) =>
      spot.x < entry.layout.x + entry.layout.width &&
      spot.x + size.width > entry.layout.x &&
      spot.y < entry.layout.y + entry.layout.height &&
      spot.y + size.height > entry.layout.y,
  );
  assert.equal(overlaps, false);
  assert.equal(spot.x % 10, 0);
  assert.equal(spot.y % 10, 0);
  // On an empty floor the first slot is the top-left corner.
  assert.deepEqual(findFreeSpot([], size), { x: 0, y: 0 });
});

test("F9 the next table number follows the zone prefix", () => {
  const indoor = tablesOfZone(fixtures.tables, zone.id);
  assert.equal(suggestTableCode(indoor, 0), "A07");
  assert.equal(suggestTableCode([], 3), "D01");
  assert.deepEqual(
    sortZones(fixtures.zones).map((entry) => entry.name),
    ["Indoor Reguler", "Taman Outdoor", "Private Room Nusantara", "WFC Corner"],
  );
});

test("F9 zone hours round-trip: days group back into one window", () => {
  const everyDay = fromZoneHours(zone.hours);
  assert.equal(everyDay.length, 7);
  assert.equal(
    everyDay.every((day) => day.open),
    true,
  );
  assert.equal(everyDay[0].start, zone.hours[0].start);
  assert.deepEqual(toZoneHours(everyDay), [
    {
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      start: zone.hours[0].start,
      end: zone.hours[0].end,
    },
  ]);

  // Weekdays open, weekend closed: two days share a window, the rest close.
  const weekdays = fromZoneHours([
    { daysOfWeek: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" },
  ]);
  assert.equal(weekdays[0].open, false);
  assert.equal(weekdays[1].open, true);
  assert.equal(hasOpenDay(weekdays), true);
  assert.deepEqual(toZoneHours(weekdays), [
    { daysOfWeek: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" },
  ]);
  assert.equal(hasOpenDay(fromZoneHours([])), false);
});

test("F9 the zone list summarises hours without inventing them", () => {
  assert.equal(
    describeZoneHours(zone.hours, labels),
    "Setiap hari 08.00–22.00",
  );
  assert.equal(
    describeZoneHours(
      [
        { daysOfWeek: [1, 2], start: "08:00", end: "18:00" },
        { daysOfWeek: [6, 0], start: "10:00", end: "22:00" },
      ],
      labels,
    ),
    "Sen, Sel 08.00–18.00 · +1 jadwal lain",
  );
  assert.equal(formatTimeOfDay("09:30"), "09.30");
});

test("F9 service charge and money inputs keep rupiah whole", () => {
  assert.equal(percentOfBasisPoints(500), 5);
  assert.equal(percentOfBasisPoints(1_250), 12.5);
  assert.equal(basisPointsOfPercent(5), 500);
  assert.equal(basisPointsOfPercent(12.5), 1_250);
  // A percent typed outside the scale is clamped, never sent as a bad rate.
  assert.equal(basisPointsOfPercent(140), 10_000);
  assert.equal(rupiahOf("Rp 500.000"), 500_000);
  assert.equal(rupiahOf("9.999.999.999.999"), 999_999_999_999);
  assert.equal(rupiahOf(""), 0);
  assert.equal(formatRupiahInput(500_000), "500.000");
  assert.equal(formatRupiahInput(0), "0");
});

test("F9 the QR sheet search matches the table number", () => {
  assert.equal(matchesTableQuery(table, "a0"), true);
  assert.equal(matchesTableQuery(table, "A03"), table.code === "A03");
  assert.equal(matchesTableQuery(table, "  "), true);
  assert.equal(matchesTableQuery(table, "zzz"), false);
});

test("ORD-10 the floor editor only switches a table on or off, never a live state", () => {
  const tableId = qr.cafeLegendQrOrderFixtures.floorBoard.tables[0].table.id;
  for (const status of ["available", "inactive"])
    assert.equal(
      qr.updateTable.body.safeParse({ status }).success,
      true,
      status,
    );
  // Emptying or occupying a table goes through updateTableStatus (ORD-10).
  for (const status of ["occupied", "reserved", "dirty"]) {
    assert.equal(qr.updateTable.body.safeParse({ status }).success, false);
    assert.equal(
      qr.createTable.body.safeParse({
        zoneId: qr.cafeLegendQrOrderFixtures.floorBoard.zones[0].id,
        code: "Z9",
        capacity: 2,
        type: "regular",
        layout: {
          x: 0,
          y: 0,
          width: 40,
          height: 40,
          rotation: 0,
          shape: "rect",
        },
        status,
      }).success,
      false,
    );
  }
  assert.ok(tableId);
});

test("ORD-04 reprinting a table QR never rotates it; only Ganti QR does", () => {
  assert.equal(qr.issueTableQr.method, "POST");
  assert.equal(qr.rotateTableQr.method, "POST");
  assert.equal(qr.rotateTableQr.path, "/api/tables/:tableId/qr/rotate");
  assert.notEqual(qr.issueTableQr.path, qr.rotateTableQr.path);
  assert.equal(qr.rotateTableQr.body, undefined);
});
