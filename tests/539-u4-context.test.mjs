import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  hasShiftContext,
  hasSwapContext,
} from "../apps/web/src/features/hris-requests/request-context.ts";
import { normalizeRequestQueue } from "../apps/web/src/features/hris-requests/queue.ts";
import { hasDecisionContext } from "../apps/web/src/features/hris-requests/components/queue-model.ts";
const shift = {
  id: "assignment-a",
  businessDate: "2026-11-15",
  segments: [
    { startsAt: "2026-11-15T01:00:00Z", endsAt: "2026-11-15T09:00:00Z" },
  ],
};
const cover = {
  requestedByName: "Rina",
  toEmployeeName: "Ayu",
  fromAssignmentId: shift.id,
  toAssignmentId: null,
  fromAssignment: shift,
};
describe("request decision context", () => {
  test("cover requires both names and the requested shift", () => {
    assert.equal(hasSwapContext(cover), true);
    for (const field of ["requestedByName", "toEmployeeName", "fromAssignment"])
      assert.equal(hasSwapContext({ ...cover, [field]: null }), false);
    assert.equal(hasSwapContext({ ...cover, requestedByName: "  " }), false);
    assert.equal(
      hasSwapContext({ ...cover, fromAssignmentId: "different" }),
      false,
    );
  });
  test("a true swap requires the second matching assignment", () => {
    assert.equal(
      hasSwapContext({ ...cover, toAssignmentId: "assignment-b" }),
      false,
    );
    assert.equal(
      hasSwapContext({
        ...cover,
        toAssignmentId: "assignment-b",
        toAssignment: { ...shift, id: "assignment-b" },
      }),
      true,
    );
    assert.equal(
      hasSwapContext({
        ...cover,
        toAssignmentId: "assignment-b",
        toAssignment: shift,
      }),
      false,
    );
  });
  test("an incomplete or malformed shift cannot enable a decision", () => {
    for (const value of [
      null,
      { ...shift, segments: [] },
      { ...shift, businessDate: "bad" },
      { ...shift, segments: [{ startsAt: "bad", endsAt: "bad" }] },
      {
        ...shift,
        segments: [
          { startsAt: "2026-11-15T09:00:00Z", endsAt: "2026-11-15T01:00:00Z" },
        ],
      },
    ])
      assert.equal(hasShiftContext(value), false);
  });
});

describe("queue request-scoped details", () => {
  const t = (key) => key;
  const base = {
    swaps: [],
    leaves: [],
    overtimes: [],
    employees: [],
    assignments: [],
    leaveTypes: [],
  };
  test("uses requester and shift DTO without fetching a directory or roster", () => {
    const [item] = normalizeRequestQueue(
      {
        ...base,
        swaps: [
          {
            ...cover,
            id: "swap",
            requestedBy: "employee-a",
            status: "pending",
            peerAcceptedAt: "2026-11-12T00:00:00Z",
            requestedAt: "2026-11-12T00:00:00Z",
          },
        ],
      },
      t,
    );
    assert.equal(item.employeeName, "Rina");
    assert.equal(item.employeeNameKnown, true);
    assert.match(item.period, /15 Nov 2026/);
    assert.match(item.period, /08.00.*16.00/);
    assert.equal(hasDecisionContext(item), true);
    assert.equal(
      hasDecisionContext({
        ...item,
        raw: { ...item.raw, fromAssignment: null },
      }),
      false,
    );
  });
  test("leave and overtime names come from their authorized request rows", () => {
    const items = normalizeRequestQueue(
      {
        ...base,
        leaves: [
          {
            id: "leave",
            employeeId: "employee-a",
            employeeName: "Ayu",
            startDate: "2026-11-15",
            endDate: "2026-11-16",
            requestedAt: "2026-11-12T00:00:00Z",
            status: "pending",
          },
        ],
        overtimes: [
          {
            id: "overtime",
            employeeId: "employee-b",
            employeeName: "Rina",
            date: "2026-11-15",
            minutes: 60,
            requestedAt: "2026-11-12T00:00:00Z",
            status: "pending",
          },
        ],
      },
      t,
    );
    assert.deepEqual(
      items.map((item) => item.employeeName),
      ["Ayu", "Rina"],
    );
    assert.equal(items.every(hasDecisionContext), true);
    assert.equal(
      hasDecisionContext({ ...items[0], employeeNameKnown: false }),
      false,
    );
  });
});

test("queue shift clock follows the selected outlet time zone", () => {
  const [item] = normalizeRequestQueue(
    {
      swaps: [
        {
          ...cover,
          id: "swap",
          requestedBy: "employee-a",
          requestedAt: "2026-11-12T00:00:00Z",
          status: "pending",
        },
      ],
      leaves: [],
      overtimes: [],
      employees: [],
      assignments: [],
      leaveTypes: [],
    },
    (key) => key,
    { timeZone: "Asia/Makassar" },
  );
  assert.match(item.period, /09.00.*17.00/);
});
