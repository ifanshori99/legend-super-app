// Petty cash (Kas Kecil) per outlet — HTTP + database tests (bead legend-4961,
// WS-07; PRD v1.7 §3.19 Kas & Bank, §3.18 Pembelian Sederhana; design
// docs/briefs/ws-cash-bank-design.md). Real Better Auth, RLS and PostgreSQL on
// the disposable test DB; requests go through the real routes of createApp().
//
// Founder money rules (fail-first; every refusal test has a control that
// succeeds so a missing route cannot pass by answering 404):
// 1. (transfer rule: accounting-cash-bank-entries.test.ts)
// 2. petty cash cannot go below zero: a return or a petty purchase above the
//    fund balance is refused and writes nothing; parallel spends cannot
//    overdraw; the database itself refuses a negative balance;
// 3. no permission / outlet scope / other tenant is refused;
// 4. one document makes one journal (retry of a parked entry posts once; a
//    purchase entry has no journal of its own and its own journal is single).
// Invariant after every scenario: balance = sum(topup) - sum(return) -
// sum(purchase), never negative, and the last entry's balance_after equals it.
//
// Assumptions where the design is silent:
// - Success is 201 for a create; a replay answers 200 or 201 with the same id;
//   a retry post answers 200 or 201.
// - Errors use the `{ error: { code } }` envelope of the other suites.
// - An outlet WITHOUT a fund keeps the old behavior: a petty purchase is still
//   recorded (design 3; open question to the founder whether a fund must exist).
//   If the founder decides the opposite, update CASH-10.
// - A petty purchase refused for lack of balance answers 422 PETTY_CASH_INSUFFICIENT
//   (the limit policy is set high so the limit check cannot be the cause).
// - A scoped finance user is refused on POST with 403 (OUTLET_OUT_OF_SCOPE per
//   the design); a retry/GET against another outlet is hidden or refused.
// - Table and column names are the ones the design fixes.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  asRuntime,
  auditActionsFor,
  closeKit,
  daysAgo,
  journalCount,
  journalLinesOf,
  journalsByKey,
  key,
  lineOf,
  makeOutlet,
  makeWorld,
  owner,
  scopeOf,
  signedIn,
  tenantId,
  type Session,
  type World,
} from "./helpers/cash-bank-world.ts";

const app = createApp();
const MOVEMENTS = "/api/accounting/petty-cash/movements";
const PETTY_ENTRIES = "/api/accounting/petty-cash/entries";
const FUNDS = "/api/accounting/petty-cash/funds";
const PURCHASES = "/api/inventory/petty-purchases";
const POLICY = "/api/inventory/petty-purchase-policy";
const PETTY_SOURCES = ["petty_cash_topup", "petty_cash_return"];

let world: World;
let finance: Session;
let scopedFinance: Session;
let recorder: Session;
let nobody: Session;
let scopedOutlet: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  world = await makeWorld();
  scopedOutlet = await makeOutlet(world.entityId);
  finance = await signedIn(app, "PC finance", [
    { role: "finance", outletId: null },
  ]);
  scopedFinance = await signedIn(app, "PC finance outlet", [
    { role: "finance", outletId: scopedOutlet },
  ]);
  // Records the petty purchases; granted per outlet in `freshOutlet`.
  recorder = await signedIn(app, "PC recorder", []);
  nobody = await signedIn(app, "PC nobody", []);
});

afterAll(async () => {
  setAuditWriter(null);
  await closeKit();
});

// ---- fixtures --------------------------------------------------------------

async function freshOutlet(): Promise<string> {
  const outletId = await makeOutlet(world.entityId);
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'outlet_manager'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantId, recorder.userId, rows[0]!.id, outletId],
  );
  const policy = await finance.client
    .put(POLICY)
    .set(originHeader)
    .send({ outletId, limitIdr: 1_000_000, idempotencyKey: key() });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  return outletId;
}

const movementBody = (
  outletId: string,
  kind: "topup" | "return",
  amountIdr: number,
  extra: Record<string, unknown> = {},
) => ({
  kind,
  outletId,
  bankAccountId: world.bankAccountA,
  amountIdr,
  description: kind === "topup" ? "Isi kas kecil" : "Setor sisa kas kecil",
  idempotencyKey: key(),
  ...extra,
});
const move = (who: Session, body: Record<string, unknown>) =>
  who.client
    .post(MOVEMENTS)
    .set(originHeader)
    .send(body as object);
const retryPost = (who: Session, entryId: string) =>
  who.client
    .post(`${PETTY_ENTRIES}/${entryId}/post`)
    .set(originHeader)
    .send({});
const listEntries = (who: Session, query: Record<string, string | number>) =>
  who.client.get(PETTY_ENTRIES).set(originHeader).query(query);
const listFunds = (who: Session, query: Record<string, string>) =>
  who.client.get(FUNDS).set(originHeader).query(query);

const ok = (status: number) => [200, 201].includes(status);

