// Refund approval limit lookup (brief 532 B1; founder Q63). The cumulative
// ceiling of a bill must be found without scanning every payment intent, order
// and POS tender of the tenant, so orders and pos_order_tenders get an index
// on (tenant_id, payment_intent_id). Two things are proven here:
//   1. Results do not change: the supervisor's cumulative Rp200.000 ceiling still
//      spans all intents of one bill and never leaks to another bill.
//   2. On a seeded tenant of 50.000 intents, 50.000 orders and 50.000 POS
//      tenders, a lookup by (tenant_id, payment_intent_id) is an index lookup on
//      the new composite index, not a sequential scan.
//
// Written from the Q63 contract and the brief, not from the implementation.
//
// Assumptions where the brief is silent:
// - The EXPLAIN runs a lookup shaped `WHERE tenant_id = $1 AND payment_intent_id
//   = $2` on orders and on pos_order_tenders (the access path the limit check
//   needs), not the limit service's own SQL, which this test must not read. The
//   plan must use an index whose definition is (tenant_id, payment_intent_id).
// - The seed lives in one transaction on a dedicated connection that is rolled
//   back, with triggers off (session_replication_role = replica), then ANALYZEd
//   inside it so the planner has statistics. Nothing is left behind.
// - Bill groupings other than the payment link are proven through the approval
//   inbox (the real service, as payment-refund-role-limits does for POS bills):
//   a prior COMPLETED refund of Rp100.000 on one intent of the bill, then a
//   pending refund on the other intent. Rp100.000 more reaches the supervisor
//   ceiling of Rp200.000 exactly and is approved; Rp100.001 is refused with
//   REFUND_APPROVAL_LIMIT_EXCEEDED. A second bill with its own prior refund must
//   not change that. Rows for these bills are committed with triggers and FKs
//   off (session_replication_role = replica) and removed the same way.
// - The new migration is numbered 0285-0286 and its journal `when` is greater
//   than that of 0334 (1794415777888), as the brief requires.
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { establishTenantContext } from "@starter/shared/core/server";
import { createApp } from "../app";
import { db } from "../db";
import { paymentRefunds } from "../db/schema/index";
import { withTenant } from "../db/tenant";
import { outletContext } from "../services/device-pin-support";
import { refundApprovalWithinLimit } from "../services/payment-refund-approval-limits";
import { openRefundChainAtRequest } from "../services/payment-refund.service";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { FakeRefundGateway } from "./refund-fake-gateway";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const ADMIN = "/api/payments/admin";
type Client = ReturnType<typeof agent>;
const SEED = 50_000;
const SUPERVISOR_LIMIT = 200_000;

const users: string[] = [];
const links: string[] = [];
const intents: string[] = [];
const refunds: string[] = [];
const orders: string[] = [];
const splits: string[] = [];
let requester: Client;
let requesterId: string;
let supervisor: Client;
let supervisorId: string;
let savedPolicies: Record<string, unknown>[] = [];
let gateway: FakeRefundGateway;
const key = () => `lookup-${randomUUID()}`;

async function roleId(template: string) {
  const result = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, template],
  );
  if (!result.rows[0]) throw new Error(`Missing role ${template}`);
  return result.rows[0].id;
}

async function grant(userId: string, template: string, scope: string | null) {
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenantId,
      userId,
      await roleId(template),
      scope === null ? "tenant" : "outlet",
      scope,
    ],
  );
}

async function user(label: string) {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const id = session.body.user.id as string;
  users.push(id);
  await verifySessionMfa(email);
  return { client, id };
}

async function seedBill(amounts: number[]) {
  const linkId = randomUUID();
  links.push(linkId);
  const paid = amounts.reduce((total, amount) => total + amount, 0);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)`,
    [
      linkId,
      tenantId,
      outletId,
      randomBytes(32).toString("hex"),
      `LKP-${linkId.slice(0, 8)}`,
      paid,
      requesterId,
    ],
  );
  const ids: string[] = [];
  for (const amount of amounts) {
    const id = randomUUID();
    intents.push(id);
    ids.push(id);
    await owner.query(
      `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
      [id, tenantId, outletId, linkId, amount, key()],
    );
    await owner.query(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [tenantId, outletId, id, `evidence-${id}`, amount],
    );
  }
  return { intentIds: ids, paid };
}

