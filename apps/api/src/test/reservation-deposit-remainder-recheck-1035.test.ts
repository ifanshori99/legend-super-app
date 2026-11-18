// legend-8cm5k (brief 1035, finding C / second-opinion 1034 item 4): applying
// customer DP credit must only spend credit whose source was validated (receipt
// posted and not reversed, source locked). A remainder that appears between the
// candidate read and the spend read (another session finalising for the same
// customer) must never be spent unvalidated.
// Written from docs/qa/second-opinion-refund-ronde2-1034.md (item 4) and
// docs/briefs/sub-1035-refund-so2.md, not from the implementation. Fixtures
// copied from reservation-deposit-remainder.test.ts.
//
// Assumptions:
// - Barrier: a separate connection holds the customer profile FOR UPDATE, so
//   apply parks between its two reads; the test polls pg_blocking_pids (never
//   a fixed sleep), then lets the OTHER session finalise source B (real
//   closeTableSession) and commit, then releases the profile. If the fix makes finalisation
//   wait for apply's lock instead, the close simply finishes after apply; the
//   assertions hold in both orders (see MONEY INVARIANT below).
// - MONEY INVARIANT: only validated credit can be spent. Source B's receipt is
//   missing (variant 1) or reversed (variant 2), so nothing of B may be moved
//   or spent: spend <= credit of A, B's remainder stays untouched, and a
//   later apply cannot reach B either.
// - Control: B with a posted receipt is spendable (apply never over-blocks).
// - Another tenant sees none of these remainders.
//
// Run: LEGEND_TEST_FILES="src/test/reservation-deposit-remainder-recheck-1035.test.ts" heavy pnpm test
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
import { reverseJournal } from "../services/accounting-journal.service.ts";
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
    receipt?: boolean;
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
  const receiptJournalId =
    input.receipt === false
      ? null
      : await seedOriginalReceipt(intentId, deposit);
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
      "reservation_credit_recon_flags",
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

const applyCredit = async (
  profileId: string,
  sessionId: string,
  amount: number,
  key: string = randomUUID(),
) => {
  const { applyReservationCustomerCredit } =
    await import("../services/reservation-deposit-remainder.ts");
  return applyReservationCustomerCredit(
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
};

async function spendTotal(sessionId: string) {
  const { rows } = await owner.query<{ amount: string }>(
    "SELECT coalesce(sum(amount_idr), 0)::text AS amount FROM reservation_customer_credit_uses WHERE tenant_id = $1 AND table_session_id = $2",
    [seededTenantId, sessionId],
  );
  return Number(rows[0]!.amount);
}

async function targetSession(profileId: string, total: number) {
  const target = await newSession();
  await addOrder(target.sessionId, total, 0, profileId);
  settlements.set(target.sessionId, { total, paid: 0 });
  return target.sessionId;
}

const creditRows = async (reservationId: string) =>
  (await remainders(reservationId)).filter((r) => r.kind === "customer_credit");

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 20));

type Settled = { status: "fulfilled" | "rejected" };

/**
 * Barrier BETWEEN apply's two reads: its candidate read takes no row lock, so
 * another transaction holding the customer profile FOR UPDATE parks apply on
 * its later profile FOR SHARE, after the first read and the deposit-intent
 * lock (observed on pg_blocking_pids, never a fixed sleep). While it is
 * parked the other session finalises source B and commits: B is invisible to
 * the first read, visible to the second. Then the profile is released. If finalisation itself waits on the same row
 * (a fix that serialises finalisation behind apply), "two blocked backends"
 * releases the barrier too; the assertions hold in either order.
 */
