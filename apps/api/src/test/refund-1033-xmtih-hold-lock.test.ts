// legend-xmtih (brief 1033, money): a refund_recon_hold must be created under
// the same deposit-intent advisory lock a customer-credit apply holds SHARED
// and the provider-refund recorder takes EXCLUSIVE (legend-9uvvu). Two paths
// file a hold without that lock today:
//   (a) the REFERENCE_MISMATCH hold of a signed DOIT refund.succeeded webhook
//       (the intent that owns the payment id gets the hold);
//   (b) the live-own hold of the recorder when our own in-flight refund already
//       covers the whole transaction (legend-tiyce branch, which returns before
//       the recorder's own lock).
// Correct: the hold creator WAITS for a running credit apply (it commits first)
// or an apply arriving after the hold sees the hold. Never "credit used in full
// from the pre-hold amount AND an open hold, with no defined order".
//
// Written from the brief and the 1025c-B / 1033 fixtures, not from the fix.
// Fail-first. Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1033-xmtih-hold-lock.test.ts" heavy pnpm test
//
// Scenario numbers: DP 100.000, session A consumes 60.000 -> 40.000 customer
// credit; the guest takes 40.000 of it on session B (bill 40.000).
//
// Assumptions where the brief is not exact:
//  - Barrier as in 9uvvu: a real credit apply is stalled AFTER it took its
//    advisory locks (owner-side LOCK TABLE ... IN SHARE MODE on the tables it
//    writes). The deposit-intent lock key is not guessed: a hold creator "waits
//    on the lock" when pg_locks shows it queued (not granted) on one of the
//    advisory keys the stalled apply holds. No sleep decides pass/fail.
//  - Path (a) is driven over HTTP with the reverse mismatch shape of the 1025-C
//    tests: the event names the intent's own payment id but a reference that is
//    not that intent's id. The intent is bound to a DOIT integration (secret
//    known to the test) so the signature is accepted.
//  - Path (b) is the full-refund door (`payment:<ref>`, force) with our own
//    approved, sent, not yet acknowledged refund of the whole 100.000 in flight
//    (seeded directly; the DP is applied to a seated bill so the API refuses it).
//  - What the fix does about credit applied to a still open session is not
//    pinned: after both finished either the guest can spend nothing beyond the
//    net (effective credit <= net after the hold) or a
//    credit_used_before_provider_refund hold names the surplus.
//  - Other tenant: a real second tenant is out of reach for this fixture, so
//    "unaffected" = a second DP intent of the same tenant (its lock key differs)
//    is not made to wait; the key embeds the tenant id, so another tenant is
//    unaffected a fortiori.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { idr, outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { closeTableSessionInputSchema } from "@starter/shared/qr-order";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { resetPaymentWebhookRateLimits } from "../routes/payment-webhook.routes";
import {
  clearDoitWebhookSecretCache,
  reprocessStoredWebhookEvents,
} from "../services/payment-webhook.service";
import { recordProviderRefundInTx } from "../services/payment-provider-partial-refund.ts";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import { depositCreditForSession } from "../services/reservation-lifecycle.ts";
import { applyReservationCustomerCredit } from "../services/reservation-deposit-remainder.ts";
import {
  closeTableSession,
  openOrJoinTableSession,
  setTableSessionSettlementLookup,
} from "../services/table-session.service.ts";
import {
  createTable,
  createZone,
  issueQr,
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";

const CREDIT_HOLD = "credit_used_before_provider_refund";
const outletId = outletIdSchema.parse(seededOutletA);
const scope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
const app = createApp();
const webhookPath = `/api/webhooks/payments/doit/${seededTenantId}`;
const webhookSecret = `whsec-xmtih-${randomBytes(16).toString("hex")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zoneIds: string[] = [];
const tableIds: string[] = [];
const reservationIds: string[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
const profileIds: string[] = [];
const orderIds: string[] = [];
const sessionIds: string[] = [];
const eventIds: string[] = [];
const settlements = new Map<string, { total: number; paid: number } | null>();
let staff: Staff;
let integrationId = "";
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
 VALUES($1,$2,$3,$4,$5,$6,'customer_deposit',$7,'Penerimaan DP xmtih',$8,$9)`,
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
}

