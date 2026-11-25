// legend-1264: an edge `order.refunded` still parked (the drawer already paid the guest) leaves
// no room for a staff voucher on the same order: 422 APOLOGY_VOUCHER_NOTHING_DUE, no voucher.
//
// Run: LEGEND_TEST_FILES="src/test/refund-1264-parked-refund-voucher.test.ts" heavy pnpm test
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { owner } from "./floor-test-helpers.ts";
import { registerNode } from "./refund-1095-edge-helpers.ts";
import {
  createPosWorld,
  toUlid,
  type PaidOrder,
  type PosWorld,
} from "./refund-1095-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

let p: PosWorld;
let nodeId: string;
let parkedOrder: PaidOrder;
let parkedIssueId: string;
let freeOrder: PaidOrder;
let freeIssueId: string;

beforeAll(async () => {
  p = await createPosWorld();
  parkedOrder = await p.paidPlainOrder();
  await p.becomePosSale(parkedOrder);
  parkedIssueId = await p.reportLine(parkedOrder.rotiLine);
  freeOrder = await p.paidPlainOrder();
  await p.becomePosSale(freeOrder);
  freeIssueId = await p.reportLine(freeOrder.rotiLine);
  const node = await registerNode(p.w.tenant);
  nodeId = node.scope.edgeNodeId;
}, 240_000);

afterAll(async () => {
  await p.teardown();
});

async function parkRefund(paid: PaidOrder) {
  const ulid = toUlid(paid.orderId);
  const eventId = createUlid();
  const envelope = {
    id: eventId,
    tenantId: p.w.tenant.tenantId,
    name: "order.refunded",
    aggregateType: "order",
    aggregateId: ulid,
    sequence: 2,
    payload: { orderId: ulid },
  };
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [p.w.tenant.tenantId],
    );
    await client.query(
      `INSERT INTO edge_deferred_events
         (tenant_id, outlet_id, edge_node_id, event_id, aggregate_type, aggregate_id,
          aggregate_sequence, event_name, envelope, parked_reason)
       VALUES ($1, $2, $3, $4::uuid, 'order', $5, 2, 'order.refunded', $6::jsonb, 'deferred')`,
      [
        p.w.tenant.tenantId,
        p.w.tenant.outletId,
        nodeId,
        ulidToUuid(eventId as never),
        ulid,
        JSON.stringify(envelope),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("legend-1264 parked edge refund x staff voucher", () => {
  it("a parked order.refunded: the staff voucher is refused (NOTHING_DUE), no voucher exists", async () => {
    await parkRefund(parkedOrder);
    const issued = await p.staffVoucher(parkedIssueId, 10_000);
    expect(issued.status, JSON.stringify(issued.body)).toBe(422);
    expect(issued.body.error?.code).toBe("APOLOGY_VOUCHER_NOTHING_DUE");
    expect(await p.voucherValues(parkedIssueId)).toEqual([]);
  });

  it("control: a parked refund of another order does not block this order", async () => {
    const issued = await p.staffVoucher(freeIssueId, 10_000);
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  });
});