/** Tops the outlet's fund up through the API and returns the new entry id. */
async function fundWith(outletId: string, amountIdr: number): Promise<string> {
  const res = await move(finance, movementBody(outletId, "topup", amountIdr));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

async function insertPhoto(outletId: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO core_storage_objects
       (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id)
     VALUES ($1, $2, $3, 'receipt', $4, 'image/webp', 1024, $5)`,
    [tenantId, outletId, id, `legend-4961/${id}.webp`, recorder.userId],
  );
  return id;
}

async function purchaseBody(
  outletId: string,
  amountIdr: number,
  extra: Record<string, unknown> = {},
) {
  return {
    outletId,
    vendorName: "Pasar Induk",
    description: "Cabai dan bawang",
    amountIdr,
    photoMediaId: await insertPhoto(outletId),
    idempotencyKey: key(),
    ...extra,
  };
}
const buy = (body: Record<string, unknown>) =>
  recorder.client
    .post(PURCHASES)
    .set(originHeader)
    .send(body as object);

// ---- reads (migration owner) -----------------------------------------------

type FundRow = { id: string; balance: number };
async function fundRow(outletId: string): Promise<FundRow | null> {
  const { rows } = await owner.query<{ id: string; balance: string }>(
    "SELECT id, balance_idr::text AS balance FROM petty_cash_funds WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantId, outletId],
  );
  return rows[0] ? { id: rows[0].id, balance: Number(rows[0].balance) } : null;
}
async function balanceOf(outletId: string): Promise<number> {
  const fund = await fundRow(outletId);
  if (!fund) throw new Error(`No petty cash fund for ${outletId}`);
  return fund.balance;
}

type EntryRow = {
  id: string;
  kind: string;
  amount: number;
  balance_after: number;
  bank_account_id: string | null;
  petty_purchase_id: string | null;
  journal_status: string;
  journal_entry_id: string | null;
  park_code: string | null;
  idempotency_key: string;
};
async function entryRows(outletId: string): Promise<EntryRow[]> {
  const { rows } = await owner.query<{
    id: string;
    kind: string;
    amount: string;
    balance_after: string;
    bank_account_id: string | null;
    petty_purchase_id: string | null;
    journal_status: string;
    journal_entry_id: string | null;
    park_code: string | null;
    idempotency_key: string;
  }>(
    `SELECT id, kind, amount_idr::text AS amount, balance_after_idr::text AS balance_after,
            bank_account_id, petty_purchase_id, journal_status, journal_entry_id,
            park_code, idempotency_key
       FROM petty_cash_entries WHERE tenant_id = $1 AND outlet_id = $2
      ORDER BY created_at, id`,
    [tenantId, outletId],
  );
  return rows.map((row) => ({
    ...row,
    amount: Number(row.amount),
    balance_after: Number(row.balance_after),
  }));
}
async function entryById(entryId: string): Promise<EntryRow> {
  const { rows } = await owner.query<{ outlet_id: string }>(
    "SELECT outlet_id FROM petty_cash_entries WHERE tenant_id = $1 AND id = $2",
    [tenantId, entryId],
  );
  expect(rows, `petty_cash_entries row ${entryId}`).toHaveLength(1);
  const found = (await entryRows(rows[0]!.outlet_id)).find(
    (row) => row.id === entryId,
  );
  return found!;
}

async function pettyPurchaseCount(outletId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM petty_purchases WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantId, outletId],
  );
  return Number(rows[0]!.n);
}
async function recordedEventCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'petty_purchase.recorded'`,
    [tenantId],
  );
  return Number(rows[0]!.n);
}

/**
 * Founder invariant, checked after each scenario: the fund balance is exactly
 * topups - returns - purchases, never negative, the ledger's last
 * balance_after matches, and every movement has exactly the journal its
 * status says (posted: one; parked: none; purchase: none of its own here).
 */
async function expectLedgerConsistent(outletId: string): Promise<void> {
  const fund = await fundRow(outletId);
  expect(fund, "fund exists").not.toBeNull();
  const entries = await entryRows(outletId);
  const expected = entries.reduce(
    (total, row) => total + (row.kind === "topup" ? row.amount : -row.amount),
    0,
  );
  expect(fund!.balance).toBe(expected);
  expect(fund!.balance).toBeGreaterThanOrEqual(0);
  for (const row of entries)
    expect(row.balance_after).toBeGreaterThanOrEqual(0);
  if (entries.length > 0)
    expect(entries[entries.length - 1]!.balance_after).toBe(fund!.balance);
  for (const row of entries) {
    if (row.kind === "purchase") {
      expect(row.journal_entry_id).toBeNull();
      expect(row.journal_status).toBe("external");
      continue;
    }
    const journals = await journalsByKey(world.entityId, `pc:${row.id}`);
    expect(journals, `journals of ${row.kind} ${row.id}`).toHaveLength(
      row.journal_status === "posted" ? 1 : 0,
    );
  }
}

// ---- consumer delivery (as purchase-return-petty-e2e.test.ts) ---------------

