// Card A of 1053 (bead legend-rvao9, founder decision Q43: refuse). Written
// fail-first from the brief (scratchpad brief-1053.md), the founder rules
// "nobody is paid twice, GL 1102 never goes negative, other tenants and entities
// are untouched", and the public service/API surface, NOT from the guard code.
//
// Rule: approving a CASH payroll batch is refused with 409 PAYOUT_CASH_INSUFFICIENT
// when the cash actually available (GL 1102 minus credits still waiting to post:
// unposted petty purchases and cash payroll items that are already approved) is
// below the batch's total net. A bank batch is never affected.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - The refusal is an HttpError 409 with code PAYOUT_CASH_INSUFFICIENT (brief:
//   "mis. PAYOUT_CASH_INSUFFICIENT"; the code is a suggestion, status 409 is firm).
// - The message names available balance, batch total and shortfall as plain
//   rupiah numbers; the test strips thousand separators and looks for the digits,
//   so "Rp 40.000", "40.000" and "40000" all pass.
// - Available cash = GL 1102 (debit - credit of the payout world's entity) minus
//   the net of cash batches this file approved (tracked in `committed`; the file
//   never hands over, so no approved item ever posts). Every test works relative
//   to the available cash it reads, so test order does not matter.
// - GL 1102 is funded through petty cash top-ups (HTTP, as so1036 does), each
//   on its own outlet of the entity. Petty purchases still waiting to post are
//   outbox events (`petty_purchase.recorded`, pending), as in so1036.
// - Not covered here: "no petty_cash account mapped" (brief: follow the return
//   guard, skip) and a second tenant: the payout world has one entity and
//   foreign-entity pending credits stand in for "other entity/tenant".
// - Concurrency: the outcome of a race is not fixed (either side may win), so
//   only invariants are asserted: exactly one of two competing claims on the
//   same cash succeeds, the loser gets a business refusal (409 / 422) and never
//   a database deadlock, and available cash never goes below zero.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  approveDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import { originHeader } from "./helpers.ts";
import { withLimitSharedLock } from "./helpers/cash-limit-lock.ts";
import {
  closeKit,
  daysAgo,
  key,
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
  bank,
  cash,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const app = createApp();
const MOVEMENTS = "/api/accounting/petty-cash/movements";
const W = installPayoutWorld("1053cash");

let finance: Session;
let bankAccountId: string;
let pettyGlId: string;
const outlets: string[] = [];
/** Net of the cash batches approved by this file (their items stay `approved`). */
let committed = 0;

withLimitSharedLock();

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn(app, "1053 finance", [
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

// ---- helpers ---------------------------------------------------------------

async function newOutlet(): Promise<string> {
  const id = await makeOutlet(W.entityId());
  outlets.push(id);
  return id;
}

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
      description: kind === "topup" ? "Isi kas kecil 1053" : "Setor kas 1053",
      idempotencyKey: key(),
    });

async function topUp(amountIdr: number, outletId?: string) {
  const res = await movement(
    "topup",
    amountIdr,
    outletId ?? (await newOutlet()),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

/**
 * Tops 1102 up (new outlet) until at least `min` is available. Keeps the batch
 * totals below positive whatever earlier tests did, so a failing run fails on
 * the missing guard and not on a negative slip.
 */
async function fund(min: number) {
  const avail = await available();
  if (avail < min) await topUp(min - avail);
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

/** GL 1102 minus the cash batches approved so far (no other pending credit). */
const available = async () => (await glBalance()) - committed;

async function journalCount(): Promise<number> {
  const { rows } = await kitOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, W.entityId()],
  );
  return Number(rows[0]!.n);
}

type Pending = { batchId: string; hash: string; net: number };

/** A cash batch of one slip, submitted and waiting for approval. */
async function pendingBatch(
  net: number,
  channel: "cash" | "manual_bank" = "cash",
): Promise<Pending> {
  const slip = channel === "cash" ? cash(CASHIER, net) : bank(CASHIER, net);
  const runId = await W.seedRun([slip]);
  const batchId = await W.createBatch(runId, channel);
  await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
  const hash = (await W.batchById(batchId)).content_hash as string;
  return { batchId, hash, net };
}

async function sourceAccountOf(channel: string): Promise<string | null> {
  if (channel !== "manual_bank") return null;
  const [row] = await W.rowsOf(
    `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
      WHERE tenant_id = $1 AND legal_entity_id = $2`,
    [tenantId, W.entityId()],
  );
  return (row?.id as string | undefined) ?? null;
}

/** Approves through the service; null on success, the thrown error otherwise. */
async function tryApprove(
  batch: Pending,
  channel: "cash" | "manual_bank" = "cash",
): Promise<unknown> {
  const sourceBankAccountId = await sourceAccountOf(channel);
  const failure = await W.httpFailure(
    W.inTx((tx) =>
      approveDisbursementBatch(tx, actorOf(APP), batch.batchId, {
        contentHash: batch.hash,
        sourceBankAccountId,
      } as never),
    ),
  );
  if (failure === null && channel === "cash") committed += batch.net;
  return failure;
}

/** The failure is the business refusal of the guard, not a database error. */
function expectCashRefusal(failure: unknown) {
  expect(failure, "the approval must be refused").toBeInstanceOf(HttpError);
  const error = failure as HttpError;
  expect(error.status, `${error.code}: ${error.message}`).toBe(409);
  expect(error.code).toBe("PAYOUT_CASH_INSUFFICIENT");
  return error;
}

async function expectUntouched(batch: Pending, journalsBefore: number) {
  const row = await W.batchById(batch.batchId);
  expect(row.status).toBe("pending_approval");
  expect(row.approved_by).toBeNull();
  expect(row.approved_at).toBeNull();
  for (const item of await W.itemsOf(batch.batchId))
    expect(item.status, "items stay as submitted").toBe("prepared");
  expect(await journalCount(), "no journal written").toBe(journalsBefore);
}

async function expectApproved(batch: Pending) {
  expect((await W.batchById(batch.batchId)).status).toBe("approved");
  for (const item of await W.itemsOf(batch.batchId))
    expect(item.status).toBe("approved");
}

const digitsOf = (text: string) => text.replace(/(?<=\d)[.,](?=\d)/g, "");

/** One pending petty purchase or payroll.paid fact waiting in the outbox. */
async function seedOutbox(
  aggregateType: string,
  name: string,
  payload: Record<string, unknown>,
  status: "pending" | "delivered" = "pending",
  forTenant: string = tenantId,
): Promise<string> {
  const id = randomUUID();
  await kitOwner.query(
    `INSERT INTO domain_event_outbox
       (tenant_id, id, event_id, aggregate_type, aggregate_id, sequence, event, destination, status, delivered_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, 'cloud-sync', $7::varchar,
             CASE WHEN $7::text = 'delivered' THEN now() END)`,
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
      status,
    ],
  );
  return id;
}

const purchaseEvent = (outletId: string, amountIdr: number) =>
  seedOutbox("petty_purchase", "petty_purchase.recorded", {
    pettyPurchaseId: randomUUID(),
    outletId,
    amountIdr,
    businessDate: "2026-11-10",
    paidBy: randomUUID(),
    paidAt: "2026-11-10T03:00:00.000Z",
  });

const clearOutbox = (ids: string[]) =>
  kitOwner.query(
    "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
    [tenantId, ids],
  );

// ---- single-actor behaviour ------------------------------------------------

describe("1053 cash payroll approval needs cash in 1102", () => {
  it("[legend-rvao9-refuse-short] a cash batch above the available cash is refused 409 with a clear message; batch, items and ledger stay as they were", async () => {
    await fund(30_000);
    const avail = await available();
    const net = avail + 40_000;
    const batch = await pendingBatch(net);
    const journals = await journalCount();

    const error = expectCashRefusal(await tryApprove(batch));

    // Finance can act on the message: balance, batch total, shortfall.
    const message = digitsOf(error.message);
    expect(message, "available cash").toContain(String(avail));
    expect(message, "batch total").toContain(String(net));
    expect(message, "shortfall").toContain("40000");
    await expectUntouched(batch, journals);
    expect(await glBalance()).toBe(avail + committed);
  });

  it("[legend-rvao9-exact-passes] the batch total equal to the available cash is approved (the batch's own items are not counted against itself)", async () => {
    await fund(70_000);
    const avail = await available();
    const batch = await pendingBatch(avail);

    expect(await tryApprove(batch)).toBeNull();

    await expectApproved(batch);
    expect(await available(), "all cash is now spoken for").toBe(0);
  });

  it("[legend-rvao9-reapprove-after-topup] the refused batch can be approved again after a top-up covers the shortfall", async () => {
    await fund(20_000);
    const avail = await available();
    const batch = await pendingBatch(avail + 50_000);

    expectCashRefusal(await tryApprove(batch));
    await topUp(50_000);
    expect(await tryApprove(batch)).toBeNull();

    await expectApproved(batch);
    expect(await available()).toBe(0);
  });

  it("[legend-rvao9-pending-credits-count] cash payroll already approved and petty purchases not yet posted reduce what a new cash batch may take", async () => {
    await fund(100_000);
    const avail = await available();

    // 1. An approved cash batch of 60.000 leaves avail - 60.000.
    const first = await pendingBatch(60_000);
    expect(await tryApprove(first)).toBeNull();
    const second = await pendingBatch(avail - 60_000 + 10_000);
    expectCashRefusal(await tryApprove(second));

    // 2. A petty purchase still in the outbox takes another 30.000.
    const outletId = await newOutlet();
    const seeded = [await purchaseEvent(outletId, 30_000)];
    try {
      const tooMuch = await pendingBatch(avail - 60_000 - 30_000 + 10_000);
      expectCashRefusal(await tryApprove(tooMuch));
      // What is really left (avail - 60.000 - 30.000) goes through.
      const fits = await pendingBatch(avail - 60_000 - 30_000);
      expect(await tryApprove(fits)).toBeNull();
      await expectApproved(fits);
    } finally {
      await clearOutbox(seeded);
    }
  });

  it("[legend-rvao9-other-entity-and-done-not-counted] pending credits of another legal entity, delivered events and non-cash facts do not reduce the available cash", async () => {
    await fund(100_000);
    const avail = await available();
    const other = await kitOwner.query<{ id: string }>(
      "SELECT id FROM legal_entities WHERE tenant_id = $1 AND id <> $2 LIMIT 1",
      [tenantId, W.entityId()],
    );
    const foreignEntity = other.rows[0]?.id ?? randomUUID();
    const seeded: string[] = [];
    try {
      seeded.push(
        // Another entity's cash payroll and (when it exists) its petty purchase.
        await seedOutbox("payroll_run", "payroll.paid", {
          payrollRunId: randomUUID(),
          legalEntityId: foreignEntity,
          netIdr: 80_000,
          bankTransferIdr: 0,
          cashIdr: 80_000,
        }),
        // Already delivered (its journal is in GL 1102 by now).
        await seedOutbox(
          "payroll_run",
          "payroll.paid",
          {
            payrollRunId: randomUUID(),
            legalEntityId: W.entityId(),
            netIdr: 80_000,
            bankTransferIdr: 0,
            cashIdr: 80_000,
          },
          "delivered",
        ),
        // A bank loan is not a cash credit.
        await seedOutbox("employee_loan", "employee_loan.disbursed", {
          employeeLoanId: randomUUID(),
          legalEntityId: W.entityId(),
          principalIdr: 80_000,
          disbursedVia: "bank",
        }),
      );
      if (other.rows[0]) {
        const foreignOutlet = await makeOutlet(foreignEntity);
        outlets.push(foreignOutlet);
        seeded.push(await purchaseEvent(foreignOutlet, 80_000));
      }
      const batch = await pendingBatch(avail);
      expect(await tryApprove(batch)).toBeNull();
      await expectApproved(batch);
    } finally {
      await clearOutbox(seeded);
    }
  });

  it("[legend-rvao9-bank-batch-unaffected] a bank batch is approved even when 1102 holds far less than its total", async () => {
    const avail = await available();
    const net = Math.max(avail, 0) + 4_000_000;
    const batch = await pendingBatch(net, "manual_bank");

    expect(await tryApprove(batch, "manual_bank")).toBeNull();

    await expectApproved(batch);
  });
});

// ---- concurrency -----------------------------------------------------------

/** Business refusal, never a database deadlock (40P01) or an unexpected crash. */
function expectBusinessRefusal(failure: unknown, status: number) {
  expect(failure, "the loser is refused, not crashed").toBeInstanceOf(
    HttpError,
  );
  expect((failure as HttpError).status).toBe(status);
}

describe("1053 concurrent claims on the same cash", () => {
  it("[legend-rvao9-race-two-batches] two cash batches that each fit alone but not together: exactly one is approved", async () => {
    for (let round = 0; round < 2; round++) {
      await fund(100_000);
      const avail = await available();
      const net = avail - 20_000; // each fits, the two do not
      const [a, b] = [await pendingBatch(net), await pendingBatch(net)];
      const journals = await journalCount();

      const [fa, fb] = await Promise.all([tryApprove(a), tryApprove(b)]);

      const winners = [fa, fb].filter((f) => f === null).length;
      expect(winners, `round ${round}: exactly one batch passes`).toBe(1);
      const loser = fa === null ? fb : fa;
      expectCashRefusal(loser);
      expect(
        await available(),
        "1102 is never overdrawn",
      ).toBeGreaterThanOrEqual(0);
      expect(await journalCount()).toBe(journals);
      const statuses = await Promise.all(
        [a, b].map(async (x) => (await W.batchById(x.batchId)).status),
      );
      expect(statuses.sort()).toEqual(["approved", "pending_approval"]);
    }
  }, 90_000);

  it("[legend-rvao9-race-approve-vs-return] a cash approval and a petty cash return that each fit alone but not together: only one gets the cash and 1102 never goes negative", async () => {
    for (let round = 0; round < 2; round++) {
      const outletId = await newOutlet();
      await topUp(100_000, outletId);
      await fund(100_000);
      const avail = await available();
      const net = avail - 40_000; // net + 100.000 > avail
      const batch = await pendingBatch(net);

      const [failure, ret] = await Promise.all([
        tryApprove(batch),
        movement("return", 100_000, outletId),
      ]);

      const approved = failure === null;
      const returned = ret.status === 201;
      expect(
        approved !== returned,
        `round ${round}: approved=${approved}, return=${ret.status} ${JSON.stringify(ret.body)}`,
      ).toBe(true);
      if (!approved) expectCashRefusal(failure);
      if (!returned) expect(ret.status).toBe(422);
      expect(await glBalance(), "GL 1102 not negative").toBeGreaterThanOrEqual(
        0,
      );
      expect(
        await available(),
        "no cash promised that is not there",
      ).toBeGreaterThanOrEqual(0);
      expect((await W.batchById(batch.batchId)).status).toBe(
        approved ? "approved" : "pending_approval",
      );
    }
  }, 90_000);

  it("[legend-rvao9-race-approve-vs-topup] (control, may pass before the guard) an approval racing a top-up that would cover its shortfall: no deadlock, a consistent result, and the batch can be approved after the top-up", async () => {
    for (let round = 0; round < 2; round++) {
      const outletId = await newOutlet();
      await fund(10_000);
      const avail = await available();
      const batch = await pendingBatch(avail + 50_000);

      const [failure, top] = await Promise.all([
        tryApprove(batch),
        movement("topup", 50_000, outletId),
      ]);

      expect(top.status, JSON.stringify(top.body)).toBe(201);
      if (failure !== null) {
        // It read the cash before the top-up landed: a business refusal only.
        expectBusinessRefusal(failure, 409);
        expectCashRefusal(failure);
        expect((await W.batchById(batch.batchId)).status).toBe(
          "pending_approval",
        );
        expect(
          await tryApprove(batch),
          "approved once the cash is there",
        ).toBeNull();
      }
      await expectApproved(batch);
      expect(await available(), "never overdrawn").toBeGreaterThanOrEqual(0);
    }
  }, 90_000);
});

// ---- other tenant ----------------------------------------------------------
//
// Assumptions for the two tests below: tenant B is a real second tenant with
// its own legal entity, chart (GL 1102 with a huge balance, a revenue account)
// and fiscal period. Its journal is seeded by SQL (as the accounting suites do)
// so no second login is needed. Its outbox also holds pending credits that
// NAME tenant A's entity and an outlet of tenant A (a poisoned payload): only
// the tenant column can keep them out of A's decision. B's rows are locked
// (FOR UPDATE) for the whole decision of A: a guard that touched B's rows
// would block and the race against the timer below would fail.

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
       SELECT $1, $2, 'Payout 1053 other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [bTenant, `p1053-${randomBytes(3).toString("hex")}`, tenantId],
    );
    const entity = await client.query<{ id: string }>(
      "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
      [bTenant, `Entity 1053 B ${randomBytes(3).toString("hex")}`],
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
        `p1053-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
      [bTenant, entry.rows[0]!.id, cashAccountId, revenue, B_BALANCE],
    );
    await client.query("COMMIT");
    // Pending credits of tenant B, poisoned to point at tenant A's entity.
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
      "pending",
      bTenant,
    );
    await seedOutbox(
      "petty_purchase",
      "petty_purchase.recorded",
      {
        pettyPurchaseId: randomUUID(),
        outletId: aOutletId,
        amountIdr: B_BALANCE,
        businessDate: "2026-11-10",
        paidBy: randomUUID(),
        paidAt: "2026-11-10T03:00:00.000Z",
      },
      "pending",
      bTenant,
    );
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

describe("1053 another tenant does not change the cash decision", () => {
  it("[legend-rvao9-other-tenant-isolated] tenant B with a huge GL 1102 and huge pending credits does not change tenant A: a short cash batch of A is still refused (message shows A's own cash), an exact one passes, and A never touches B's rows", async () => {
    await fund(100_000);
    const avail = await available();
    const b = await seedTenantB(await newOutlet());
    const unlock = await lockTenantBRows(b);
    try {
      const short = await pendingBatch(avail + 40_000);
      const exact = await pendingBatch(avail);
      const journals = await journalCount();

      // B's money is not A's: refused although B holds 9 billion in 1102.
      const error = expectCashRefusal(
        await withinMs(
          20_000,
          tryApprove(short),
          "approval of A's short batch",
        ),
      );
      const message = digitsOf(error.message);
      expect(message, "A's own available cash").toContain(String(avail));
      expect(message, "shortfall").toContain("40000");
      expect(message, "B's balance is not shown").not.toContain(
        String(B_BALANCE),
      );
      await expectUntouched(short, journals);

      // B's pending credits (poisoned to name A's entity) are not A's credits:
      // exactly A's available cash is still approved.
      expect(
        await withinMs(
          20_000,
          tryApprove(exact),
          "approval of A's exact batch",
        ),
      ).toBeNull();
      await expectApproved(exact);
      expect(await available(), "all of A's cash is spoken for").toBe(0);

      // B is untouched by A's decisions.
      const bBalance = await kitOwner.query<{ balance: string }>(
        `SELECT coalesce(sum(debit_idr - credit_idr), 0)::text AS balance
           FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
        [b.tenantId, b.cashAccountId],
      );
      expect(Number(bBalance.rows[0]!.balance)).toBe(B_BALANCE);
    } finally {
      await unlock();
      await dropTenantB(b);
    }
  }, 90_000);
});

