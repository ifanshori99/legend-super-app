// Mock mode for `?outlets=many` (bead legend-gmcmr): the delivery desk and the
// roster read model serve the second fixture outlet's own data, not a 404 and
// not the first outlet's rows. The reservation desk is covered in
// ws08-reservation-ui.test.mjs.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { cafeLegendFixtures } from "../packages/shared/src/core/index.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import "../apps/web/src/features/ws08-delivery/mock.ts";
import "../apps/web/src/lib/mock/handlers/hris-directory.ts";

const [first, second] = cafeLegendFixtures.outlets;

const get = (path, query) => dispatchMock({ method: "GET", path, query });

beforeEach(() => resetMocks());

describe("delivery desk, second outlet", () => {
  test("serves its own channels and orders", async () => {
    const channels = await get(`/api/outlets/${second.id}/delivery-channels`);
    assert.equal(channels.data.length, 3);
    for (const row of channels.data) assert.equal(row.outletId, second.id);

    const orders = await get(`/api/outlets/${second.id}/delivery-orders`, {
      limit: 100,
    });
    assert.ok(orders.data.length > 0);
    for (const row of orders.data) assert.equal(row.outletId, second.id);

    const firstOrders = await get(`/api/outlets/${first.id}/delivery-orders`, {
      limit: 100,
    });
    const firstIds = new Set(firstOrders.data.map((row) => row.id));
    for (const row of orders.data) assert.ok(!firstIds.has(row.id));
  });

  test("an unknown outlet is still a 404", async () => {
    await assert.rejects(
      get(
        `/api/outlets/00000000-0000-4000-8000-00000000ffff/delivery-channels`,
      ),
      (error) => error.status === 404,
    );
  });
});

describe("roster read model, second outlet", () => {
  test("lists shifts for its own staff only", async () => {
    const shifts = await get("/api/hris/shifts", {
      outletId: second.id,
      from: "2026-10-26",
      to: "2026-11-01",
      limit: 100,
    });
    assert.ok(shifts.data.length > 0);
    for (const row of shifts.data) assert.equal(row.outletId, second.id);

    const employees = await get("/api/hris/employees", {
      outletId: second.id,
      limit: 100,
    });
    const staff = new Set(employees.data.map((row) => row.id));
    for (const row of shifts.data) assert.ok(staff.has(row.employeeId));
  });
});