async function applyWhileSourceFinalises(input: {
  profileId: string;
  amount: number;
  target: string;
  finaliseB: () => Promise<unknown>;
}) {
  const blocker = await owner.connect();
  let applyOutcome: Settled & { error?: unknown } = { status: "rejected" };
  let applySettled = false;
  let closeSettled = false;
  try {
    await blocker.query("BEGIN");
    const pid = (
      await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    await blocker.query(
      "SELECT 1 FROM customer_profiles WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [seededTenantId, input.profileId],
    );
    const blockedCount = async () =>
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [pid],
        )
      ).rows[0].n as number;
    const apply = applyCredit(input.profileId, input.target, input.amount)
      .then(
        () => (applyOutcome = { status: "fulfilled" }),
        (error: unknown) => (applyOutcome = { status: "rejected", error }),
      )
      .finally(() => {
        applySettled = true;
      });
    for (let n = 0; n < 1000 && !applySettled; n++) {
      if ((await blockedCount()) > 0) break;
      await nextTick();
    }
    const finalise = input
      .finaliseB()
      .catch(() => undefined)
      .finally(() => {
        closeSettled = true;
      });
    for (let n = 0; n < 1000 && !closeSettled; n++) {
      if ((await blockedCount()) >= 2) break;
      await nextTick();
    }
    await blocker.query("COMMIT");
    await Promise.all([apply, finalise]);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  return applyOutcome;
}

/*
 * Finalising B through closeTableSession inside the barrier is not possible:
 * it needs the customer profile row that the barrier holds. So the session of
 * B is closed BEFORE the race (its remainder is real, written by the real
 * close) and parked at remaining 0 (a spent remainder: invisible to apply's
 * first read, which only takes remainders with credit left). Inside the
 * barrier "another session finalises B" is the commit that gives B its
 * credit back (remaining = amount), after apply's first read. B is also made
 * older than A (assumption: apply draws the oldest remainder first), so a
 * wrongly admitted B is the one that gets spent.
 */
async function closeAndHide(b: Awaited<ReturnType<typeof paidDeposit>>) {
  await close(b.sessionId);
  const { rowCount } = await owner.query(
    "UPDATE reservation_deposit_remainders SET remaining_idr = 0, created_at = created_at - interval '1 day' WHERE tenant_id = $1 AND reservation_id = $2 AND kind = 'customer_credit'",
    [seededTenantId, b.reservationId],
  );
  expect(rowCount).toBe(1);
}
async function reveal(b: Awaited<ReturnType<typeof paidDeposit>>) {
  await owner.query(
    "UPDATE reservation_deposit_remainders SET remaining_idr = amount_idr WHERE tenant_id = $1 AND reservation_id = $2 AND kind = 'customer_credit'",
    [seededTenantId, b.reservationId],
  );
}

