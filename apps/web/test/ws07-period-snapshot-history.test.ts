// Bead legend-eukn: the period-close snapshot shows the period's current
// periodStatus/periodVersion; after a reopen the snapshot is history.
//   - the mock snapshot endpoint fills periodStatus/periodVersion like the API;
//   - a reopened (open) period still serves its last snapshot, marked history;
//   - isSnapshotHistory follows the contract: open, or a different version.
import {
  cafeLegendAccountingFixtures as fixtures,
  getPeriodSnapshot,
  requestPeriodReopen,
} from "@starter/shared/accounting";
import { dispatchMock, resetMocks } from "@/lib/mock/runtime";
import { isSnapshotHistory } from "@/features/ws07-statements/lib";
import "@/features/ws07-statements/mock";

const october = fixtures.fiscalPeriods.find((row) => row.period === "2026-10")!;

beforeEach(() => resetMocks());

async function snapshot() {
  return getPeriodSnapshot.response.parse(
    await dispatchMock({
      method: "GET",
      path: `/api/accounting/fiscal-periods/${october.id}/snapshot`,
    }),
  ).data;
}

test("a closed period's snapshot carries the current status and version", async () => {
  const data = await snapshot();
  expect(data.periodStatus).toBe("closed");
  expect(data.periodVersion).toBe(october.version);
  expect(isSnapshotHistory(data)).toBe(false);
});

test("after an approved reopen the snapshot is history", async () => {
  const request = requestPeriodReopen.response.parse(
    await dispatchMock({
      method: "POST",
      path: `/api/accounting/fiscal-periods/${october.id}/reopen-requests`,
      body: { reason: "Tagihan listrik belum dicatat." },
    }),
  ).data;
  await dispatchMock({
    method: "POST",
    path: `/api/accounting/period-reopen-requests/${request.id}/approve`,
    body: { note: null },
  });
  const data = await snapshot();
  expect(data.periodStatus).toBe("open");
  expect(data.periodVersion).toBeGreaterThan(data.version);
  expect(isSnapshotHistory(data)).toBe(true);
});

test("isSnapshotHistory: open, or version differs; older mocks stay current", () => {
  const base = { version: 4 };
  expect(isSnapshotHistory({ ...base, periodStatus: "open" })).toBe(true);
  expect(
    isSnapshotHistory({ ...base, periodStatus: "closed", periodVersion: 6 }),
  ).toBe(true);
  expect(
    isSnapshotHistory({ ...base, periodStatus: "closed", periodVersion: 4 }),
  ).toBe(false);
  expect(isSnapshotHistory(base)).toBe(false);
});
