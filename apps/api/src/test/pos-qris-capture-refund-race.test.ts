// POS QRIS capture vs gateway refund on the same intent (bead legend-r5brx,
// tier K / money).
//
// Invariant: the paid webhook never captures a POS QRIS tender with money of
// an intent that an approved or completed refund already takes. A refund
// still pending does not block the capture: its approval then finds the
// captured tender holding the intent and fails `cap_exceeded` (the sale wins).
// Before the fix `handlePosPaymentPaid` captured the tender without taking the
// payment_intents row lock and without reading the intent's refunds, so a
// refund approved in between paid the guest back for a sale that then counted
// the same money: the guest was paid twice.
//
// Written from the sub-brief (docs/briefs/sub-181-refund-payout-followups.md
// section P2). Real Express app, Better Auth, services and PostgreSQL. Rows
// follow payment-refund-pos-tender-guard.test.ts (raw paid intent, link,
// evidence, open POS order, authorized QRIS tender); the stall technique
// follows dp-intent-lock-race.test.ts (temp trigger waiting on an advisory
// key, pg_locks / pg_blocking_pids polled, never slept).
//
// Assumptions where the brief is not exact:
// - The webhook is `handlePosPaymentPaid` called directly with a minimal
//   `payment.paid` envelope (it reads only `name` and `payload`).
// - The tender stores the paid intent (payment_intent_id = I) and its link, so
//   it holds I both before and after legend-060xt (link matching).
// - "The order is not paid" = no captured tender on it and its status is
//   unchanged (`awaiting_payment`).
// - C2: rows a step adds while the other transaction holds the intent row lock
//   are inserted with session_replication_role = replica, so their foreign key
//   check (FOR KEY SHARE on payment_intents) does not queue behind that lock.
//   In C2(b) the tender is added after approve read the balance: that is how
//   a refund gets approved while the money is about to pay a tender.
// - C1 approves its refund raw (status approved, a distinct approver), as the
//   approve route leaves it before the payout.
// - "No deadlock" = both sides settle, no 40P01, no 5xx, no throw.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import {
  handlePosPaymentPaid,
  type DomainEvent,
} from "../services/pos-order-payment";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { FakeRefundGateway } from "./refund-fake-gateway";
import {
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";

const ADMIN = "/api/payments/admin";
const GUARD_CODE = "REFUND_INTENT_IN_POS_SALE";
// A business day no other test closes for outlet A.
const BUSINESS_DATE = "2031-03-14";

async function asOwner<T>(
  run: (client: PoolClient) => Promise<T>,
  { replica = false }: { replica?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
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

const app = createApp();
let staff: Staff;
let approver: ReturnType<typeof agent>; // finance + outlet supervisor, never the requester
const approverUserIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
const orderIds: string[] = [];
let holdKey = 7_181_000;

const key = (prefix = "race") => `${prefix}-${randomUUID()}`;

const scope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

type Bill = {
  orderId: string;
  linkId: string;
  intentId: string;
  amountIdr: number;
};

/**
 * An open POS order of `amountIdr` and a QRIS link + intent the guest has
 * paid in full (evidence written, intent `paid`), as the WS-05 webhook leaves
 * them before the POS consumer runs. The tender is added by `addTender`.
 */
async function paidBill(amountIdr: number): Promise<Bill> {
  const orderId = randomUUID();
  const linkId = randomUUID();
  const intentId = randomUUID();
  orderIds.push(orderId);
  linkIds.push(linkId);
  intentIds.push(intentId);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
         'awaiting_payment', $6, now())`,
      [
        orderId,
        seededTenantId,
        seededOutletA,
        `CR-${randomUUID().slice(0, 8)}`,
        amountIdr,
        BUSINESS_DATE,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
       VALUES ($1, $2, $3, 'pos', now())`,
      [orderId, seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'capture-race-test')`,
      [
        linkId,
        seededTenantId,
        seededOutletA,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `CR-${linkId.slice(0, 8)}`,
        amountIdr,
      ],
    );
    await client.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
          idempotency_key, status, instructions, expires_at, paid_at, provider_ref)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid',
               '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
               now() + interval '1 hour', now(), $7)`,
      [
        intentId,
        seededTenantId,
        seededOutletA,
        linkId,
        amountIdr,
        `cr-pay-${intentId}`,
        `ref-${intentId.slice(0, 8)}`,
      ],
    );
    await client.query(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [
        seededTenantId,
        seededOutletA,
        intentId,
        `evidence-${intentId}`,
        amountIdr,
      ],
    );
  });
  return { orderId, linkId, intentId, amountIdr };
}

