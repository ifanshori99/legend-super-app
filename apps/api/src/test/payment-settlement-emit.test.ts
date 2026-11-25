// `settlement.reconciled` emitter (1269 C4a, legend-osqou.7, legend-3a5m).
// POST /api/payments/admin/reconciliation/settlements/reconcile ties imported
// gateway settlements to the bank statement line that paid them. The event is
// what books the bank money, so: exact net, one line once, one event per
// outlet, and nothing at all when anything is in doubt.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { settlementReconciledPayloadSchema } from "@starter/shared/payment";
import { createApp } from "../app";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import {
  autoMatchBankAccount,
  entityLock,
} from "../services/accounting-bank-matching.ts";
import { loadBankAccount } from "../services/accounting-cash-bank-shared.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const IMPORT = "/api/payments/admin/reconciliation/settlements";
const RECONCILE = `${IMPORT}/reconcile`;
const PAID_ON = "2026-11-06";
const SOLD_ON = "2026-11-05";
const uid = () => randomBytes(4).toString("hex");

const userIds: string[] = [];
const intentIds: string[] = [];
let finance: ReturnType<typeof agent>;
let cashier: ReturnType<typeof agent>;
let outletOwner: ReturnType<typeof agent>;

type World = {
  entity: string;
  bankGl: string;
  clearingGl: string;
  feeGl: string;
  bankAccount: string;
  importId: string;
  outlets: [string, string];
};
let world: World;

