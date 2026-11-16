// legend-0owye (SO-885 card C, P1): the cutover must not drop guest QR money
// that m1 already parked as unallocated funds with the intent marked `failed`.
//
// On m1 a payment whose amount differs from the QR (Duitku strict amount)
// marks the intent `failed` AND records the money in `payment_unallocated_funds`
// (`holdGatewayAmountMismatch`). Backfill 0401 skipped `failed`, so after the
// migration the bill had no hold: the guest was asked to pay the whole bill
// again while the first money was still parked.
//
// CTO decision (docs/briefs/885-qris-879-so-fix.md): a `failed` intent with an
// UNRESOLVED unallocated fund gets a backfilled hold; the bill stays held until
// that fund is refunded/credited. Ambiguity holds (ragu = tahan).
//
// Method: the m1 shape is built with the real mismatch service (intent `failed`
// + parked fund), the backfill statements of 0401 run in a rolled-back
// transaction (pattern of qris-hold-so879-a-ota0l-m1-backfill.test.ts), and the
// hold rows the migration produced are re-inserted for real so the service
// guards and the hold check job are judged against what the migration wrote.
//
// Assumptions (the brief names behavior, not SQL):
// - "Open fund" = `payment_unallocated_funds.resolved_at IS NULL`.
// - A held code = one `pos_qris_holds` row of that intent: state `open`,
//   `backfilled = true`, amount = intent amount (split: with bill_split_id).
// - A replacement code is refused with HTTP 409 while the hold is active.
// - Resolution is a refund or credit of the fund (`resolution`, `resolved_at`).
// - The hold check job closes the hold once every fund of the failed intent is
//   resolved, without needing the provider (a provider timeout is scripted).
//   It must not close it while a fund is open, even when the provider answers
//   "expired" for the code.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qris-hold-so885-c-failed-fund-backfill.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import {
  holdGatewayAmountMismatch,
  pollPendingGatewayIntents,
} from "../services/payment.service.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { owner } from "./floor-test-helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import {
  ScriptedGateway,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  requestQris,
  resetHoldPorts,
  runHoldCheck,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 120_000 });

const TAG = "0401_pos_qris_holds";
const BILL_IDR = 33_000;
const PARKED_IDR = 10_000;

function backfillOf(tag: string): string[] {
  const statements = readFileSync(
    new URL(`../../drizzle/${tag}.sql`, import.meta.url),
    "utf8",
  )
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  const from = statements.findIndex((s) =>
    /NO FORCE ROW LEVEL SECURITY/i.test(s),
  );
  const to = statements.findIndex(
    (s, i) =>
      i > from &&
      /\bFORCE ROW LEVEL SECURITY/i.test(s) &&
      !/NO FORCE ROW LEVEL SECURITY/i.test(s),
  );
  return from >= 0 && to > from ? statements.slice(from, to) : [];
}
const backfill = backfillOf(TAG);

let fx: HoldFixture;
let gw: ScriptedGateway;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so885-c");
  gw = new ScriptedGateway("doit");
  enableVaBank(gw);
  setPaymentGateway(gw);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

// ---- migration plumbing -----------------------------------------------------

