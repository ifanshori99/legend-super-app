// 1053b item 1 (P2-a): cash payroll reserve. Written fail-first from the brief
// (scratchpad brief-1053b.md), the founder rules "nobody is paid twice, GL 1102
// never goes negative, other tenants are untouched", and the public HTTP and
// service surface, NOT from the guard code.
//
// Rule: approving a cash payroll batch is NOT tightened. Instead, every other
// cash spend that credits GL 1102 by a user action must respect the cash that
// is really available: GL 1102 minus credits still waiting to post, where an
// approved-but-not-yet-handed-over cash payroll item is a reserve. Here that is
// a petty purchase: it needs its outlet fund AND the available 1102 cash. A
// purchase above the available cash is refused PETTY_CASH_GL_INSUFFICIENT.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Status of the refusal: the brief says 409 "sesuai pola return", but the
//   shared error table answers PETTY_CASH_GL_INSUFFICIENT with 422 (and the
//   a4z2f return test asserts 422). Only the code is pinned; 409 or 422 passes.
//   Never 5xx, never a deadlock.
// - The message names available cash, the purchase amount and the shortfall as
//   plain rupiah numbers; thousand separators are stripped before looking for
//   the digits, so "Rp 30.000", "30.000" and "30000" all pass.
// - Available cash = GL 1102 (debit - credit of the payout world's entity)
//   minus the net of cash batches this file approved and has not handed over
//   or cancelled (`committed`) minus purchases this file recorded (`purchased`:
//   their petty_purchase.recorded outbox events stay pending, nobody delivers
//   them here). Every test starts from `drain()`: it approves one exact cash
//   batch for whatever is available, so the baseline is exactly 0 whatever an
//   earlier test did.
// - Purchases and top-ups go through the real HTTP routes, one fresh outlet of
//   the payout entity per shop (own fund, own recorder with the outlet manager
//   role, own per-outlet purchase limit of Rp1.000.000).
// - A cash handover posts to 1102 at once only after the run's locked journal
//   exists; the handover test posts it first so GL 1102 moves at handover.
// - The race outcome is not fixed (any claimant may win); only invariants are
//   asserted: exactly one of the claims that cannot all fit gets the cash, the
//   losers get a business refusal (409 / 422, never 5xx), and available cash
//   and GL 1102 never go below zero.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  approveDisbursementBatch,
  cancelDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import { originHeader } from "./helpers.ts";
import { approveChainLevelAs } from "./helpers/cash-out-chain.ts";
import { withLimitSharedLock } from "./helpers/cash-limit-lock.ts";
import {
  closeKit,
  daysAgo,
  key,
  makeBankAccount,
  makeOutlet,
  owner as kitOwner,
  signedIn,
  tenantId,
  type Session,
} from "./helpers/cash-bank-world.ts";
import {
  APP,
  APP2,
  CASHIER,
  REQ,
  actorOf,
  cash,
  installPayoutWorld,
} from "./payroll-payout-fixtures.ts";

const app = createApp();
const MOVEMENTS = "/api/accounting/petty-cash/movements";
const PURCHASES = "/api/inventory/petty-purchases";
const POLICY = "/api/inventory/petty-purchase-policy";
const W = installPayoutWorld("1053breserve");

let finance: Session;
let bankAccountId: string;
let pettyGlId: string;
const outlets: string[] = [];
const photoIds: string[] = [];
const usedKeys: string[] = [];
/** Net of the cash batches approved here and not handed over or cancelled. */
let committed = 0;
/** Total of the purchases recorded here (their outbox events stay pending). */
let purchased = 0;

withLimitSharedLock();

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn(app, "1053b finance", [
    { role: "finance", outletId: null },
  ]);
  const bankRow = await kitOwner.query<{ id: string }>(
    "SELECT id FROM bank_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 LIMIT 1",
    [tenantId, W.entityId()],
  );
  bankAccountId = bankRow.rows[0]!.id;
  const gl = await kitOwner.query<{ id: string }>(
    "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1102'",
    [tenantId, W.entityId()],
  );
  pettyGlId = gl.rows[0]!.id;
});

