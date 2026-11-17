// legend-6n4p3 + legend-obgj5 (brief 1033): DP credit comes from ONE net pool
// per payment intent, and an open refund_recon_hold limits that pool.
// Written from docs/briefs/1033-kredit-dp-pool-net.md ("Test"), not from the
// implementation. Fixtures follow reservation-deposit-dp-shared-intent-refund.test.ts.
// Money rule: nobody is paid more than the net DP, the outlet never loses.
//
// Assumptions where the brief is not exact:
// - Credit is observed through behaviour only: `takeable(guest)` applies credit
//   to bills by bisection (unit 1.000 IDR) and returns the total the guest can
//   take; every test then also proves 1 IDR more is rejected. A rejected apply
//   moves nothing (1028-5), so probing is safe.
// - Each session consumes CONSUMED (5.000) of its allocation (an empty bill
//   would make the leftover a manual_refund remainder, not credit). The money
//   ceiling is therefore: takeable <= DP - consumed - provider refund - open
//   hold (consumed + credit + refunds + hold <= DP). The lower bound is the
//   ceiling minus CONSUMED (the brief's pool formula may cap a session claim
//   including its consumed part); a stricter exact value is used only where no
//   refund or hold exists (baseline 90k, as in 1028).
// - A hold is inserted directly (reason "Reference names another intent",
//   as the 1025-d tests do). Resolving is simulated with UPDATE of
//   resolved_at/resolution (not the HTTP route, which needs MFA staff):
//   `not_this_intent` = hold closed, no refund row; `counted_against_intent`
//   = hold closed AND the provider refund recorded in payment_provider_refunds.
// - "Another tenant" = an isolated tenant reading the credit of these
//   sessions yields 0; a hold of another intent / another DP is "another
//   intent" in the same tenant.
//
// Run: LEGEND_TEST_FILES="src/test/reservation-deposit-dp-pool-1033.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { idr, outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { closeTableSessionInputSchema } from "@starter/shared/qr-order";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { depositCreditForSession } from "../services/reservation-lifecycle.ts";
import { applyReservationCustomerCredit } from "../services/reservation-deposit-remainder.ts";
import {
  closeTableSession,
  openOrJoinTableSession,
  setTableSessionSettlementLookup,
} from "../services/table-session.service.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  dropFloorRows,
  dropIsolatedTenant,
  issueQr,
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers";

const CONSUMED = 5_000;
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
const orderIds: string[] = [];
const sessionIds: string[] = [];
const settlements = new Map<string, { total: number; paid: number } | null>();
let staff: Staff;
let tenantB: IsolatedTenant;

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
 VALUES($1,$2,$3,$4,$5,$6,'customer_deposit',$7,'Penerimaan DP 1033',$8,$9)`,
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
     VALUES ($1, $2, '1033 Customer', 'active', now())`,
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
    deviceHash: `t1033-${randomUUID()}`,
  });
  sessionIds.push(opened.session.id);
  return { sessionId: opened.session.id, zoneId: zone.id as string };
}

async function addOrder(
  sessionId: string,
  total: number,
  profileId: string,
  deposit = 0,
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
             $5, $8, 'sent', '2026-11-12', now(), $6, $7)`,
    [
      id,
      seededTenantId,
      outletId,
      `T1033-${id.slice(0, 8)}`,
      total,
      sessionId,
      profileId,
      deposit,
    ],
  );
}

async function seatReservation(
  profileId: string,
  amount: number,
  deposit: number,
) {
  const session = await newSession();
  const reservationId = randomUUID();
  reservationIds.push(reservationId);
  await owner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
        duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
        source, seated_at, table_session_id)
     VALUES ($1, $2, $3, $4, '1033 Payer', now(), 90, 2, $5, $6, $7,
             'seated', 'staff', now(), $8)`,
    [
      reservationId,
      seededTenantId,
      outletId,
      profileId,
      session.zoneId,
      deposit,
      JSON.stringify({
        version: "t1033",
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
    ],
  );
  await owner.query(
    "UPDATE table_sessions SET reservation_id = $2 WHERE id = $1",
    [session.sessionId, reservationId],
  );
  // Each session consumes 5k of its allocation (an empty bill would turn the
  // leftover into a manual refund, not customer credit); the rest is credit.
  await addOrder(session.sessionId, CONSUMED, profileId, CONSUMED);
  settlements.set(session.sessionId, { total: CONSUMED, paid: amount });
  return { ...session, reservationId, amount };
}

