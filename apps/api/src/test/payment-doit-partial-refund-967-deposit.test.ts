// legend-30hfs (P1), brief 967, architect r2b: a DOIT partial refund of a
// reservation's deposit payment shrinks what is left of the deposit when the
// table session closes. Written from the brief and the 958/967 contract, not
// from the implementation; fixtures copied from reservation-deposit-remainder
// .test.ts (Q82). Failing first.
//
// Rules asserted:
//  - deposit 100.000, final bill 60.000, provider refunded 20.000 of the
//    payment itself: the unused deposit that may become customer credit is the
//    NET 20.000 (100.000 - 20.000 - 60.000), never 40.000.
//  - the provider refunded the whole 100.000: nothing is credited (0).
//
// Assumptions: the provider refund is recorded the way the engineer's design
// stores it (brief 967 D1: table `payment_provider_refunds`, columns tenant_id,
// outlet_id, payment_intent_id, provider, provider_refund_id,
// provider_payment_ref, amount_idr, source). The webhook path itself is covered
// in payment-doit-partial-refund-967.test.ts; this tenant has no DOIT
// integration, so the row is seeded directly. "Credit" is what
// reservation_deposit_remainders holds for the reservation after
// closeTableSession (same observation as Q82-NET-01).
//
// Run: LEGEND_TEST_FILES="src/test/payment-doit-partial-refund-967-deposit.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idr, outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { closeTableSessionInputSchema } from "@starter/shared/qr-order";
import { createApp } from "../app";
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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires disposable database");
  staff = await staffWithRole(createApp(), {
    template: "owner",
    label: "967 DP Owner",
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
      "DELETE FROM payment_provider_refunds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
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

async function providerRefunded(intentId: string, amountIdr: number) {
  await owner.query(
    `INSERT INTO payment_provider_refunds
       (tenant_id, outlet_id, payment_intent_id, provider, provider_refund_id,
        provider_payment_ref, amount_idr, source)
     VALUES ($1, $2, $3, 'doit', $4, $5, $6, 'payment_webhook')`,
    [
      seededTenantId,
      outletId,
      intentId,
      `rf_${randomUUID().slice(0, 12)}`,
      `pay_${intentId.slice(0, 12)}`,
      amountIdr,
    ],
  );
}

const creditLeft = async (reservationId: string) =>
  (await remainders(reservationId)).reduce((sum, r) => sum + r.remaining, 0);

describe("legend-30hfs provider partial refund and the reservation deposit", () => {
  it("967-r2b deposit 100.000, bill 60.000, provider refunded 20.000: the credit is the net 20.000", async () => {
    const d = await paidDeposit();
    await providerRefunded(d.intentId, 20_000);
    settlements.set(d.sessionId, { total: 60_000, paid: 100_000 });
    await close(d.sessionId);
    expect(await remainders(d.reservationId)).toEqual([
      {
        kind: "customer_credit",
        amount: 20_000,
        remaining: 20_000,
        profileId: d.profileId,
      },
    ]);
  });

  it("967-r2b the provider refunded the whole deposit payment: nothing is credited", async () => {
    const d = await paidDeposit();
    await providerRefunded(d.intentId, 100_000);
    settlements.set(d.sessionId, { total: 60_000, paid: 100_000 });
    await close(d.sessionId);
    expect(await creditLeft(d.reservationId)).toBe(0);
  });
});
