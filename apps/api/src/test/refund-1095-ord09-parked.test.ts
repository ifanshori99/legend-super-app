// legend-1095 card B (legend-aja6g): a PARKED edge `order.voided` (refused by the ingest but
// kept in edge_deferred_events, because the cloud never ingested that sale) blocks the ORD-09
// recovery refund of the same order, and an existing ORD-09 refund keeps a later edge void out.
// One refund lane per order; the guest never gets back more than paid.
//
// Written from docs/briefs/sub-1095.md and the 771dl / 1042 edge fixtures, never from the
// implementation.
//
// Assumptions (also reported):
// - An edge node registered in the tenant makes QR ordering answer 503 EDGE_LINK_DOWN, so every
//   order and every issue is prepared BEFORE the node is registered (beforeAll), and the tests
//   only deliver edge events and resolve / deliver ORD-09 afterwards. Since E3b the resolve
//   route answers 409 POS_WRITE_ON_EDGE on an edge outlet, so ORD-09s that must reach money
//   are resolved in beforeAll too; the tests only deliver them.
// - "Parked void" = an `order.voided` (voidedFinalOrder = true) sitting in edge_deferred_events
//   with no pos_order_voids row (the 532b state: the ingest refused it, the event stays parked).
//   A void for a sale the cloud never ingested is NOT parked by the link at all (verified), so the
//   parked row is seeded directly into the table, with the registered node as its source.
// - The ORD-09 side: the resolve route answers 409, or answers 200 and delivering the event
//   opens no refund (see expectOrd09Refused in refund-1095-helpers.ts).
//
// Run: LEGEND_TEST_FILES="src/test/refund-1095-ord09-parked.test.ts" heavy pnpm test
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  edgeKit,
  registerEdgeAppliers,
  registerNode,
  resetEdge,
} from "./refund-1095-edge-helpers.ts";
import { ulidToUuid } from "@starter/shared/core";
import { owner } from "./floor-test-helpers.ts";
import {
  ORDER_PAID,
  ROTI_PAID,
  ROTI_PRICE,
  createPosWorld,
  toUlid,
  type PaidOrder,
  type PosWorld,
} from "./refund-1095-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

type Prepared = {
  paid: PaidOrder;
  issueId: string;
  approvalId: string;
};

let p: PosWorld;
let kit: ReturnType<typeof edgeKit>;
const prepared: Record<string, Prepared> = {};
let ord09First: { paid: PaidOrder; issueId: string };
let isolationX: PaidOrder;

async function prepare(): Promise<Prepared> {
  const paid = await p.paidPlainOrder();
  const { issueId, approvalId } = await p.prepareOrd09(
    paid.rotiLine,
    ROTI_PRICE,
  );
  return { paid, issueId, approvalId };
}

beforeAll(async () => {
  p = await createPosWorld();
  // Everything that needs guest ordering comes before the edge node exists.
  for (const name of ["parkedFirst", "replay", "isolationY", "race"])
    prepared[name] = await prepare();
  const filedPaid = await p.paidPlainOrder();
  ord09First = {
    paid: filedPaid,
    issueId: await p.recoveryRefundFor(
      filedPaid.rotiLine,
      ROTI_PRICE,
      ROTI_PAID,
    ),
  };
  isolationX = await p.paidPlainOrder();
  // E3b (c118a25b8): once the outlet has an edge node the cloud resolve route
  // answers 409 POS_WRITE_ON_EDGE, so the ORD-09 resolves the tests deliver
  // later are made here, before the node exists (delivery is the worker step).
  for (const name of ["isolationY", "race"]) {
    const { issueId, approvalId } = prepared[name]!;
    const resolved = await p.resolveOrd09(issueId, approvalId);
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  }

  const node = await registerNode(p.w.tenant);
  kit = edgeKit(p.w.tenant, node, {
    requestedBy: p.w.floorStaff.userId,
    approvedBy: p.w.supervisor.userId,
  });
}, 240_000);

beforeEach(() => {
  registerEdgeAppliers();
});