/**
 * A second paid intent on the bill's link, paid `secondsEarlier` before the
 * counted one: the link was already covered, so WS-05 flagged it
 * `double_payment` and moved its whole amount to an unallocated fund.
 */
async function doublePaidIntent(
  bill: Bill,
  secondsEarlier: number,
): Promise<string> {
  const intentId = randomUUID();
  intentIds.push(intentId);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
          idempotency_key, status, instructions, expires_at, paid_at, provider_ref, flags)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid',
               '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
               now() + interval '1 hour', now() - make_interval(secs => $7), $8,
               ARRAY['double_payment']::text[])`,
      [
        intentId,
        seededTenantId,
        seededOutletA,
        bill.linkId,
        bill.amountIdr,
        `cr-dbl-${intentId}`,
        secondsEarlier,
        `ref-${intentId.slice(0, 8)}`,
      ],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())
       RETURNING id`,
      [
        seededTenantId,
        seededOutletA,
        intentId,
        `evidence-${intentId}`,
        bill.amountIdr,
      ],
    );
    await client.query(
      `INSERT INTO payment_unallocated_funds (tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, $5, 'double_payment')`,
      [seededTenantId, seededOutletA, intentId, rows[0]!.id, bill.amountIdr],
    );
  });
  return intentId;
}

const requestRefund = (intentId: string, amountIdr: number) =>
  staff.client
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key("req"),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian uji balapan capture",
    });

/** The bill's authorized QRIS tender (link + paid intent); returns its id. */
async function addTender(
  bill: Bill,
  { replica = false }: { replica?: boolean } = {},
): Promise<string> {
  return asOwner(
    async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
            payment_link_id, payment_link_token_sealed, payment_intent_id, amount_idr,
            status, requested_at)
         VALUES ($1, $2, $3, 'qris', 'doit', $4, 'sealed-test-token', $5, $6,
                 'authorized', now())
         RETURNING id`,
        [
          seededTenantId,
          seededOutletA,
          bill.orderId,
          bill.linkId,
          bill.intentId,
          bill.amountIdr,
        ],
      );
      return rows[0]!.id;
    },
    { replica },
  );
}

/**
 * A refund of the intent filed by `staff`, still `pending` or (`approved`)
 * already approved by the finance approver.
 */
async function pendingRefund(
  intentId: string,
  amountIdr: number,
  {
    replica = false,
    approved = false,
  }: { replica?: boolean; approved?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await asOwner(
    (client) =>
      client.query(
        `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
            requested_by, approved_by, decided_at)
         VALUES ($1, $2, $3, $4, $5, 'Refund uji balapan capture', $6, $7, $8, $9)`,
        [
          id,
          seededTenantId,
          seededOutletA,
          intentId,
          amountIdr,
          approved ? "approved" : "pending",
          staff.userId,
          approved ? approverUserIds[0] : null,
          approved ? new Date() : null,
        ],
      ),
    { replica },
  );
  return id;
}

/** Sends the approve call at once (a supertest request is lazy until then). */
const approveRefund = (refundId: string) =>
  approver
    .post(`${ADMIN}/refunds/${refundId}/approve`)
    .set(originHeader)
    .send({ idempotencyKey: key("apr") })
    .then((response) => response);

/** The verified `payment.paid` of the bill, as the outbox consumer hands it. */
const deliverPaid = (bill: Bill) =>
  handlePosPaymentPaid(scope(), {
    name: "payment.paid",
    payload: { paymentLinkId: bill.linkId, intentId: bill.intentId },
  } as unknown as DomainEvent);

async function tenderOf(tenderId: string) {
  const { rows } = await owner.query<{
    status: string;
    payment_intent_id: string | null;
  }>(
    "SELECT status, payment_intent_id FROM pos_order_tenders WHERE tenant_id = $1 AND id = $2",
    [seededTenantId, tenderId],
  );
  return rows[0];
}

async function orderState(orderId: string) {
  const { rows } = await owner.query<{ status: string; captured: string }>(
    `SELECT o.status,
            (SELECT count(*) FROM pos_order_tenders t
              WHERE t.tenant_id = o.tenant_id AND t.order_id = o.id
                AND t.status = 'captured')::text AS captured
       FROM orders o WHERE o.tenant_id = $1 AND o.id = $2`,
    [seededTenantId, orderId],
  );
  return rows[0];
}

async function refundRows(intentId: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    amount: string;
    requested_by: string;
  }>(
    "SELECT id, status, amount_idr::text AS amount, requested_by FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY created_at",
    [seededTenantId, intentId],
  );
  return rows;
}

/** Sum of every refund of the intent that is not `failed`. */
const reservedOf = async (intentId: string) =>
  (await refundRows(intentId))
    .filter((row) => row.status !== "failed")
    .reduce((sum, row) => sum + Number(row.amount), 0);

/**
 * Stalls the next UPDATE on `table` matching `when` until `release()`: a temp
 * BEFORE UPDATE trigger waits on an advisory lock this test holds.
 * `waitForStalled()` returns the stalled backend's pid.
 */
async function stallUpdates(
  table: "pos_order_tenders" | "payment_refunds",
  when: string,
) {
  const hold = holdKey++;
  const blocker = await owner.connect();
  const name = `cr_stall_${hold}`;
  const { rows } = await blocker.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const blockerPid = rows[0]!.pid;
  await blocker.query("SELECT pg_advisory_lock($1)", [hold]);
  await owner.query(`
    CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN PERFORM pg_advisory_xact_lock(${hold}); RETURN NEW; END $f$`);
  await owner.query(`
    CREATE TRIGGER ${name} BEFORE UPDATE ON ${table}
    FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}()`);
  return {
    async waitForStalled(): Promise<number> {
      for (let attempt = 0; attempt < 400; attempt++) {
        const { rows: waiters } = await owner.query<{ pid: number }>(
          `SELECT pid FROM pg_locks
           WHERE locktype = 'advisory' AND NOT granted
             AND $1::int = ANY(pg_blocking_pids(pid)) LIMIT 1`,
          [blockerPid],
        );
        if (waiters[0]) return waiters[0].pid;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("The writer never reached the stalling trigger");
    },
    async release() {
      await blocker
        .query("SELECT pg_advisory_unlock_all()")
        .catch(() => undefined);
    },
    async cleanup() {
      await blocker
        .query("SELECT pg_advisory_unlock_all()")
        .catch(() => undefined);
      await owner
        .query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`)
        .catch(() => undefined);
      await owner
        .query(`DROP FUNCTION IF EXISTS ${name}()`)
        .catch(() => undefined);
      blocker.release();
    },
  };
}