async function newProfile() {
  const id = randomUUID();
  profileIds.push(id);
  await owner.query(
    `INSERT INTO customer_profiles
       (id, tenant_id, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, 'xmtih Customer', 'active', now())`,
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
    deviceHash: `txmtih-${randomUUID()}`,
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
      `TXMTIH-${id.slice(0, 8)}`,
      total,
      deposit,
      sessionId,
      profileId,
    ],
  );
}

type Deposit = Awaited<ReturnType<typeof paidDeposit>>;

/** Paid DP 100.000 seated on session A whose bill is 60.000 (DP covers it). */
async function paidDeposit() {
  const profileId = await newProfile();
  const total = 60_000;
  const deposit = 100_000;
  const session = await newSession();
  const reservationId = randomUUID();
  const intentId = randomUUID();
  const linkId = randomUUID();
  const providerRef = `txmtih-evidence-${intentId}`;
  reservationIds.push(reservationId);
  intentIds.push(intentId);
  linkIds.push(linkId);
  await owner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
        duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
        source, seated_at, table_session_id)
     VALUES ($1, $2, $3, $4, 'xmtih Payer', now(), 90, 2, $5, $6, $7,
             'seated', 'staff', now(), $8)`,
    [
      reservationId,
      seededTenantId,
      outletId,
      profileId,
      session.zoneId,
      deposit,
      JSON.stringify({
        version: "txmtih",
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
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'txmtih-test')`,
    [
      linkId,
      seededTenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `TXMTIH-${linkId.slice(0, 8)}`,
      deposit,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, reservation_id, method, provider,
        provider_ref, amount_idr, idempotency_key, status, instructions, expires_at, paid_at,
        gateway_integration_id)
     VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, $8, 'paid',
       '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
       now() + interval '1 hour', now(), $9)`,
    [
      intentId,
      seededTenantId,
      outletId,
      linkId,
      reservationId,
      providerRef,
      deposit,
      `txmtih-pay-${intentId}`,
      integrationId,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [seededTenantId, outletId, intentId, providerRef, deposit],
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
  await seedOriginalReceipt(intentId, deposit);
  return {
    ...session,
    reservationId,
    intentId,
    profileId,
    providerRef,
    deposit,
    total,
  };
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
    "SELECT kind, amount_idr::text, remaining_idr::text FROM reservation_deposit_remainders WHERE reservation_id = $1 ORDER BY kind, amount_idr, remaining_idr",
    [reservationId],
  );
  return rows.map((r) => ({
    kind: r.kind,
    amount: Number(r.amount_idr),
    remaining: Number(r.remaining_idr),
  }));
}

const applyCredit = (profileId: string, sessionId: string, amount: number) =>
  applyReservationCustomerCredit(
    scope(),
    staff.userId,
    outletId,
    {
      customerProfileId: profileId,
      tableSessionId: sessionId,
      amountIdr: idr(amount),
    },
    randomUUID(),
  );

/** A second visit of the same customer with an open bill of `total`. */
async function targetSession(profileId: string, total: number) {
  const target = await newSession();
  await addOrder(target.sessionId, total, 0, profileId);
  // The bill is covered by the credit the guest takes.
  settlements.set(target.sessionId, { total, paid: total });
  return target.sessionId;
}

const effectiveCredit = (sessionId: string) =>
  withTenant(db, scope(), (tx) =>
    depositCreditForSession(
      tx,
      tenantIdSchema.parse(seededTenantId),
      sessionId,
    ),
  );

/** DP 100k, A consumed 60k and closed: 40k credit exists for the customer. */
async function closedSourceWithCredit() {
  const d = await paidDeposit();
  await close(d.sessionId);
  expect(await remainders(d.reservationId)).toEqual([
    { kind: "customer_credit", amount: 40_000, remaining: 40_000 },
  ]);
  return d;
}

type Hold = { id: string; amount: number; reason: string; open: boolean };

async function holdsOf(intentId: string): Promise<Hold[]> {
  const { rows } = await owner.query<{
    id: string;
    amount_idr: string;
    reason: string;
    resolved_at: Date | null;
  }>(
    `SELECT id, amount_idr::text, reason, resolved_at FROM refund_recon_holds
      WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY flagged_at`,
    [seededTenantId, intentId],
  );
  return rows.map((r) => ({
    id: r.id,
    amount: Number(r.amount_idr),
    reason: r.reason,
    open: r.resolved_at === null,
  }));
}
const mismatchHolds = async (intentId: string) =>
  (await holdsOf(intentId)).filter((h) =>
    h.reason.includes("REFERENCE_MISMATCH"),
  );
const liveOwnHolds = async (intentId: string) =>
  (await holdsOf(intentId)).filter((h) => h.reason.includes("REFUND_LIVE_OWN"));
const creditHolds = async (intentId: string) =>
  (await holdsOf(intentId)).filter((h) => h.reason.startsWith(CREDIT_HOLD));

// --- path (a): signed refund.succeeded webhook with a reference mismatch ----

function signatureHeader(raw: string): string {
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", webhookSecret)
    .update(`${t}.${raw}`)
    .digest("hex");
  return `t=${t},v1=${mac}`;
}

/**
 * The provider's refund.succeeded reaches the webhook. Inside the 15 minute
 * retry window the event is stored `failed` and nothing is held yet; the hold
 * is filed by the retry worker once the event is older (as the 1025-C tests do).
 * This stores the event and ages it, so `runWorker` files the hold.
 */
async function armMismatch(d: Deposit, amountIdr: number) {
  const eventId = `evt_${randomBytes(8).toString("hex")}`;
  eventIds.push(eventId);
  const otherReference = randomUUID(); // not this intent's id
  const raw = JSON.stringify({
    id: eventId,
    type: "refund.succeeded",
    created_at: new Date().toISOString(),
    data: {
      refund: {
        id: `rf_${randomBytes(6).toString("hex")}`,
        amount: amountIdr,
        reference: otherReference,
      },
      payment: {
        id: d.providerRef,
        reference: otherReference,
        status: "refunded",
        amount: amountIdr,
      },
    },
  });
  const response = await request(app)
    .post(webhookPath)
    .set("Content-Type", "application/json")
    .set("PayBridge-Signature", signatureHeader(raw))
    .send(raw);
  // Signature accepted and event stored (a 5xx asks the provider to retry).
  expect(response.status, JSON.stringify(response.body)).not.toBe(401);
  await owner.query(
    `UPDATE gateway_webhook_events
        SET received_at = now() - interval '20 minutes',
            updated_at = now() - interval '20 minutes'
      WHERE tenant_id = $1 AND event_id = $2`,
    [seededTenantId, eventId],
  );
  expect(
    (
      await owner.query(
        "SELECT 1 FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2",
        [seededTenantId, eventId],
      )
    ).rowCount,
    "premise: the event is stored",
  ).toBe(1);
  return eventId;
}

const webhookContext = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenantIdSchema.parse(seededTenantId),
    brandId: null,
    source: "webhook",
  }),
  { kind: "tenant" },
);

/** The retry worker reprocesses the aged event: this is where the hold is filed. */
const runWorker = () =>
  reprocessStoredWebhookEvents(webhookContext, new Date(), 100).catch(
    () => null,
  );

// --- path (b): recorder, our own refund of the whole transaction in flight ---

async function addOwnRefundInFlight(d: Deposit, amountIdr: number) {
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, provider_ref, payout_attempts)
     VALUES ($1, $2, $3, $4, $5, 'xmtih refund in flight', 'approved',
             $6, 'approver', now(), NULL, NULL, 1)`,
    [
      randomUUID(),
      seededTenantId,
      outletId,
      d.intentId,
      amountIdr,
      staff.userId,
    ],
  );
}