afterAll(async () => {
  resetEdge();
  await p.teardown();
});

/** The registered node of the tenant (needed as the source of a seeded parked event). */
async function edgeNodeId(): Promise<string> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [p.w.tenant.tenantId],
    );
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM edge_nodes WHERE tenant_id = $1 AND outlet_id = $2 LIMIT 1",
      [p.w.tenant.tenantId, p.w.tenant.outletId],
    );
    await client.query("COMMIT");
    return rows[0]!.id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * A final edge void left parked: the event row exists, no void row was written (the ingest
 * refused it). Seeded straight into edge_deferred_events with the real envelope.
 */
async function parkVoid(paid: PaidOrder) {
  const ulid = toUlid(paid.orderId);
  const event = kit.voidEvent(ulid, 2, ORDER_PAID);
  const nodeId = await edgeNodeId();
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
       VALUES ($1, $2, $3, $4::uuid, 'order', $5, 2, 'order.voided', $6::jsonb, 'deferred')`,
      [
        p.w.tenant.tenantId,
        p.w.tenant.outletId,
        nodeId,
        ulidToUuid(event.id as never),
        ulid,
        JSON.stringify(event),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  expect(await kit.parkedVoids(ulid), "void event is parked").toBe(1);
  expect(await kit.voidRows(ulid), "no void row was written").toBe(0);
  return ulid;
}

describe("legend-aja6g parked edge void x ORD-09", () => {
  it("a parked edge void first: ORD-09 is refused (409) or opens no refund", async () => {
    const { paid, issueId, approvalId } = prepared.parkedFirst!;
    await parkVoid(paid);

    await p.expectOrd09Refused(issueId, approvalId);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });

  it("the parked void delivered again does not unblock ORD-09", async () => {
    const { paid, issueId, approvalId } = prepared.replay!;
    const ulid = await parkVoid(paid);
    await kit
      .deliver([kit.voidEvent(ulid, 2, ORDER_PAID)])
      .catch(() => undefined);
    expect(await kit.voidRows(ulid)).toBe(0);

    await p.expectOrd09Refused(issueId, approvalId);
  });

  it("ORD-09 first, then edge void events: no void row is written, ORD-09 money intact", async () => {
    const { paid, issueId } = ord09First;
    const ulid = toUlid(paid.orderId);
    await kit
      .deliver([kit.voidEvent(ulid, 2, ORDER_PAID)])
      .catch(() => undefined);
    await kit
      .deliver([kit.voidEvent(ulid, 3, ORDER_PAID)])
      .catch(() => undefined);

    expect(await kit.voidRows(ulid)).toBe(0);
    expect(await p.recoveryRefundTotal([issueId])).toBe(ROTI_PAID);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });

  it("isolation: a parked void of order X does not block ORD-09 of order Y", async () => {
    await parkVoid(isolationX);
    const { paid, issueId } = prepared.isolationY!;

    const event = await p.ord09Event(issueId);
    expect(event).not.toBeNull();
    await p.deliverOrd09(event!);

    expect(await p.recoveryRefundTotal([issueId])).toBe(ROTI_PAID);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });

  // Regression only: the link never parks a void for a sale the cloud has not ingested, so
  // this race cannot produce a parked void; it checks that the two never both reach money.
  it("ORD-09 delivery racing an edge void delivery: never a void row AND a live ORD-09 refund, total <= paid", async () => {
    const { paid, issueId } = prepared.race!;
    const event = await p.ord09Event(issueId);
    expect(event).not.toBeNull();
    const ulid = toUlid(paid.orderId);

    await Promise.allSettled([
      p.deliverOrd09(event!),
      kit.deliver([kit.voidEvent(ulid, 2, ORDER_PAID)]),
    ]);

    const voided = await kit.voidRows(ulid);
    const ord09Money = await p.recoveryRefundTotal([issueId]);
    expect(voided > 0 && ord09Money > 0).toBe(false);
    await p.expectWithinPaid(paid.orderId, [issueId]);
  });
});