async function request(intentId: string, amountIdr: number) {
  const response = await requester
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key(),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian pesanan untuk pencarian batas",
    });
  expect(response.status).toBe(201);
  const id = response.body.data.id as string;
  refunds.push(id);
  return id;
}

const approve = (id: string) =>
  supervisor
    .post(`${ADMIN}/refunds/${id}/approve`)
    .set(originHeader)
    .send({ idempotencyKey: key() });

const paidOut = () =>
  gateway.calls.reduce((total, call) => total + call.amountIdr, 0);

async function refundStatus(id: string) {
  const result = await owner.query<{ status: string }>(
    "SELECT status FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  return result.rows[0]!.status;
}

beforeAll(async () => {
  const requesting = await user("Lookup requester");
  requester = requesting.client;
  requesterId = requesting.id;
  await grant(requesterId, "owner", null);
  const approving = await user("Lookup supervisor");
  supervisor = approving.client;
  supervisorId = approving.id;
  // Finance permits the payment admin endpoint and is the matrix's role; the
  // supervisor role sets the monetary ceiling (Rp200.000).
  await grant(approving.id, "finance", null);
  await grant(approving.id, "supervisor", outletId);
  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [tenantId],
    )
  ).rows;
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [tenantId, await roleId("finance")],
  );
});

beforeEach(() => {
  gateway = new FakeRefundGateway();
  setPaymentRefundGateway(gateway);
});
afterEach(() => setPaymentRefundGateway(null));

afterAll(async () => {
  await owner.query(
    "DELETE FROM approval_requests WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = ANY($2::text[])",
    [tenantId, refunds],
  );
  const cleanup = await owner.connect();
  try {
    await cleanup.query("BEGIN");
    await cleanup.query("SET LOCAL session_replication_role = replica");
    await cleanup.query(
      "DELETE FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])",
      [tenantId, orders],
    );
    await cleanup.query(
      "DELETE FROM bill_splits WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, splits],
    );
    await cleanup.query(
      "DELETE FROM pos_orders WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])",
      [tenantId, orders],
    );
    await cleanup.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orders,
    ]);
    await cleanup.query("COMMIT");
  } catch (error) {
    await cleanup.query("ROLLBACK");
    throw error;
  } finally {
    cleanup.release();
  }
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intents],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intents],
  );
  await owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
    intents,
  ]);
  await owner.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
    links,
  ]);
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [tenantId],
  );
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.tenant_id,
        row.action_type,
        row.threshold_idr,
        row.approver_role_id,
        row.levels,
        row.requires_distinct_actor,
      ],
    );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, users],
  );
  await owner.end();
});

describe("PAY-04 Q63 limit results with the indexed lookup", () => {
  it("a multi-intent bill is capped cumulatively at the supervisor ceiling, and nobody is paid above it", async () => {
    const bill = await seedBill([100_000, 100_000, 100_000]);
    const first = await request(bill.intentIds[0]!, 100_000);
    const second = await request(bill.intentIds[1]!, 100_000);
    expect((await approve(first)).status).toBe(200);
    expect((await approve(second)).status).toBe(200);
    expect(paidOut()).toBe(SUPERVISOR_LIMIT);

    // Rp1 more on the third intent of the same bill exceeds Rp200.000 in total.
    const third = await request(bill.intentIds[2]!, 1);
    const refused = await approve(third);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
    expect(await refundStatus(third)).toBe("pending");
    expect(paidOut()).toBe(SUPERVISOR_LIMIT);
    expect(bill.paid - paidOut()).toBeGreaterThanOrEqual(0);
  });

  it("refunds of another bill of the same tenant do not count against this bill", async () => {
    const other = await seedBill([100_000, 100_000]);
    const noise = await Promise.all(
      other.intentIds.map((id) => request(id, 100_000)),
    );
    for (const id of noise) expect((await approve(id)).status).toBe(200);
    expect(paidOut()).toBe(SUPERVISOR_LIMIT);

    const bill = await seedBill([100_000, 100_000]);
    const a = await request(bill.intentIds[0]!, 100_000);
    const b = await request(bill.intentIds[1]!, 100_000);
    expect((await approve(a)).status).toBe(200);
    expect((await approve(b)).status).toBe(200);
    expect(paidOut()).toBe(SUPERVISOR_LIMIT * 2);
    // Each bill stands at its own Rp200.000; the other bill added nothing.
  });

  it("one intent over the ceiling is still refused on a bill that has other intents", async () => {
    const bill = await seedBill([200_001, 50_000]);
    const id = await request(bill.intentIds[0]!, 200_001);
    const refused = await approve(id);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
    expect(paidOut()).toBe(0);
  });
});

