import assert from "node:assert/strict";
import { test } from "node:test";
import { cafeLegendHrisFixtures } from "../packages/shared/src/hris/index.ts";
import { localDateOf } from "../packages/shared/src/core/index.ts";
import { dispatchMock } from "../apps/web/src/lib/mock/runtime.ts";
import {
  MOCK_ME,
  MOCK_OUTLET,
  MOCK_SHIFT_ASSIGNMENTS,
} from "../apps/web/src/lib/mock/handlers/hris-directory.ts";
import "../apps/web/src/features/hris-requests/mock.ts";

test("employee-safe candidate mock returns home-outlet peers and their shifts", async () => {
  const source = MOCK_SHIFT_ASSIGNMENTS.find(
    (row) => row.employeeId === MOCK_ME.id && row.status === "published",
  );
  assert.ok(source, "An owned source assignment exists in the HRIS fixture");
  const peer = cafeLegendHrisFixtures.employees.find(
    (row) =>
      row.id !== MOCK_ME.id &&
      row.homeOutletId === source.outletId &&
      row.status === "active",
  );
  assert.ok(peer, "An active colleague belongs to the same home outlet");
  const businessDate = localDateOf(new Date(), MOCK_OUTLET.timeZone);
  const target = {
    ...structuredClone(source),
    id: "00000000-0000-4000-8000-000000009998",
    employeeId: peer.id,
    businessDate,
    segments: source.segments.map((segment) => ({
      startsAt: `${businessDate}T${segment.startsAt.slice(11)}`,
      endsAt: `${businessDate}T${segment.endsAt.slice(11)}`,
    })),
  };
  const originalLength = MOCK_SHIFT_ASSIGNMENTS.length;
  MOCK_SHIFT_ASSIGNMENTS.push(target);
  try {
    const response = await dispatchMock({
      method: "GET",
      path: "/api/hris/shift-swaps/candidates",
      query: {
        outletId: source.outletId,
        fromAssignmentId: source.id,
      },
    });
    assert.ok(response.data.length > 0);
    const candidate = response.data.find((row) => row.id === peer.id);
    assert.ok(candidate, "Filtering by homeOutletId retains the colleague");
    assert.equal(candidate.name, peer.fullName);
    assert.ok(candidate.assignments.length > 0);
    assert.deepEqual(
      candidate.assignments.find((row) => row.id === target.id),
      {
        id: target.id,
        businessDate,
        segments: target.segments,
        breakMinutes: target.breakMinutes,
      },
    );
    assert.ok(response.data.every((row) => row.id !== MOCK_ME.id));
  } finally {
    MOCK_SHIFT_ASSIGNMENTS.splice(originalLength);
  }
});
