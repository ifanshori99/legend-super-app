// Founder Q82, legend-fug4: real session close may convert only a linked,
// valid final bill's unused DP into customer credit. Otherwise money stays
// refundable to the original payer; retries and races may never spend it twice.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { closeTableSessionInputSchema } from "@starter/shared/qr-order";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { depositInUseOfIntent } from "../services/reservation-deposit-credit.ts";
import { unlinkWhatsAppIdentity } from "../services/identity-wa-unlink.service.ts";
import { reverseJournal } from "../services/accounting-journal.service.ts";
import { createRefund } from "../services/payment-admin.service.ts";
import { depositCreditForSession } from "../services/reservation-lifecycle.ts";
import {
  closeTableSession,
  openOrJoinTableSession,
  setTableSessionSettlementLookup,
} from "../services/table-session.service.ts";
import {
  createTable,
  createZone,
  dropFloorRows,
  issueQr,
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";

const outletId = outletIdSchema.parse(seededOutletA);
const scope = (tenantId = seededTenantId) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
const zoneIds: string[] = [];
const tableIds: string[] = [];
const reservationIds: string[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
const profileIds: string[] = [];
const profileUserIds: string[] = [];
const orderIds: string[] = [];
const sessionIds: string[] = [];
const settlements = new Map<string, { total: number; paid: number } | null>();
let staff: Staff;
let receiptEntity: string;
let receiptPeriod: string;
const receiptAccounts = [randomUUID(), randomUUID()];
const receiptEntries: string[] = [];

async function seedOriginalReceipt(intentId: string, amount: number) {
  const journalId = randomUUID();
  receiptEntries.push(journalId);
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO journal_entries(id,tenant_id,legal_entity_id,outlet_id,entry_date,fiscal_period_id,source_type,source_id,description,idempotency_key,request_fingerprint)
 VALUES($1,$2,$3,$4,$5,$6,'customer_deposit',$7,'Penerimaan DP Q82',$8,$9)`,
      [
        journalId,
        seededTenantId,
        receiptEntity,
        outletId,
        new Date().toISOString().slice(0, 10),
        receiptPeriod,
        intentId,
        `aj:receipt:${intentId}`,
        "0".repeat(64),
      ],
    );
    await c.query(
      `INSERT INTO journal_lines(tenant_id,entry_id,account_id,line_no,debit_idr,credit_idr,outlet_id) VALUES($1,$2,$3,1,$5,0,$6),($1,$2,$4,2,0,$5,$6)`,
      [
        seededTenantId,
        journalId,
        receiptAccounts[0],
        receiptAccounts[1],
        amount,
        outletId,
      ],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  return journalId;
}

async function newProfile() {
  const id = randomUUID();
  profileIds.push(id);
  await owner.query(
    `INSERT INTO customer_profiles
       (id, tenant_id, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, 'Q82 Customer', 'active', now())`,
    [id, seededTenantId],
  );
  return id;
}

async function newSession() {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const table = await createTable(staff.client, { zoneId: zone.id });
  tableIds.push(table.id);
  const qr = await issueQr(staff.client, table.id);
  const opened = await openOrJoinTableSession(scope(), {
    qrToken: qr.token,
    pax: 2,
    deviceHash: `q82-${randomUUID()}`,
  });
  sessionIds.push(opened.session.id);
  return { sessionId: opened.session.id, zoneId: zone.id as string };
}

async function addOrder(
  sessionId: string,
  total: number,
  deposit: number,
  profileId: string | null,
) {
  const id = randomUUID();
  orderIds.push(id);
  await owner.query(
    `INSERT INTO orders
       (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
        total_idr, deposit_applied_idr, status, business_date, placed_at,
        table_session_id, customer_profile_id)
     VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $5, 0, 0, 0, 0,
             $5, $6, 'sent', '2026-11-12', now(), $7, $8)`,
    [
      id,
      seededTenantId,
      outletId,
      `Q82-${id.slice(0, 8)}`,
      total,
      deposit,
      sessionId,
      profileId,
    ],
  );
}

async function paidDeposit(
  input: {
    profileId?: string | null;
    total?: number;
    deposit?: number;
    source?: string;
  } = {},
) {
  const profileId =
    input.profileId === undefined ? await newProfile() : input.profileId;
  const total = input.total ?? 60_000;
  const deposit = input.deposit ?? 100_000;
  const session = await newSession();
  const reservationId = randomUUID();
  const intentId = randomUUID();
  const linkId = randomUUID();
  reservationIds.push(reservationId);
  intentIds.push(intentId);
  linkIds.push(linkId);
  await owner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
        duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
        source, seated_at, table_session_id)
     VALUES ($1, $2, $3, $4, 'Q82 Payer', now(), 90, 2, $5, $6, $7,
             'seated', $9, now(), $8)`,
    [
      reservationId,
      seededTenantId,
      outletId,
      profileId,
      session.zoneId,
      deposit,
      JSON.stringify({
        version: "q82",
        depositRequirement: "required",
        depositAmountIdr: deposit,
        paymentWindowMinutes: 60,
        freeCancellationHours: 24,
        lateCancellationRefundBp: 0,
        noShowRefundBp: 0,
        minimumSpendIdr: 0,
        capturedAt: new Date().toISOString(),
      }),
      session.sessionId,
      input.source ?? "staff",
    ],
  );
  await owner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'q82-test')`,
    [
      linkId,
      seededTenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `Q82-${linkId.slice(0, 8)}`,
      deposit,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, reservation_id, method, provider,
        amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
     VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, 'paid',
       '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
       now() + interval '1 hour', now())`,
    [
      intentId,
      seededTenantId,
      outletId,
      linkId,
      reservationId,
      deposit,
      `q82-pay-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [seededTenantId, outletId, intentId, `q82-evidence-${intentId}`, deposit],
  );
  await owner.query(
    `UPDATE reservations SET deposit_payment_id = $2, deposit_payment_link_id = $3 WHERE id = $1`,
    [reservationId, intentId, linkId],
  );
  await owner.query(
    "UPDATE table_sessions SET reservation_id = $2 WHERE id = $1",
    [session.sessionId, reservationId],
  );
  await owner.query(
    `INSERT INTO reservation_deposit_allocations
       (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      seededTenantId,
      outletId,
      reservationId,
      session.sessionId,
      intentId,
      deposit,
    ],
  );
  await addOrder(session.sessionId, total, Math.min(deposit, total), profileId);
  settlements.set(session.sessionId, { total, paid: deposit });
  const receiptJournalId = await seedOriginalReceipt(intentId, deposit);
  return {
    ...session,
    reservationId,
    intentId,
    profileId,
    deposit,
    total,
    receiptJournalId,
  };
}

