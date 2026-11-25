// `settlement.reconciled` emitter (1269 C4a, legend-osqou.7, legend-3a5m).
// POST /api/payments/admin/reconciliation/settlements/reconcile ties imported
// gateway settlements to the bank statement line that paid them. The event is
// what books the bank money, so: exact net, one line once, one event per
// outlet, and nothing at all when anything is in doubt.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { settlementReconciledPayloadSchema } from "@starter/shared/payment";
import { createApp } from "../app";
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
  bankAccount: string;
  importId: string;
  outlets: [string, string];
};
let world: World;

async function asTenant<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

async function makeWorld(): Promise<World> {
  const w: World = {
    entity: randomUUID(),
    bankGl: randomUUID(),
    bankAccount: randomUUID(),
    importId: randomUUID(),
    outlets: [randomUUID(), randomUUID()],
  };
  await asTenant(async (c) => {
    await c.query(
      "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
      [w.entity, tenantId, `Entity emit ${uid()}`],
    );
    for (const id of w.outlets)
      await c.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
         SELECT $1, $2, brand_id, $3, $4, 'Outlet emit', 'Jl. Emit', 'Asia/Jakarta', '04:00', '{}', 'active'
           FROM outlets WHERE tenant_id = $2 LIMIT 1`,
        [id, tenantId, w.entity, `EM-${uid()}`.toUpperCase()],
      );
    await c.query(
      `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, '1103', 'Bank', 'asset', 'cash_and_equivalents')`,
      [w.bankGl, tenantId, w.entity],
    );
    await c.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, 'bank', $3)`,
      [tenantId, w.entity, w.bankGl],
    );
    await c.query(
      `INSERT INTO bank_accounts
         (id, tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
          account_number_hmac, account_number_last4, account_number_key_version, gl_account_id, created_by)
       VALUES ($1, $2, $3, 'BCA', 'Rekening utama', $4, $5, '1234', 1, $6, 'seed')`,
      [
        w.bankAccount,
        tenantId,
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
      [w.importId, tenantId, w.bankAccount, randomBytes(32).toString("hex")],
    );
  });
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
  o: { postedOn?: string; status?: string; account?: World } = {},
): Promise<string> {
  const id = randomUUID();
  const w = o.account ?? world;
  await owner.query(
    `INSERT INTO bank_statement_lines
       (id, tenant_id, bank_account_id, import_id, posted_on, amount_idr, description, dedupe_key, match_status, excluded_reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'Settlement gateway', $7, $8, $9)`,
    [
      id,
      tenantId,
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