/** One paid DOIT DP intent, shared by one reservation per entry of `shares`. */
async function sharedDp(shares: number[], guest?: string) {
  const deposit = shares.reduce((a, b) => a + b, 0);
  const profileId = guest ?? (await newProfile());
  const intentId = randomUUID();
  const linkId = randomUUID();
  intentIds.push(intentId);
  linkIds.push(linkId);
  const seats = [];
  for (const share of shares)
    seats.push(await seatReservation(profileId, share, deposit));
  await owner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 't1033-test')`,
    [
      linkId,
      seededTenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `T1033-${linkId.slice(0, 8)}`,
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
      seats[0]!.reservationId,
      deposit,
      `t1033-pay-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [seededTenantId, outletId, intentId, `t1033-evidence-${intentId}`, deposit],
  );
  await seedOriginalReceipt(intentId, deposit);
  for (const [index, seat] of seats.entries()) {
    // deposit_payment_link_id is unique per reservation: only the first
    // reservation of a shared intent carries the link (as in the 1020 T2 test).
    await owner.query(
      "UPDATE reservations SET deposit_payment_id = $2, deposit_payment_link_id = $3 WHERE id = $1",
      [seat.reservationId, intentId, index === 0 ? linkId : null],
    );
    await owner.query(
      `INSERT INTO reservation_deposit_allocations
         (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        seededTenantId,
        outletId,
        seat.reservationId,
        seat.sessionId,
        intentId,
        seat.amount,
      ],
    );
  }
  return { profileId, intentId, deposit, seats };
}

const close = (sessionId: string) =>
  closeTableSession(
    scope(),
    sessionId,
    closeTableSessionInputSchema.parse({
      tableCleaned: true,
      waiterConfirmedEmpty: false,
    }),
    staff.userId,
  );

async function remainders(reservationId: string) {
  const { rows } = await owner.query<{
    kind: string;
    amount_idr: string;
    remaining_idr: string;
  }>(
    "SELECT kind, amount_idr::text, remaining_idr::text FROM reservation_deposit_remainders WHERE reservation_id = $1",
    [reservationId],
  );
  return rows.map((r) => ({
    kind: r.kind,
    amount: Number(r.amount_idr),
    remaining: Number(r.remaining_idr),
  }));
}

/** The provider refund event; the same refundId twice is a duplicate event. */
async function providerRefunded(
  intentId: string,
  amountIdr: number,
  refundId = `rf_${randomUUID().slice(0, 12)}`,
) {
  await owner.query(
    `INSERT INTO payment_provider_refunds
       (tenant_id, outlet_id, payment_intent_id, provider, provider_refund_id,
        provider_payment_ref, amount_idr, source)
     VALUES ($1, $2, $3, 'doit', $4, $5, $6, 'payment_webhook')
     ON CONFLICT (tenant_id, provider, provider_refund_id) DO NOTHING`,
    [
      seededTenantId,
      outletId,
      intentId,
      refundId,
      `pay_${intentId.slice(0, 12)}`,
      amountIdr,
    ],
  );
}

const applyCredit = (
  profileId: string,
  sessionId: string,
  amount: number,
  key: string = randomUUID(),
) =>
  applyReservationCustomerCredit(
    scope(),
    staff.userId,
    outletId,
    {
      customerProfileId: profileId,
      tableSessionId: sessionId,
      amountIdr: idr(amount),
    },
    key,
  );

/** A later visit of the customer with an open bill of `total`. */
async function targetSession(profileId: string, total: number) {
  const target = await newSession();
  await addOrder(target.sessionId, total, profileId);
  settlements.set(target.sessionId, { total, paid: 0 });
  return target.sessionId;
}

const effectiveCredit = (sessionId: string, tenantId = seededTenantId) =>
  withTenant(db, scope(tenantId), (tx) =>
    depositCreditForSession(tx, tenantIdSchema.parse(tenantId), sessionId),
  );

async function expectNoNegativeRemainders(d: {
  seats: { reservationId: string }[];
}) {
  for (const seat of d.seats)
    for (const row of await remainders(seat.reservationId))
      expect(row.remaining).toBeGreaterThanOrEqual(0);
}

/** The guest cannot get one more IDR than the net value. */
async function expectNothingLeft(d: { profileId: string }) {
  const probe = await targetSession(d.profileId, 1);
  await expect(applyCredit(d.profileId, probe, 1)).rejects.toMatchObject({
    code: "CUSTOMER_CREDIT_NOT_AVAILABLE",
  });
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires disposable database");
  staff = await staffWithRole(createApp(), {
    template: "owner",
    label: "1033 DP Credit Owner",
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
      `INSERT INTO chart_of_accounts(id,tenant_id,legal_entity_id,code,name,type,report_group) VALUES($1,$2,$3,$4,'1033 DP receipt',$5,$6)`,
      [
        receiptAccounts[i],
        seededTenantId,
        receiptEntity,
        `987.${i + 1}`,
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
  tenantB = await createIsolatedTenant(`t1033-${randomUUID().slice(0, 6)}`);
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
      "reservation_credit_recon_flags",
      "reservation_customer_credit_uses",
      "reservation_deposit_remainders",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND table_session_id = ANY($2::uuid[])`,
        [seededTenantId, sessionIds],
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
      "DELETE FROM refund_recon_holds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
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
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await dropIsolatedTenant(tenantB);
  await owner.end();
});