const close = (sessionId: string, waiterConfirmedEmpty = false) =>
  closeTableSession(
    scope(),
    sessionId,
    closeTableSessionInputSchema.parse({
      tableCleaned: true,
      waiterConfirmedEmpty,
    }),
    staff.userId,
  );

async function remainders(reservationId: string) {
  const { rows } = await owner.query<{
    kind: string;
    amount_idr: string;
    remaining_idr: string;
    customer_profile_id: string | null;
  }>(
    "SELECT kind, amount_idr::text, remaining_idr::text, customer_profile_id FROM reservation_deposit_remainders WHERE reservation_id = $1",
    [reservationId],
  );
  return rows.map((r) => ({
    kind: r.kind,
    amount: Number(r.amount_idr),
    remaining: Number(r.remaining_idr),
    profileId: r.customer_profile_id,
  }));
}

const requestRefund = (intentId: string, amount: number, key = randomUUID()) =>
  createRefund(
    scope(),
    staff.userId,
    {
      idempotencyKey: key,
      paymentIntentId: intentId,
      amountIdr: idr(amount),
      reason: "Q82 refund original payer",
    },
    key,
  );

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires disposable database");
  staff = await staffWithRole(createApp(), {
    template: "owner",
    label: "Q82 DP Owner",
  });
  const entity = await owner.query(
    "SELECT legal_entity_id FROM outlets WHERE id=$1",
    [outletId],
  );
  receiptEntity = entity.rows[0].legal_entity_id;
  for (const [i, type, group] of [
    [0, "asset", "current_asset"],
    [1, "liability", "current_liability"],
  ] as const)
    await owner.query(
      `INSERT INTO chart_of_accounts(id,tenant_id,legal_entity_id,code,name,type,report_group) VALUES($1,$2,$3,$4,'Q82 DP receipt',$5,$6)`,
      [
        receiptAccounts[i],
        seededTenantId,
        receiptEntity,
        `982.${i + 1}`,
        type,
        group,
      ],
    );
  await owner.query(
    `INSERT INTO fiscal_periods(tenant_id,legal_entity_id,period) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [seededTenantId, receiptEntity, new Date().toISOString().slice(0, 7)],
  );
  receiptPeriod = (
    await owner.query(
      "SELECT id FROM fiscal_periods WHERE tenant_id=$1 AND legal_entity_id=$2 AND period=$3",
      [seededTenantId, receiptEntity, new Date().toISOString().slice(0, 7)],
    )
  ).rows[0].id;
  setTableSessionSettlementLookup(async ({ sessionId }) => {
    const s = settlements.get(sessionId);
    return s ? { billTotalIdr: idr(s.total), paidIdr: idr(s.paid) } : null;
  });
});

afterAll(async () => {
  setTableSessionSettlementLookup(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    // Replica mode permits deleting immutable money facts owned by this file.
    await client.query(
      "DELETE FROM journal_lines WHERE entry_id=ANY($1::uuid[]) OR entry_id IN(SELECT id FROM journal_entries WHERE reversal_of=ANY($1::uuid[]))",
      [receiptEntries],
    );
    await client.query(
      "DELETE FROM journal_entries WHERE id=ANY($1::uuid[]) OR reversal_of=ANY($1::uuid[])",
      [receiptEntries],
    );
    await client.query(
      "DELETE FROM chart_of_accounts WHERE id=ANY($1::uuid[])",
      [receiptAccounts],
    );
    for (const table of ["pos_deposit_refunds", "pos_order_refunds"])
      await client.query(
        `DELETE FROM ${table} WHERE order_id = ANY($1::uuid[])`,
        [orderIds],
      );
    for (const table of [
      "reservation_customer_credit_uses",
      "reservation_deposit_remainders",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND table_session_id = ANY($2::uuid[])`,
        [seededTenantId, sessionIds],
      );
    await client.query(
      "DELETE FROM approval_requests WHERE object_type = 'payment_refund' AND object_id IN (SELECT id::text FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[]))",
      [intentIds],
    );
    await client.query(
      "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orderIds,
    ]);
    await client.query(
      "DELETE FROM reservation_deposit_allocations WHERE reservation_id = ANY($1::uuid[])",
      [reservationIds],
    );
    await client.query("DELETE FROM reservations WHERE id = ANY($1::uuid[])", [
      reservationIds,
    ]);
    await client.query(
      "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      "DELETE FROM payment_intents WHERE id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
      linkIds,
    ]);
    await client.query(
      "DELETE FROM customer_profiles WHERE id = ANY($1::uuid[])",
      [profileIds],
    );
    await client.query(
      "DELETE FROM user_identities WHERE user_id=ANY($1::text[])",
      [profileUserIds],
    );
    await client.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [
      profileUserIds,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await owner.end();
});