async function inRolledBackTx<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    return await work(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** The database as m1 left it: no holds at all. Rolled back with the tx. */
async function removeHolds(client: PoolClient) {
  await client.query("LOCK TABLE pos_qris_holds IN EXCLUSIVE MODE");
  await client.query("SET LOCAL session_replication_role = replica");
  await client.query("DELETE FROM pos_qris_holds");
  await client.query("SET LOCAL session_replication_role = origin");
}

/** Tables the backfill reads or writes; the migrator owns them (0401 lifts
 * FORCE on the ones that exist before it, `pos_qris_holds` is new). */
const BACKFILL_TABLES = [
  "orders",
  "pos_orders",
  "pos_order_tenders",
  "payment_intents",
  "bill_splits",
  "payment_unallocated_funds",
  "pos_qris_holds",
];

/**
 * Runs the backfill the way production does: as a plain table owner (NOSUPERUSER,
 * NOBYPASSRLS) with NO tenant context (`app.tenant_id` unset, so any read of a
 * table that is still FORCE RLS throws in `app.require_tenant_id()`). Role,
 * ownership and the RLS state are set up inside the rolled-back transaction.
 */
async function runBackfill(client: PoolClient) {
  await client.query(
    "CREATE ROLE so885c_migrator NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOLOGIN",
  );
  for (const table of BACKFILL_TABLES)
    await client.query(`ALTER TABLE public.${table} OWNER TO so885c_migrator`);
  // The holds table is brand new when 0401 runs: no RLS yet.
  await client.query(
    "ALTER TABLE public.pos_qris_holds NO FORCE ROW LEVEL SECURITY",
  );
  await client.query("GRANT USAGE ON SCHEMA public, app TO so885c_migrator");
  // 0402/0403 (freeze and display triggers) do not exist yet when 0401 runs.
  await client.query("SET LOCAL session_replication_role = replica");
  await client.query("SET LOCAL ROLE so885c_migrator");
  for (const statement of backfill) await client.query(statement);
  await client.query("RESET ROLE");
  await client.query("SET LOCAL session_replication_role = origin");
}

async function asM1<T>(client: PoolClient, work: () => Promise<T>) {
  await client.query("SET LOCAL session_replication_role = replica");
  try {
    return await work();
  } finally {
    await client.query("SET LOCAL session_replication_role = origin");
  }
}

type BackfilledHold = {
  json: string;
  intentId: string;
  state: string;
  backfilled: boolean;
  amountIdr: number;
  billSplitId: string | null;
};

/** Runs the backfill in a rolled-back tx and returns the hold rows of the bill. */
async function backfillHoldsOf(
  orderUuid: string,
  prepare?: (client: PoolClient) => Promise<void>,
): Promise<BackfilledHold[]> {
  return inRolledBackTx(async (client) => {
    await removeHolds(client);
    if (prepare) await prepare(client);
    await runBackfill(client);
    const { rows } = await client.query<{
      json: string;
      intent_id: string;
      state: string;
      backfilled: boolean;
      amount_idr: number;
      bill_split_id: string | null;
    }>(
      `SELECT row_to_json(h)::text AS json, payment_intent_id::text AS intent_id,
              state, backfilled, amount_idr::int AS amount_idr,
              bill_split_id::text AS bill_split_id
         FROM pos_qris_holds h WHERE tenant_id=$1 AND order_id=$2
        ORDER BY opened_at, id`,
      [fx.tenant.tenantId, orderUuid],
    );
    return rows.map((r) => ({
      json: r.json,
      intentId: r.intent_id,
      state: r.state,
      backfilled: r.backfilled,
      amountIdr: r.amount_idr,
      billSplitId: r.bill_split_id,
    }));
  });
}

/** Replaces the live (m2) holds of the bill by the rows the migration wrote. */
async function adoptBackfilledHolds(
  orderUuid: string,
  rows: BackfilledHold[],
): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [fx.tenant.tenantId],
    );
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "DELETE FROM pos_qris_holds WHERE tenant_id=$1 AND order_id=$2",
      [fx.tenant.tenantId, orderUuid],
    );
    for (const row of rows)
      await client.query(
        "INSERT INTO pos_qris_holds SELECT * FROM json_populate_record(null::pos_qris_holds, $1::json)",
        [row.json],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function expectHeld(
  rows: BackfilledHold[],
  intentId: string,
  amountIdr: number,
): BackfilledHold {
  const mine = rows.filter((r) => r.intentId === intentId);
  expect(
    mine,
    `failed code ${intentId} holds unresolved money: it needs exactly one hold`,
  ).toHaveLength(1);
  expect(mine[0]).toMatchObject({ state: "open", backfilled: true });
  expect(mine[0]!.amountIdr).toBe(amountIdr);
  return mine[0]!;
}

async function expectBillFrozen(orderUuid: string, rows: BackfilledHold[]) {
  await inRolledBackTx(async (client) => {
    await removeHolds(client);
    await runBackfill(client);
    await client.query("SAVEPOINT freeze_probe");
    let refused = "";
    try {
      await client.query(
        "UPDATE orders SET deposit_applied_idr=10000 WHERE tenant_id=$1 AND id=$2",
        [fx.tenant.tenantId, orderUuid],
      );
    } catch (error) {
      refused = String((error as Error).message);
    }
    await client.query("ROLLBACK TO SAVEPOINT freeze_probe");
    expect(
      refused,
      `the bill must be frozen (QRIS_HOLD_ACTIVE) while ${rows.length} hold(s) stand`,
    ).toContain("QRIS_HOLD_ACTIVE");
  });
}

// ---- fund plumbing ----------------------------------------------------------

async function fundsOf(intentId: string) {
  const { rows } = await owner.query<{
    amount: number;
    resolved_at: Date | null;
  }>(
    `SELECT amount_idr::int AS amount, resolved_at FROM payment_unallocated_funds
      WHERE tenant_id=$1 AND payment_intent_id=$2 ORDER BY created_at, id`,
    [fx.tenant.tenantId, intentId],
  );
  return rows;
}

/** The manager refunded (or credited) the parked money. */
async function resolveFunds(intentId: string) {
  const resolved = await owner.query(
    `UPDATE payment_unallocated_funds
        SET resolution='refund', resolved_by=$3, approval_ref='so885-c',
            resolved_at=now()
      WHERE tenant_id=$1 AND payment_intent_id=$2 AND resolved_at IS NULL`,
    [fx.tenant.tenantId, intentId, fx.staff.userId],
  );
  expect(resolved.rowCount).toBeGreaterThan(0);
}

async function intentStatus(intentId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!.status;
}

async function holdStateOf(intentId: string) {
  const { rows } = await owner.query<{ state: string; next_check_at: Date }>(
    `SELECT state, next_check_at FROM pos_qris_holds
      WHERE tenant_id=$1 AND payment_intent_id=$2`,
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!;
}

/** m1 Duitku mismatch: intent `failed` and the paid amount parked. */
async function mismatch(intentId: string) {
  const { rows } = await owner.query<{ provider_ref: string }>(
    "SELECT provider_ref FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId],
  );
  const result = await holdGatewayAmountMismatch(
    fx.context,
    intentId,
    {
      providerRef: `${rows[0]!.provider_ref}-paid-${randomUUID().slice(0, 8)}`,
      paidAmountIdr: PARKED_IDR,
      source: "webhook",
    },
    new Date(),
  );
  expect(result.intentStatus).toBe("failed");
  expect(await intentStatus(intentId)).toBe("failed");
  expect((await fundsOf(intentId)).map((f) => f.amount)).toEqual([PARKED_IDR]);
}

/** The provider code lapsed long ago; the hold check may look at it. */
async function lapse(intentId: string) {
  await owner.query(
    `UPDATE payment_intents SET expires_at = now() - interval '2 hours'
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, intentId],
  );
}

// ---- bills ------------------------------------------------------------------

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;

type Scenario = {
  orderUuid: string;
  intentId: string;
  amountIdr: number;
  billSplitId: string | null;
  /** Asks for another code on the same bill. */
  replace: () => Promise<{ status: number; body: unknown }>;
};

async function guestOrderScenario(): Promise<Scenario> {
  const guest: Guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  expect(order.totalIdr).toBe(BILL_IDR);
  const paid = await fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId: order.id },
    method: "qris",
    idempotencyKey: randomUUID(),
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const intentId = paid.body.data.id as string;
  await mismatch(intentId);
  return {
    orderUuid: ulidToUuid(order.id),
    intentId,
    amountIdr: BILL_IDR,
    billSplitId: null,
    replace: () =>
      fx.guestPost(guest, "/payments", {
        target: { kind: "order", orderId: order.id },
        method: "qris",
        idempotencyKey: randomUUID(),
      }),
  };
}

async function guestSplitScenario(): Promise<Scenario> {
  const guest: Guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const split = await fx.guestPost(guest, "/splits", {
    method: "equal",
    parts: 2,
    idempotencyKey: randomUUID(),
  });
  expect(split.status, JSON.stringify(split.body)).toBe(201);
  const parts = split.body.data.splits as { id: string; amountIdr: number }[];
  const pay = () =>
    fx.guestPost(guest, "/payments", {
      target: { kind: "split", billSplitId: parts[0]!.id },
      method: "qris",
      payerSecret: secretFor(parts[0]!.id),
      idempotencyKey: randomUUID(),
    });
  const paid = await pay();
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id::text AS id FROM payment_intents
      WHERE tenant_id=$1 AND bill_split_id=$2`,
    [fx.tenant.tenantId, parts[0]!.id],
  );
  expect(rows).toHaveLength(1);
  const intentId = rows[0]!.id;
  await mismatch(intentId);
  return {
    orderUuid: ulidToUuid(order.id),
    intentId,
    amountIdr: parts[0]!.amountIdr,
    billSplitId: parts[0]!.id,
    replace: pay,
  };
}

/** POS bill: tender A (QR) voided locally with its intent expired; a sibling
 * code B on the same link was paid with the wrong amount (intent `failed`,
 * money parked). m1 left no hold at all. */
async function siblingScenario(): Promise<Scenario> {
  const order = await newSubmittedOrder(fx, 0);
  const qrA = await issueQris(fx, order.id);
  const client = await owner.connect();
  let intentId: string;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [fx.tenant.tenantId],
    );
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `UPDATE pos_order_tenders SET status='voided', resolved_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, qrA.tenderId],
    );
    await client.query(
      `UPDATE payment_intents SET status='expired', expires_at = now() - interval '2 hours'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, qrA.intentId],
    );
    const cols = (
      await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='payment_intents' AND table_schema='public'
            AND is_generated='NEVER' ORDER BY ordinal_position`,
      )
    ).rows.map((r) => r.column_name);
    const copy = (name: string) =>
      name === "id"
        ? "gen_random_uuid()"
        : name === "idempotency_key"
          ? "'so885c-' || gen_random_uuid()::text"
          : name === "provider_ref"
            ? "'so885c-ref-' || gen_random_uuid()::text"
            : name === "status"
              ? "'pending'"
              : `"${name}"`;
    const cloned = await client.query<{ id: string }>(
      `INSERT INTO payment_intents (${cols.map((n) => `"${n}"`).join(",")})
       SELECT ${cols.map(copy).join(",")}
         FROM payment_intents WHERE tenant_id=$1 AND id=$2
       RETURNING id::text AS id`,
      [fx.tenant.tenantId, qrA.intentId],
    );
    intentId = cloned.rows[0]!.id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await mismatch(intentId);
  return {
    orderUuid: ulidToUuid(order.id),
    intentId,
    amountIdr: qrA.amountIdr,
    billSplitId: null,
    replace: async () => {
      const response = await requestQris(fx, order.id);
      return { status: response.status, body: response.body };
    },
  };
}

const scenarios = [
  ["guest whole-order QR", guestOrderScenario],
  ["guest split part QR", guestSplitScenario],
  ["sibling code of a POS QR link", siblingScenario],
] as const;

// ---- tests ------------------------------------------------------------------

describe("legend-0owye backfill holds failed codes whose money is still parked", () => {
  it("legend-0owye the migration file is found and its backfill part is not empty", () => {
    expect(backfill.length).toBeGreaterThan(0);
    expect(backfill.join("\n")).toMatch(/pos_qris_holds/);
  });

  for (const [label, build] of scenarios) {
    it(`legend-0owye ${label}: failed intent with an open fund -> held until the fund is returned; replacement refused; then free`, async () => {
      const bill = await build();

      // 1. The migration holds the failed code and freezes the bill.
      const rows = await backfillHoldsOf(bill.orderUuid);
      const hold = expectHeld(rows, bill.intentId, bill.amountIdr);
      expect(hold.billSplitId).toBe(bill.billSplitId);
      await expectBillFrozen(bill.orderUuid, rows);

      // 2. With the migration's rows in place, a replacement code is refused.
      await adoptBackfilledHolds(bill.orderUuid, [hold]);
      const refused = await bill.replace();
      expect(
        refused.status,
        `replacement must wait for the parked money: ${JSON.stringify(refused.body)}`,
      ).toBe(409);

      // 3. A provider "expired" answer is not proof while money is parked.
      await lapse(bill.intentId);
      gw.script(bill.intentId, { status: "expired" });
      await runHoldCheck(fx, new Date());
      expect((await holdStateOf(bill.intentId)).state).toBe("open");
      expect((await bill.replace()).status).toBe(409);

      // 4. The parked money goes back; the hold ends (provider unreachable).
      await resolveFunds(bill.intentId);
      gw.script(bill.intentId, { error: "timeout" });
      await runHoldCheck(fx, new Date());
      expect((await holdStateOf(bill.intentId)).state).toBe("closed");

      // 5. Now the guest may be asked for a new code.
      const allowed = await bill.replace();
      expect(
        allowed.status,
        `replacement allowed once the money is returned: ${JSON.stringify(allowed.body)}`,
      ).toBe(201);
    });
  }

  it("legend-0owye an open fund keeps the hold re-checked soon after it is resolved (not parked for 24 hours)", async () => {
    const bill = await guestOrderScenario();
    const rows = await backfillHoldsOf(bill.orderUuid);
    await adoptBackfilledHolds(bill.orderUuid, [
      expectHeld(rows, bill.intentId, bill.amountIdr),
    ]);
    gw.script(bill.intentId, { error: "timeout" });
    await runHoldCheck(fx, new Date());
    const hold = await holdStateOf(bill.intentId);
    expect(hold.state).toBe("open");
    expect(hold.next_check_at.getTime()).toBeLessThanOrEqual(
      Date.now() + 2 * 3_600_000,
    );
  });

  it("legend-0owye control: failed intent whose fund is already resolved gets no hold", async () => {
    const bill = await guestOrderScenario();
    await resolveFunds(bill.intentId);
    const rows = await backfillHoldsOf(bill.orderUuid);
    expect(rows.filter((r) => r.intentId === bill.intentId)).toEqual([]);
  });

  it("legend-0owye control: failed intent without any fund gets no hold", async () => {
    const bill = await guestOrderScenario();
    const rows = await backfillHoldsOf(bill.orderUuid, async (client) => {
      await asM1(client, () =>
        client.query(
          "DELETE FROM payment_unallocated_funds WHERE tenant_id=$1 AND payment_intent_id=$2",
          [fx.tenant.tenantId, bill.intentId],
        ),
      );
    });
    expect(rows.filter((r) => r.intentId === bill.intentId)).toEqual([]);
  });

  it("legend-0owye guard: a failed VA code with an open fund refuses a replacement code until the fund is returned and the provider answers final", async () => {
    const guest: Guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const va = await fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId: order.id },
      method: "va",
      bankCode: "bmri",
      idempotencyKey: randomUUID(),
    });
    expect(va.status, JSON.stringify(va.body)).toBe(201);
    const vaId = va.body.data.id as string;
    await mismatch(vaId);
    const ask = () =>
      fx.guestPost(guest, "/payments", {
        target: { kind: "order", orderId: order.id },
        method: "qris",
        idempotencyKey: randomUUID(),
      });
    const refused = await ask();
    expect(
      refused.status,
      `the VA money is still parked: ${JSON.stringify(refused.body)}`,
    ).toBe(409);
    await resolveFunds(vaId);
    // SO-896: the money is back, but the provider never declared the code dead
    // (a `failed` code stays live until it answers final): still refused.
    const stillLive = await ask();
    expect(stillLive.status, JSON.stringify(stillLive.body)).toBe(409);
    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - interval '61 seconds'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, vaId],
    );
    gw.script(vaId, { status: "expired" });
    await pollPendingGatewayIntents(
      fx.context,
      new Date(Date.now() + 2 * 3_600_000),
      200,
    );
    const allowed = await ask();
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
  });
});