/** The full-refund door (`synthetic_full`) with our whole-DP refund in flight. */
function recordFullRefund(d: Deposit) {
  const context = scope();
  return withTenant(db, context, (tx) =>
    recordProviderRefundInTx(
      tx,
      context,
      {
        provider: "doit",
        providerRefundId: d.providerRef,
        refundIdKind: "synthetic_full",
        providerPaymentRef: d.providerRef,
        amountIdr: d.deposit,
        source: "refund_webhook",
        expectedIntentId: d.intentId,
        force: true,
      },
      new Date(),
    ),
  );
}

// --- barrier -----------------------------------------------------------------

type Stall = { keys: string[]; applying: Promise<unknown> };

/**
 * Runs `body` while a real credit apply (40k of the closed source's credit onto
 * a fresh bill of 40k) is stalled after it took its advisory locks. The stall
 * is released afterwards, always, and the apply awaited.
 */
async function whileApplyStalled<T>(
  d: Deposit,
  body: (stall: Stall & { target: string }) => Promise<T>,
): Promise<{ result: T; target: string }> {
  const target = await targetSession(d.profileId, 40_000);
  const gate = await owner.connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await gate.query("ROLLBACK");
    gate.release();
  };
  let applying: Promise<unknown> = Promise.resolve();
  try {
    // SHARE mode blocks the apply's writes only; its reads and locks pass.
    await gate.query("BEGIN");
    await gate.query(
      "LOCK TABLE reservation_customer_credit_uses, reservation_deposit_remainders IN SHARE MODE",
    );
    applying = applyCredit(d.profileId, target, 40_000);
    applying.catch(() => undefined);
    let keys: string[] = [];
    const deadline = Date.now() + 15_000;
    while (keys.length === 0) {
      if (Date.now() > deadline)
        throw new Error(
          "premise: the credit apply never stalled holding locks",
        );
      const { rows } = await owner.query<{ key: string }>(
        `SELECT l.classid::text || ':' || l.objid::text || ':' || l.objsubid::text AS key
           FROM pg_stat_activity a
           JOIN pg_locks l ON l.pid = a.pid
          WHERE a.datname = current_database()
            AND a.pid <> pg_backend_pid()
            AND a.wait_event_type = 'Lock' AND a.wait_event = 'relation'
            AND l.locktype = 'advisory' AND l.granted AND l.mode = 'ShareLock'`,
      );
      keys = rows.map((r) => r.key);
      if (keys.length === 0) await sleep(50);
    }
    const result = await body({ keys, applying, target });
    return { result, target };
  } finally {
    await release();
    await Promise.allSettled([applying]);
  }
}