describe("legend-8cm5k finding C: apply never spends a remainder that appeared after validation", () => {
  async function sourcesWhereBHasNoValidReceipt(
    mode: "missing" | "reversed" | "reversed-during",
  ) {
    const profileId = await newProfile();
    const a = await paidDeposit({ profileId });
    await close(a.sessionId);
    expect(
      sum((await creditRows(a.reservationId)).map((r) => r.remaining)),
    ).toBe(40_000);
    const b = await paidDeposit({
      profileId,
      receipt: mode !== "missing",
    });
    if (mode === "reversed")
      await reverseJournal(
        scope(),
        b.receiptJournalId!,
        {
          entryDate: new Date().toISOString().slice(0, 10),
          reason: "Koreksi DP B 1035",
          idempotencyKey: randomUUID(),
        },
        userIdSchema.parse(staff.userId),
      );
    await closeAndHide(b);
    return { profileId, a, b };
  }

  // "reversed-during": B's receipt is posted when its session closes, then
  // reversed while apply is still parked (between its two reads).
  const finaliser =
    (mode: string, b: Awaited<ReturnType<typeof paidDeposit>>) => async () => {
      await reveal(b);
      if (mode === "reversed-during")
        await reverseJournal(
          scope(),
          b.receiptJournalId!,
          {
            entryDate: new Date().toISOString().slice(0, 10),
            reason: "Koreksi DP B saat apply 1035",
            idempotencyKey: randomUUID(),
          },
          userIdSchema.parse(staff.userId),
        );
    };

  for (const mode of ["missing", "reversed", "reversed-during"] as const) {
    it(`1035-C-${mode}: B finalised between the two reads (receipt ${mode}) is never moved; money <= validated credit of A`, async () => {
      const { profileId, a, b } = await sourcesWhereBHasNoValidReceipt(mode);
      const target = await targetSession(profileId, 60_000);
      // 60k needs B: only A (40k) is validated, so the guest cannot take it.
      const outcome = await applyWhileSourceFinalises({
        profileId,
        amount: 60_000,
        target,
        finaliseB: finaliser(mode, b),
      });
      const spent = await spendTotal(target);
      const bRows = await creditRows(b.reservationId);
      // B is unvalidated money: untouched, whatever else happened.
      for (const row of bRows) expect(row.remaining).toBe(row.amount);
      expect(spent).toBeLessThanOrEqual(40_000);
      expect(outcome.status).toBe("rejected");
      expect(spent).toBe(0);
      // Money is conserved: nothing left A except what was spent.
      expect(
        sum((await creditRows(a.reservationId)).map((r) => r.remaining)) +
          spent,
      ).toBe(40_000);
    });

    it(`1035-C-${mode}-partial: a smaller apply racing the same finalisation takes only A, never B`, async () => {
      const { profileId, a, b } = await sourcesWhereBHasNoValidReceipt(mode);
      const target = await targetSession(profileId, 30_000);
      await applyWhileSourceFinalises({
        profileId,
        amount: 30_000,
        target,
        finaliseB: finaliser(mode, b),
      });
      const spent = await spendTotal(target);
      for (const row of await creditRows(b.reservationId))
        expect(row.remaining).toBe(row.amount);
      expect(spent).toBeLessThanOrEqual(30_000);
      expect(
        sum((await creditRows(a.reservationId)).map((r) => r.remaining)) +
          spent,
      ).toBe(40_000);
      // Afterwards the guest still cannot reach B: only what is left of A.
      const left = 40_000 - spent;
      const probe = await targetSession(profileId, left + 1);
      await expect(
        applyCredit(profileId, probe, left + 1),
      ).rejects.toBeDefined();
      expect(await spendTotal(probe)).toBe(0);
      // Another tenant sees none of these remainders.
      const foreign = await withTenant(db, scope(randomUUID()), (tx) =>
        tx.execute(
          sql`SELECT id FROM reservation_deposit_remainders WHERE reservation_id IN (${a.reservationId}::uuid, ${b.reservationId}::uuid)`,
        ),
      );
      expect(foreign.rows).toHaveLength(0);
    });
  }

  it("1035-C-posted-during: a valid source B finalised in the window keeps money conserved (nothing created, nothing lost)", async () => {
    const profileId = await newProfile();
    const a = await paidDeposit({ profileId });
    await close(a.sessionId);
    const b = await paidDeposit({ profileId });
    await closeAndHide(b);
    const target = await targetSession(profileId, 30_000);
    const outcome = await applyWhileSourceFinalises({
      profileId,
      amount: 30_000,
      target,
      finaliseB: finaliser("posted", b),
    });
    expect(outcome.status).toBe("fulfilled");
    const spent = await spendTotal(target);
    expect(spent).toBe(30_000);
    const left = sum(
      [
        ...(await creditRows(a.reservationId)),
        ...(await creditRows(b.reservationId)),
      ].map((r) => r.remaining),
    );
    // 2 x 40k credit in total: whatever apply drew, spent + left is exactly 80k.
    expect(left + spent).toBe(80_000);
  });

  it("1035-C-control: a source B with a posted receipt, finalised before apply, is spendable (apply does not over-block)", async () => {
    const profileId = await newProfile();
    const a = await paidDeposit({ profileId });
    const b = await paidDeposit({ profileId });
    await close(a.sessionId);
    await close(b.sessionId);
    const target = await targetSession(profileId, 60_000);
    await applyCredit(profileId, target, 60_000);
    expect(await spendTotal(target)).toBe(60_000);
    const left = sum(
      [
        ...(await creditRows(a.reservationId)),
        ...(await creditRows(b.reservationId)),
      ].map((r) => r.remaining),
    );
    expect(left).toBe(20_000);
  });
});
