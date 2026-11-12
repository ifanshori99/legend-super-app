// 539-U4 row D (beads legend-ydf2): the pure logic behind the employee
// "Pengajuan saya" list and the holiday calendar. The screens only render what
// these models return, so the merge order, period wording, cover-vs-swap kind
// and month grouping are checked here without React or a network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const {
  buildMyRequests,
  countRejected,
  formatDays,
  formatInstantDate,
  formatPeriod,
} =
  await import("../apps/web/src/features/hris-requests/components/my-requests-model.ts");
const { groupHolidaysByMonth, countHolidayRows, yearRange } =
  await import("../apps/web/src/features/hris-requests/components/holiday-model.ts");

const swap = (over = {}) => ({
  id: "swap-1",
  fromAssignmentId: "asg-1",
  toAssignmentId: "asg-2",
  status: "pending",
  requestedAt: "2026-11-10T03:00:00.000Z",
  decidedAt: null,
  ...over,
});
const leave = (over = {}) => ({
  id: "leave-1",
  leaveTypeId: "lt-1",
  startDate: "2026-11-18",
  endDate: "2026-11-19",
  days: "2.0000",
  status: "rejected",
  requestedAt: "2026-11-11T03:00:00.000Z",
  decidedAt: "2026-11-12T03:00:00.000Z",
  ...over,
});
const overtime = (over = {}) => ({
  id: "ot-1",
  date: "2026-11-20",
  minutes: 90,
  status: "approved",
  requestedAt: "2026-11-09T03:00:00.000Z",
  decidedAt: "2026-11-09T05:00:00.000Z",
  ...over,
});

describe("buildMyRequests", () => {
  test("empty sources give an empty list", () => {
    assert.deepEqual(buildMyRequests({}), []);
  });

  test("merges the three lists newest submission first", () => {
    const items = buildMyRequests({
      swaps: [swap()],
      leaves: [leave()],
      overtimes: [overtime()],
    });
    assert.deepEqual(
      items.map((item) => item.key),
      ["leave:leave-1", "swap:swap-1", "overtime:ot-1"],
    );
  });

  test("a swap without a target shift is a cover (ganti shift)", () => {
    const [cover, trade] = buildMyRequests({
      swaps: [
        swap({
          id: "c",
          toAssignmentId: null,
          requestedAt: "2026-11-11T00:00:00.000Z",
        }),
        swap({ id: "t" }),
      ],
    });
    assert.equal(cover.kind, "cover");
    assert.equal(trade.kind, "swap");
  });

  test("leave shows the type name, period days and decision", () => {
    const [item] = buildMyRequests({
      leaves: [leave()],
      leaveTypeNames: new Map([["lt-1", "Cuti tahunan"]]),
    });
    assert.equal(item.title, "Cuti tahunan");
    assert.equal(item.days, "2");
    assert.equal(item.status, "rejected");
    assert.equal(item.decidedAt, "2026-11-12T03:00:00.000Z");
  });

  test("an unknown leave type keeps a null title so the kind label shows", () => {
    const [item] = buildMyRequests({ leaves: [leave()] });
    assert.equal(item.title, null);
  });

  test("a swap takes its date from the employee's own shifts when known", () => {
    const [known] = buildMyRequests({
      swaps: [swap()],
      assignmentDates: new Map([["asg-1", "2026-11-25"]]),
    });
    assert.equal(known.startDate, "2026-11-25");
    const [unknown] = buildMyRequests({ swaps: [swap()] });
    assert.equal(unknown.startDate, null);
  });

  test("overtime keeps minutes and no days", () => {
    const [item] = buildMyRequests({ overtimes: [overtime()] });
    assert.equal(item.minutes, 90);
    assert.equal(item.days, null);
  });

  test("equal submission times keep a stable order", () => {
    const at = "2026-11-10T03:00:00.000Z";
    const keys = buildMyRequests({
      swaps: [
        swap({ id: "b", requestedAt: at }),
        swap({ id: "a", requestedAt: at }),
      ],
    }).map((item) => item.key);
    assert.deepEqual(keys, ["swap:a", "swap:b"]);
  });

  test("countRejected counts only rejected requests", () => {
    const items = buildMyRequests({
      swaps: [swap({ status: "cancelled" })],
      leaves: [leave()],
      overtimes: [overtime({ status: "rejected" })],
    });
    assert.equal(countRejected(items), 2);
  });
});

describe("formatting", () => {
  test("formatDays drops the decimal4 padding", () => {
    assert.equal(formatDays("2.0000"), "2");
    assert.equal(formatDays("1.5000"), "1,5");
  });

  test("a period inside one month matches the mockup wording", () => {
    assert.equal(
      formatPeriod("2026-11-18", "2026-11-19"),
      "18–19 November 2026",
    );
  });

  test("a single day and a cross-month period", () => {
    assert.equal(formatPeriod("2026-11-18", "2026-11-18"), "18 November 2026");
    assert.match(
      formatPeriod("2026-11-28", "2026-12-02"),
      /^28 Nov – 2 Des 2026$/,
    );
  });

  test("an instant is shown as the business-zone date", () => {
    // 20:00 UTC is already the next day in Asia/Jakarta.
    assert.equal(formatInstantDate("2026-11-11T20:00:00.000Z"), "12 Nov 2026");
    assert.equal(formatInstantDate("not-a-date"), "not-a-date");
  });
});

describe("holiday calendar", () => {
  const holiday = (id, date, name, over = {}) => ({
    id,
    date,
    name,
    type: "national",
    outletId: null,
    ...over,
  });

  test("yearRange covers the whole calendar year", () => {
    assert.deepEqual(yearRange(2026), { from: "2026-01-01", to: "2026-12-31" });
  });

  test("groups by month in date order and labels days and weekdays", () => {
    const months = groupHolidaysByMonth(
      [
        holiday("c", "2026-12-25", "Hari Natal"),
        holiday("a", "2026-08-17", "Hari Kemerdekaan"),
        holiday("b", "2026-08-18", "Cuti bersama", { type: "collective" }),
      ],
      2026,
    );
    assert.deepEqual(
      months.map((m) => m.key),
      ["2026-08", "2026-12"],
    );
    assert.equal(months[0].label, "Agustus");
    assert.deepEqual(
      months[0].rows.map((r) => r.day),
      ["17", "18"],
    );
    assert.equal(months[0].rows[0].weekday, "Senin");
    assert.equal(countHolidayRows(months), 3);
  });

  test("drops rows from other years and flags single-outlet holidays", () => {
    const months = groupHolidaysByMonth(
      [
        holiday("x", "2025-12-31", "Tahun lalu"),
        holiday("y", "2026-03-01", "Libur cabang", {
          type: "company",
          outletId: "outlet-1",
        }),
      ],
      2026,
    );
    assert.equal(countHolidayRows(months), 1);
    assert.equal(months[0].rows[0].singleOutlet, true);
  });

  test("no holidays gives no months", () => {
    assert.deepEqual(groupHolidaysByMonth([], 2026), []);
  });
});