const UNIT = 1_000;

/**
 * Total credit the guest can still take over all closed sessions of the DPs
 * they own, found by bisection. Every success really applies credit, a
 * rejection moves nothing. Ends with a 1 IDR probe: nothing is left.
 */
async function takeable(d: { profileId: string; deposit: number }) {
  let total = 0;
  let lo = 0;
  let hi = Math.ceil(d.deposit / UNIT);
  let target: string | null = null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    target ??= await targetSession(d.profileId, d.deposit);
    try {
      await applyCredit(d.profileId, target, mid * UNIT);
      total += mid * UNIT;
      target = null;
      lo = 0;
      hi -= mid;
    } catch (error) {
      if ((error as { code?: string }).code !== "CUSTOMER_CREDIT_NOT_AVAILABLE")
        throw error;
      hi = mid - 1;
    }
  }
  await expectNothingLeft(d);
  return total;
}

type Dp = Awaited<ReturnType<typeof sharedDp>>;

/** Money ceiling: consumed + credit + provider refund + open hold <= DP. */
function expectWithinPool(
  total: number,
  d: Dp,
  {
    refund = 0,
    hold = 0,
    floor = true,
  }: { refund?: number; hold?: number; floor?: boolean } = {},
) {
  const ceiling = Math.max(
    0,
    d.deposit - d.seats.length * CONSUMED - refund - hold,
  );
  expect(total, "credit above the net pool").toBeLessThanOrEqual(ceiling);
  // floor:false = the refund is larger than the later allocations, so the part
  // of it that cut an allocation with no remainder row is not recorded and the
  // pool is cut again (restrictive, the guest is under-credited, never over).
  if (floor)
    expect(total, "credit far below the net pool").toBeGreaterThanOrEqual(
      Math.max(0, ceiling - CONSUMED),
    );
  return ceiling;
}

type Mode =
  | "refund-before-close"
  | "refund-after-close"
  | "refund-between-closes"
  | "concurrent-close"
  | "concurrent-refund";

/** A shared DP, a provider refund and the closes in the given timing/order. */
async function scenario(
  shares: number[],
  refund: number,
  mode: Mode,
  order: number[] = shares.map((_, i) => i),
) {
  const d = await sharedDp(shares);
  const seat = (i: number) => d.seats[i]!.sessionId;
  switch (mode) {
    case "refund-before-close":
      await providerRefunded(d.intentId, refund);
      for (const i of order) await close(seat(i));
      break;
    case "refund-after-close":
      for (const i of order) await close(seat(i));
      await providerRefunded(d.intentId, refund);
      break;
    case "refund-between-closes":
      await close(seat(order[0]!));
      await providerRefunded(d.intentId, refund);
      for (const i of order.slice(1)) await close(seat(i));
      break;
    case "concurrent-close":
      await providerRefunded(d.intentId, refund);
      await Promise.all(order.map((i) => close(seat(i))));
      break;
    case "concurrent-refund":
      await Promise.all([
        providerRefunded(d.intentId, refund),
        ...order.map((i) => close(seat(i))),
      ]);
      break;
  }
  await expectNoNegativeRemainders(d);
  return { d, total: await takeable(d) };
}

/** An open recon hold on the intent (reference named another intent). */
async function openHold(
  intentId: string,
  amountIdr: number,
  refundId?: string,
) {
  const id = randomUUID();
  const providerRefundId = refundId ?? `rf_${randomUUID().slice(0, 12)}`;
  await asTenantTx(seededTenantId, (client) =>
    client.query(
      `INSERT INTO refund_recon_holds
         (id, tenant_id, payment_intent_id, webhook_event_id, provider_refund_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'Reference names another intent')`,
      [id, seededTenantId, intentId, randomUUID(), providerRefundId, amountIdr],
    ),
  );
  return { id, providerRefundId };
}

