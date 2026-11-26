// Receipt F-series while the outlet's edge is down (1271 F2;
// docs/briefs/1271-edge-failover-cards.md D3, D4, "Ralat dari review K F1").
// Real PostgreSQL with RLS: fixtures are written as the migration owner (each
// scenario on its own outlet of the seeded tenant), the allocator runs through
// the real service as legend_app in its own committed transaction, as a sale
// would.
//
// Assumptions (from the brief, not from the implementation):
// - In the cloud, a device sale on an outlet an active edge serves takes the
//   device's `F<n>` run while the outlet's window is `active`; any other
//   state refuses with RECEIPT_DEVICE_ON_EDGE.
// - `F<n>` is the next free F prefix of the outlet, per device, kept across
//   outages (a second window continues the same run).
// - The device's P-run, the outlet's `C` run (series `cloud`) and every edge
//   claim/pull/retire path never see the F-run.
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { DeviceReceiptSequenceBinding } from "@starter/shared/edge";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  allocateReceipt,
  claimDeviceReceiptSequencesForEdge,
  listDeviceReceiptSequences,
  mergeDeviceReceiptRun,
  retireUnlistedDeviceReceiptSequences,
} from "../services/pos-receipt.service.ts";
import {
  createOwnerPool,
  requireDisposableDatabase,
  tenantAId,
  tenantContext,
} from "./tenant-isolation-harness.ts";

requireDisposableDatabase();

const owner = createOwnerPool();
const outletBaseId = cafeLegendPlatformFixtures.outlets[0].id;
const hex = () => randomBytes(4).toString("hex");
const context = tenantContext(tenantAId);

afterAll(async () => {
  await owner.end();
});

async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantAId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

interface Place {
  outletId: string;
  binding: DeviceReceiptSequenceBinding;
  devices: [string, string];
}

/**
 * A fresh outlet served by an active edge, two POS terminals, each with its
 * P-run bound to that edge database (as after a normal pull).
 */
async function edgeOutlet(): Promise<Place> {
  const outletId = randomUUID();
  const binding = { edgeNodeId: randomUUID(), edgeInstanceId: randomUUID() };
  const devices: [string, string] = [randomUUID(), randomUUID()];
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $3, 'Outlet uji struk F', address, opening_hours
         FROM outlets WHERE id = $2`,
      [outletId, outletBaseId, `EFR-${hex()}`.toUpperCase()],
    );
    await client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash, instance_id)
       VALUES ($1, $2, $3, 'primary', 'active', 'Mini PC uji', $4, $5)`,
      [
        binding.edgeNodeId,
        tenantAId,
        outletId,
        randomBytes(32).toString("hex"),
        binding.edgeInstanceId,
      ],
    );
    for (const [index, deviceId] of devices.entries()) {
      await client.query(
        `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
         VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute', true)`,
        [deviceId, tenantAId, outletId, `Kasir ${index + 1}`],
      );
      await client.query(
        `INSERT INTO receipt_sequences (tenant_id, outlet_id, device_id, prefix, edge_node_id, edge_instance_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenantAId,
          outletId,
          deviceId,
          `P${index + 1}`,
          binding.edgeNodeId,
          binding.edgeInstanceId,
        ],
      );
    }
  });
  return { outletId, binding, devices };
}

async function openWindow(place: Place): Promise<string> {
  const id = randomUUID();
  await asOwner((client) =>
    client.query(
      `INSERT INTO outlet_failover_windows
         (id, tenant_id, outlet_id, edge_node_id, reason, idempotency_key, activated_by, business_date_from)
       VALUES ($1, $2, $3, $4, 'Mini PC mati', $5, 'manajer-uji', '2026-11-26')`,
      [id, tenantAId, place.outletId, place.binding.edgeNodeId, `fo-${hex()}`],
    ),
  );
  return id;
}

async function moveWindow(windowId: string, to: "returning" | "closed") {
  await asOwner((client) =>
    client.query(
      to === "returning"
        ? `UPDATE outlet_failover_windows
             SET status = 'returning', return_started_at = now(),
                 return_started_by = activated_by, business_date_to = '2026-11-26'
           WHERE id = $1`
        : `UPDATE outlet_failover_windows SET status = 'closed', closed_at = now() WHERE id = $1`,
      [windowId],
    ),
  );
}

/** A completed zero-value POS order of the outlet; returns its ULID. */
async function order(outletId: string): Promise<string> {
  const orderId = createUlid();
  const uuid = ulidToUuid(orderId);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at, deposit_applied_idr, table_session_id)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', 0, 0, 0, 0, 0, 0,
               'completed', '2026-11-26', now(), 0, NULL)`,
      [uuid, tenantAId, outletId, `EFR-${hex()}`],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), now())`,
      [uuid, tenantAId, outletId],
    );
  });
  return orderId;
}

/** One cloud sale in its own transaction (as the order route commits it). */
const sell = (outletId: string, orderId: string, deviceId: string | null) =>
  withTenant(db, context, (tx) =>
    allocateReceipt(tx as never, context, {
      orderId,
      outletId,
      deviceId,
      at: new Date(),
    }),
  );

const codeOf = async (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: { code?: string }) => error.code ?? String(error),
  );

async function runs(outletId: string) {
  const result = await owner.query<{
    id: string;
    device_id: string;
    prefix: string;
    series: string;
    last_number: number;
    edge_node_id: string | null;
    retired_at: Date | null;
  }>(
    `SELECT id, device_id, prefix, series, last_number, edge_node_id, retired_at
       FROM receipt_sequences WHERE tenant_id = $1 AND outlet_id = $2
      ORDER BY prefix`,
    [tenantAId, outletId],
  );
  return result.rows;
}

async function numbersOf(outletId: string, deviceId: string) {
  const result = await owner.query<{ number: string }>(
    `SELECT number FROM pos_receipts
      WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $3
      ORDER BY sequence_number`,
    [tenantAId, outletId, deviceId],
  );
  return result.rows.map((row) => row.number);
}

const expected = (prefix: string, count: number) =>
  Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index + 1).padStart(6, "0")}`,
  );