const scoped = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantId),
    brandId: null,
    source: "domain",
  }),
  { kind: "tenant" },
);

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
  tenant: string = tenantId,
) {
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
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function signedIn(
  template: string,
  scopeType: "tenant" | "outlet",
  scopeId: string | null = null,
) {
  const client = agent(app);
  const email = await signUp(client, `Settlement emit ${template}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  await verifySessionMfa(email);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     SELECT $1, $2, id, $4, $5, now() - interval '1 minute', $2
       FROM roles WHERE tenant_id = $1 AND template_key = $3`,
    [tenantId, userId, template, scopeType, scopeId],
  );
  return client;
}

async function makeWorld(tenant: string = tenantId): Promise<World> {
  const w: World = {
    entity: randomUUID(),
    bankGl: randomUUID(),
    clearingGl: randomUUID(),
    feeGl: randomUUID(),
    bankAccount: randomUUID(),
    importId: randomUUID(),
    outlets: [randomUUID(), randomUUID()],
  };
  await asTenant(async (c) => {
    await c.query(
      "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
      [w.entity, tenant, `Entity emit ${uid()}`],
    );
    for (const id of w.outlets)
      await c.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
         SELECT $1, $2, id, $3, $4, 'Outlet emit', 'Jl. Emit', 'Asia/Jakarta', '04:00', '{}', 'active'
           FROM brands WHERE tenant_id = $2 LIMIT 1`,
        [id, tenant, w.entity, `EM-${uid()}`.toUpperCase()],
      );
    await c.query(
      `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, '1103', 'Bank', 'asset', 'cash_and_equivalents'),
              ($4, $2, $3, '1201', 'Kliring gateway', 'asset', 'current_asset'),
              ($5, $2, $3, '6109', 'Biaya gateway', 'expense', 'operating_expense')`,
      [w.bankGl, tenant, w.entity, w.clearingGl, w.feeGl],
    );
    await c.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'bank', $3), ($1, $2, 'gateway_clearing', $4), ($1, $2, 'gateway_fee_expense', $5)`,
      [tenant, w.entity, w.bankGl, w.clearingGl, w.feeGl],
    );
    await c.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, '2026-10'), ($1, $2, '2026-11')`,
      [tenant, w.entity],
    );
    await c.query(
      `INSERT INTO bank_accounts
         (id, tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
          account_number_hmac, account_number_last4, account_number_key_version, gl_account_id, created_by)
       VALUES ($1, $2, $3, 'BCA', 'Rekening utama', $4, $5, '1234', 1, $6, 'seed')`,
      [
        w.bankAccount,
        tenant,
        w.entity,
        randomBytes(32),
        randomBytes(32).toString("hex"),
        w.bankGl,
      ],
    );
    await c.query(
      `INSERT INTO bank_statement_imports
         (id, tenant_id, bank_account_id, file_name, file_sha256, imported_by, line_count, duplicate_count, auto_matched_count)
       VALUES ($1, $2, $3, 'seed.csv', $4, 'seed', 0, 0, 0)`,
      [w.importId, tenant, w.bankAccount, randomBytes(32).toString("hex")],
    );
  }, tenant);
  return w;
}

async function seedIntent(outlet: string, ref: string, amountIdr: number) {
  const linkId = randomUUID();
  const id = randomUUID();
  await asTenant(async (c) => {
    await c.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
      [
        linkId,
        tenantId,
        outlet,
        randomBytes(32).toString("hex"),
        `EMIT-${linkId.slice(0, 8)}`,
        amountIdr,
      ],
    );
    await c.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, provider_ref, amount_idr,
          idempotency_key, status, paid_at, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, $7, 'paid', $8::timestamptz,
               '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
      [
        id,
        tenantId,
        outlet,
        linkId,
        ref,
        amountIdr,
        `emit-${id}`,
        `${SOLD_ON} 12:00:00+07`,
      ],
    );
  });
  intentIds.push(id);
}

/** An imported gateway report of one sale: gross 100.000, fee 700 by default. */
async function seedSettlement(
  o: {
    outlet?: string;
    posIdr?: number | null;
    amountIdr?: number;
    feeIdr?: number;
  } = {},
): Promise<string> {
  const outlet = o.outlet ?? world.outlets[0];
  const amountIdr = o.amountIdr ?? 100_000;
  const feeIdr = o.feeIdr ?? 700;
  const ref = `PR-${uid()}`;
  if (o.posIdr !== null) await seedIntent(outlet, ref, o.posIdr ?? amountIdr);
  const res = await finance
    .post(IMPORT)
    .set(originHeader)
    .set("Idempotency-Key", `imp-${randomUUID()}`)
    .send({
      outletId: outlet,
      source: "gateway",
      provider: "doit",
      reference: `EMIT-${uid()}`,
      periodStart: SOLD_ON,
      periodEnd: SOLD_ON,
      grossIdr: amountIdr,
      feeIdr,
      netIdr: amountIdr - feeIdr,
      lines: [{ reference: ref, amountIdr, feeIdr }],
    });
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  return res.body.data.id as string;
}

async function seedBankLine(
  amountIdr: number,
  o: {
    postedOn?: string;
    status?: string;
    account?: World;
    tenant?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const w = o.account ?? world;
  await owner.query(
    `INSERT INTO bank_statement_lines
       (id, tenant_id, bank_account_id, import_id, posted_on, amount_idr, description, dedupe_key, match_status, excluded_reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'Settlement gateway', $7, $8, $9)`,
    [
      id,
      o.tenant ?? tenantId,
      w.bankAccount,
      w.importId,
      o.postedOn ?? PAID_ON,
      amountIdr,
      `k-${id}`,
      o.status ?? "unmatched",
      o.status === "excluded" ? "seed" : null,
    ],
  );
  return id;
}

const reconcile = (
  bankStatementLineId: string,
  settlementIds: string[],
  o: { client?: ReturnType<typeof agent>; key?: string } = {},
) =>
  (o.client ?? finance)
    .post(RECONCILE)
    .set(originHeader)
    .set("Idempotency-Key", o.key ?? `rec-${randomUUID()}`)
    .send({ bankStatementLineId, settlementIds });

async function emitted(settlementId: string) {
  const { rows } = await asTenant((c) =>
    c.query(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'settlement.reconciled'`,
      [tenantId, settlementId],
    ),
  );
  return rows.map((r) => r.event) as {
    outletId: string;
    idempotencyKey: string;
    payload: unknown;
  }[];
}

/** Delivers the real outbox row to the auto-journal consumer. */
async function post(settlementId: string) {
  const [event] = await emitted(settlementId);
  return withTenant(db, scoped, (tx) =>
    deliverAutoJournalEvent(scoped, eventEnvelopeSchema.parse(event), tx),
  );
}