async function resolveHold(
  hold: { id: string; providerRefundId: string },
  intentId: string,
  amountIdr: number,
  resolution: "not_this_intent" | "counted_against_intent",
) {
  await asTenantTx(seededTenantId, (client) =>
    client.query(
      `UPDATE refund_recon_holds
          SET resolved_at = now(), resolution = $2, resolution_note = 't1033'
        WHERE id = $1 AND tenant_id = $3`,
      [hold.id, resolution, seededTenantId],
    ),
  );
  if (resolution === "counted_against_intent")
    await providerRefunded(intentId, amountIdr, hold.providerRefundId);
}

async function asTenantTx<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

const closeAll = async (d: Dp) => {
  for (const seat of d.seats) await close(seat.sessionId);
};

describe("legend-6n4p3 one net pool per intent: DP 100k = 50k + 50k, provider refund 40k", () => {
  it("1033-1 baseline: no refund, both sessions closed: guest takes 90k (100k - 2 x 5k consumed), not 1 IDR more", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await closeAll(d);
    expect(await takeable(d)).toBe(90_000);
  });

  const modes: Mode[] = [
    "refund-before-close",
    "refund-after-close",
    "refund-between-closes",
    "concurrent-close",
    "concurrent-refund",
  ];
  for (const mode of modes)
    it(`1033-1 ${mode}: total credit stays within 100k - 10k consumed - 40k refund = 50k`, async () => {
      const { d, total } = await scenario([50_000, 50_000], 40_000, mode);
      expectWithinPool(total, d, { refund: 40_000 });
    });

  it("1033-1 reverse close order (second session closes first), refund before, between and after: still within 50k", async () => {
    for (const mode of [
      "refund-before-close",
      "refund-between-closes",
      "refund-after-close",
    ] as const) {
      const { d, total } = await scenario(
        [50_000, 50_000],
        40_000,
        mode,
        [1, 0],
      );
      expectWithinPool(total, d, { refund: 40_000 });
    }
  });

  it("1033-1 the total does not depend on the order in which the sessions close or the refund arrives", async () => {
    const totals: number[] = [];
    for (const [mode, order] of [
      ["refund-before-close", [0, 1]],
      ["refund-before-close", [1, 0]],
      ["refund-after-close", [0, 1]],
      ["refund-after-close", [1, 0]],
      ["refund-between-closes", [0, 1]],
      ["refund-between-closes", [1, 0]],
    ] as const)
      totals.push(
        (await scenario([50_000, 50_000], 40_000, mode, [...order])).total,
      );
    expect(new Set(totals).size, `totals ${totals.join(",")}`).toBe(1);
  });

  it("1033-1 first session closed and its credit (45k) already applied, then the 40k provider refund, then the second closes: the rest is at most 5k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await close(d.seats[0]!.sessionId);
    const target = await targetSession(d.profileId, 45_000);
    await applyCredit(d.profileId, target, 45_000);
    await providerRefunded(d.intentId, 40_000);
    await close(d.seats[1]!.sessionId);
    const rest = await takeable(d);
    // 45k used + 10k consumed + 40k refund = 95k: at most 5k of the DP is left.
    expect(45_000 + rest, "used + rest above the net pool").toBeLessThanOrEqual(
      50_000,
    );
  });

  it("1033-1 uneven allocation 70k + 30k, provider refund 60k (more than the smaller allocation): never above 100k - 10k - 60k = 30k, whatever the timing and order", async () => {
    for (const [mode, order] of [
      ["refund-before-close", [0, 1]],
      ["refund-before-close", [1, 0]],
      ["refund-after-close", [0, 1]],
      ["refund-between-closes", [0, 1]],
      ["refund-between-closes", [1, 0]],
    ] as const) {
      const { d, total } = await scenario([70_000, 30_000], 60_000, mode, [
        ...order,
      ]);
      expectWithinPool(total, d, { refund: 60_000, floor: false });
    }
  });

  it("1033-1 three allocations 40k + 30k + 30k, provider refund 50k: never above 100k - 15k - 50k = 35k", async () => {
    const { d, total } = await scenario(
      [40_000, 30_000, 30_000],
      50_000,
      "refund-between-closes",
      [1, 0, 2],
    );
    expectWithinPool(total, d, { refund: 50_000, floor: false });
  });

  it("1033-1 two provider refunds (25k + 15k) behave like one of 40k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await providerRefunded(d.intentId, 25_000);
    await close(d.seats[0]!.sessionId);
    await providerRefunded(d.intentId, 15_000);
    await close(d.seats[1]!.sessionId);
    expectWithinPool(await takeable(d), d, { refund: 40_000 });
  });

  it("1033-1 the pool of this intent does not touch another DP of the same guest or of another guest, and another tenant sees nothing", async () => {
    const shared = await sharedDp([50_000, 50_000]);
    const sameGuest = await sharedDp([60_000], shared.profileId);
    const otherGuest = await sharedDp([100_000]);
    await providerRefunded(shared.intentId, 40_000);
    await closeAll(shared);
    await close(sameGuest.seats[0]!.sessionId);
    await close(otherGuest.seats[0]!.sessionId);

    // Other guest: 100k - 5k consumed, untouched.
    expect(await takeable(otherGuest)).toBe(95_000);
    // Same guest: own 55k from the 60k DP plus at most 50k from the shared one.
    const mine = await takeable({
      profileId: shared.profileId,
      deposit: 160_000,
    });
    expect(mine, "same guest: other DP 55k + shared pool").toBeLessThanOrEqual(
      55_000 + 50_000,
    );
    expect(mine).toBeGreaterThanOrEqual(55_000);

    const target = await targetSession(shared.profileId, 1_000);
    expect(await effectiveCredit(target, tenantB.tenantId)).toBe(0);
  });
});