// ---- other bill groupings, through the approval inbox -----------------------

async function twoIntents(amount = 150_000): Promise<[string, string]> {
  // Two separate payment links: the link must NOT be what ties them together.
  const a = (await seedBill([amount])).intentIds[0]!;
  const b = (await seedBill([amount])).intentIds[0]!;
  return [a, b];
}

// A POS order is final once completed (POS-04): it is inserted once, in its
// final shape, and never updated.
async function seedPosOrder(
  intentIds: string[],
  amountIdr = 300_000,
  orderIntentId: string | null = null,
) {
  const orderId = randomUUID();
  orders.push(orderId);
  await owner.query(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
       subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
       status, business_date, placed_at, payment_intent_id)
     VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
       'completed', '2026-11-11', now(), $6)`,
    [
      orderId,
      tenantId,
      outletId,
      `LKP-${orderId.slice(0, 8)}`,
      amountIdr,
      orderIntentId,
    ],
  );
  await owner.query(
    `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
     VALUES ($1, $2, $3, 'pos', now(), now())`,
    [orderId, tenantId, outletId],
  );
  if (intentIds.length > 0)
    await owner.query(
      "UPDATE payment_intents SET order_id = $2 WHERE id = ANY($1::uuid[])",
      [intentIds, orderId],
    );
  return orderId;
}

/** Commit rows whose parents are not seeded: triggers and FKs off for this transaction only. */
async function withoutForeignKeys(run: (client: PoolClient) => Promise<void>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await run(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Grouping = {
  name: string;
  /**
   * An intent of a POS sale is not refundable through the payment-admin path
   * (no approval request is opened), so for those groupings the same limit
   * function is called directly on the pending refund row (`limit`).
   */
  via: "inbox" | "limit";
  /** Two intents of ONE bill, tied together only through this grouping. */
  build: () => Promise<[string, string]>;
};

const GROUPINGS: Grouping[] = [
  {
    name: "payment_intents.order_id",
    via: "inbox",
    build: async () => {
      const [a, b] = await twoIntents();
      await seedPosOrder([a, b]);
      return [a, b];
    },
  },
  {
    name: "orders.payment_intent_id",
    via: "limit",
    build: async () => {
      const [a, b] = await twoIntents();
      // b carries the order id; a is known to the order only through
      // orders.payment_intent_id.
      await seedPosOrder([b], 300_000, a);
      return [a, b];
    },
  },
  {
    name: "pos_order_tenders.payment_intent_id",
    via: "limit",
    build: async () => {
      const [a, b] = await twoIntents();
      const orderId = await seedPosOrder([]);
      // Tenders of a completed order are final too: insert them with the
      // POS-04 triggers off (they are removed the same way in afterAll).
      await withoutForeignKeys(async (client) => {
        for (const intentId of [a, b])
          await client.query(
            `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider, payment_intent_id,
               amount_idr, status, requested_at, resolved_at)
             VALUES ($1, $2, $3, 'qris', 'doit', $4, 150000, 'captured', now(), now())`,
            [tenantId, outletId, orderId, intentId],
          );
      });
      return [a, b];
    },
  },
  {
    name: "bill_splits of one order",
    via: "inbox",
    build: async () => {
      const [a, b] = await twoIntents();
      const orderId = await seedPosOrder([]);
      const setId = randomUUID();
      const sessionId = randomUUID();
      const splitIds = [randomUUID(), randomUUID()];
      splits.push(...splitIds);
      await withoutForeignKeys(async (client) => {
        for (const [index, id] of splitIds.entries())
          await client.query(
            `INSERT INTO bill_splits
               (id, tenant_id, outlet_id, table_session_id, order_id, split_set_id,
                method, share_index, amount_idr, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'equal', $7, 150000, 'pending')`,
            [id, tenantId, outletId, sessionId, orderId, setId, index],
          );
        await client.query(
          "UPDATE payment_intents SET bill_split_id = $2 WHERE tenant_id = $3 AND id = $1",
          [a, splitIds[0], tenantId],
        );
        await client.query(
          "UPDATE payment_intents SET bill_split_id = $2 WHERE tenant_id = $3 AND id = $1",
          [b, splitIds[1], tenantId],
        );
      });
      return [a, b];
    },
  },
  {
    name: "reservation",
    via: "inbox",
    build: async () => {
      const [a, b] = await twoIntents();
      const reservationId = randomUUID();
      await withoutForeignKeys(async (client) => {
        await client.query(
          "UPDATE payment_intents SET reservation_id = $2 WHERE tenant_id = $3 AND id = ANY($1::uuid[])",
          [[a, b], reservationId, tenantId],
        );
      });
      return [a, b];
    },
  },
];

async function rawRefund(
  intentId: string,
  amountIdr: number,
  status: "pending" | "completed",
) {
  const id = randomUUID();
  refunds.push(id);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
       requested_by, approved_by, decided_at, completed_at, provider_ref)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dari modul pesanan', $6, $7,
       $8, $9, $9, $10)`,
    [
      id,
      tenantId,
      outletId,
      intentId,
      amountIdr,
      status,
      requesterId,
      // payment_refunds_distinct_approver_check: the approver is not the requester.
      status === "completed" ? supervisorId : null,
      status === "completed" ? new Date() : null,
      status === "completed" ? `prior-${id}` : null,
    ],
  );
  return id;
}