async function outboxEvent(aggregateId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'petty_purchase.recorded'`,
    [tenantId, aggregateId],
  );
  expect(rows, `petty_purchase.recorded of ${aggregateId}`).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}
function deliver(event: EventEnvelope) {
  const context = scopeOf();
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, new Date()),
  );
}

// ============================================================================

describe("legend-4961 petty cash movements", () => {
  it("[legend-4961-PC-1] the first topup opens the fund and posts Dr petty cash / Cr the account's own bank GL, balanced", async () => {
    const outletId = await freshOutlet();
    expect(await fundRow(outletId)).toBeNull();

    const res = await move(finance, movementBody(outletId, "topup", 100_000));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      kind: "topup",
      amountIdr: 100_000,
      balanceAfterIdr: 100_000,
      journalStatus: "posted",
    });
    expect(await balanceOf(outletId)).toBe(100_000);

    const entry = await entryById(res.body.data.id);
    expect(entry.journal_entry_id).toEqual(expect.any(String));
    const journals = await journalsByKey(world.entityId, `pc:${entry.id}`);
    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatchObject({
      id: entry.journal_entry_id,
      source_type: "petty_cash_topup",
    });
    const lines = await journalLinesOf(entry.journal_entry_id!);
    expect(lineOf(lines, world.gl.pettyCash)).toEqual({
      debit: 100_000,
      credit: 0,
    });
    expect(lineOf(lines, world.gl.bankA)).toEqual({
      debit: 0,
      credit: 100_000,
    });
    expect(lines).toHaveLength(2);
    await expectLedgerConsistent(outletId);
  });

  it("[legend-4961-PC-2] the bank GL comes from the chosen bank account, not from the role map; a return mirrors it", async () => {
    const outletId = await freshOutlet();
    // The role map points bank at bank A's GL; bank B must still be credited.
    const top = await move(
      finance,
      movementBody(outletId, "topup", 125_000, {
        bankAccountId: world.bankAccountB,
      }),
    );
    expect(top.status, JSON.stringify(top.body)).toBe(201);
    const topLines = await journalLinesOf(
      (await entryById(top.body.data.id)).journal_entry_id!,
    );
    expect(lineOf(topLines, world.gl.bankB)).toEqual({
      debit: 0,
      credit: 125_000,
    });
    expect(lineOf(topLines, world.gl.bankA)).toBeUndefined();

    const back = await move(
      finance,
      movementBody(outletId, "return", 25_000, {
        bankAccountId: world.bankAccountB,
      }),
    );
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    expect(back.body.data).toMatchObject({
      kind: "return",
      amountIdr: 25_000,
      balanceAfterIdr: 100_000,
      journalStatus: "posted",
    });
    const entry = await entryById(back.body.data.id);
    const journals = await journalsByKey(world.entityId, `pc:${entry.id}`);
    expect(journals[0]).toMatchObject({ source_type: "petty_cash_return" });
    const lines = await journalLinesOf(entry.journal_entry_id!);
    expect(lineOf(lines, world.gl.bankB)).toEqual({ debit: 25_000, credit: 0 });
    expect(lineOf(lines, world.gl.pettyCash)).toEqual({
      debit: 0,
      credit: 25_000,
    });
    expect(await balanceOf(outletId)).toBe(100_000);
    await expectLedgerConsistent(outletId);
  });

  it("[legend-4961-PC-3] replaying a movement with the same key adds nothing; another body under the key is refused", async () => {
    const outletId = await freshOutlet();
    const body = movementBody(outletId, "topup", 60_000);
    const journals = await journalCount(world.entityId, PETTY_SOURCES);
    const first = await move(finance, body);
    const replay = await move(finance, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(ok(replay.status), JSON.stringify(replay.body)).toBe(true);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await balanceOf(outletId)).toBe(60_000);
    expect(await entryRows(outletId)).toHaveLength(1);
    expect(await journalCount(world.entityId, PETTY_SOURCES)).toBe(
      journals + 1,
    );

    const reused = await move(finance, { ...body, amountIdr: 61_000 });
    expect(reused.status, JSON.stringify(reused.body)).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await balanceOf(outletId)).toBe(60_000);
    await expectLedgerConsistent(outletId);
  });

  it("[legend-4961-PC-4] four parallel topups with one key add the money once", async () => {
    const outletId = await freshOutlet();
    const body = movementBody(outletId, "topup", 70_000);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => move(finance, body)),
    );
    for (const res of results)
      expect(ok(res.status), JSON.stringify(res.body)).toBe(true);
    expect(new Set(results.map((res) => res.body.data.id)).size).toBe(1);
    expect(await balanceOf(outletId)).toBe(70_000);
    expect(await entryRows(outletId)).toHaveLength(1);
    await expectLedgerConsistent(outletId);
  });

  it("[legend-4961-PC-5] bad movements are refused with 4xx and change nothing", async () => {
    const outletId = await freshOutlet();
    await fundWith(outletId, 50_000);
    const before = await entryRows(outletId);
    const bad: Record<string, unknown>[] = [
      movementBody(outletId, "topup", 0),
      movementBody(outletId, "topup", -10_000),
      movementBody(outletId, "return", 1000.5),
      movementBody(outletId, "topup", 10_000, { description: "" }),
      movementBody(outletId, "topup", 10_000, { idempotencyKey: "short" }),
      // Spending is only the photo-backed petty purchase, never a movement.
      { ...movementBody(outletId, "topup", 10_000), kind: "purchase" },
      { ...movementBody(outletId, "topup", 10_000), kind: "spend" },
      // The client never picks accounts or balances.
      movementBody(outletId, "topup", 10_000, {
        accountOverrides: { bank: world.gl.revenue },
      }),
      movementBody(outletId, "topup", 10_000, { balanceAfterIdr: 999_999 }),
    ];
    for (const body of bad) {
      const res = await move(finance, body);
      expect(
        res.status >= 400 && res.status < 500,
        `${JSON.stringify(body)} -> ${res.status}`,
      ).toBe(true);
    }
    expect(await entryRows(outletId)).toHaveLength(before.length);
    expect(await balanceOf(outletId)).toBe(50_000);
    await expectLedgerConsistent(outletId);
  });

  it("[legend-4961-PC-6] a foreign, unknown or other-entity bank account / outlet is refused and changes nothing", async () => {
    const outletId = await freshOutlet();
    const refused = [
      // Another tenant's bank account is invisible.
      [world.foreign.bankAccountId, outletId, [404]],
      // Unknown bank account.
      [randomUUID(), outletId, [404]],
      // A bank account of another legal entity than the outlet's.
      [world.otherBankAccount, outletId, [404, 422]],
      // Unknown outlet.
      [world.bankAccountA, randomUUID(), [403, 404]],
    ] as const;
    for (const [bankAccountId, outlet, statuses] of refused) {
      const res = await move(
        finance,
        movementBody(outlet, "topup", 10_000, { bankAccountId }),
      );
      expect(statuses as readonly number[], JSON.stringify(res.body)).toContain(
        res.status,
      );
    }
    expect(await fundRow(outletId)).toBeNull();
    // Control: with the right bank account the topup works.
    expect(
      (await move(finance, movementBody(outletId, "topup", 10_000))).status,
    ).toBe(201);
  });
});

describe("legend-4961 petty cash never goes below zero (money rule 2)", () => {
  it("[legend-4961-PC-10] a return above the balance is refused: balance, entries and journals unchanged; the exact balance is allowed", async () => {
    const outletId = await freshOutlet();
    await fundWith(outletId, 100_000);
    const journals = await journalCount(world.entityId, PETTY_SOURCES);

    const over = await move(finance, movementBody(outletId, "return", 150_000));
    expect(over.status, JSON.stringify(over.body)).toBe(422);
    expect(over.body.error.code).toBe("PETTY_CASH_INSUFFICIENT");
    expect(await balanceOf(outletId)).toBe(100_000);
    expect(await entryRows(outletId)).toHaveLength(1);
    expect(await journalCount(world.entityId, PETTY_SOURCES)).toBe(journals);

    const oneOver = await move(
      finance,
      movementBody(outletId, "return", 100_001),
    );
    expect(oneOver.status).toBe(422);
    expect(oneOver.body.error.code).toBe("PETTY_CASH_INSUFFICIENT");

    // Boundary: exactly the balance is fine and leaves 0, and then 1 is too much.
    const exact = await move(
      finance,
      movementBody(outletId, "return", 100_000),
    );
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(exact.body.data.balanceAfterIdr).toBe(0);
    expect(await balanceOf(outletId)).toBe(0);
    const one = await move(finance, movementBody(outletId, "return", 1));
    expect(one.status).toBe(422);
    expect(one.body.error.code).toBe("PETTY_CASH_INSUFFICIENT");
    expect(await balanceOf(outletId)).toBe(0);
    await expectLedgerConsistent(outletId);
  });

  it("[legend-4961-PC-11] a petty purchase above the balance is refused: no purchase row, no outbox event, balance unchanged", async () => {
    const outletId = await freshOutlet();
    await fundWith(outletId, 100_000);
    const events = await recordedEventCount();

    const over = await buy(await purchaseBody(outletId, 150_000));
    expect(over.status, JSON.stringify(over.body)).toBe(422);
    expect(over.body.error.code).toBe("PETTY_CASH_INSUFFICIENT");
    expect(await pettyPurchaseCount(outletId)).toBe(0);
    expect(await recordedEventCount()).toBe(events);
    expect(await balanceOf(outletId)).toBe(100_000);
    expect(await entryRows(outletId)).toHaveLength(1);

    // Boundary: exactly the balance works and leaves 0; one more rupiah does not.
    const exact = await buy(await purchaseBody(outletId, 100_000));
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(await balanceOf(outletId)).toBe(0);
    const one = await buy(await purchaseBody(outletId, 1));
    expect(one.status).toBe(422);
    expect(one.body.error.code).toBe("PETTY_CASH_INSUFFICIENT");
    expect(await pettyPurchaseCount(outletId)).toBe(1);
    expect(await recordedEventCount()).toBe(events + 1);
    await expectLedgerConsistent(outletId);
  });

  it("[legend-4961-PC-12] two parallel purchases of 60.000 on a 100.000 fund: exactly one passes, balance 40.000", async () => {
    const outletId = await freshOutlet();
    await fundWith(outletId, 100_000);
    const events = await recordedEventCount();
    const bodies = [
      await purchaseBody(outletId, 60_000),
      await purchaseBody(outletId, 60_000),
    ];
    const results = await Promise.all(bodies.map((body) => buy(body)));
    expect(results.map((res) => res.status).sort()).toEqual([201, 422]);
    const refused = results.find((res) => res.status === 422)!;
    expect(refused.body.error.code).toBe("PETTY_CASH_INSUFFICIENT");
    expect(await balanceOf(outletId)).toBe(40_000);
    expect(await pettyPurchaseCount(outletId)).toBe(1);
    expect(await recordedEventCount()).toBe(events + 1);
    await expectLedgerConsistent(outletId);
  });

  it("[legend-4961-PC-13] parallel returns cannot overdraw either; mixed spends keep the fund at or above zero", async () => {
    const outletId = await freshOutlet();
    await fundWith(outletId, 100_000);
    const returns = await Promise.all([
      move(finance, movementBody(outletId, "return", 60_000)),
      move(finance, movementBody(outletId, "return", 60_000)),
    ]);
    expect(returns.map((res) => res.status).sort()).toEqual([201, 422]);
    expect(await balanceOf(outletId)).toBe(40_000);

    // 40.000 left: a return of 25.000 and a purchase of 25.000 race; one wins.
    const mixed = await Promise.all([
      move(finance, movementBody(outletId, "return", 25_000)),
      buy(await purchaseBody(outletId, 25_000)),
    ]);
    expect(mixed.map((res) => res.status).sort()).toEqual([201, 422]);
    expect(await balanceOf(outletId)).toBe(15_000);
    await expectLedgerConsistent(outletId);
  });

  it("[legend-4961-PC-14] the database refuses a negative balance even for a direct write", async () => {
    const outletId = await freshOutlet();
    await fundWith(outletId, 10_000);
    const fund = (await fundRow(outletId))!;
    await expect(
      owner.query(
        "UPDATE petty_cash_funds SET balance_idr = -1 WHERE id = $1",
        [fund.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // The runtime login may move the balance column, but not below zero.
    await expect(
      asRuntime((client) =>
        client.query(
          "UPDATE petty_cash_funds SET balance_idr = -5 WHERE tenant_id = $1 AND id = $2",
          [tenantId, fund.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await balanceOf(outletId)).toBe(10_000);
  });

  it("[legend-4961-PC-15] the ledger is append-only for the runtime login", async () => {
    const outletId = await freshOutlet();
    const entryId = await fundWith(outletId, 10_000);
    for (const sql of [
      "DELETE FROM petty_cash_entries WHERE tenant_id = $1 AND id = $2",
      "UPDATE petty_cash_entries SET amount_idr = 1 WHERE tenant_id = $1 AND id = $2",
      "UPDATE petty_cash_entries SET balance_after_idr = 99999 WHERE tenant_id = $1 AND id = $2",
    ])
      await expect(
        asRuntime((client) => client.query(sql, [tenantId, entryId])),
        sql,
      ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asRuntime((client) =>
        client.query("DELETE FROM petty_cash_funds WHERE tenant_id = $1", [
          tenantId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect((await entryById(entryId)).amount).toBe(10_000);
  });
});

describe("legend-4961 one document, one journal (money rule 4)", () => {
  it("[legend-4961-PC-20] a missing petty_cash mapping parks the topup (money still moves); retry posts exactly one journal, repeatable", async () => {
    const outletId = await freshOutlet();
    const mapping = await owner.query<{ account_id: string }>(
      "SELECT account_id FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'",
      [tenantId, world.entityId],
    );
    expect(mapping.rows).toHaveLength(1);
    const pettyAccount = mapping.rows[0]!.account_id;
    const removeMapping = () =>
      owner.query(
        "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'",
        [tenantId, world.entityId],
      );
    await removeMapping();
    let parkedId = "";
    const parkedBody = movementBody(outletId, "topup", 30_000);
    try {
      const res = await move(finance, parkedBody);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({
        kind: "topup",
        journalStatus: "parked",
        parkCode: "ACCOUNT_MAPPING_MISSING",
        balanceAfterIdr: 30_000,
      });
      expect(res.body.data.journalEntryId ?? null).toBeNull();
      parkedId = res.body.data.id as string;
    } finally {
      await owner.query(
        `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
         VALUES ($1, $2, 'petty_cash', $3)`,
        [tenantId, world.entityId, pettyAccount],
      );
    }
    // The cash is physically in the drawer, so the balance moved; no journal yet.
    expect(await balanceOf(outletId)).toBe(30_000);
    const row = await entryById(parkedId);
    expect(row).toMatchObject({
      journal_status: "parked",
      park_code: "ACCOUNT_MAPPING_MISSING",
      journal_entry_id: null,
    });
    expect(await journalsByKey(world.entityId, `pc:${parkedId}`)).toHaveLength(
      0,
    );
    await expectLedgerConsistent(outletId);

    const first = await retryPost(finance, parkedId);
    expect(ok(first.status), JSON.stringify(first.body)).toBe(true);
    expect(first.body.data).toMatchObject({
      id: parkedId,
      journalStatus: "posted",
    });
    const journalId = first.body.data.journalEntryId as string;
    expect(journalId).toEqual(expect.any(String));
    const journals = await journalsByKey(world.entityId, `pc:${parkedId}`);
    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatchObject({
      id: journalId,
      source_type: "petty_cash_topup",
    });
    const lines = await journalLinesOf(journalId);
    expect(lineOf(lines, world.gl.pettyCash)).toEqual({
      debit: 30_000,
      credit: 0,
    });
    expect(lineOf(lines, world.gl.bankA)).toEqual({ debit: 0, credit: 30_000 });

    // Retry again, twice in parallel: same journal, still one.
    const again = await Promise.all([
      retryPost(finance, parkedId),
      retryPost(finance, parkedId),
    ]);
    for (const res of again) {
      expect(ok(res.status), JSON.stringify(res.body)).toBe(true);
      expect(res.body.data.journalEntryId).toBe(journalId);
    }
    expect(await journalsByKey(world.entityId, `pc:${parkedId}`)).toHaveLength(
      1,
    );
    expect(await balanceOf(outletId)).toBe(30_000);

    // Replaying the original create now shows the current (posted) state.
    const replay = await move(finance, parkedBody);
    expect(ok(replay.status), JSON.stringify(replay.body)).toBe(true);
    expect(replay.body.data).toMatchObject({
      id: parkedId,
      journalStatus: "posted",
    });
    expect(await balanceOf(outletId)).toBe(30_000);
    // Park and retry are audited.
    expect((await auditActionsFor(parkedId)).length).toBeGreaterThanOrEqual(2);
    await expectLedgerConsistent(outletId);
  });

  it("[legend-4961-PC-21] retry of an unknown entry is 404; a posted entry is returned as it is", async () => {
    const outletId = await freshOutlet();
    const entryId = await fundWith(outletId, 20_000);
    const unknown = await retryPost(finance, randomUUID());
    expect(unknown.status).toBe(404);
    const journals = await journalCount(world.entityId, PETTY_SOURCES);
    const posted = await retryPost(finance, entryId);
    expect(ok(posted.status), JSON.stringify(posted.body)).toBe(true);
    expect(posted.body.data).toMatchObject({
      id: entryId,
      journalStatus: "posted",
    });
    expect(await journalCount(world.entityId, PETTY_SOURCES)).toBe(journals);
    await expectLedgerConsistent(outletId);
  });

  it("[legend-4961-PC-24] a topup parked, then its period closed, still posts on retry: one journal in the first open period, flagged with the real date", async () => {
    // Own legal entity: closing a month must not disturb the shared `world`.
    const w = await makeWorld();
    const outletId = await makeOutlet(w.entityId);
    const removeMapping = () =>
      owner.query(
        "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'",
        [tenantId, w.entityId],
      );
    await removeMapping();
    const parked = await move(
      finance,
      movementBody(outletId, "topup", 45_000, {
        bankAccountId: w.bankAccountA,
      }),
    );
    expect(parked.status, JSON.stringify(parked.body)).toBe(201);
    expect(parked.body.data).toMatchObject({
      journalStatus: "parked",
      parkCode: "ACCOUNT_MAPPING_MISSING",
    });
    const entryId = parked.body.data.id as string;

    // The month of the entry's own business date is closed after parking.
    const { rows: dates } = await owner.query<{ entry_date: string }>(
      "SELECT entry_date::text AS entry_date FROM petty_cash_entries WHERE tenant_id = $1 AND id = $2",
      [tenantId, entryId],
    );
    const entryDate = dates[0]!.entry_date;
    await owner.query(
      `UPDATE fiscal_periods SET status = 'closed', closed_by = $3, closed_at = now(), version = version + 1
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $4`,
      [tenantId, w.entityId, randomUUID(), entryDate.slice(0, 7)],
    );
    // The accountant fixes the chart: the petty_cash mapping is back.
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'petty_cash', $3)`,
      [tenantId, w.entityId, w.gl.pettyCash],
    );

    const retry = await retryPost(finance, entryId);
    expect(ok(retry.status), JSON.stringify(retry.body)).toBe(true);
    expect(retry.body.data).toMatchObject({
      id: entryId,
      journalStatus: "posted",
    });
    const journals = await journalsByKey(w.entityId, `pc:${entryId}`);
    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatchObject({
      id: retry.body.data.journalEntryId,
      source_type: "petty_cash_topup",
    });

    // Dated in an open period, with the original date kept as the late flag.
    const { rows: journal } = await owner.query<{
      entry_date: string;
      late_adjustment_from: string | null;
      period_status: string | null;
    }>(
      `SELECT j.entry_date::text AS entry_date,
              j.late_adjustment_from::text AS late_adjustment_from,
              (SELECT p.status FROM fiscal_periods p
                WHERE p.tenant_id = j.tenant_id AND p.legal_entity_id = j.legal_entity_id
                  AND p.period = to_char(j.entry_date, 'YYYY-MM')) AS period_status
         FROM journal_entries j WHERE j.tenant_id = $1 AND j.id = $2`,
      [tenantId, journals[0]!.id],
    );
    expect(journal[0]!.entry_date > entryDate).toBe(true);
    expect(journal[0]!.entry_date.slice(0, 7)).not.toBe(entryDate.slice(0, 7));
    expect(journal[0]!.period_status).toBe("open");
    expect(journal[0]!.late_adjustment_from).toBe(entryDate);
    const lines = await journalLinesOf(journals[0]!.id);
    expect(lineOf(lines, w.gl.pettyCash)).toEqual({ debit: 45_000, credit: 0 });
    expect(lineOf(lines, w.gl.bankA)).toEqual({ debit: 0, credit: 45_000 });

    // A second retry stays at one journal.
    expect(ok((await retryPost(finance, entryId)).status)).toBe(true);
    expect(await journalsByKey(w.entityId, `pc:${entryId}`)).toHaveLength(1);
    // The cash is in the drawer once.
    const { rows: fund } = await owner.query<{ balance: string }>(
      "SELECT balance_idr::text AS balance FROM petty_cash_funds WHERE tenant_id = $1 AND outlet_id = $2",
      [tenantId, outletId],
    );
    expect(Number(fund[0]!.balance)).toBe(45_000);
  });

  it("[legend-4961-PC-22] a petty purchase draws the fund once, keeps no journal of its own, and its auto journal is single", async () => {
    const outletId = await freshOutlet();
    await fundWith(outletId, 100_000);
    const body = await purchaseBody(outletId, 40_000);
    const res = await buy(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const purchaseId = res.body.data.id as string;
    expect(await balanceOf(outletId)).toBe(60_000);

    // Replaying the same purchase does not draw again.
    const replay = await buy(body);
    expect(ok(replay.status), JSON.stringify(replay.body)).toBe(true);
    expect(replay.body.data.id).toBe(purchaseId);
    expect(await balanceOf(outletId)).toBe(60_000);
    expect(await pettyPurchaseCount(outletId)).toBe(1);

    const entries = await entryRows(outletId);
    const purchaseEntries = entries.filter((row) => row.kind === "purchase");
    expect(purchaseEntries).toHaveLength(1);
    expect(purchaseEntries[0]).toMatchObject({
      amount: 40_000,
      balance_after: 60_000,
      petty_purchase_id: purchaseId,
      bank_account_id: null,
      journal_status: "external",
      journal_entry_id: null,
      idempotency_key: `pp:${purchaseId}`,
    });

    // The journal stays the auto-journal's: exactly one, Dr expense / Cr petty cash.
    const event = await outboxEvent(purchaseId);
    const first = await deliver(event);
    expect(first.status).toBe("posted");
    const journals = await journalsByKey(
      world.entityId,
      `aj:petty-purchase:${purchaseId}`,
    );
    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatchObject({ source_type: "petty_purchase" });
    const lines = await journalLinesOf(journals[0]!.id);
    expect(lineOf(lines, world.gl.pettyExpense)).toEqual({
      debit: 40_000,
      credit: 0,
    });
    expect(lineOf(lines, world.gl.pettyCash)).toEqual({
      debit: 0,
      credit: 40_000,
    });
    const redelivered = await deliver(event);
    expect(redelivered.status).toBe("already_posted");
    expect(
      await journalsByKey(world.entityId, `aj:petty-purchase:${purchaseId}`),
    ).toHaveLength(1);
    // Delivering the event did not touch the fund or add a petty-cash movement.
    expect(await balanceOf(outletId)).toBe(60_000);
    expect(await entryRows(outletId)).toHaveLength(entries.length);
    await expectLedgerConsistent(outletId);
  });

  it("[legend-4961-PC-23] an outlet without a fund keeps the old behavior: the purchase is recorded and no fund appears", async () => {
    // Assumption (see header): until the founder decides a fund is mandatory,
    // the balance rule applies only to outlets that have a fund.
    const outletId = await freshOutlet();
    const res = await buy(await purchaseBody(outletId, 25_000));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await fundRow(outletId)).toBeNull();
    expect(await entryRows(outletId)).toHaveLength(0);
    expect(await pettyPurchaseCount(outletId)).toBe(1);
  });
});