describe("1271 F2 receipt F-series", () => {
  it("no window: a cloud device sale on an edge outlet is refused (RECEIPT_DEVICE_ON_EDGE)", async () => {
    const place = await edgeOutlet();
    const orderId = await order(place.outletId);
    expect(await codeOf(sell(place.outletId, orderId, place.devices[0]))).toBe(
      "RECEIPT_DEVICE_ON_EDGE",
    );
    expect(await numbersOf(place.outletId, place.devices[0])).toEqual([]);
  });

  it("active window: 2 terminals x 50 concurrent sales number F<n>-000001..50 gapless, P-runs untouched", async () => {
    const place = await edgeOutlet();
    await openWindow(place);
    const orders = await Promise.all(
      Array.from({ length: 100 }, () => order(place.outletId)),
    );
    const receipts = await Promise.all(
      orders.map((orderId, index) =>
        sell(place.outletId, orderId, place.devices[index % 2]!),
      ),
    );
    expect(new Set(receipts.map((receipt) => receipt.number)).size).toBe(100);

    const all = await runs(place.outletId);
    const failover = all.filter((run) => run.series === "failover");
    expect(failover.map((run) => run.prefix).sort()).toEqual(["F1", "F2"]);
    for (const run of failover) {
      expect(run.last_number).toBe(50);
      expect(run.edge_node_id).toBeNull();
      expect(run.retired_at).toBeNull();
      expect(await numbersOf(place.outletId, run.device_id)).toEqual(
        expected(run.prefix, 50),
      );
    }
    expect(new Set(failover.map((run) => run.device_id))).toEqual(
      new Set(place.devices),
    );
    // The P-runs keep their edge binding and their counter.
    const device = all.filter((run) => run.series === "device");
    expect(device.map((run) => [run.prefix, run.last_number])).toEqual([
      ["P1", 0],
      ["P2", 0],
    ]);
    for (const run of device) {
      expect(run.edge_node_id).toBe(place.binding.edgeNodeId);
      expect(run.retired_at).toBeNull();
    }
  });

  it("the F-run is kept across outages; `returning` and `closed` refuse", async () => {
    const place = await edgeOutlet();
    const device = place.devices[0];
    const first = await openWindow(place);
    expect(
      (await sell(place.outletId, await order(place.outletId), device)).number,
    ).toBe("F1-000001");
    await moveWindow(first, "returning");
    expect(
      await codeOf(sell(place.outletId, await order(place.outletId), device)),
    ).toBe("RECEIPT_DEVICE_ON_EDGE");
    await moveWindow(first, "closed");
    expect(
      await codeOf(sell(place.outletId, await order(place.outletId), device)),
    ).toBe("RECEIPT_DEVICE_ON_EDGE");
    await openWindow(place);
    expect(
      (await sell(place.outletId, await order(place.outletId), device)).number,
    ).toBe("F1-000002");
    // The other terminal gets the next free F prefix of the outlet.
    expect(
      (
        await sell(
          place.outletId,
          await order(place.outletId),
          place.devices[1],
        )
      ).number,
    ).toBe("F2-000001");
  });

  it("a cloud sale without a device keeps the `C` run (series cloud), with and without a window", async () => {
    const place = await edgeOutlet();
    expect(
      (await sell(place.outletId, await order(place.outletId), null)).number,
    ).toBe("C-000001");
    await openWindow(place);
    expect(
      (await sell(place.outletId, await order(place.outletId), null)).number,
    ).toBe("C-000002");
    const cloud = (await runs(place.outletId)).filter(
      (run) => run.device_id === place.outletId,
    );
    expect(
      cloud.map((run) => [run.prefix, run.series, run.last_number]),
    ).toEqual([["C", "cloud", 2]]);
  });

  it("claim never binds, rotates or retires an F-run; the edge pull lists none", async () => {
    const place = await edgeOutlet();
    await openWindow(place);
    for (const device of place.devices)
      await sell(place.outletId, await order(place.outletId), device);
    const before = (await runs(place.outletId)).filter(
      (run) => run.series === "failover",
    );
    expect(before).toHaveLength(2);

    const claim = await withTenant(db, context, (tx) =>
      claimDeviceReceiptSequencesForEdge(tx as never, context, {
        outletId: place.outletId,
        ...place.binding,
      }),
    );
    expect(claim.rotated).toBe(0);
    expect(claim.claimed).toBe(0);
    // A second edge database of the node: every device run rotates, F-runs stay.
    const other = { ...place.binding, edgeInstanceId: randomUUID() };
    await withTenant(db, context, (tx) =>
      claimDeviceReceiptSequencesForEdge(tx as never, context, {
        outletId: place.outletId,
        ...other,
      }),
    );
    const after = (await runs(place.outletId)).filter(
      (run) => run.series === "failover",
    );
    expect(after).toEqual(before);

    const listed = await withTenant(db, context, (tx) =>
      listDeviceReceiptSequences(tx as never, context, place.outletId, other),
    );
    expect(listed.map((run) => run.prefix).sort()).toEqual(["P3", "P4"]);
  });

  it("retire-unlisted never retires an F-run", async () => {
    const place = await edgeOutlet();
    await openWindow(place);
    await sell(place.outletId, await order(place.outletId), place.devices[0]);
    const pRun = (await runs(place.outletId)).find(
      (run) => run.prefix === "P1",
    )!;
    const retired = await withTenant(db, context, (tx) =>
      retireUnlistedDeviceReceiptSequences(
        tx as never,
        context,
        place.outletId,
        [pRun.id],
        place.binding,
      ),
    );
    // P2 is unlisted and bound to this database: retired. F1 stays.
    expect(retired).toBe(1);
    const fRun = (await runs(place.outletId)).find(
      (run) => run.prefix === "F1",
    )!;
    expect(fRun.retired_at).toBeNull();
  });

  it("an edge merge cannot land on an F-run", async () => {
    const place = await edgeOutlet();
    await openWindow(place);
    await sell(place.outletId, await order(place.outletId), place.devices[0]);
    expect(
      await codeOf(
        withTenant(db, context, (tx) =>
          mergeDeviceReceiptRun(tx as never, context, {
            sequence: {
              outletId: place.outletId,
              deviceId: place.devices[0],
              prefix: "F1",
              lastNumber: 1,
            },
            receipts: [],
          }),
        ),
      ),
    ).toBe("RECEIPT_PREFIX_MISMATCH");
  });

  it("after the edge is revoked, a cloud device sale takes a P-run, not the F-run", async () => {
    const place = await edgeOutlet();
    const window = await openWindow(place);
    await sell(place.outletId, await order(place.outletId), place.devices[0]);
    await moveWindow(window, "returning");
    await moveWindow(window, "closed");
    await asOwner((client) =>
      client.query(
        `UPDATE edge_nodes SET status = 'revoked', revoked_at = now() WHERE id = $1`,
        [place.binding.edgeNodeId],
      ),
    );
    const receipt = await sell(
      place.outletId,
      await order(place.outletId),
      place.devices[0],
    );
    expect(receipt.number).toMatch(/^P\d+-000001$/);
    const fRun = (await runs(place.outletId)).find(
      (run) => run.prefix === "F1",
    )!;
    expect([fRun.last_number, fRun.retired_at]).toEqual([1, null]);
  });
});