// ---- no petty_cash account mapped -------------------------------------------
//
// Not specified by the brief beyond "follow the return guard, skip". The test
// documents what approveDisbursementBatch does TODAY for an entity without a
// `petty_cash` mapping and where a later cash handover posts. It is a
// characterisation, not a verdict: the CTO decides whether the behavior stays.

async function withoutPettyCashMapping<T>(work: () => Promise<T>) {
  const rows = await W.rowsOf(
    `SELECT role, account_id FROM account_mappings
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'`,
    [tenantId, W.entityId()],
  );
  expect(rows, "premise: the entity has a petty_cash mapping").toHaveLength(1);
  await kitOwner.query(
    "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'",
    [tenantId, W.entityId()],
  );
  try {
    return await work();
  } finally {
    await kitOwner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'petty_cash', $3)`,
      [tenantId, W.entityId(), (rows[0] as Row).account_id],
    );
  }
}

describe("1053 entity without a petty_cash account mapping (characterisation)", () => {
  it("[legend-rvao9-no-petty-cash-mapping] documents whether the guard is skipped on approve and what the later cash handover does", async () => {
    await fund(10_000);
    const avail = await available();
    const net = Math.max(avail, 0) + 5_000_000; // far above any 1102 cash
    const slips = [cash(CASHIER, net)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const batchId = await W.createBatch(runId, "cash");
    await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
    const batch: Pending = {
      batchId,
      hash: (await W.batchById(batchId)).content_hash as string,
      net,
    };

    // Observed today (characterisation): the approval is NOT refused (the
    // guard is skipped when no petty_cash account is mapped), and the later
    // cash handover fails 422 ACCOUNT_MAPPING_MISSING, so nothing is posted and
    // the items stay `approved`. The money cannot go out until finance maps
    // petty_cash again; no journal goes to any other account.
    const journalsBefore = await journalCount();
    await withoutPettyCashMapping(async () => {
      expect(await tryApprove(batch), "guard skipped, approval succeeds").toBe(
        null,
      );
      await expectApproved(batch);

      const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
      const failure = await W.httpFailure(W.handover(batchId, itemIds, APP2));
      // An AccountingError (not an HttpError class) carrying status and code.
      expect(failure, "handover is refused").toBeInstanceOf(Error);
      const error = failure as HttpError;
      expect(error.status).toBe(422);
      expect(error.code).toBe("ACCOUNT_MAPPING_MISSING");
      expect(error.message).toContain("petty_cash");
    });

    expect(await W.postingsOf(batchId), "nothing posted").toHaveLength(0);
    expect(await journalCount(), "no journal anywhere").toBe(journalsBefore);
    for (const item of await W.itemsOf(batchId))
      expect(item.status, "items not handed over").toBe("approved");
  }, 90_000);
});

// ---- accounting module off ---------------------------------------------------
//
// Assumptions: "accounting off" = the tenant's feature_flags.modules no longer
// lists "accounting" (the same flag the accounting suites flip). With it off
// nothing is posted to GL 1102, so a cash guard on 1102 has nothing to protect
// and must not refuse. The "large pending credit" is a pending petty purchase in
// the outbox for an outlet of the entity (the credit kind this file already
// uses); the mapping petty_cash stays in place. Flags are restored exactly.

async function withAccountingOff<T>(work: () => Promise<T>) {
  const before = await kitOwner.query<{ flags: unknown }>(
    "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
    [tenantId],
  );
  const original = before.rows[0]!.flags as { modules?: string[] };
  expect(original.modules, "premise: accounting is on").toContain("accounting");
  const off = {
    ...original,
    modules: (original.modules ?? []).filter((m) => m !== "accounting"),
  };
  await kitOwner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [tenantId, JSON.stringify(off)],
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

describe("1053 accounting module off skips the cash guard", () => {
  it("[legend-rvao9-accounting-off] a tenant with accounting off, a petty_cash mapping and a huge pending credit: approving a cash batch above 1102 is NOT refused", async () => {
    // Earlier tests leave 1102 overspent on paper (committed batches), so no
    // top-up: the batch is simply far above any cash 1102 could hold.
    const avail = await available();
    const net = Math.max(avail, 0) + 5_000_000;
    const batch = await pendingBatch(net);
    const seeded = [await purchaseEvent(await newOutlet(), 50_000_000)];
    try {
      const failure = await withAccountingOff(() => tryApprove(batch));
      expect(failure, "guard skipped while accounting is off").toBeNull();
      await expectApproved(batch);
    } finally {
      await clearOutbox(seeded);
    }
  }, 90_000);
});
