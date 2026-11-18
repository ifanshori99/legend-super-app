import assert from "node:assert/strict";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  getEdgeStatus,
  listEdgeDevices,
  listPrintJobs,
} from "@starter/shared/edge";
import { dispatchMock, resetMocks } from "@/lib/mock/runtime";
import "@/features/ws02-edge/mock";

const { tenant, outlets } = cafeLegendFixtures;
const [outlet, otherOutlet] = outlets;

beforeEach(() => resetMocks());

test("EDG-03/05: mock registry devices share the active outlet scope", async () => {
  const registry = listEdgeDevices.response.parse(
    await dispatchMock({
      method: "GET",
      path: "/api/edge/devices",
      query: { outletId: outlet.id },
    }),
  );
  assert.equal(registry.data.length, 4);
  assert.ok(registry.data.some((device) => device.label === "Printer Dapur"));
  for (const device of registry.data) {
    assert.equal(device.tenantId, tenant.id);
    assert.equal(device.outletId, outlet.id);
  }

  const other = listEdgeDevices.response.parse(
    await dispatchMock({
      method: "GET",
      path: "/api/edge/devices",
      query: { outletId: otherOutlet.id },
    }),
  );
  assert.deepEqual(other.data, [], "Outlet filtering remains strict");
});

test("F5: mock status and print queue share the registry scope", async () => {
  const status = getEdgeStatus.response.parse(
    await dispatchMock({ method: "GET", path: "/api/edge/status" }),
  );
  assert.ok(status.data.edgeNode);
  assert.ok(status.data.thisDevice);
  for (const row of [
    status.data,
    status.data.edgeNode,
    status.data.thisDevice,
  ]) {
    assert.equal(row.tenantId, tenant.id);
    assert.equal(row.outletId, outlet.id);
  }

  const queue = listPrintJobs.response.parse(
    await dispatchMock({ method: "GET", path: "/api/edge/print-jobs" }),
  );
  assert.ok(queue.data.length > 0);
  for (const job of queue.data) {
    assert.equal(job.tenantId, tenant.id);
    assert.equal(job.outletId, outlet.id);
  }
});