describe("legend-4961 access and isolation (money rule 3)", () => {
  it("[legend-4961-PC-30] anonymous gets 401; users without the permission get 403 on every route; nothing changes", async () => {
    const outletId = await freshOutlet();
    const entryId = await fundWith(outletId, 40_000);
    const anonymous = agent(app);
    expect(
      (
        await anonymous
          .post(MOVEMENTS)
          .set(originHeader)
          .send(movementBody(outletId, "topup", 1_000))
      ).status,
    ).toBe(401);
    expect(
      (await anonymous.get(PETTY_ENTRIES).query({ outletId })).status,
    ).toBe(401);

    // `recorder` is an outlet manager: it records purchases but does not run
    // the fund. `nobody` has no role at all.
    for (const who of [nobody, recorder]) {
      expect(
        (await move(who, movementBody(outletId, "topup", 1_000))).status,
      ).toBe(403);
      expect(
        (await move(who, movementBody(outletId, "return", 1_000))).status,
      ).toBe(403);
      expect((await retryPost(who, entryId)).status).toBe(403);
      expect(
        (
          await listEntries(who, {
            outletId,
            from: daysAgo(30),
            to: daysAgo(-2),
          })
        ).status,
      ).toBe(403);
      expect(
        (await listFunds(who, { legalEntityId: world.entityId, outletId }))
          .status,
      ).toBe(403);
    }
    expect(await balanceOf(outletId)).toBe(40_000);
    expect(await entryRows(outletId)).toHaveLength(1);
  });

  it("[legend-4961-PC-31] a movement from an untrusted origin is refused", async () => {
    const outletId = await freshOutlet();
    const res = await finance.client
      .post(MOVEMENTS)
      .set("Origin", "https://evil.example")
      .send(movementBody(outletId, "topup", 5_000) as object);
    expect(res.status).toBe(403);
    expect(await fundRow(outletId)).toBeNull();
    // Control: the same body from the trusted origin works.
    expect(
      (await move(finance, movementBody(outletId, "topup", 5_000))).status,
    ).toBe(201);
  });

  it("[legend-4961-PC-32] a finance user scoped to one outlet cannot move fund money; reads of other outlets are empty or refused", async () => {
    const otherOutlet = await freshOutlet();
    const entryId = await fundWith(otherOutlet, 30_000);

    for (const outletId of [scopedOutlet, otherOutlet]) {
      for (const kind of ["topup", "return"] as const) {
        const res = await move(
          scopedFinance,
          movementBody(outletId, kind, 1_000),
        );
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.error.code).toBe("OUTLET_OUT_OF_SCOPE");
      }
    }
    expect(await fundRow(scopedOutlet)).toBeNull();
    expect(await balanceOf(otherOutlet)).toBe(30_000);

    // Retry on another outlet's entry: hidden (404) or refused (403).
    const retry = await retryPost(scopedFinance, entryId);
    expect([403, 404]).toContain(retry.status);

    // Reading another outlet's ledger: nothing leaks.
    const read = await listEntries(scopedFinance, {
      outletId: otherOutlet,
      from: daysAgo(30),
      to: daysAgo(-2),
    });
    if (read.status === 200) expect(read.body.data).toEqual([]);
    else expect([403, 404]).toContain(read.status);

    // Control: the tenant-wide finance user reads and retries it.
    const mine = await listEntries(finance, {
      outletId: otherOutlet,
      from: daysAgo(30),
      to: daysAgo(-2),
    });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.data.map((row: { id: string }) => row.id)).toContain(
      entryId,
    );
    expect(ok((await retryPost(finance, entryId)).status)).toBe(true);
  });
});