async function queuedOn(keys: string[]) {
  const { rows } = await owner.query<{ key: string }>(
    `SELECT classid::text || ':' || objid::text || ':' || objsubid::text AS key
       FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
  );
  return rows.some((r) => keys.includes(r.key));
}

/**
 * Resolves once the hold creator is queued on one of the apply's advisory
 * keys (it waits) or has finished (it did not wait). Polls; no fixed sleep
 * decides the outcome.
 */
async function waitsOrFinishes(
  keys: string[],
  finished: () => boolean,
): Promise<"waiting" | "finished"> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (finished()) return "finished";
    if (await queuedOn(keys)) return "waiting";
    await sleep(50);
  }
  throw new Error("hold creator neither queued on the lock nor finished");
}

/** A promise that also records that it settled. */
function track<T>(p: Promise<T>) {
  const state = { done: false };
  const tracked = p.then(
    (v) => {
      state.done = true;
      return v;
    },
    (e) => {
      state.done = true;
      throw e;
    },
  );
  tracked.catch(() => undefined);
  return { state, tracked };
}

async function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not finish within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires disposable database");
  staff = await staffWithRole(app, {
    template: "owner",
    label: "xmtih DP Hold Owner",
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
      `INSERT INTO chart_of_accounts(id,tenant_id,legal_entity_id,code,name,type,report_group) VALUES($1,$2,$3,$4,'xmtih DP receipt',$5,$6)`,
      [
        receiptAccounts[i],
        seededTenantId,
        receiptEntity,
        `985.${i + 1}`,
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
  // The DOIT integration whose secret signs the webhook (outlet scoped, so no
  // other suite's tenant-wide integration is touched).
  const created = await upsertIntegration(
    scope(),
    {
      outletId: null,
      provider: "doit",
      config: { baseUrl: "http://127.0.0.1:9" },
      credentials: { apiKey: `doit-key-xmtih-${randomUUID()}`, webhookSecret },
    },
    staff.userId,
  );
  await setIntegrationStatus(
    scope(),
    created.id,
    { status: "active" },
    staff.userId,
  );
  integrationId = created.id;
  clearDoitWebhookSecretCache();
});

beforeEach(() => {
  resetPaymentWebhookRateLimits();
  clearDoitWebhookSecretCache();
});

afterAll(async () => {
  setTableSessionSettlementLookup(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "DELETE FROM journal_lines WHERE entry_id=ANY($1::uuid[])",
      [receiptEntries],
    );
    await client.query("DELETE FROM journal_entries WHERE id=ANY($1::uuid[])", [
      receiptEntries,
    ]);
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
    await client.query(
      "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      "DELETE FROM refund_recon_holds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      "DELETE FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = ANY($2::text[])",
      [seededTenantId, eventIds],
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
    await client.query("DELETE FROM tenant_integrations WHERE id = $1", [
      integrationId,
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
  await owner
    .query("DELETE FROM table_sessions WHERE id = ANY($1::uuid[])", [
      sessionIds,
    ])
    .catch(() => undefined);
  void zoneIds;
  void tableIds;
});

describe("legend-xmtih controls: the hold paths work when no credit apply runs", () => {
  it("xmtih-a0 a signed refund.succeeded with a foreign reference files ONE open mismatch hold on the intent that owns the payment id", async () => {
    const d = await closedSourceWithCredit();
    await armMismatch(d, 40_000);
    await runWorker();
    const holds = await mismatchHolds(d.intentId);
    expect(holds, "premise: the mismatch hold exists").toHaveLength(1);
    expect(holds[0]).toMatchObject({ amount: 40_000, open: true });
  });

  it("xmtih-b0 our own whole-DP refund in flight and the provider refunding everything files ONE live-own hold", async () => {
    const d = await closedSourceWithCredit();
    await addOwnRefundInFlight(d, 100_000);
    await recordFullRefund(d);
    const holds = await liveOwnHolds(d.intentId);
    expect(holds, "premise: the live-own hold exists").toHaveLength(1);
    expect(holds[0]).toMatchObject({ open: true });
  });
});

describe("legend-xmtih the hold creator waits for a running credit apply", () => {
  it("xmtih-a1 path (a): mismatch hold waits while a credit apply holds the deposit-intent lock, files after it committed", async () => {
    const d = await closedSourceWithCredit();
    await armMismatch(d, 40_000);
    const { result } = await whileApplyStalled(d, async ({ keys }) => {
      const worker = track(runWorker());
      const outcome = await waitsOrFinishes(keys, () => worker.state.done);
      const visible = await mismatchHolds(d.intentId);
      return { worker, outcome, visible };
    });
    expect(
      result.outcome,
      "the mismatch hold creator must queue on the deposit-intent lock",
    ).toBe("waiting");
    expect(result.visible, "no hold while the apply is still running").toEqual(
      [],
    );
    await result.worker.tracked;
    const holds = await mismatchHolds(d.intentId);
    expect(
      holds,
      "after the apply committed the hold is filed once",
    ).toHaveLength(1);
    expect(holds[0]).toMatchObject({ amount: 40_000, open: true });
  }, 60_000);

  it("xmtih-b1 path (b): live-own hold waits while a credit apply holds the deposit-intent lock, files after it committed", async () => {
    const d = await closedSourceWithCredit();
    const { result } = await whileApplyStalled(d, async ({ keys }) => {
      // Filed after the apply read the net, so the apply is not refused up front.
      await addOwnRefundInFlight(d, 100_000);
      const recording = track(recordFullRefund(d));
      const outcome = await waitsOrFinishes(keys, () => recording.state.done);
      const visible = await liveOwnHolds(d.intentId);
      return { recording, outcome, visible };
    });
    expect(
      result.outcome,
      "the live-own hold creator must queue on the deposit-intent lock",
    ).toBe("waiting");
    expect(result.visible, "no hold while the apply is still running").toEqual(
      [],
    );
    await result.recording.tracked;
    const holds = await liveOwnHolds(d.intentId);
    expect(
      holds,
      "after the apply committed the hold is filed once",
    ).toHaveLength(1);
  }, 60_000);
});

describe("legend-xmtih money: hold and credit apply together never pay the guest more", () => {
  it("xmtih-m1 mismatch hold 40k at the same time as a 40k credit apply: guest can spend nothing above the net, or the surplus is held with a credit trace", async () => {
    const d = await closedSourceWithCredit();
    await armMismatch(d, 40_000);
    const { result, target } = await whileApplyStalled(d, async ({ keys }) => {
      const worker = track(runWorker());
      // Either it queues behind the apply (fixed) or it ran at once (bug); the
      // apply is released in both cases and the outcome is judged afterwards.
      await waitsOrFinishes(keys, () => worker.state.done);
      return worker;
    });
    await result.tracked;

    const openHold = (await mismatchHolds(d.intentId))
      .filter((h) => h.open)
      .reduce((s, h) => s + h.amount, 0);
    expect(openHold, "premise: the mismatch hold exists").toBe(40_000);
    // Net DP left once the held 40k is counted as gone: 100 - 60 - 40 = 0.
    const net = Math.max(0, d.deposit - 60_000 - openHold);
    const spendable = await effectiveCredit(target);
    const trace = (await creditHolds(d.intentId)).filter((h) => h.open);
    expect(
      spendable <= net || trace.length > 0,
      `guest can spend ${spendable} of a net of ${net} and no ${CREDIT_HOLD} hold names the surplus`,
    ).toBe(true);
    // Never a trace for money that was not used, nor for more than was used.
    for (const h of trace) expect(h.amount).toBeLessThanOrEqual(40_000);
  }, 60_000);

  it("xmtih-m2 control: a mismatch hold that is already committed limits a credit apply that comes after it", async () => {
    const d = await closedSourceWithCredit();
    await armMismatch(d, 40_000);
    await runWorker();
    expect(await mismatchHolds(d.intentId)).toHaveLength(1);
    const target = await targetSession(d.profileId, 40_000);
    await applyCredit(d.profileId, target, 40_000).catch(() => undefined);
    // Net after the held 40k = 0: the guest can spend nothing of this DP.
    expect(await effectiveCredit(target)).toBeLessThanOrEqual(0);
  }, 60_000);
});

describe("legend-xmtih other intents and tenants are not slowed down", () => {
  it("xmtih-i1 a credit apply of one intent in flight does not make a hold path of ANOTHER intent wait", async () => {
    const stalled = await closedSourceWithCredit();
    const other = await closedSourceWithCredit();
    await addOwnRefundInFlight(other, 100_000);
    await armMismatch(other, 40_000);
    await whileApplyStalled(stalled, async () => {
      await within(15_000, runWorker(), "mismatch hold of the other intent");
      await within(
        15_000,
        recordFullRefund(other),
        "live-own hold of the other intent",
      );
    });
    expect(await mismatchHolds(other.intentId)).toHaveLength(1);
    expect(await liveOwnHolds(other.intentId)).toHaveLength(1);
    expect(await holdsOf(stalled.intentId), "stalled intent untouched").toEqual(
      [],
    );
  }, 90_000);
});