async function decideInbox(refundId: string) {
  const context = outletContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    outletId,
  );
  await withTenant(db, context, async (tx) => {
    const [refund] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, tenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    if (!refund) throw new Error("Missing refund");
    await openRefundChainAtRequest(tx, context, refund, new Date());
  });
  const pending = await owner.query<{ id: string }>(
    "SELECT id FROM approval_requests WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2 AND status = 'pending' ORDER BY level",
    [tenantId, refundId],
  );
  const requestId = pending.rows[0]!.id;
  const response = await supervisor
    .post(`/api/approvals/${requestId}/decisions`)
    .set(originHeader)
    .set("Idempotency-Key", key())
    .send({ decision: "approved", reason: "Bukti pengembalian sesuai" });
  const stored = await owner.query<{
    status: string;
    decided_by: string | null;
  }>("SELECT status, decided_by FROM approval_requests WHERE id = $1", [
    requestId,
  ]);
  return { response, stored: stored.rows[0]! };
}

/**
 * Decide a pending refund through the grouping's path. Returns whether the
 * supervisor's Q63 authority covers it; `inbox` also proves nothing was
 * recorded when it does not.
 */
async function decide(grouping: Grouping, refundId: string) {
  if (grouping.via === "inbox") {
    const { response, stored } = await decideInbox(refundId);
    if (response.status === 403) {
      expect(response.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
      expect(stored).toEqual({ status: "pending", decided_by: null });
      return false;
    }
    expect(response.status).toBe(200);
    expect(stored.status).toBe("approved");
    expect(stored.decided_by).not.toBeNull();
    return true;
  }
  const context = outletContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    outletId,
  );
  return withTenant(db, context, async (tx) => {
    const [refund] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, tenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    if (!refund) throw new Error("Missing refund");
    return refundApprovalWithinLimit(
      tx,
      context,
      supervisorId,
      refund,
      new Date(),
    );
  });
}

describe("PAY-04 Q63 limit results for every bill grouping", () => {
  for (const grouping of GROUPINGS) {
    it(`bill grouped by ${grouping.name}: Rp100.001 more after Rp100.000 is refused, so the bill never exceeds Rp200.000`, async () => {
      const [a, b] = await grouping.build();
      await rawRefund(a, 100_000, "completed");
      const current = await rawRefund(b, 100_001, "pending");
      expect(await decide(grouping, current)).toBe(false);
      expect(gateway.calls).toHaveLength(0);
    });

    it(`bill grouped by ${grouping.name}: exactly Rp200.000 in total is approved and another bill's refund does not count`, async () => {
      // Another bill of the same kind with its own Rp100.000 refund first: if
      // it were counted against this bill the Rp200.000 total would be refused.
      const [otherA] = await grouping.build();
      await rawRefund(otherA, 100_000, "completed");

      const [a, b] = await grouping.build();
      await rawRefund(a, 100_000, "completed");
      const current = await rawRefund(b, 100_000, "pending");
      expect(await decide(grouping, current)).toBe(true);
      // Approval only: nothing is paid before the payout step.
      expect(gateway.calls).toHaveLength(0);
    });
  }
});