afterAll(async () => {
  // Runs before the payout world's own cleanup (hooks run in reverse order).
  const client = await kitOwner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const purchases = `(SELECT id FROM petty_purchases WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[]))`;
    await client.query(
      `DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id IN ${purchases}`,
      [tenantId, outlets],
    );
    await client.query(
      "DELETE FROM petty_purchases WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenantId, outlets],
    );
    await client.query(
      "DELETE FROM petty_purchase_policies WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenantId, outlets],
    );
    await client.query(
      "DELETE FROM purchasing_idempotency WHERE tenant_id = $1 AND operation LIKE 'petty_purchase%' AND idempotency_key = ANY($2::text[])",
      [tenantId, usedKeys],
    );
    await client.query(
      "DELETE FROM core_storage_objects WHERE id = ANY($1::uuid[])",
      [photoIds],
    );
    for (const outletId of outlets) {
      await client.query(
        "DELETE FROM petty_cash_entries WHERE tenant_id = $1 AND outlet_id = $2",
        [tenantId, outletId],
      );
      await client.query(
        "DELETE FROM petty_cash_funds WHERE tenant_id = $1 AND outlet_id = $2",
        [tenantId, outletId],
      );
      await client.query("DELETE FROM outlets WHERE id = $1", [outletId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await closeKit();
});

// ---- cash helpers ------------------------------------------------------------

const movement = (
  kind: "topup" | "return",
  amountIdr: number,
  outletId: string,
) =>
  finance.client
    .post(MOVEMENTS)
    .set(originHeader)
    .send({
      kind,
      outletId,
      bankAccountId,
      amountIdr,
      description: kind === "topup" ? "Isi kas kecil 1053b" : "Setor kas 1053b",
      idempotencyKey: key(),
    });

async function topUp(amountIdr: number, outletId: string) {
  const res = await movement("topup", amountIdr, outletId);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

/** Debit minus credit of GL 1102 of the payout world's entity. */
async function glBalance(): Promise<number> {
  const { rows } = await kitOwner.query<{ balance: string }>(
    `SELECT coalesce(sum(l.debit_idr - l.credit_idr), 0)::text AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND l.account_id = $3`,
    [tenantId, W.entityId(), pettyGlId],
  );
  return Number(rows[0]!.balance);
}

/** GL 1102 minus the approved cash payroll and the recorded purchases. */
const available = async () => (await glBalance()) - committed - purchased;

async function journalCount(): Promise<number> {
  const { rows } = await kitOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, W.entityId()],
  );
  return Number(rows[0]!.n);
}

const digitsOf = (text: string) => text.replace(/(?<=\d)[.,](?=\d)/g, "");

// ---- payroll helpers -----------------------------------------------------------

type Pending = { batchId: string; hash: string; net: number; runId: string };

/** A cash batch of one slip, submitted and waiting for approval. */
async function pendingBatch(
  net: number,
  options: { lockedJournal?: boolean } = {},
): Promise<Pending> {
  const slips = [cash(CASHIER, net)];
  const runId = await W.seedRun(slips);
  if (options.lockedJournal) await W.postLockedJournal(runId, slips);
  const batchId = await W.createBatch(runId, "cash");
  await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
  const hash = (await W.batchById(batchId)).content_hash as string;
  return { batchId, hash, net, runId };
}

/** Approves through the service; null on success, the thrown error otherwise. */
async function tryApprove(batch: Pending): Promise<unknown> {
  const failure = await W.httpFailure(
    W.inTx((tx) =>
      approveDisbursementBatch(tx, actorOf(APP), batch.batchId, {
        contentHash: batch.hash,
        sourceBankAccountId: null,
      } as never),
    ),
  );
  if (failure === null) committed += batch.net;
  return failure;
}

/** Approves a batch that must pass: the reserve of a cash payroll. */
async function reserve(net: number, options: { lockedJournal?: boolean } = {}) {
  const batch = await pendingBatch(net, options);
  expect(await tryApprove(batch), "the reserve batch is approved").toBeNull();
  expect((await W.batchById(batch.batchId)).status).toBe("approved");
  return batch;
}

/** Approves one exact batch for all available cash: baseline becomes 0. */
async function drain() {
  const avail = await available();
  expect(
    avail,
    "available cash is never negative between tests",
  ).toBeGreaterThanOrEqual(0);
  if (avail > 0) await reserve(avail);
  expect(await available()).toBe(0);
}

// ---- shop (outlet + recorder) and purchase helpers ------------------------------

type Shop = { outletId: string; recorder: Session };

/** A fresh outlet of the payout entity with a recorder and a purchase limit. */
async function makeShop(): Promise<Shop> {
  const outletId = await makeOutlet(W.entityId());
  outlets.push(outletId);
  const recorder = await signedIn(app, "1053b recorder", [
    { role: "outlet_manager", outletId },
  ]);
  const policy = await finance.client
    .put(POLICY)
    .set(originHeader)
    .send({ outletId, limitIdr: 1_000_000, idempotencyKey: pkey() });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  return { outletId, recorder };
}

function pkey() {
  const value = `k-${randomUUID()}`;
  usedKeys.push(value);
  return value;
}

async function insertPhoto(ownerUserId: string, outletId: string) {
  const id = randomUUID();
  await kitOwner.query(
    `INSERT INTO core_storage_objects
       (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id)
     VALUES ($1, $2, $3, 'receipt', $4, 'image/webp', 1024, $5)`,
    [tenantId, outletId, id, `legend-1053b/${id}.webp`, ownerUserId],
  );
  photoIds.push(id);
  return id;
}

/** One petty purchase over HTTP; the response is returned as is. */
async function buy(shop: Shop, amountIdr: number) {
  const body = {
    outletId: shop.outletId,
    vendorName: "Pasar Induk",
    description: "Cabai dan bawang",
    amountIdr,
    photoMediaId: await insertPhoto(shop.recorder.userId, shop.outletId),
    idempotencyKey: pkey(),
  };
  const res = await shop.recorder.client
    .post(PURCHASES)
    .set(originHeader)
    .send(body);
  if (res.status === 201) purchased += amountIdr;
  return res;
}

async function fundBalance(outletId: string): Promise<number | null> {
  const { rows } = await kitOwner.query<{ balance: string }>(
    "SELECT balance_idr::text AS balance FROM petty_cash_funds WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantId, outletId],
  );
  return rows[0] ? Number(rows[0].balance) : null;
}

async function purchaseState(outletId: string) {
  const one = async (sql: string) =>
    Number(
      (await kitOwner.query<{ n: string }>(sql, [tenantId, outletId])).rows[0]!
        .n,
    );
  return {
    fund: await fundBalance(outletId),
    purchases: await one(
      "SELECT count(*)::text AS n FROM petty_purchases WHERE tenant_id = $1 AND outlet_id = $2",
    ),
    ledger: await one(
      "SELECT count(*)::text AS n FROM petty_cash_entries WHERE tenant_id = $1 AND outlet_id = $2",
    ),
    events: await one(
      `SELECT count(*)::text AS n FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'petty_purchase.recorded'
          AND event->'payload'->>'outletId' = $2`,
    ),
    journals: await journalCount(),
    gl: await glBalance(),
  };
}

/** The refusal of the new guard: a business error naming the cash, not a crash. */
function expectGlRefusal(
  res: {
    status: number;
    body: { error?: { code?: string; message?: string } };
  },
  figures?: { avail: number; amount: number },
) {
  const detail = JSON.stringify(res.body);
  expect([409, 422], `status ${res.status}: ${detail}`).toContain(res.status);
  expect(res.body.error?.code, detail).toBe("PETTY_CASH_GL_INSUFFICIENT");
  const message = digitsOf(String(res.body.error?.message ?? ""));
  expect(message, "a message for finance, not empty").not.toBe("");
  if (figures) {
    expect(message, "available cash after the payroll reserve").toContain(
      String(figures.avail),
    );
    expect(message, "purchase amount").toContain(String(figures.amount));
    expect(message, "shortfall").toContain(
      String(figures.amount - figures.avail),
    );
  }
}

// ---- single-actor behaviour ------------------------------------------------------

describe("1053b petty purchase respects the cash payroll reserve", () => {
  it("[1053b-purchase-refused-by-reserve] a purchase that the outlet fund covers but the available 1102 cash (after the approved cash payroll) does not is refused with a clear message; fund, purchase, ledger, outbox and GL stay as they were", async () => {
    await drain();
    const shop = await makeShop();
    await topUp(100_000, shop.outletId);
    await reserve(70_000); // available: 100.000 - 70.000 = 30.000
    expect(await available()).toBe(30_000);
    const before = await purchaseState(shop.outletId);
    expect(before.fund, "premise: the fund alone would cover it").toBe(100_000);

    const res = await buy(shop, 50_000);

    expectGlRefusal(res, { avail: 30_000, amount: 50_000 });
    expect(await purchaseState(shop.outletId)).toEqual(before);
    expect(await available(), "nothing was spent").toBe(30_000);
  }, 90_000);

  it("[1053b-purchase-fits-and-boundary] a purchase equal to the available cash passes (it does not count against itself), then one rupiah more is refused because the first purchase is now a pending credit", async () => {
    await drain();
    const shop = await makeShop();
    await topUp(100_000, shop.outletId);
    await reserve(70_000); // available 30.000

    const exact = await buy(shop, 30_000);
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(await fundBalance(shop.outletId)).toBe(70_000);
    const pending = await kitOwner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_event_outbox
        WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'petty_purchase.recorded'`,
      [tenantId, exact.body.data.id],
    );
    expect(Number(pending.rows[0]!.n), "one pending event").toBe(1);

    const before = await purchaseState(shop.outletId);
    const one = await buy(shop, 1);
    expectGlRefusal(one, { avail: 0, amount: 1 });
    expect(await purchaseState(shop.outletId)).toEqual(before);
  }, 90_000);

  it("[1053b-approve-payroll-still-possible] payroll approval is not tightened: after a purchase was refused for the reserve, a cash batch for all the available cash is still approved, and then even Rp1 of purchase is refused", async () => {
    await drain();
    const shop = await makeShop();
    await topUp(100_000, shop.outletId);
    await reserve(70_000);

    expectGlRefusal(await buy(shop, 40_000));
    const rest = await pendingBatch(30_000);
    expect(
      await tryApprove(rest),
      "approval is not blocked by the refused purchase",
    ).toBeNull();
    expect((await W.batchById(rest.batchId)).status).toBe("approved");
    expect(await available()).toBe(0);
    expectGlRefusal(await buy(shop, 1));
  }, 90_000);

  it("[1053b-reserve-released-on-cancel] cancelling the approved cash batch releases the reserve: the purchase refused before is then accepted", async () => {
    await drain();
    const shop = await makeShop();
    await topUp(100_000, shop.outletId);
    const batch = await reserve(70_000);
    expectGlRefusal(await buy(shop, 50_000), { avail: 30_000, amount: 50_000 });

    await W.inTx((tx) =>
      cancelDisbursementBatch(tx, actorOf(REQ), batch.batchId, {
        reason: "uji batal 1053b",
      } as never),
    );
    committed -= batch.net;
    expect((await W.batchById(batch.batchId)).status).toBe("cancelled");
    expect(await available()).toBe(100_000);

    const ok = await buy(shop, 50_000);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await fundBalance(shop.outletId)).toBe(50_000);
    expect(await available()).toBe(50_000);
  }, 90_000);

  it("[1053b-reserve-consistent-after-handover] when the cash is handed over the reserve turns into a real 1102 credit: the available cash is the same before and after, purchases above it stay refused and up to it pass", async () => {
    await drain();
    const shop = await makeShop();
    await topUp(100_000, shop.outletId);
    const batch = await reserve(60_000, { lockedJournal: true }); // avail 40.000
    expectGlRefusal(await buy(shop, 40_001), { avail: 40_000, amount: 40_001 });
    const glBefore = await glBalance();

    const items = await W.itemsOf(batch.batchId);
    await W.handover(
      batch.batchId,
      items.map((item) => item.id as string),
      APP2,
    );
    committed -= batch.net;
    expect(await glBalance(), "premise: handover credited 1102").toBe(
      glBefore - 60_000,
    );
    expect(await available(), "no money appeared or vanished").toBe(40_000);

    expectGlRefusal(await buy(shop, 40_001), { avail: 40_000, amount: 40_001 });
    const ok = await buy(shop, 40_000);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await available()).toBe(0);
    expectGlRefusal(await buy(shop, 1));
  }, 90_000);
});

// ---- concurrency ---------------------------------------------------------------------

/**
 * Two outlets with a fund of 200.000 each and an approved cash batch of 250.000:
 * 150.000 are available and every claim of 100.000 fits alone, no two do.
 */
async function crowdedScene() {
  await drain();
  const [a, b] = [await makeShop(), await makeShop()];
  await topUp(200_000, a.outletId);
  await topUp(200_000, b.outletId);
  await reserve(250_000);
  expect(await available()).toBe(150_000);
  return { a, b };
}

function expectBusinessLoss(status: number, what: string) {
  expect(
    [409, 422],
    `${what} must be a business refusal, got ${status}`,
  ).toContain(status);
}

describe("1053b concurrent claims on the same cash", () => {
  it("[1053b-race-purchase-approve-return] a purchase, a cash payroll approval and a petty cash return that each fit alone but not together: exactly one gets the cash, the others get a business refusal, 1102 never goes negative, no deadlock", async () => {
    for (let round = 0; round < 3; round++) {
      const { a, b } = await crowdedScene();
      const batch = await pendingBatch(100_000);

      const [purchase, approveFailure, ret] = await Promise.all([
        buy(a, 100_000),
        tryApprove(batch),
        movement("return", 100_000, b.outletId),
      ]);

      const won = {
        purchase: purchase.status === 201,
        approve: approveFailure === null,
        ret: ret.status === 201,
      };
      const detail = `round ${round}: ${JSON.stringify(won)} purchase=${JSON.stringify(
        purchase.body,
      )} return=${JSON.stringify(ret.body)}`;
      expect(Object.values(won).filter(Boolean).length, detail).toBe(1);
      if (!won.purchase) expectBusinessLoss(purchase.status, "purchase");
      if (!won.ret) expectBusinessLoss(ret.status, "return");
      if (!won.approve) {
        expect(approveFailure).toBeInstanceOf(HttpError);
        expect((approveFailure as HttpError).status).toBe(409);
      }
      expect(await glBalance(), "GL 1102 not negative").toBeGreaterThanOrEqual(
        0,
      );
      expect(
        await available(),
        "no cash promised that is not there",
      ).toBeGreaterThanOrEqual(0);
      expect((await W.batchById(batch.batchId)).status).toBe(
        won.approve ? "approved" : "pending_approval",
      );
    }
  }, 180_000);

  it("[1053b-race-two-purchases] two purchases on two outlets that each fit the available cash but not together: exactly one is recorded", async () => {
    for (let round = 0; round < 3; round++) {
      const { a, b } = await crowdedScene();

      const [first, second] = await Promise.all([
        buy(a, 100_000),
        buy(b, 100_000),
      ]);

      const winners = [first, second].filter((res) => res.status === 201);
      expect(
        winners.length,
        `round ${round}: ${JSON.stringify([first.body, second.body])}`,
      ).toBe(1);
      const loser = first.status === 201 ? second : first;
      expectBusinessLoss(loser.status, "the second purchase");
      expect(loser.body.error?.code).toBe("PETTY_CASH_GL_INSUFFICIENT");
      expect(await available()).toBe(50_000);
      expect(await glBalance()).toBeGreaterThanOrEqual(0);
    }
  }, 180_000);
});

// ---- other entity and other tenant -------------------------------------------------------
//
// Assumptions: another legal entity of the same tenant and a real second tenant
// have their own GL 1102 and their own pending credits; none of it may change
// what A's purchase may spend. The foreign pending credits are outbox rows
// (payroll.paid cash and petty_purchase.recorded), some poisoned so that their
// payload NAMES A's entity or an outlet of A: only the tenant column and the
// entity of the owning outlet can keep them out of A's decision. Tenant B's
// rows are locked (FOR UPDATE) during A's purchases: a guard that touched them
// would block and the timer would fail the test.

async function seedOutbox(
  aggregateType: string,
  name: string,
  payload: Record<string, unknown>,
  forTenant: string = tenantId,
): Promise<string> {
  const id = randomUUID();
  await kitOwner.query(
    `INSERT INTO domain_event_outbox
       (tenant_id, id, event_id, aggregate_type, aggregate_id, sequence, event, destination, status)
     VALUES ($1, $2, $3, $4, $5, 1, $6, 'cloud-sync', 'pending')`,
    [
      forTenant,
      id,
      randomUUID(),
      aggregateType,
      randomUUID(),
      JSON.stringify({
        name,
        tenantId: forTenant,
        aggregateType,
        sequence: 1,
        payload,
      }),
    ],
  );
  return id;
}

const pendingPurchaseOf = (
  outletId: string,
  amountIdr: number,
  forTenant?: string,
): Promise<string> =>
  seedOutbox(
    "petty_purchase",
    "petty_purchase.recorded",
    {
      pettyPurchaseId: randomUUID(),
      outletId,
      amountIdr,
      businessDate: "2026-11-10",
      paidBy: randomUUID(),
      paidAt: "2026-11-10T03:00:00.000Z",
    },
    forTenant,
  );

const B_BALANCE = 9_000_000_000;
type TenantB = { tenantId: string; entityId: string; cashAccountId: string };

async function seedTenantB(aOutletId: string): Promise<TenantB> {
  const bTenant = randomUUID();
  const client = await kitOwner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Reserve 1053b other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [bTenant, `r1053b-${randomBytes(3).toString("hex")}`, tenantId],
    );
    const entity = await client.query<{ id: string }>(
      "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
      [bTenant, `Entity 1053b B ${randomBytes(3).toString("hex")}`],
    );
    const entityId = entity.rows[0]!.id;
    const account = async (
      code: string,
      name: string,
      type: string,
      group: string,
    ) =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [bTenant, entityId, code, name, type, group],
        )
      ).rows[0]!.id;
    const cashAccountId = await account(
      "1102",
      "Kas Kecil",
      "asset",
      "cash_and_equivalents",
    );
    const revenue = await account(
      "4901",
      "Pendapatan Lain",
      "revenue",
      "other_income",
    );
    await client.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'petty_cash', $3)`,
      [bTenant, entityId, cashAccountId],
    );
    const period = await client.query<{ id: string }>(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) RETURNING id`,
      [bTenant, entityId, daysAgo(0).slice(0, 7)],
    );
    const entry = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
          source_id, description, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, 'sale', NULL, 'Saldo besar tenant B', $5, $6)
       RETURNING id`,
      [
        bTenant,
        entityId,
        daysAgo(0),
        period.rows[0]!.id,
        `r1053b-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
      [bTenant, entry.rows[0]!.id, cashAccountId, revenue, B_BALANCE],
    );
    await client.query("COMMIT");
    // Pending credits of tenant B, poisoned to point at A's entity and outlet.
    await seedOutbox(
      "payroll_run",
      "payroll.paid",
      {
        payrollRunId: randomUUID(),
        legalEntityId: W.entityId(),
        netIdr: B_BALANCE,
        bankTransferIdr: 0,
        cashIdr: B_BALANCE,
      },
      bTenant,
    );
    await pendingPurchaseOf(aOutletId, B_BALANCE, bTenant);
    return { tenantId: bTenant, entityId, cashAccountId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function dropTenantB(b: TenantB) {
  const client = await kitOwner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "domain_event_outbox",
      "journal_lines",
      "journal_entries",
      "fiscal_periods",
      "account_mappings",
      "chart_of_accounts",
      "legal_entities",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        b.tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [b.tenantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Holds row locks on tenant B's cash rows until released. */
async function lockTenantBRows(b: TenantB) {
  const client = await kitOwner.connect();
  await client.query("BEGIN");
  for (const table of [
    "chart_of_accounts",
    "account_mappings",
    "journal_entries",
    "journal_lines",
    "legal_entities",
  ])
    await client.query(
      `SELECT 1 FROM ${table} WHERE tenant_id = $1 FOR UPDATE`,
      [b.tenantId],
    );
  return async () => {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  };
}

async function withinMs<T>(ms: number, work: Promise<T>, what: string) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} still waiting after ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe("1053b other entity and other tenant do not change the purchase decision", () => {
  it("[1053b-other-entity-tenant-isolated] pending credits of another entity and of another tenant (huge balance, huge poisoned credits) neither reduce nor add to A's available cash: a purchase above A's own cash is refused with A's figures, an exact one passes, and A never touches B's rows", async () => {
    await drain();
    const shop = await makeShop();
    await topUp(150_000, shop.outletId);
    await reserve(100_000); // A's available: 50.000
    expect(await available()).toBe(50_000);

    // Another entity of the same tenant: a pending cash payroll and a pending
    // purchase of an outlet of that entity, both large.
    const other = await kitOwner.query<{ id: string }>(
      "SELECT id FROM legal_entities WHERE tenant_id = $1 AND id <> $2 LIMIT 1",
      [tenantId, W.entityId()],
    );
    const foreignEntity = other.rows[0]?.id ?? randomUUID();
    const seeded: string[] = [
      await seedOutbox("payroll_run", "payroll.paid", {
        payrollRunId: randomUUID(),
        legalEntityId: foreignEntity,
        netIdr: 80_000,
        bankTransferIdr: 0,
        cashIdr: 80_000,
      }),
    ];
    if (other.rows[0]) {
      const foreignOutlet = await makeOutlet(foreignEntity);
      outlets.push(foreignOutlet);
      seeded.push(await pendingPurchaseOf(foreignOutlet, 80_000));
    }

    const b = await seedTenantB(shop.outletId);
    const unlock = await lockTenantBRows(b);
    try {
      const before = await purchaseState(shop.outletId);
      // B holds 9 billion in 1102, but it is not A's money.
      const tooMuch = await withinMs(
        20_000,
        buy(shop, 60_000),
        "A's purchase above its cash",
      );
      expectGlRefusal(tooMuch, { avail: 50_000, amount: 60_000 });
      expect(
        digitsOf(String(tooMuch.body.error?.message)),
        "B's balance is not shown",
      ).not.toContain(String(B_BALANCE));
      expect(await purchaseState(shop.outletId)).toEqual(before);

      // The poisoned credits of B and the other entity's credits are not A's
      // credits: A's exact available cash still goes through.
      const exact = await withinMs(
        20_000,
        buy(shop, 50_000),
        "A's exact purchase",
      );
      expect(exact.status, JSON.stringify(exact.body)).toBe(201);
      expect(await available()).toBe(0);

      const bBalance = await kitOwner.query<{ balance: string }>(
        `SELECT coalesce(sum(debit_idr - credit_idr), 0)::text AS balance
           FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
        [b.tenantId, b.cashAccountId],
      );
      expect(Number(bBalance.rows[0]!.balance), "B untouched").toBe(B_BALANCE);
    } finally {
      await unlock();
      await dropTenantB(b);
      await kitOwner.query(
        "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenantId, seeded],
      );
    }
  }, 90_000);
});