describe("legend-obgj5 an open recon hold limits the credit", () => {
  it("1033-2 hold 20k open before the sessions close: credit within 100k - 10k - 20k = 70k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await openHold(d.intentId, 20_000);
    await closeAll(d);
    expectWithinPool(await takeable(d), d, { hold: 20_000 });
  });

  it("1033-2 hold 20k opens after both sessions closed, before any credit is applied: credit within 70k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await closeAll(d);
    await openHold(d.intentId, 20_000);
    expectWithinPool(await takeable(d), d, { hold: 20_000 });
  });

  it("1033-2 hold opens between the two closes: credit within 70k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await close(d.seats[0]!.sessionId);
    await openHold(d.intentId, 20_000);
    await close(d.seats[1]!.sessionId);
    expectWithinPool(await takeable(d), d, { hold: 20_000 });
  });

  it("1033-2 45k already applied, then a 20k hold opens: used + rest is at most 70k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await closeAll(d);
    const target = await targetSession(d.profileId, 45_000);
    await applyCredit(d.profileId, target, 45_000);
    await openHold(d.intentId, 20_000);
    const rest = await takeable(d);
    expect(45_000 + rest, "used + rest above the net pool").toBeLessThanOrEqual(
      70_000,
    );
  });

  it("1033-2 hold 20k plus provider refund 10k: credit within 100k - 10k - 30k = 60k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await providerRefunded(d.intentId, 10_000);
    await openHold(d.intentId, 20_000);
    await closeAll(d);
    expectWithinPool(await takeable(d), d, { refund: 10_000, hold: 20_000 });
  });

  it("1033-2 a hold larger than the whole DP leaves no credit, and nothing goes negative", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await openHold(d.intentId, 150_000);
    await closeAll(d);
    await expectNoNegativeRemainders(d);
    expect(await takeable(d)).toBe(0);
  });

  it("1033-2 hold resolved not_this_intent: the full 90k credit is back", async () => {
    const d = await sharedDp([50_000, 50_000]);
    const hold = await openHold(d.intentId, 20_000);
    await closeAll(d);
    await resolveHold(hold, d.intentId, 20_000, "not_this_intent");
    expect(await takeable(d)).toBe(90_000);
  });

  it("1033-2 hold resolved not_this_intent before the sessions close: the full 90k credit", async () => {
    const d = await sharedDp([50_000, 50_000]);
    const hold = await openHold(d.intentId, 20_000);
    await resolveHold(hold, d.intentId, 20_000, "not_this_intent");
    await closeAll(d);
    expect(await takeable(d)).toBe(90_000);
  });

  it("1033-2 hold resolved counted_against_intent: the 20k is a recorded provider refund, counted once (not twice)", async () => {
    const d = await sharedDp([50_000, 50_000]);
    const hold = await openHold(d.intentId, 20_000);
    await closeAll(d);
    await resolveHold(hold, d.intentId, 20_000, "counted_against_intent");
    expectWithinPool(await takeable(d), d, { refund: 20_000 });
  });

  it("1033-2 a hold on ANOTHER intent (same tenant, same guest) does not reduce this intent's credit", async () => {
    const a = await sharedDp([50_000, 50_000]);
    const b = await sharedDp([100_000], a.profileId);
    await openHold(b.intentId, 100_000);
    await closeAll(a);
    await close(b.seats[0]!.sessionId);
    // A keeps its full 90k; B is fully held (0). Total for the guest: 90k.
    expect(await takeable({ profileId: a.profileId, deposit: 200_000 })).toBe(
      90_000,
    );
  });

  it("1033-2 a hold on another guest's intent does not touch this guest", async () => {
    const a = await sharedDp([50_000, 50_000]);
    const other = await sharedDp([100_000]);
    await openHold(other.intentId, 100_000);
    await closeAll(a);
    await close(other.seats[0]!.sessionId);
    expect(await takeable(a)).toBe(90_000);
    expect(await takeable(other)).toBe(0);
  });
});