describe("legend-fug4 founder Q82 reservation DP remainder", () => {
  it("Q82 linked customer and valid final bill credit only the unused DP", async () => {
    const d = await paidDeposit();
    const closed = await close(d.sessionId);
    expect(closed.closedReason).toBe("paid_and_cleaned");
    expect(await remainders(d.reservationId)).toEqual([
      {
        kind: "customer_credit",
        amount: 40_000,
        remaining: 40_000,
        profileId: d.profileId,
      },
    ]);
  });

  it("Q82 final bill linked profile can receive credit when the reservation had no profile", async () => {
    const d = await paidDeposit();
    await owner.query(
      "UPDATE reservations SET customer_profile_id = NULL WHERE id = $1",
      [d.reservationId],
    );
    await close(d.sessionId);
    expect(await remainders(d.reservationId)).toEqual([
      {
        kind: "customer_credit",
        amount: 40_000,
        remaining: 40_000,
        profileId: d.profileId,
      },
    ]);
  });

  it("Q82 unlinked customer retains the remainder as a manual refund liability", async () => {
    const d = await paidDeposit({ profileId: null });
    await close(d.sessionId);
    expect(await remainders(d.reservationId)).toEqual([
      {
        kind: "manual_refund",
        amount: 40_000,
        remaining: 40_000,
        profileId: null,
      },
    ]);
    await expect(requestRefund(d.intentId, 40_000)).resolves.toBeDefined();
    await expect(requestRefund(d.intentId, 1)).rejects.toBeDefined();
  });

  it("Q82 an unresolved profile reference never turns the payer's DP into spendable credit", async () => {
    const d = await paidDeposit({ profileId: null });
    await owner.query(
      "UPDATE reservations SET customer_profile_id = $2 WHERE id = $1",
      [d.reservationId, randomUUID()],
    );
    await close(d.sessionId);
    const rows = await remainders(d.reservationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("manual_refund");
    expect(rows[0]?.amount).toBe(40_000);
    expect(rows[0]?.remaining).toBe(40_000);
  });

  it("Q82 a website booking's unverified profile link never receives credit", async () => {
    const d = await paidDeposit({ profileId: null, source: "website" });
    const memberB = await newProfile();
    await owner.query(
      "UPDATE reservations SET customer_profile_id = $2 WHERE id = $1",
      [d.reservationId, memberB],
    );
    await close(d.sessionId);
    expect(await remainders(d.reservationId)).toEqual([
      {
        kind: "manual_refund",
        amount: 40_000,
        remaining: 40_000,
        profileId: null,
      },
    ]);
  });

  it("Q82 a website booking credits the bill's own profile, not the booking's", async () => {
    const d = await paidDeposit({ source: "website" });
    const memberB = await newProfile();
    await owner.query(
      "UPDATE reservations SET customer_profile_id = $2 WHERE id = $1",
      [d.reservationId, memberB],
    );
    await close(d.sessionId);
    expect(await remainders(d.reservationId)).toEqual([
      {
        kind: "customer_credit",
        amount: 40_000,
        remaining: 40_000,
        profileId: d.profileId,
      },
    ]);
    expect(d.profileId).not.toBe(memberB);
  });

  it.each(["unverified", "unpaid"] as const)(
    "Q82 linked customer with %s final bill receives no automatic credit",
    async (state) => {
      const d = await paidDeposit();
      settlements.set(
        d.sessionId,
        state === "unverified" ? null : { total: 120_000, paid: 100_000 },
      );
      const closed = await close(d.sessionId, true);
      expect(closed.closedReason).toBe("voided");
      const rows = await remainders(d.reservationId);
      expect(rows.length).toBe(1);
      expect(rows[0]?.kind).toBe("manual_refund");
      expect(rows[0]?.amount).toBe(40_000);
    },
  );

  it("Q82 replay and two cashiers closing one session post the credit once", async () => {
    const d = await paidDeposit();
    const results = await Promise.allSettled([
      close(d.sessionId),
      close(d.sessionId),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    await close(d.sessionId).catch(() => undefined);
    expect(await remainders(d.reservationId)).toEqual([
      {
        kind: "customer_credit",
        amount: 40_000,
        remaining: 40_000,
        profileId: d.profileId,
      },
    ]);
  });

  it("Q82 credited remainder cannot also be refunded manually", async () => {
    const d = await paidDeposit();
    await close(d.sessionId);
    await expect(requestRefund(d.intentId, 1)).rejects.toBeDefined();
    const { rows } = await owner.query(
      "SELECT id FROM payment_refunds WHERE payment_intent_id = $1 AND status <> 'failed'",
      [d.intentId],
    );
    expect(rows).toHaveLength(0);
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(40_000);
  });

  it("Q82 another tenant cannot read credit liability rows", async () => {
    const d = await paidDeposit();
    await close(d.sessionId);
    const result = await withTenant(db, scope(randomUUID()), (tx) =>
      tx.execute(
        sql`SELECT id FROM reservation_deposit_remainders WHERE reservation_id = ${d.reservationId}::uuid`,
      ),
    );
    expect(result.rows).toHaveLength(0);
  });
});

const applyCredit = async (
  profileId: string,
  sessionId: string,
  amount: number,
  key: string,
  tenantId = seededTenantId,
) => {
  const { applyReservationCustomerCredit } =
    await import("../services/reservation-deposit-remainder.ts");
  return applyReservationCustomerCredit(
    scope(tenantId),
    staff.userId,
    outletId,
    {
      customerProfileId: profileId,
      tableSessionId: sessionId,
      amountIdr: idr(amount),
    },
    key,
  );
};

async function spendTotal(sessionId: string) {
  const { rows } = await owner.query<{ amount: string }>(
    "SELECT coalesce(sum(amount_idr), 0)::text AS amount FROM reservation_customer_credit_uses WHERE tenant_id = $1 AND table_session_id = $2",
    [seededTenantId, sessionId],
  );
  return Number(rows[0]!.amount);
}

async function targetSession(profileId: string, total = 30_000) {
  const target = await newSession();
  await addOrder(target.sessionId, total, 0, profileId);
  settlements.set(target.sessionId, { total, paid: 0 });
  return target.sessionId;
}

describe("legend-fug4 Q82 customer credit cannot be cashed out twice", () => {
  it("Q82 source close racing a manual refund never credits and refunds the same money", async () => {
    const d = await paidDeposit();
    const results = await Promise.allSettled([
      close(d.sessionId),
      requestRefund(d.intentId, 40_000),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    // A refused close may be retried after the refund transaction commits.
    await close(d.sessionId).catch(() => undefined);
    const credited = (await remainders(d.reservationId))
      .filter((r) => r.kind === "customer_credit")
      .reduce((sum, r) => sum + r.amount, 0);
    const { rows } = await owner.query<{ reserved: string }>(
      "SELECT coalesce(sum(amount_idr), 0)::text AS reserved FROM payment_refunds WHERE payment_intent_id = $1 AND status <> 'failed'",
      [d.intentId],
    );
    expect(credited + Number(rows[0]!.reserved)).toBe(40_000);
  });

  it("Q82 repeated spend key debits credit once and a further overspend changes nothing", async () => {
    const d = await paidDeposit();
    await close(d.sessionId);
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(40_000);
    const target = await targetSession(d.profileId!);
    const key = randomUUID();
    await applyCredit(d.profileId!, target, 30_000, key);
    await applyCredit(d.profileId!, target, 30_000, key);
    expect(
      await withTenant(db, scope(), (tx) =>
        depositCreditForSession(
          tx,
          tenantIdSchema.parse(seededTenantId),
          target,
        ),
      ),
    ).toBe(30_000);
    expect(await spendTotal(target)).toBe(30_000);
    await expect(
      applyCredit(d.profileId!, target, 10_000, key),
    ).rejects.toBeDefined();
    expect(await spendTotal(target)).toBe(30_000);
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(10_000);
    const secondTarget = await targetSession(d.profileId!, 20_000);
    await expect(
      applyCredit(d.profileId!, secondTarget, 20_000, randomUUID()),
    ).rejects.toBeDefined();
    expect(await spendTotal(secondTarget)).toBe(0);
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(10_000);
    await expect(requestRefund(d.intentId, 1)).rejects.toBeDefined();
  });

  it("Q82 closing an unused target returns credit to its source without creating new money", async () => {
    const d = await paidDeposit();
    await close(d.sessionId);
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(40_000);
    const target = await targetSession(d.profileId!);
    await applyCredit(d.profileId!, target, 30_000, randomUUID());
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(10_000);
    // The target order is cancelled before this visit closes: no sale consumed
    // the applied customer credit, so all 30k belongs back to its source.
    await owner.query(
      "UPDATE orders SET status = 'voided' WHERE table_session_id = $1",
      [target],
    );
    settlements.set(target, { total: 0, paid: 0 });
    await close(target);
    expect(await remainders(d.reservationId)).toEqual([
      {
        kind: "customer_credit",
        amount: 40_000,
        remaining: 40_000,
        profileId: d.profileId,
      },
    ]);
    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM reservation_deposit_remainders WHERE tenant_id = $1 AND table_session_id = $2",
      [seededTenantId, target],
    );
    expect(rows[0]?.n).toBe(0);
    await expect(requestRefund(d.intentId, 1)).rejects.toBeDefined();
  });

  it("Q82 two cashiers spending one customer's remaining credit never overpay a bill", async () => {
    const d = await paidDeposit();
    await close(d.sessionId);
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(40_000);
    const target = await targetSession(d.profileId!);
    const results = await Promise.allSettled([
      applyCredit(d.profileId!, target, 30_000, randomUUID()),
      applyCredit(d.profileId!, target, 30_000, randomUUID()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await spendTotal(target)).toBe(30_000);
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(10_000);
  });

  it("Q82 two cashiers at different bills cannot spend more than the customer's credit", async () => {
    const d = await paidDeposit();
    await close(d.sessionId);
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(40_000);
    const first = await targetSession(d.profileId!);
    const second = await targetSession(d.profileId!);
    const results = await Promise.allSettled([
      applyCredit(d.profileId!, first, 30_000, randomUUID()),
      applyCredit(d.profileId!, second, 30_000, randomUUID()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await spendTotal(first)) + (await spendTotal(second))).toBe(30_000);
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(10_000);
  });

  it("Q82 credit cannot pay another customer's bill or cross a tenant boundary", async () => {
    const d = await paidDeposit();
    await close(d.sessionId);
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(40_000);
    const otherProfile = await newProfile();
    const wrongTarget = await targetSession(otherProfile);
    await expect(
      applyCredit(d.profileId!, wrongTarget, 30_000, randomUUID()),
    ).rejects.toBeDefined();
    expect(await spendTotal(wrongTarget)).toBe(0);
    const ownTarget = await targetSession(d.profileId!);
    await expect(
      applyCredit(d.profileId!, ownTarget, 30_000, randomUUID(), randomUUID()),
    ).rejects.toBeDefined();
    expect(await spendTotal(ownTarget)).toBe(0);
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(40_000);
  });
});

describe("legend-77r0 Q81 durable source-specific DP release", () => {
  it("Q81-MULTI-01: a failed A payout cannot make B available for a second refund", async () => {
    const a = await paidDeposit({
      deposit: 50_000,
      total: 100_000,
      profileId: null,
    });
    const b = await paidDeposit({ deposit: 50_000, total: 1, profileId: null });
    const firstOrder = orderIds[orderIds.length - 2]!;
    const refundId = randomUUID();
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(
        "UPDATE orders SET deposit_applied_idr=100000 WHERE id=$1",
        [firstOrder],
      );
      await c.query(
        "UPDATE orders SET status='voided' WHERE table_session_id=$1",
        [b.sessionId],
      );
      await c.query(
        "UPDATE reservation_deposit_allocations SET table_session_id=$1 WHERE payment_intent_id=$2",
        [a.sessionId, b.intentId],
      );
      await c.query(
        `INSERT INTO pos_order_refunds
        (id,tenant_id,outlet_id,order_id,amount_idr,reason,reason_note,lines,items,requested_by,approved_by,approval_request_id,refunded_at)
        VALUES($1,$2,$3,$4,0,'quality_complaint','DP returned from A','[]','[{"itemId":"returned","quantity":1}]','cashier-a','manager-b',$5,now())`,
        [refundId, seededTenantId, outletId, firstOrder, randomUUID()],
      );
      await c.query(
        `INSERT INTO pos_deposit_refunds
        (tenant_id,outlet_id,order_id,pos_refund_id,payment_intent_id,amount_idr,released_at)
        VALUES($1,$2,$3,$4,$5,25000,now())`,
        [seededTenantId, outletId, firstOrder, refundId, a.intentId],
      );
      await c.query(
        `INSERT INTO payment_refunds
        (tenant_id,outlet_id,payment_intent_id,amount_idr,reason,requested_by,status,failure_reason)
        VALUES($1,$2,$3,25000,'DP return A','cashier-a','failed','provider_declined')`,
        [seededTenantId, outletId, a.intentId],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    // A's 25k obligation remains owed to A even when its gateway request fails.
    // B's entire 50k still backs the bill and cannot be cashed out as well.
    const inUse = await withTenant(db, scope(), (tx) =>
      depositInUseOfIntent(
        tx,
        tenantIdSchema.parse(seededTenantId),
        b.intentId,
      ),
    );
    expect(inUse).toBe(50000n);
    await expect(requestRefund(b.intentId, 1)).rejects.toMatchObject({
      code: "REFUND_DEPOSIT_IN_USE",
    });
    const rows = await owner.query(
      "SELECT count(*)::int AS n FROM payment_refunds WHERE payment_intent_id=$1 AND status <> 'failed'",
      [b.intentId],
    );
    expect(rows.rows[0]?.n).toBe(0);
  });
});

describe("legend-fug4 Q82 original receipt remains authoritative", () => {
  it("Q82-RECEIPT-01: reversing the original receipt prevents spending an existing customer credit", async () => {
    const d = await paidDeposit();
    await close(d.sessionId);
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(40000);
    await reverseJournal(
      scope(),
      d.receiptJournalId,
      {
        entryDate: new Date().toISOString().slice(0, 10),
        reason: "Koreksi DP asli",
        idempotencyKey: randomUUID(),
      },
      userIdSchema.parse(staff.userId),
    );
    const target = await targetSession(d.profileId!);
    await expect(
      applyCredit(d.profileId!, target, 30000, randomUUID()),
    ).rejects.toBeDefined();
    expect(await spendTotal(target)).toBe(0);
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(40000);
  });
  it("Q82-MANUAL-01: a reserved manual refund leaves the original liability visible with zero remaining refundable money", async () => {
    const d = await paidDeposit({ profileId: null });
    await close(d.sessionId);
    await requestRefund(d.intentId, 40000);
    const { getReservationDepositRemainders } =
      await import("../services/reservation-deposit-remainder.ts");
    const result = await getReservationDepositRemainders(
      scope(),
      staff.userId,
      outletId,
      d.reservationId,
    );
    expect(result).toMatchObject([
      {
        kind: "manual_refund",
        amountIdr: 40000,
        customerCreditIdr: 0,
        refundableIdr: 0,
      },
    ]);
  });
});

describe("legend-fug4 Q82 credited source is not bill capacity twice", () => {
  it("Q82-MULTI-02: a second source converted to credit cannot release the first source backing the bill", async () => {
    const a = await paidDeposit({ deposit: 100000, total: 100000 });
    const b = await paidDeposit({
      deposit: 100000,
      total: 1,
      profileId: a.profileId,
    });
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role=replica");
      await c.query(
        "UPDATE orders SET status='voided' WHERE table_session_id=$1",
        [b.sessionId],
      );
      await c.query(
        "UPDATE reservation_deposit_allocations SET table_session_id=$1 WHERE payment_intent_id=$2",
        [a.sessionId, b.intentId],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    settlements.set(a.sessionId, { total: 100000, paid: 200000 });
    await close(a.sessionId);
    const rows = await owner.query(
      "SELECT coalesce(sum(amount_idr),0)::text AS amount FROM reservation_deposit_remainders WHERE tenant_id=$1 AND table_session_id=$2 AND kind='customer_credit'",
      [seededTenantId, a.sessionId],
    );
    expect(Number(rows.rows[0]?.amount)).toBe(100000);
    await expect(requestRefund(a.intentId, 1)).rejects.toBeDefined();
    await expect(requestRefund(b.intentId, 1)).rejects.toBeDefined();
  });
});

describe("legend-fug4 Q82 returned credit remains refund liability", () => {
  it("Q82-RETURN-01: closing a credit-backed bill after DP10k return does not recredit that10k", async () => {
    const d = await paidDeposit();
    await close(d.sessionId);
    const target = await targetSession(d.profileId!);
    await applyCredit(d.profileId!, target, 30000, randomUUID());
    const targetOrder = orderIds[orderIds.length - 1]!;
    const refundId = randomUUID();
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role=replica");
      await c.query("UPDATE orders SET deposit_applied_idr=30000 WHERE id=$1", [
        targetOrder,
      ]);
      await c.query(
        `INSERT INTO pos_order_refunds(id,tenant_id,outlet_id,order_id,amount_idr,reason,reason_note,lines,items,requested_by,approved_by,approval_request_id,refunded_at)
    VALUES($1,$2,$3,$4,0,'quality_complaint','Credit goods returned','[]','[{"itemId":"returned","quantity":1}]','cashier-a','manager-b',$5,now())`,
        [refundId, seededTenantId, outletId, targetOrder, randomUUID()],
      );
      await c.query(
        `INSERT INTO pos_deposit_refunds(tenant_id,outlet_id,order_id,pos_refund_id,payment_intent_id,amount_idr,released_at) VALUES($1,$2,$3,$4,$5,10000,now())`,
        [seededTenantId, outletId, targetOrder, refundId, d.intentId],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    settlements.set(target, { total: 30000, paid: 30000 });
    await close(target);
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(10000);
    await expect(requestRefund(d.intentId, 10001)).rejects.toBeDefined();
  });
});

async function unlinkProfile(profileId: string) {
  const userId = randomUUID();
  profileUserIds.push(userId);
  const hash = randomUUID().replaceAll("-", "").padEnd(64, "0");
  await owner.query(
    `INSERT INTO "user"(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Pelanggan DP unlink',$2,false,now(),now())`,
    [userId, `q82-${userId}@wa.invalid`],
  );
  const identity = await owner.query(
    `INSERT INTO user_identities(user_id,type,value_hash,verified_at,is_primary) VALUES($1,'whatsapp',$2,now(),true) RETURNING id`,
    [userId, hash],
  );
  await owner.query(
    "UPDATE customer_profiles SET user_id=$2,whatsapp_hash=$3 WHERE id=$1",
    [profileId, userId, hash],
  );
  await unlinkWhatsAppIdentity(scope(), {
    actorUserId: staff.userId,
    outletId,
    customerUserId: userId,
    identityId: identity.rows[0]!.id,
    reason: "Nomor WhatsApp tidak lagi milik pelanggan",
  });
  const row = await owner.query(
    "SELECT membership_status,whatsapp_verified_at FROM customer_profiles WHERE id=$1",
    [profileId],
  );
  expect(row.rows[0]).toMatchObject({
    membership_status: "pending_verification",
    whatsapp_verified_at: null,
  });
}

describe("legend-fug4 Q82 verified profile is required after WhatsApp unlink", () => {
  it("Q82-UNLINK-01: a final bill still linked to an unverified profile keeps DP as manual liability", async () => {
    const d = await paidDeposit();
    await unlinkProfile(d.profileId!);
    await close(d.sessionId);
    expect(await remainders(d.reservationId)).toEqual([
      {
        kind: "manual_refund",
        amount: 40000,
        remaining: 40000,
        profileId: null,
      },
    ]);
  });
  it("Q82-UNLINK-02: an existing customer credit cannot be spent after actual WhatsApp unlink", async () => {
    const d = await paidDeposit();
    await close(d.sessionId);
    await unlinkProfile(d.profileId!);
    const target = await targetSession(d.profileId!);
    await expect(
      applyCredit(d.profileId!, target, 30000, randomUUID()),
    ).rejects.toBeDefined();
    expect(await spendTotal(target)).toBe(0);
    expect((await remainders(d.reservationId))[0]?.remaining).toBe(40000);
  });
});

describe("legend-fug4 Q82 refunds reserved before seating", () => {
  it("Q82-NET-01: a net80k allocation after original100k less refund20k leaves20k after bill60k", async () => {
    const d = await paidDeposit();
    await requestRefund(d.intentId, 20000);
    // seatReservation records the net DP held when seating after this refund.
    // Preserve that production postcondition instead of subtracting the refund
    // from the already-net allocation again when the final bill closes.
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role=replica");
      await c.query(
        "UPDATE reservation_deposit_allocations SET amount_idr=80000 WHERE payment_intent_id=$1",
        [d.intentId],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    settlements.set(d.sessionId, { total: 60000, paid: 80000 });
    await close(d.sessionId);
    expect(await remainders(d.reservationId)).toEqual([
      {
        kind: "customer_credit",
        amount: 20000,
        remaining: 20000,
        profileId: d.profileId,
      },
    ]);
  });
});

describe("legend-fug4 Q81 Q82 principal encumbrances count each obligation once", () => {
  it.each(["failed", "pending"] as const)(
    "Q82-NET-02: manual20k plus returnedDP10k (%s mirror) leaves20k and never funds a duplicate credit",
    async (status) => {
      const d = await paidDeposit();
      const orderId = orderIds[orderIds.length - 1]!;
      await requestRefund(d.intentId, 20000);
      const posRefundId = randomUUID();
      const paymentRefundId = randomUUID();
      const c = await owner.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL session_replication_role=replica");
        await c.query(
          "UPDATE reservation_deposit_allocations SET amount_idr=80000 WHERE payment_intent_id=$1",
          [d.intentId],
        );
        await c.query(
          `INSERT INTO pos_order_refunds(id,tenant_id,outlet_id,order_id,amount_idr,reason,reason_note,lines,items,requested_by,approved_by,approval_request_id,refunded_at)
    VALUES($1,$2,$3,$4,0,'quality_complaint','Original DP payer return','[]','[{"itemId":"returned","quantity":1}]','cashier-a','manager-b',$5,now())`,
          [posRefundId, seededTenantId, outletId, orderId, randomUUID()],
        );
        await c.query(
          `INSERT INTO pos_deposit_refunds(tenant_id,outlet_id,order_id,pos_refund_id,payment_intent_id,amount_idr,released_at) VALUES($1,$2,$3,$4,$5,10000,now())`,
          [seededTenantId, outletId, orderId, posRefundId, d.intentId],
        );
        await c.query(
          `INSERT INTO payment_refunds(id,tenant_id,outlet_id,payment_intent_id,amount_idr,reason,requested_by,status,failure_reason) VALUES($1,$2,$3,$4,10000,'Original DP payer return','cashier-a',$5,$6)`,
          [
            paymentRefundId,
            seededTenantId,
            outletId,
            d.intentId,
            status,
            status === "failed" ? "provider_declined" : null,
          ],
        );
        await c.query(
          `INSERT INTO payment_admin_idempotency(tenant_id,key,fingerprint,response) VALUES($1,$2,$3,$4::jsonb)`,
          [
            seededTenantId,
            `pos-refund-gateway:${posRefundId}:${d.intentId}`,
            "0".repeat(64),
            JSON.stringify({ refundId: paymentRefundId }),
          ],
        );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
      settlements.set(d.sessionId, { total: 60000, paid: 70000 });
      await close(d.sessionId);
      expect(await remainders(d.reservationId)).toEqual([
        {
          kind: "customer_credit",
          amount: 20000,
          remaining: 20000,
          profileId: d.profileId,
        },
      ]);
    },
  );
});