// ---- accounting off (P2-1) and bank accounts whose GL is 1102 (P2-2a) ------------
//
// Added for the architect findings of 1053b (brief-1053b-arch.md), written from
// the brief and the public HTTP surface.
// Assumptions:
// - "Accounting off" = the tenant's feature_flags.modules without "accounting"
//   (same switch the payout tests use). While it is off, a cash handover ends as a
//   `settle_skipped` posting that nobody will ever turn into a 1102 credit.
// - A bank account whose GL account is 1102 is allowed by the bank-account
//   rules; the cash-out / transfer must then respect the available 1102 cash
//   (GL 1102 minus the cash payroll reserve) exactly like a purchase or a return.
// - Only a move that REDUCES 1102 is checked (cash out, transfer out of the
//   account); money INTO 1102 is never refused for lack of cash.
// - Refusal: PETTY_CASH_GL_INSUFFICIENT with status 409 or 422, no journal and
//   no cash_bank_entries row. While accounting is off the check is skipped; the
//   route may still answer for other reasons, so only "not this refusal" is
//   pinned there.
// - A cash out above the tenant approval limit (Rp5.000.000) waits for approval;
//   the check runs again at approval, when the reserve may have grown.

const ENTRIES = "/api/accounting/cash-bank/entries";
let pettyBankId: string;
let expenseAccountId: string;
let revenueAccountId: string;