describe("legend-6n4p3 + legend-obgj5 conservation", () => {
  it("1033-3 whatever mix of refund and hold: consumed + credit + refund + open hold never exceeds the DP", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await providerRefunded(d.intentId, 15_000);
    await close(d.seats[1]!.sessionId);
    await openHold(d.intentId, 25_000);
    await close(d.seats[0]!.sessionId);
    const total = await takeable(d);
    expect(
      d.seats.length * CONSUMED + total + 15_000 + 25_000,
      "more value than the DP",
    ).toBeLessThanOrEqual(d.deposit);
  });
});

// ---------------------------------------------------------------------------
// Pre-close read: the credit a still-open session shows (depositCreditForSession)
// must also come from the one net pool of the intent. Added after the
// coordinator found that the post-close path (takeable) is already netted by
// 1020/mez2n, so the bug lives here.
//
// Assumptions: the sessions of a DP are summed (A + B); the reservation
// deposit_idr is the full DP (sharedDp does that). The ceiling here has NO
// consumed term (the credit a session shows is its pool share, consumed part
// included): sum <= DP - provider refund - open hold. The lower bound
// (ceiling - 5k, conservative) is asserted only while no session is closed,
// because the closed session's credit moves to remainders and its own read
// is not defined by the brief.
// ---------------------------------------------------------------------------

async function creditSum(d: Dp) {
  let sum = 0;
  const parts: number[] = [];
  for (const seat of d.seats) {
    const credit = await effectiveCredit(seat.sessionId);
    parts.push(credit);
    sum += credit;
  }
  return { sum, parts };
}

async function expectOpenSum(
  d: Dp,
  ceiling: number,
  { lower }: { lower: boolean },
) {
  const { sum, parts } = await creditSum(d);
  const label = `credits ${parts.join(" + ")}`;
  expect(sum, `${label}: above the net pool`).toBeLessThanOrEqual(ceiling);
  if (lower)
    expect(sum, `${label}: far below the net pool`).toBeGreaterThanOrEqual(
      ceiling - CONSUMED,
    );
}

/** A bill of `total` (no deposit applied) on every session of the DP. */
async function giveBills(d: Dp, total: number) {
  for (const seat of d.seats) {
    await addOrder(seat.sessionId, total, d.profileId);
    settlements.set(seat.sessionId, {
      total: CONSUMED + total,
      paid: seat.amount,
    });
  }
}