/**
 * While the writer with backend `holderPid` is stalled, which happens first:
 * the competing call settles ("settled") or it waits on a row lock of the
 * bill's POS order or payment_intents held by the stalled writer ("blocked")?
 * Refund paths lock the POS order (the capture's first row) before the
 * intent (lockRefundGraph), so they queue on pos_orders first. Polled, bounded.
 */
async function raceAgainstStalled(
  holderPid: number,
  competitor: Promise<unknown>,
): Promise<"blocked" | "settled"> {
  let settled = false;
  void competitor.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let attempt = 0; attempt < 600; attempt++) {
    if (settled) return "settled";
    const { rows } = await owner.query(
      `SELECT a.pid FROM pg_stat_activity a
       WHERE a.datname = current_database()
         AND $1::int = ANY(pg_blocking_pids(a.pid))
         AND EXISTS (SELECT 1 FROM pg_locks l
                     WHERE l.pid = a.pid AND l.locktype = 'tuple'
                       AND l.relation IN ('pos_orders'::regclass,
                                          'payment_intents'::regclass))
       LIMIT 1`,
      [holderPid],
    );
    if (rows[0]) return "blocked";
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Competitor neither settled nor waited on the intent lock");
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Capture Race Owner",
  });
  await verifySessionMfa(staff.email);
  approver = agent(app);
  const approverEmail = await signUp(approver, "Capture Race Finance");
  const approverSession = await approver.get("/api/auth/get-session");
  const approverId = approverSession.body.user.id as string;
  approverUserIds.push(approverId);
  await verifySessionMfa(approverEmail);
  const roleId = async (templateKey: string) =>
    (
      await owner.query<{ id: string }>(
        "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
        [seededTenantId, templateKey],
      )
    ).rows[0]!.id;
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [seededTenantId, approverId, await roleId("finance")],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [seededTenantId, approverId, await roleId("supervisor"), seededOutletA],
  );
  // One tier for every amount: Finance decides in a single level.
  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [seededTenantId],
    )
  ).rows;
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [seededTenantId],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [seededTenantId, await roleId("finance")],
  );
});