/** A journal on the entity's bank account that finance posted by hand. */
async function seedManualJournal(amountIdr: number, date: string) {
  return asTenant(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type, source_id, description, idempotency_key, request_fingerprint)
       SELECT $1, $2, $3, id, 'manual', NULL, 'Manual', $4, $5 FROM fiscal_periods
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-11' RETURNING id`,
      [
        tenantId,
        world.entity,
        date,
        `man-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const id = rows[0].id as string;
    await c.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
      [tenantId, id, world.bankGl, world.clearingGl, amountIdr],
    );
    return id;
  });
}

const autoMatch = () =>
  withTenant(db, scoped, async (tx) => {
    const account = await loadBankAccount(
      tx,
      scoped.tenant.tenantId,
      world.bankAccount,
    );
    await entityLock(tx, tenantId, world.entity);
    return autoMatchBankAccount(
      tx,
      scoped,
      account,
      { dateToleranceDays: 2 },
      "seed",
    );
  });

const lineCommand = (line: string, command: string, body: object) =>
  finance
    .post(`/api/accounting/statement-lines/${line}/${command}`)
    .set(originHeader)
    .send(body);

async function lineStatus(id: string) {
  const { rows } = await owner.query(
    "SELECT match_status FROM bank_statement_lines WHERE id = $1",
    [id],
  );
  return rows[0].match_status as string;
}

async function expectRefused(
  res: { status: number; body: { error?: { code?: string } } },
  status: number,
  settlements: string[],
) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  for (const id of settlements) expect(await emitted(id)).toEqual([]);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn("owner", "tenant");
  cashier = await signedIn("cashier", "tenant");
});
// Every case has its own entity, so "missing" scans never overlap.
beforeEach(async () => {
  world = await makeWorld();
});
afterAll(async () => {
  await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
    userIds,
  ]);
  await owner.end();
});

describe("settlement.reconciled emitter (1269 C4a)", () => {
  it("emits one event with the money of the report, dated on the bank line", async () => {
    const id = await seedSettlement();
    const line = await seedBankLine(99_300);
    const res = await reconcile(line, [id]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const events = await emitted(id);
    expect(events).toHaveLength(1);
    expect(events[0]!.outletId).toBe(world.outlets[0]);
    expect(settlementReconciledPayloadSchema.parse(events[0]!.payload)).toEqual(
      {
        settlementId: id,
        provider: "doit",
        outletId: world.outlets[0],
        settledOn: PAID_ON,
        grossIdr: 100_000,
        feeIdr: 700,
        netSettledIdr: 99_300,
      },
    );
    expect(await lineStatus(line)).toBe("manually_matched");
  });

  it("one payout of two outlets emits once per outlet and never adds up to more than the bank line", async () => {
    const a = await seedSettlement();
    const b = await seedSettlement({
      outlet: world.outlets[1],
      amountIdr: 50_000,
      feeIdr: 350,
    });
    const line = await seedBankLine(148_950);
    expect((await reconcile(line, [a, b])).status).toBe(200);
    const events = [...(await emitted(a)), ...(await emitted(b))];
    expect(events.map((e) => e.outletId).sort()).toEqual(
      [...world.outlets].sort(),
    );
    const net = events.reduce(
      (sum, e) =>
        sum + settlementReconciledPayloadSchema.parse(e.payload).netSettledIdr,
      0,
    );
    expect(net).toBe(148_950);
  });

  it("the same idempotency key replays; nothing is emitted twice", async () => {
    const id = await seedSettlement();
    const line = await seedBankLine(99_300);
    const key = `rec-${randomUUID()}`;
    const first = await reconcile(line, [id], { key });
    const second = await reconcile(line, [id], { key });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await emitted(id)).toHaveLength(1);
  });

  it("a settlement is emitted once: another bank line of the same amount is refused", async () => {
    const id = await seedSettlement();
    const line = await seedBankLine(99_300);
    const other = await seedBankLine(99_300);
    expect((await reconcile(line, [id])).status).toBe(200);
    expect((await reconcile(other, [id])).status).toBe(409);
    expect(await emitted(id)).toHaveLength(1);
    expect(await lineStatus(other)).toBe("unmatched");
  });

  it("a bank line pays once: a second settlement of the same amount is refused", async () => {
    const a = await seedSettlement();
    const b = await seedSettlement({ outlet: world.outlets[1] });
    const line = await seedBankLine(99_300);
    expect((await reconcile(line, [a])).status).toBe(200);
    await expectRefused(await reconcile(line, [b]), 409, [b]);
  });

  it("after an unmatch neither the line nor the settlement can emit again", async () => {
    const a = await seedSettlement();
    const b = await seedSettlement({ outlet: world.outlets[1] });
    const line = await seedBankLine(99_300);
    const other = await seedBankLine(99_300);
    expect((await reconcile(line, [a])).status).toBe(200);
    const undo = await finance
      .post(`/api/accounting/statement-lines/${line}/unmatch`)
      .set(originHeader)
      .send({ idempotencyKey: `un-${randomUUID()}` });
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(await lineStatus(line)).toBe("unmatched");
    await expectRefused(await reconcile(line, [b]), 409, [b]);
    expect((await reconcile(line, [a])).status).toBe(409);
    expect((await reconcile(other, [a])).status).toBe(409);
    expect(await emitted(a)).toHaveLength(1);
  });

  it("two concurrent requests for one bank line emit once", async () => {
    const a = await seedSettlement();
    const b = await seedSettlement({ outlet: world.outlets[1] });
    const line = await seedBankLine(99_300);
    const results = await Promise.all([
      reconcile(line, [a]),
      reconcile(line, [b]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await emitted(a)).length + (await emitted(b)).length).toBe(1);
  });

  for (const [name, amount] of [
    ["one rupiah less", 99_299],
    ["one rupiah more", 99_301],
    ["the gross", 100_000],
    ["money out", -99_300],
  ] as const)
    it(`refuses a bank line that is ${name}`, async () => {
      const id = await seedSettlement();
      const line = await seedBankLine(amount);
      await expectRefused(await reconcile(line, [id]), 409, [id]);
      expect(await lineStatus(line)).toBe("unmatched");
    });

  it("refuses two reports of one outlet on one bank line", async () => {
    const a = await seedSettlement();
    const b = await seedSettlement();
    const line = await seedBankLine(198_600);
    await expectRefused(await reconcile(line, [a, b]), 409, [a, b]);
  });

  it("refuses a report whose line differs from POS", async () => {
    const id = await seedSettlement({ posIdr: 90_000 });
    const line = await seedBankLine(99_300);
    await expectRefused(await reconcile(line, [id]), 409, [id]);
  });

  it("refuses a report with a line POS does not know", async () => {
    const id = await seedSettlement({ posIdr: null });
    const line = await seedBankLine(99_300);
    await expectRefused(await reconcile(line, [id]), 409, [id]);
  });

  it("refuses a report that still has an open missing case", async () => {
    await seedIntent(world.outlets[0], `PR-${uid()}`, 25_000);
    const id = await seedSettlement();
    const line = await seedBankLine(99_300);
    await expectRefused(await reconcile(line, [id]), 409, [id]);
  });

  it("refuses late funds of a written-off sale", async () => {
    const ref = `PR-${uid()}`;
    await seedIntent(world.outlets[0], ref, 25_000);
    const first = await seedSettlement();
    await asTenant((c) =>
      c.query(
        `UPDATE payment_reconciliation_cases SET status = 'resolved', resolved_by = 'seed', resolved_at = now(), note = 'written off'
          WHERE tenant_id = $1 AND settlement_id = $2`,
        [tenantId, first],
      ),
    );
    const res = await finance
      .post(IMPORT)
      .set(originHeader)
      .set("Idempotency-Key", `imp-${randomUUID()}`)
      .send({
        outletId: world.outlets[0],
        source: "gateway",
        provider: "doit",
        reference: `EMIT-${uid()}`,
        periodStart: SOLD_ON,
        periodEnd: SOLD_ON,
        grossIdr: 25_000,
        feeIdr: 0,
        netIdr: 25_000,
        lines: [{ reference: ref, amountIdr: 25_000, feeIdr: 0 }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const late = res.body.data.id as string;
    const line = await seedBankLine(25_000);
    await expectRefused(await reconcile(line, [late]), 409, [late]);
  });

  it("refuses a bank line dated before the end of the report", async () => {
    const id = await seedSettlement();
    const line = await seedBankLine(99_300, { postedOn: "2026-11-04" });
    await expectRefused(await reconcile(line, [id]), 409, [id]);
  });

  it("refuses a bank line that is not free", async () => {
    const id = await seedSettlement();
    const line = await seedBankLine(99_300, { status: "excluded" });
    await expectRefused(await reconcile(line, [id]), 409, [id]);
  });

  it("refuses a bank account of another legal entity", async () => {
    const id = await seedSettlement();
    const line = await seedBankLine(99_300, { account: await makeWorld() });
    await expectRefused(await reconcile(line, [id]), 409, [id]);
  });

  it("refuses a bank account that is not the entity's mapped bank account", async () => {
    const id = await seedSettlement();
    const line = await seedBankLine(99_300);
    await asTenant((c) =>
      c.query(
        "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2",
        [tenantId, world.entity],
      ),
    );
    await expectRefused(await reconcile(line, [id]), 409, [id]);
  });

  it("refuses an inactive bank account", async () => {
    const id = await seedSettlement();
    const line = await seedBankLine(99_300);
    await owner.query(
      "UPDATE bank_accounts SET is_active = false WHERE id = $1",
      [world.bankAccount],
    );
    await expectRefused(await reconcile(line, [id]), 409, [id]);
  });

  it("refuses a settlement an open bank case is still discussing", async () => {
    const id = await seedSettlement();
    const line = await seedBankLine(99_300);
    await asTenant((c) =>
      c.query(
        `INSERT INTO bank_reconciliation_cases
           (tenant_id, legal_entity_id, type, difference_idr, owner_id, due_at, refs, opened_by)
         VALUES ($1, $2, 'gateway_settlement', 100, 'seed', now(), $3::jsonb, 'seed')`,
        [
          tenantId,
          world.entity,
          JSON.stringify([{ type: "gateway_settlement", id }]),
        ],
      ),
    );
    await expectRefused(await reconcile(line, [id]), 409, [id]);
  });

  it("refuses a settlement a bank case wrote off", async () => {
    const id = await seedSettlement();
    const line = await seedBankLine(99_300);
    const journal = await seedManualJournal(1, "2026-11-20");
    await asTenant((c) =>
      c.query(
        `INSERT INTO bank_reconciliation_cases
           (tenant_id, legal_entity_id, type, difference_idr, owner_id, due_at, refs, opened_by,
            status, resolved_by, resolved_at, resolution_note, adjustment_journal_entry_id)
         VALUES ($1, $2, 'gateway_settlement', 100, 'seed', now(), $3::jsonb, 'seed',
                 'written_off', 'seed', now(), 'hapus', $4)`,
        [
          tenantId,
          world.entity,
          JSON.stringify([{ type: "gateway_settlement", id }]),
          journal,
        ],
      ),
    );
    await expectRefused(await reconcile(line, [id]), 409, [id]);
  });

  for (const [name, amount, date, postedOn] of [
    ["the bank line", 148_950, PAID_ON, PAID_ON],
    ["one of the nets", 99_300, PAID_ON, PAID_ON],
    [
      "the bank line, dated on the edge of the tolerance",
      148_950,
      "2026-11-08",
      PAID_ON,
    ],
    ["the bank line, dated on the sales day", 148_950, SOLD_ON, "2026-11-12"],
  ] as const)
    it(`refuses when a free journal already books ${name}`, async () => {
      const a = await seedSettlement();
      const b = await seedSettlement({
        outlet: world.outlets[1],
        amountIdr: 50_000,
        feeIdr: 350,
      });
      const line = await seedBankLine(148_950, { postedOn });
      await seedManualJournal(amount, date);
      await expectRefused(await reconcile(line, [a, b]), 409, [a, b]);
      expect(await lineStatus(line)).toBe("unmatched");
    });

  it("refuses when the bank line may be a recorded cash deposit", async () => {
    const id = await seedSettlement();
    const line = await seedBankLine(99_300);
    await asTenant((c) =>
      c.query(
        `INSERT INTO cash_deposits
           (tenant_id, legal_entity_id, outlet_id, bank_account_id, amount_idr, covers_from, covers_to, deposited_at, deposited_by)
         VALUES ($1, $2, $3, $4, 99300, $5, $5, '2026-11-06T03:00:00Z', 'seed')`,
        [tenantId, world.entity, world.outlets[0], world.bankAccount, SOLD_ON],
      ),
    );
    await expectRefused(await reconcile(line, [id]), 409, [id]);
  });

  it("a journal already matched to its own bank line does not block", async () => {
    const id = await seedSettlement();
    const line = await seedBankLine(99_300);
    const journal = await seedManualJournal(99_300, PAID_ON);
    const other = await seedBankLine(99_300);
    const matched = await lineCommand(other, "match", {
      refs: [{ type: "journal_entry", id: journal }],
    });
    expect(matched.status, JSON.stringify(matched.body)).toBe(200);
    expect((await reconcile(line, [id])).status).toBe(200);
  });

  it("the outbox events book the bank line exactly: balanced, clearing = gross, replay posts once", async () => {
    const a = await seedSettlement();
    const b = await seedSettlement({
      outlet: world.outlets[1],
      amountIdr: 50_000,
      feeIdr: 350,
    });
    const line = await seedBankLine(148_950);
    expect((await reconcile(line, [a, b])).status).toBe(200);
    for (const id of [a, b]) {
      expect(await post(id)).toMatchObject({ status: "posted" });
      expect(await post(id)).toMatchObject({ status: "already_posted" });
    }
    const { rows: entries } = await owner.query(
      `SELECT source_id, outlet_id, entry_date::text AS entry_date FROM journal_entries
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_type = 'gateway_settlement'`,
      [tenantId, world.entity],
    );
    expect(entries.map((e) => [e.source_id, e.outlet_id]).sort()).toEqual(
      [
        [a, world.outlets[0]],
        [b, world.outlets[1]],
      ].sort(),
    );
    expect(entries.map((e) => e.entry_date)).toEqual([PAID_ON, PAID_ON]);
    const { rows: totals } = await owner.query(
      `SELECT l.entry_id, sum(l.debit_idr)::int AS debit, sum(l.credit_idr)::int AS credit,
              (sum(l.debit_idr) FILTER (WHERE l.account_id = $3))::int AS bank,
              (sum(l.credit_idr) FILTER (WHERE l.account_id = $4))::int AS clearing,
              (sum(l.debit_idr) FILTER (WHERE l.account_id = $5))::int AS fee
         FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
        WHERE e.tenant_id = $1 AND e.legal_entity_id = $2 GROUP BY l.entry_id`,
      [tenantId, world.entity, world.bankGl, world.clearingGl, world.feeGl],
    );
    for (const t of totals) expect(t.debit).toBe(t.credit);
    const sum = (key: string) => totals.reduce((n, t) => n + t[key], 0);
    expect(sum("bank")).toBe(148_950);
    expect(sum("clearing")).toBe(150_000);
    expect(sum("fee")).toBe(1_050);
  });

  async function postedOnLine() {
    const id = await seedSettlement();
    const line = await seedBankLine(99_300);
    expect((await reconcile(line, [id])).status).toBe(200);
    const posted = await post(id);
    if (posted.status !== "posted") throw new Error("not posted");
    return { line, journal: posted.journalEntryId };
  }

  it("the settlement's journal never auto-matches another bank line; after an unmatch it is free again", async () => {
    const { line } = await postedOnLine();
    const other = await seedBankLine(99_300);
    expect((await autoMatch()).matched).toBe(0);
    expect(await lineStatus(other)).toBe("unmatched");
    const undo = await lineCommand(line, "unmatch", {
      idempotencyKey: `un-${randomUUID()}`,
    });
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    // Two lines want it now: exclude one, the other is the only candidate.
    await lineCommand(line, "exclude", { reason: "salah cocok" });
    expect((await autoMatch()).matched).toBe(1);
    expect(await lineStatus(other)).toBe("auto_matched");
  });

  it("the settlement's journal is refused as a manual match of another bank line", async () => {
    const { journal } = await postedOnLine();
    const other = await seedBankLine(99_300);
    const res = await lineCommand(other, "match", {
      refs: [{ type: "journal_entry", id: journal }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(await lineStatus(other)).toBe("unmatched");
  });

  it("the gateway recon shows no variance for a payout of two outlets", async () => {
    const a = await seedSettlement();
    const b = await seedSettlement({
      outlet: world.outlets[1],
      amountIdr: 50_000,
      feeIdr: 350,
    });
    const line = await seedBankLine(148_950);
    expect((await reconcile(line, [a, b])).status).toBe(200);
    await post(a);
    await post(b);
    const res = await finance.get(
      `/api/accounting/gateway-settlement-recon?legalEntityId=${world.entity}&bankAccountId=${world.bankAccount}&from=2026-11-01&to=2026-11-30`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body.data.rows as {
      settlementId: string;
      matchedAmountIdr: number;
      varianceIdr: number;
    }[];
    expect(
      rows
        .map((r) => [r.settlementId, r.matchedAmountIdr, r.varianceIdr])
        .sort(),
    ).toEqual(
      [
        [a, 99_300, 0],
        [b, 49_650, 0],
      ].sort(),
    );
  });

  it("two concurrent bank lines for one settlement emit once", async () => {
    const id = await seedSettlement();
    const one = await seedBankLine(99_300);
    const two = await seedBankLine(99_300);
    const results = await Promise.all([
      reconcile(one, [id]),
      reconcile(two, [id]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await emitted(id)).toHaveLength(1);
    expect([await lineStatus(one), await lineStatus(two)].sort()).toEqual([
      "manually_matched",
      "unmatched",
    ]);
  });

  it("an unmatch of a two-outlet payout blocks both settlements", async () => {
    const a = await seedSettlement();
    const b = await seedSettlement({
      outlet: world.outlets[1],
      amountIdr: 50_000,
      feeIdr: 350,
    });
    const line = await seedBankLine(148_950);
    expect((await reconcile(line, [a, b])).status).toBe(200);
    await lineCommand(line, "unmatch", {
      idempotencyKey: `un-${randomUUID()}`,
    });
    expect(await lineStatus(line)).toBe("unmatched");
    expect((await reconcile(line, [a, b])).status).toBe(409);
    for (const [id, net] of [
      [a, 99_300],
      [b, 49_650],
    ] as const) {
      expect((await reconcile(await seedBankLine(net), [id])).status).toBe(409);
      expect(await emitted(id)).toHaveLength(1);
    }
  });

  it("another tenant's bank line or settlement does not exist", async () => {
    const tenant = randomUUID();
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Lain', plan, status, deployment_mode, feature_flags, limits, created_by FROM tenants WHERE id = $3`,
      [tenant, `emit-${uid()}`, tenantId],
    );
    await owner.query(
      "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'lain', 'Lain')",
      [randomUUID(), tenant],
    );
    const foreign = await makeWorld(tenant);
    const foreignLine = await seedBankLine(99_300, {
      account: foreign,
      tenant,
    });
    const foreignSettlement = randomUUID();
    await asTenant(
      (c) =>
        c.query(
          `INSERT INTO payment_settlements
             (id, tenant_id, outlet_id, source, provider, reference, period_start, period_end,
              gross_idr, fee_idr, net_idr, line_count, content_hash, imported_by)
           VALUES ($1, $2, $3, 'gateway', 'doit', 'EMIT-X', $4, $4, 100000, 700, 99300, 1, $5, 'seed')`,
          [
            foreignSettlement,
            tenant,
            foreign.outlets[0],
            SOLD_ON,
            "a".repeat(64),
          ],
        ),
      tenant,
    );
    const id = await seedSettlement();
    const line = await seedBankLine(99_300);
    await expectRefused(await reconcile(foreignLine, [id]), 404, [id]);
    await expectRefused(await reconcile(line, [foreignSettlement]), 404, []);
    expect(await lineStatus(foreignLine)).toBe("unmatched");
    expect(await lineStatus(line)).toBe("unmatched");
  });

  it("refuses an unknown settlement or bank line", async () => {
    const id = await seedSettlement();
    const line = await seedBankLine(99_300);
    await expectRefused(await reconcile(randomUUID(), [id]), 404, [id]);
    await expectRefused(await reconcile(line, [randomUUID()]), 404, []);
    expect(await lineStatus(line)).toBe("unmatched");
  });

  it("refuses the same settlement twice in one request", async () => {
    const id = await seedSettlement();
    const line = await seedBankLine(198_600);
    const res = await reconcile(line, [id, id]);
    expect([400, 422]).toContain(res.status);
    expect(await emitted(id)).toEqual([]);
  });

  it("needs tenant-wide finance access", async () => {
    const id = await seedSettlement();
    const line = await seedBankLine(99_300);
    outletOwner = await signedIn("owner", "outlet", world.outlets[0]);
    for (const client of [cashier, outletOwner])
      await expectRefused(await reconcile(line, [id], { client }), 403, [id]);
    expect(await lineStatus(line)).toBe("unmatched");
  });
});