describe("legend-6n4p3 pre-close read: open sessions share one net pool", () => {
  for (const [shares, refund, ceiling] of [
    [[50_000, 50_000], 40_000, 60_000],
    [[70_000, 30_000], 60_000, 40_000],
    [[30_000, 70_000], 60_000, 40_000],
  ] as const) {
    const label = `${shares[0] / 1000}k + ${shares[1] / 1000}k, refund ${refund / 1000}k`;

    it(`1033-4 ${label}, no session closed: credits sum to at most ${ceiling / 1000}k`, async () => {
      const d = await sharedDp([...shares]);
      await providerRefunded(d.intentId, refund);
      await expectOpenSum(d, ceiling, { lower: true });
    });

    for (const closing of [0, 1])
      it(`1033-4 ${label}, session ${closing + 1} closed: credits (open + closed read) sum to at most ${ceiling / 1000}k`, async () => {
        const d = await sharedDp([...shares]);
        await providerRefunded(d.intentId, refund);
        await close(d.seats[closing]!.sessionId);
        await expectOpenSum(d, ceiling, { lower: false });
      });

    it(`1033-4 ${label}, refund arrives after session 1 closed: credits sum to at most ${ceiling / 1000}k`, async () => {
      const d = await sharedDp([...shares]);
      await close(d.seats[0]!.sessionId);
      await providerRefunded(d.intentId, refund);
      await expectOpenSum(d, ceiling, { lower: false });
    });
  }

  it("1033-4 no refund, no hold: the open sessions show the full 100k between them (baseline)", async () => {
    const d = await sharedDp([50_000, 50_000]);
    const { sum } = await creditSum(d);
    expect(sum).toBeLessThanOrEqual(100_000);
    expect(sum).toBeGreaterThanOrEqual(95_000);
  });

  it("1033-5 bills of 50k on both sessions, refund 40k: the credits across the sessions never exceed the net 60k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await giveBills(d, 50_000);
    await providerRefunded(d.intentId, 40_000);
    await expectOpenSum(d, 60_000, { lower: true });
  });

  it("1033-5 bills of 50k on both sessions, 70k + 30k, refund 60k: credits sum to at most 40k", async () => {
    const d = await sharedDp([70_000, 30_000]);
    await giveBills(d, 50_000);
    await providerRefunded(d.intentId, 60_000);
    await expectOpenSum(d, 40_000, { lower: true });
  });

  it("1033-5 bills of 50k on both sessions, no refund: credits sum to at most 100k (no more than the DP)", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await giveBills(d, 50_000);
    await expectOpenSum(d, 100_000, { lower: true });
  });
});

describe("legend-obgj5 pre-close read: an open hold limits the shown credit", () => {
  it("1033-6 open hold 20k, no session closed: credits sum to at most 80k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await openHold(d.intentId, 20_000);
    await expectOpenSum(d, 80_000, { lower: true });
  });

  it("1033-6 open hold 20k, one session closed: credits sum to at most 80k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await openHold(d.intentId, 20_000);
    await close(d.seats[0]!.sessionId);
    await expectOpenSum(d, 80_000, { lower: false });
  });

  it("1033-6 open hold 20k with bills of 50k on both sessions: credits sum to at most 80k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await giveBills(d, 50_000);
    await openHold(d.intentId, 20_000);
    await expectOpenSum(d, 80_000, { lower: true });
  });

  it("1033-6 hold 20k plus provider refund 10k: credits sum to at most 70k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await openHold(d.intentId, 20_000);
    await providerRefunded(d.intentId, 10_000);
    await expectOpenSum(d, 70_000, { lower: true });
  });

  it("1033-6 hold resolved not_this_intent: the shown credit is back to the full 100k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    const hold = await openHold(d.intentId, 20_000);
    await resolveHold(hold, d.intentId, 20_000, "not_this_intent");
    await expectOpenSum(d, 100_000, { lower: true });
  });

  it("1033-6 hold resolved counted_against_intent (recorded as a 20k provider refund): credits sum to at most 80k, counted once", async () => {
    const d = await sharedDp([50_000, 50_000]);
    const hold = await openHold(d.intentId, 20_000);
    await resolveHold(hold, d.intentId, 20_000, "counted_against_intent");
    await expectOpenSum(d, 80_000, { lower: true });
  });

  it("1033-6 a hold on another intent does not reduce this intent's shown credit", async () => {
    const a = await sharedDp([50_000, 50_000]);
    const other = await sharedDp([100_000]);
    await openHold(other.intentId, 100_000);
    await expectOpenSum(a, 100_000, { lower: true });
  });
});

// ---------------------------------------------------------------------------
// 1033-7 (architect finding): session 2 (the later allocation) pays a 50k bill
// fully from the DP BEFORE the provider refund of 40k arrives. The value already
// spent from the pool must be counted: session 1 can show/take at most
// 100k - 50k spent - 40k refund = 10k, and spent + credit + refund <= 100k.
//
// Assumptions: "spent" is the 50k of the extra bill with deposit_applied_idr =
// 50k, as in the brief (the 5k consumed by each session's base bill is not
// counted in the bound, which makes the bound looser, never stricter than the
// brief). credit(s1) is read with depositCreditForSession while session 1 is
// open; the total after closing session 1 is found with takeable().
// ---------------------------------------------------------------------------

const SPENT = 50_000;
const REFUND = 40_000;