describe("PAY-04 Q63 limit lookup uses the new indexes", () => {
  type PlanNode = {
    "Node Type": string;
    "Relation Name"?: string;
    "Index Name"?: string;
    Plans?: PlanNode[];
  };
  const flatten = (node: PlanNode): PlanNode[] => [
    node,
    ...(node.Plans ?? []).flatMap(flatten),
  ];

  // Each access path the refund authority needs, with the index that must lead it.
  const INDEXES = [
    ["orders", "payment_intent_id"],
    ["pos_order_tenders", "payment_intent_id"],
    ["payment_intents", "order_id"],
    ["payment_intents", "bill_split_id"],
    ["payment_intents", "reservation_id"],
    ["bill_splits", "order_id"],
  ] as const;
  const leading = (column: string) => new RegExp(`\\(tenant_id, ${column}\\b`);

  it("each table has an index starting with the (tenant_id, <column>) pair its lookup needs", async () => {
    for (const [table, column] of INDEXES) {
      const result = await owner.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1",
        [table],
      );
      expect(
        result.rows.some((row) => leading(column).test(row.indexdef)),
        `${table} needs an index on (tenant_id, ${column})`,
      ).toBe(true);
    }
  });

  it("on 50.000 seeded rows each lookup is an index lookup on that index, not a scan of the tenant", async () => {
    const orderTarget = randomUUID();
    const splitTarget = randomUUID();
    const reservationTarget = randomUUID();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at,
           order_id, bill_split_id, reservation_id)
         SELECT gen_random_uuid(), $1, $2, gen_random_uuid(), 'qris', 'doit', 10000, 'seed-' || n || '-' || gen_random_uuid(), 'paid', now(),
                '{"method":"qris","qrPayload":"test","issuer":null}'::jsonb, now(),
                CASE WHEN n = 25000 THEN $4::uuid ELSE gen_random_uuid() END,
                CASE WHEN n = 25000 THEN $5::uuid ELSE gen_random_uuid() END,
                CASE WHEN n = 25000 THEN $6::uuid ELSE gen_random_uuid() END
         FROM generate_series(1, $3::int) AS n`,
        [tenantId, outletId, SEED, orderTarget, splitTarget, reservationTarget],
      );
      // One order, one POS tender and one bill split per seeded intent.
      const { rows: target } = await client.query<{ id: string }>(
        "SELECT id FROM payment_intents WHERE tenant_id = $1 AND idempotency_key LIKE 'seed-25000-%'",
        [tenantId],
      );
      const intentId = target[0]!.id;
      await client.query(
        `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
           subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
           status, business_date, placed_at, payment_intent_id)
         SELECT gen_random_uuid(), $1, $2, 'LKP-' || n || '-' || substr(gen_random_uuid()::text, 1, 8), 'pos', 'takeaway', 'pay_first',
                10000, 0, 0, 0, 0, 10000, 'completed', '2026-11-11', now(),
                CASE WHEN n = 25000 THEN $4::uuid ELSE gen_random_uuid() END
         FROM generate_series(1, $3::int) AS n`,
        [tenantId, outletId, SEED, intentId],
      );
      await client.query(
        `INSERT INTO pos_order_tenders (id, tenant_id, outlet_id, order_id, method, provider, payment_intent_id,
           amount_idr, status, requested_at, resolved_at)
         SELECT gen_random_uuid(), $1, $2, gen_random_uuid(), 'qris', 'doit',
                CASE WHEN n = 25000 THEN $4::uuid ELSE gen_random_uuid() END,
                10000, 'captured', now(), now()
         FROM generate_series(1, $3::int) AS n`,
        [tenantId, outletId, SEED, intentId],
      );
      await client.query(
        `INSERT INTO bill_splits (id, tenant_id, outlet_id, table_session_id, order_id, split_set_id,
           method, share_index, amount_idr, status)
         SELECT gen_random_uuid(), $1, $2, gen_random_uuid(),
                CASE WHEN n = 25000 THEN $4::uuid ELSE gen_random_uuid() END,
                gen_random_uuid(), 'equal', n % 30000, 10000, 'pending'
         FROM generate_series(1, $3::int) AS n`,
        [tenantId, outletId, SEED, orderTarget],
      );
      for (const table of [
        "payment_intents",
        "orders",
        "pos_order_tenders",
        "bill_splits",
      ])
        await client.query(`ANALYZE ${table}`);

      const targets: Record<string, string> = {
        "orders.payment_intent_id": intentId,
        "pos_order_tenders.payment_intent_id": intentId,
        "payment_intents.order_id": orderTarget,
        "payment_intents.bill_split_id": splitTarget,
        "payment_intents.reservation_id": reservationTarget,
        "bill_splits.order_id": orderTarget,
      };
      for (const [table, column] of INDEXES) {
        const value = targets[`${table}.${column}`]!;
        const explained = await client.query<{
          "QUERY PLAN": { Plan: PlanNode }[];
        }>(
          // Literals (all UUIDs from this test) so the planner sees the
          // values, as it does for a bound parameter in a custom plan.
          `EXPLAIN (FORMAT JSON) SELECT * FROM ${table} WHERE tenant_id = '${tenantId}' AND ${column} = '${value}'`,
        );
        const nodes = flatten(explained.rows[0]!["QUERY PLAN"][0]!.Plan);
        const onTable = nodes.filter((node) => node["Relation Name"] === table);
        expect(
          onTable.some((node) => /Seq Scan/.test(node["Node Type"])),
          `${table}.${column} lookup must not be a sequential scan`,
        ).toBe(false);
        const indexNames = nodes
          .map((node) => node["Index Name"])
          .filter((name): name is string => Boolean(name));
        expect(indexNames.length).toBeGreaterThan(0);
        const defs = await client.query<{ indexdef: string }>(
          "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1::text[])",
          [indexNames],
        );
        expect(
          defs.rows.some((row) => leading(column).test(row.indexdef)),
          `${table}.${column} lookup must use the (tenant_id, ${column}) index`,
        ).toBe(true);
      }
    } finally {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
  });
});

describe("PAY-04 Q63 migration hygiene for the index migration", () => {
  it("a migration numbered 0285-0286 creates both indexes and its journal entry is newer than 0334", () => {
    const dir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
    const files = readdirSync(dir).filter((name) =>
      /^028[56]_.+\.sql$/.test(name),
    );
    const sql = files
      .map((name) => readFileSync(`${dir}${name}`, "utf8"))
      .join("\n");
    for (const table of ["orders", "pos_order_tenders"])
      expect(
        new RegExp(
          `CREATE INDEX[^;]*ON "?${table}"?[^;]*\\("?tenant_id"?,\\s*"?payment_intent_id"?\\)`,
          "is",
        ).test(sql),
        `a 028x migration must index ${table} (tenant_id, payment_intent_id)`,
      ).toBe(true);

    const journal = JSON.parse(
      readFileSync(`${dir}meta/_journal.json`, "utf8"),
    ) as { entries: { idx: number; when: number; tag: string }[] };
    const mine = journal.entries.filter((entry) => /^028[56]_/.test(entry.tag));
    expect(mine.length).toBeGreaterThan(0);
    for (const entry of mine)
      expect(entry.when, entry.tag).toBeGreaterThan(1_794_415_777_888);
    // Only the new entries are checked: older entries are not in `when` order
    // by idx and are not this change's concern.
    const base = journal.entries.find(
      (entry) => entry.tag === "0284_unallocated_fund_live_refund_uq",
    );
    expect(base, "journal entry 0284").toBeDefined();
    const ordered = [...mine].sort((a, b) => a.idx - b.idx);
    for (const entry of ordered)
      expect(entry.when, entry.tag).toBeGreaterThan(base!.when);
    for (let i = 1; i < ordered.length; i++)
      expect(ordered[i]!.when, ordered[i]!.tag).toBeGreaterThan(
        ordered[i - 1]!.when,
      );
  });
});