afterAll(async () => {
  setPaymentRefundGateway(null);
  const { rows: refunds } = await owner.query<{ id: string }>(
    "SELECT id FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM approval_requests WHERE object_type = 'payment_refund' AND object_id = ANY($1::text[])",
    [refunds.map((r) => r.id)],
  );
  // Refund, tender and order rows may be immutable once final: skip user
  // triggers in a dedicated transaction.
  await asOwner(
    async (client) => {
      await client.query(
        "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
        [intentIds],
      );
      await client.query(
        "DELETE FROM payment_unallocated_funds WHERE payment_intent_id = ANY($1::uuid[])",
        [intentIds],
      );
      await client.query(
        "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
        [intentIds],
      );
      for (const table of ["pos_order_tenders", "pos_orders"])
        await client.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])`,
          [seededTenantId, orderIds],
        );
      await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
        orderIds,
      ]);
      await client.query(
        "DELETE FROM payment_intents WHERE tenant_id = $1 AND id = ANY($2)",
        [seededTenantId, intentIds],
      );
      await client.query(
        "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2)",
        [seededTenantId, linkIds],
      );
    },
    { replica: true },
  );
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [seededTenantId],
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
    [seededTenantId, approverUserIds],
  );
  await owner.end();
});

describe("legend-r5brx the paid webhook never captures money a refund reserves", () => {
  it("legend-r5brx C1 a refund approved before the webhook: the tender is voided, the order stays unpaid, and the late refund returns only the rest", async () => {
    const bill = await paidBill(100_000);
    const tenderId = await addTender(bill);
    // Approved before the POS consumer ran (raw: today's approve refuses it).
    await pendingRefund(bill.intentId, 40_000, { approved: true });

    await deliverPaid(bill);

    expect(await tenderOf(tenderId)).toMatchObject({ status: "voided" });
    expect(await orderState(bill.orderId)).toEqual({
      status: "awaiting_payment",
      captured: "0",
    });
    // The late-payment refund files the 60000 left, never the full 100000.
    const rows = await refundRows(bill.intentId);
    expect(rows).toHaveLength(2);
    // Found by who filed it, not by position: created_at can tie or step back.
    expect(rows.find((row) => row.requested_by === "system:pos")).toMatchObject(
      {
        amount: "60000",
        requested_by: "system:pos",
      },
    );
    expect(await reservedOf(bill.intentId)).toBe(bill.amountIdr);
  });

  it("legend-r5brx C4 a refund still pending does not block the capture; its approval then fails cap_exceeded with REFUND_INTENT_IN_POS_SALE", async () => {
    const bill = await paidBill(100_000);
    const tenderId = await addTender(bill);
    const refundId = await pendingRefund(bill.intentId, 100_000);

    await deliverPaid(bill);

    expect(await tenderOf(tenderId)).toEqual({
      status: "captured",
      payment_intent_id: bill.intentId,
    });
    const fake = new FakeRefundGateway();
    setPaymentRefundGateway(fake);
    try {
      const response = await approveRefund(refundId);
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe(GUARD_CODE);
      const { rows } = await owner.query<{
        status: string;
        failure_reason: string | null;
      }>(
        "SELECT status, failure_reason FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
        [seededTenantId, refundId],
      );
      expect(rows[0]).toEqual({
        status: "failed",
        failure_reason: "cap_exceeded",
      });
      expect(fake.calls).toHaveLength(0);
      // The sale keeps the money; no late refund is filed for it.
      expect(await refundRows(bill.intentId)).toHaveLength(1);
    } finally {
      setPaymentRefundGateway(null);
    }
  });

  it("legend-r5brx C5 a double payment paid earlier on the same link is never captured: the tender takes the counted intent, which then cannot be refunded", async () => {
    const bill = await paidBill(100_000);
    const doubleId = await doublePaidIntent(bill, 60);
    const tenderId = await addTender(bill);

    await deliverPaid(bill);

    expect(await tenderOf(tenderId)).toEqual({
      status: "captured",
      payment_intent_id: bill.intentId,
    });
    const response = await requestRefund(bill.intentId, 100_000);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe(GUARD_CODE);
    expect(await refundRows(bill.intentId)).toHaveLength(0);
    expect(await refundRows(doubleId)).toHaveLength(0);
  });

  it("legend-r5brx C3 no refund on the intent: the webhook captures the tender as before", async () => {
    const bill = await paidBill(100_000);
    const tenderId = await addTender(bill);

    await deliverPaid(bill);

    expect(await tenderOf(tenderId)).toEqual({
      status: "captured",
      payment_intent_id: bill.intentId,
    });
    expect(await refundRows(bill.intentId)).toHaveLength(0);
  });
});

describe("legend-r5brx capture and refund approval serialize on the intent row", () => {
  it("legend-r5brx C2a approve waits for a capture holding the intent, then is refused with REFUND_INTENT_IN_POS_SALE", async () => {
    const bill = await paidBill(100_000);
    const tenderId = await addTender(bill);
    const stall = await stallUpdates(
      "pos_order_tenders",
      `NEW.id = '${tenderId}'::uuid AND NEW.status = 'captured'`,
    );
    const fake = new FakeRefundGateway();
    setPaymentRefundGateway(fake);
    let captureCall: Promise<void> | undefined;
    let approveCall: ReturnType<typeof approveRefund> | undefined;
    try {
      captureCall = deliverPaid(bill); // stalled at its tender UPDATE
      const capturePid = await stall.waitForStalled();
      // Filed while the capture holds the intent (replica: no FK key share).
      const refundId = await pendingRefund(bill.intentId, 100_000, {
        replica: true,
      });
      approveCall = approveRefund(refundId);

      expect(
        await raceAgainstStalled(capturePid, approveCall),
        "refund approval must wait for the capture holding the intent",
      ).toBe("blocked");

      await stall.release();
      await captureCall;
      const response = await approveCall;
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe(GUARD_CODE);
      expect(await tenderOf(tenderId)).toMatchObject({ status: "captured" });
      expect(await refundRows(bill.intentId)).toEqual([
        expect.objectContaining({ id: refundId, status: "failed" }),
      ]);
      expect(fake.calls).toHaveLength(0);
    } finally {
      await stall.cleanup();
      setPaymentRefundGateway(null);
      await captureCall?.catch(() => undefined);
      await approveCall?.catch(() => undefined);
    }
  });

  it("legend-r5brx C2b a capture waits for an approve holding the intent, then voids the tender instead of capturing", async () => {
    const bill = await paidBill(100_000);
    const refundId = await pendingRefund(bill.intentId, 100_000);
    const stall = await stallUpdates(
      "payment_refunds",
      `NEW.id = '${refundId}'::uuid AND NEW.status = 'approved'`,
    );
    const fake = new FakeRefundGateway();
    setPaymentRefundGateway(fake);
    let approveCall: ReturnType<typeof approveRefund> | undefined;
    let captureCall: Promise<void> | undefined;
    try {
      approveCall = approveRefund(refundId); // stalled at its approved UPDATE
      const approvePid = await stall.waitForStalled();
      // The tender appears after approve read the balance (replica: no FK
      // key share behind the approve's intent lock).
      const tenderId = await addTender(bill, { replica: true });
      captureCall = deliverPaid(bill);

      expect(
        await raceAgainstStalled(approvePid, captureCall),
        "the capture must wait for the approval holding the intent",
      ).toBe("blocked");

      await stall.release();
      const response = await approveCall;
      await captureCall;
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(["approved", "completed"]).toContain(response.body.data.status);
      expect(await tenderOf(tenderId)).toMatchObject({ status: "voided" });
      expect(await orderState(bill.orderId)).toEqual({
        status: "awaiting_payment",
        captured: "0",
      });
      // Everything received is already refunded: no late refund on top.
      expect(await refundRows(bill.intentId)).toEqual([
        expect.objectContaining({ id: refundId }),
      ]);
      expect(await reservedOf(bill.intentId)).toBe(bill.amountIdr);
    } finally {
      await stall.cleanup();
      setPaymentRefundGateway(null);
      await approveCall?.catch(() => undefined);
      await captureCall?.catch(() => undefined);
    }
  });
});