async function ensureAccount(
  code: string,
  name: string,
  type: string,
  group: string,
) {
  await kitOwner.query(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING`,
    [tenantId, W.entityId(), code, name, type, group],
  );
  const { rows } = await kitOwner.query<{ id: string }>(
    "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3",
    [tenantId, W.entityId(), code],
  );
  return rows[0]!.id;
}

async function withAccountingOff<T>(work: () => Promise<T>) {
  const before = await kitOwner.query<{ flags: unknown }>(
    "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
    [tenantId],
  );
  const original = before.rows[0]!.flags as { modules?: string[] };
  expect(original.modules, "premise: accounting is on").toContain("accounting");
  await kitOwner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [
      tenantId,
      JSON.stringify({
        ...original,
        modules: (original.modules ?? []).filter((m) => m !== "accounting"),
      }),
    ],
  );
  try {
    return await work();
  } finally {
    await kitOwner.query(
      "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
      [tenantId, JSON.stringify(original)],
    );
  }
}

/** Puts cash into 1102 by a seeded journal (setup only). */
const addCash = (amountIdr: number) => W.fundPettyCash(amountIdr);

const finEntry = (who: Session, body: Record<string, unknown>) =>
  who.client
    .post(ENTRIES)
    .set(originHeader)
    .send(body as object);

const entryBase = () => ({
  legalEntityId: W.entityId(),
  entryDate: daysAgo(0),
  description: "Uji kas 1102 1053b",
  reference: `REF-${randomBytes(3).toString("hex")}`,
  idempotencyKey: key(),
});
const cashOutFrom1102 = (amountIdr: number) => ({
  ...entryBase(),
  kind: "cash_out",
  bankAccountId: pettyBankId,
  counterAccountId: expenseAccountId,
  amountIdr,
});
const cashInTo1102 = (amountIdr: number) => ({
  ...entryBase(),
  kind: "cash_in",
  bankAccountId: pettyBankId,
  counterAccountId: revenueAccountId,
  amountIdr,
});
const transfer = (from: string, to: string, amountIdr: number) => ({
  ...entryBase(),
  kind: "transfer",
  fromBankAccountId: from,
  toBankAccountId: to,
  amountIdr,
});

const freshFinance = (label: string) =>
  signedIn(app, `1053b ${label}`, [{ role: "finance", outletId: null }]);

async function entryRows(): Promise<number> {
  const { rows } = await kitOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM cash_bank_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, W.entityId()],
  );
  return Number(rows[0]!.n);
}

describe("1053b accounting off does not freeze petty purchases forever (P2-1)", () => {
  it("[1053b-purchase-accounting-off-skips-check] a cash handover done while accounting is off stays a settle_skipped credit forever: while accounting is off the purchase is NOT refused for it", async () => {
    await drain();
    const shop = await makeShop();
    await topUp(100_000, shop.outletId);
    const batch = await reserve(60_000); // available 40.000

    const items = await W.itemsOf(batch.batchId);
    await withAccountingOff(() =>
      W.handover(
        batch.batchId,
        items.map((item) => item.id as string),
        APP2,
      ),
    );
    const postings = await W.postingsOf(batch.batchId);
    expect(postings, "premise: one posting").toHaveLength(1);
    expect(postings[0]!.kind, "premise: settle_skipped").toBe("settle_skipped");

    // Premise: with accounting on the skipped credit still counts as pending.
    expectGlRefusal(await buy(shop, 50_000), { avail: 40_000, amount: 50_000 });

    const before = await purchaseState(shop.outletId);
    const res = await withAccountingOff(() => buy(shop, 50_000));
    expect(
      res.status,
      `accounting off: the 1102 check is skipped, ${JSON.stringify(res.body)}`,
    ).toBe(201);
    const after = await purchaseState(shop.outletId);
    expect(after.purchases).toBe(before.purchases + 1);
    expect(after.fund).toBe(50_000);

    // Test hygiene: the baseline of the next tests is zero again.
    const gap = -(await available());
    if (gap > 0) await addCash(gap);
    expect(await available()).toBe(0);
  }, 90_000);
});

describe("1053b bank account on GL 1102 respects the cash payroll reserve (P2-2a)", () => {
  beforeAll(async () => {
    pettyBankId = await makeBankAccount(W.entityId(), pettyGlId);
    expenseAccountId = await ensureAccount(
      "6990",
      "Beban Uji 1053b",
      "expense",
      "operating_expense",
    );
    revenueAccountId = await ensureAccount(
      "4990",
      "Pendapatan Uji 1053b",
      "revenue",
      "other_income",
    );
  });

  it("[1053b-cashout-1102-refused-by-reserve] a cash out from a bank account on 1102 that the reserve makes too big is refused with a clear message; no journal, no entry, GL unchanged; one that fits passes", async () => {
    await drain();
    await addCash(100_000);
    await reserve(70_000); // available 30.000
    const who = await freshFinance("cash out");
    const journals = await journalCount();
    const entries = await entryRows();
    const gl = await glBalance();

    const refused = await finEntry(who, cashOutFrom1102(50_000));

    expectGlRefusal(refused, { avail: 30_000, amount: 50_000 });
    expect(await journalCount(), "no journal").toBe(journals);
    expect(await entryRows(), "no entry").toBe(entries);
    expect(await glBalance()).toBe(gl);

    const fits = await finEntry(who, cashOutFrom1102(30_000));
    expect(fits.status, JSON.stringify(fits.body)).toBe(201);
    expect(await glBalance(), "1102 reduced by the cash out").toBe(gl - 30_000);
    expect(await available()).toBe(0);
    expectGlRefusal(await finEntry(who, cashOutFrom1102(1)), {
      avail: 0,
      amount: 1,
    });
  }, 90_000);

  it("[1053b-transfer-1102-refused-by-reserve] a transfer out of a bank account on 1102 that the reserve makes too big is refused; no journal; a fitting one passes", async () => {
    await drain();
    await addCash(100_000);
    await reserve(70_000); // available 30.000
    const who = await freshFinance("transfer");
    const journals = await journalCount();
    const entries = await entryRows();
    const gl = await glBalance();

    const refused = await finEntry(
      who,
      transfer(pettyBankId, bankAccountId, 50_000),
    );

    expectGlRefusal(refused, { avail: 30_000, amount: 50_000 });
    expect(await journalCount(), "no journal").toBe(journals);
    expect(await entryRows(), "no entry").toBe(entries);
    expect(await glBalance()).toBe(gl);

    const fits = await finEntry(
      who,
      transfer(pettyBankId, bankAccountId, 30_000),
    );
    expect(fits.status, JSON.stringify(fits.body)).toBe(201);
    expect(await glBalance(), "1102 reduced by the transfer").toBe(gl - 30_000);
    expect(await available()).toBe(0);
  }, 90_000);

  it("[1053b-1102-inflow-never-refused] money INTO 1102 (cash in, transfer to the 1102 account) is not refused although available cash is 0", async () => {
    await drain();
    const who = await freshFinance("inflow");
    const gl = await glBalance();

    const cashIn = await finEntry(who, cashInTo1102(40_000));
    expect(cashIn.status, JSON.stringify(cashIn.body)).toBe(201);
    const moved = await finEntry(
      who,
      transfer(bankAccountId, pettyBankId, 20_000),
    );
    expect(moved.status, JSON.stringify(moved.body)).toBe(201);
    expect(await glBalance()).toBe(gl + 60_000);
    // Hygiene: baseline back to zero for the next tests.
    await drain();
  }, 90_000);

  it("[1053b-cashout-other-bank-unaffected] a cash out from a bank account that is NOT on 1102 is not limited by the reserve", async () => {
    await drain(); // available 0
    const who = await freshFinance("other bank");
    const gl = await glBalance();
    const res = await finEntry(who, {
      ...cashOutFrom1102(10_000),
      bankAccountId,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await glBalance(), "1102 untouched").toBe(gl);
  }, 90_000);

  it("[1053b-cashout-1102-accounting-off] while accounting is off the 1102 check is skipped: the same oversized cash out is not refused as PETTY_CASH_GL_INSUFFICIENT", async () => {
    await drain();
    await addCash(100_000);
    await reserve(70_000); // available 30.000
    const who = await freshFinance("accounting off");

    const res = await withAccountingOff(() =>
      finEntry(who, cashOutFrom1102(50_000)),
    );

    // Hygiene first, so a failure below cannot leave a negative baseline.
    const gap = -(await available());
    if (gap > 0) await addCash(gap);

    expect(
      res.status,
      `accounting off: the check is skipped and the cash out is recorded, ${JSON.stringify(res.body)}`,
    ).toBe(201);
  }, 90_000);

  it("[1053b-approve-cashout-1102-refused-by-reserve] a cash out above the approval limit is pending; once a cash payroll reserve makes it too big approval is refused (still pending, no journal); after the reserve is cancelled the same approval passes", async () => {
    await drain();
    await addCash(6_000_000);
    const creator = await freshFinance("approval creator");
    const approver = await freshFinance("approver");
    const created = await finEntry(creator, cashOutFrom1102(5_000_001));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.status).toBe("pending_approval");
    const entryId = created.body.data.id as string;
    const batch = await reserve(1_500_000); // available 4.500.000 < 5.000.001
    const journals = await journalCount();
    const decide = async () => {
      await approveChainLevelAs(approver, entryId);
      return approver.client
        .post(`${ENTRIES}/${encodeURIComponent(entryId)}/approve`)
        .set(originHeader)
        .send({});
    };

    const refused = await decide();

    expectGlRefusal(refused, { avail: 4_500_000, amount: 5_000_001 });
    expect(await journalCount(), "no journal").toBe(journals);
    const status = await kitOwner.query<{ status: string }>(
      "SELECT status FROM cash_bank_entries WHERE tenant_id = $1 AND id = $2",
      [tenantId, entryId],
    );
    expect(status.rows[0]!.status).toBe("pending_approval");

    await W.inTx((tx) =>
      cancelDisbursementBatch(tx, actorOf(REQ), batch.batchId, {
        reason: "uji batal 1053b",
      } as never),
    );
    committed -= batch.net;
    const approved = await decide();
    expect([200, 201], JSON.stringify(approved.body)).toContain(
      approved.status,
    );
    expect(await available(), "6.000.000 - 5.000.001").toBe(999_999);
  }, 120_000);
});