describe("legend-4961 reading funds and entries (empty and filled states)", () => {
  it("[legend-4961-PC-40] funds: an outlet without a fund shows none; after topups it shows the balance", async () => {
    const outletId = await freshOutlet();
    const empty = await listFunds(finance, {
      legalEntityId: world.entityId,
      outletId,
    });
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    // No fund yet: no row, or a row at zero (never invented money).
    for (const row of empty.body.data as { balanceIdr: number }[])
      expect(row.balanceIdr).toBe(0);

    await fundWith(outletId, 80_000);
    await move(finance, movementBody(outletId, "return", 30_000));
    const filled = await listFunds(finance, {
      legalEntityId: world.entityId,
      outletId,
    });
    expect(filled.status).toBe(200);
    expect(filled.body.data).toHaveLength(1);
    expect(filled.body.data[0]).toMatchObject({ outletId, balanceIdr: 50_000 });

    const wide = await listFunds(finance, { legalEntityId: world.entityId });
    expect(wide.status).toBe(200);
    expect(
      wide.body.data.find(
        (row: { outletId: string }) => row.outletId === outletId,
      ),
    ).toMatchObject({ balanceIdr: 50_000 });
  });

  it("[legend-4961-PC-41] entries: newest first with all three kinds, a cursor page, and an empty window", async () => {
    const outletId = await freshOutlet();
    const topupId = await fundWith(outletId, 100_000);
    const returnRes = await move(
      finance,
      movementBody(outletId, "return", 20_000),
    );
    expect(returnRes.status).toBe(201);
    const purchase = await buy(await purchaseBody(outletId, 10_000));
    expect(purchase.status, JSON.stringify(purchase.body)).toBe(201);

    const query = { outletId, from: daysAgo(30), to: daysAgo(-2), limit: 100 };
    const all = await listEntries(finance, query);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const rows = all.body.data as {
      id: string;
      kind: string;
      balanceAfterIdr: number;
    }[];
    expect(rows.map((row) => row.kind)).toEqual([
      "purchase",
      "return",
      "topup",
    ]);
    expect(rows.map((row) => row.balanceAfterIdr)).toEqual([
      70_000, 80_000, 100_000,
    ]);
    expect(rows[2]!.id).toBe(topupId);

    const first = await listEntries(finance, { ...query, limit: 2 });
    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.nextCursor).toEqual(expect.any(String));
    const second = await listEntries(finance, {
      ...query,
      limit: 2,
      cursor: first.body.meta.nextCursor,
    });
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).toBe(topupId);
    expect(second.body.meta.nextCursor).toBeNull();

    const empty = await listEntries(finance, {
      outletId,
      from: "2001-01-01",
      to: "2001-01-31",
    });
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body.data).toEqual([]);
    expect(empty.body.meta.nextCursor).toBeNull();
    await expectLedgerConsistent(outletId);
  });
});