/** Session 2 pays a 50k bill fully from the DP (before any provider refund). */
async function payFromDp(d: Dp, seat: number) {
  const s = d.seats[seat]!;
  await addOrder(s.sessionId, SPENT, d.profileId, SPENT);
  // Bill (base 5k + 50k) is fully settled by the deposit, so the table can close.
  settlements.set(s.sessionId, {
    total: CONSUMED + SPENT,
    paid: CONSUMED + SPENT,
  });
}

describe("legend-6n4p3 spent from the DP before the provider refund is counted", () => {
  it("1033-7 session 2 open, paid 50k from DP, then refund 40k: credit of open session 1 is at most 10k and spent + credit + refund <= 100k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await payFromDp(d, 1);
    await providerRefunded(d.intentId, REFUND);
    const credit = await effectiveCredit(d.seats[0]!.sessionId);
    expect(
      credit,
      "credit of session 1 above 100k - 50k - 40k",
    ).toBeLessThanOrEqual(10_000);
    expect(
      SPENT + credit + REFUND,
      "more value than the DP",
    ).toBeLessThanOrEqual(d.deposit);
  });

  it("1033-7 both sessions open, paid 50k from DP on session 2, refund 40k: session 1 reads at most 10k, session 2 reads nothing above the rest", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await payFromDp(d, 1);
    await providerRefunded(d.intentId, REFUND);
    const { sum, parts } = await creditSum(d);
    expect(parts[0]!, "credit of session 1").toBeLessThanOrEqual(10_000);
    // Session 2's read credit (a cap for what is still to come) does not
    // include what it already spent; its value to the guest is the larger.
    expect(sum).toBe(parts[0]! + parts[1]!);
    expect(
      parts[0]! + Math.max(SPENT, parts[1]!) + REFUND,
      `credits ${parts.join(" + ")}: more value than the DP`,
    ).toBeLessThanOrEqual(d.deposit);
  });

  it("1033-7 session 2 closed after paying from DP, then refund 40k: open session 1 reads at most 10k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await payFromDp(d, 1);
    await close(d.seats[1]!.sessionId);
    await providerRefunded(d.intentId, REFUND);
    const credit = await effectiveCredit(d.seats[0]!.sessionId);
    expect(
      credit,
      "credit of session 1 above 100k - 50k - 40k",
    ).toBeLessThanOrEqual(10_000);
    expect(
      SPENT + credit + REFUND,
      "more value than the DP",
    ).toBeLessThanOrEqual(d.deposit);
    await expectNoNegativeRemainders(d);
  });

  it("1033-7 session 2 closed after paying from DP, refund 40k, then session 1 closes: the guest takes at most 10k and spent + takeable + refund <= 100k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await payFromDp(d, 1);
    await close(d.seats[1]!.sessionId);
    await providerRefunded(d.intentId, REFUND);
    await close(d.seats[0]!.sessionId);
    await expectNoNegativeRemainders(d);
    const total = await takeable(d);
    expect(total, "takeable above 100k - 50k - 40k").toBeLessThanOrEqual(
      10_000,
    );
    expect(
      SPENT + total + REFUND,
      "more value than the DP",
    ).toBeLessThanOrEqual(d.deposit);
  });

  it("1033-7 session 2 open (paid from DP), refund 40k, session 1 closes: the guest takes at most 10k and spent + takeable + refund <= 100k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await payFromDp(d, 1);
    await providerRefunded(d.intentId, REFUND);
    await close(d.seats[0]!.sessionId);
    await expectNoNegativeRemainders(d);
    const total = await takeable(d);
    expect(total, "takeable above 100k - 50k - 40k").toBeLessThanOrEqual(
      10_000,
    );
    expect(
      SPENT + total + REFUND,
      "more value than the DP",
    ).toBeLessThanOrEqual(d.deposit);
  });

  it("1033-7 session 1 closes first, then session 2 pays from DP and closes, refund last: spent + takeable + refund <= 100k", async () => {
    const d = await sharedDp([50_000, 50_000]);
    await close(d.seats[0]!.sessionId);
    await payFromDp(d, 1);
    await close(d.seats[1]!.sessionId);
    await providerRefunded(d.intentId, REFUND);
    await expectNoNegativeRemainders(d);
    const total = await takeable(d);
    expect(total, "takeable above 100k - 50k - 40k").toBeLessThanOrEqual(
      10_000,
    );
    expect(
      SPENT + total + REFUND,
      "more value than the DP",
    ).toBeLessThanOrEqual(d.deposit);
  });
});
