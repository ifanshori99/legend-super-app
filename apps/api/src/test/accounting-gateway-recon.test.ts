// Gateway settlement recon endpoint (bead legend-ds1o; PRD §3.19 "Rekonsiliasi
// Gateway", ACC-04, TEN-01/02). Written from the DESIGN in
// docs/briefs/ws-settlement-recon.md: GET /api/accounting/gateway-settlement-recon
// ?legalEntityId&bankAccountId&from&to answers { data: { rows, truncated } }.
// The numbers are the ones the web card used to compute client-side from the
// settlement journals (gross = credit lines, fee = non-bank debit lines,
// net = bank debit - credit, variance = net - matched statement line amount);
// they are hand-computed constants here, never recomputed with product code.
//
// Assumptions (also in the report):
//  - Rows are ordered by entry date descending, then description ascending.
//  - Row field names follow the design: journalId, settlementId (the journal's source id), entryDate,
//    description, grossIdr, fees[{accountId, amountIdr}], feeIdr, netIdr, statementLineId,
//    matchedAmountIdr, varianceIdr. Only those are asserted.
//  - Bad query (missing/unknown/non-uuid param) answers 400 or 422.
//  - Another tenant's entity or bank account answers 403 or 404.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { agent, signUp, verifySessionMfa } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const PATH = "/api/accounting/gateway-settlement-recon";
const uid = () => randomBytes(4).toString("hex");

const userIds: string[] = [];
const entityIds: string[] = [];
const otherTenant = randomUUID();
let finance: ReturnType<typeof agent>;
let nobody: ReturnType<typeof agent>;

async function signedIn(template: string | null) {
  const client = agent(app);
  const email = await signUp(client, `Gateway recon ${template ?? "none"}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  await verifySessionMfa(email);
  if (template) {
    const role = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
      [tenantId, template],
    );
    if (!role.rows[0]) throw new Error(`No ${template} role template`);
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
      [tenantId, userId, role.rows[0].id],
    );
  }
  return client;
}

type Entity = {
  tenant: string;
  id: string;
  bankGl: string;
  clearing: string;
  mdr: string;
  vaFee: string;
  bankAccountId: string;
  importId: string;
  periodNov: string;
  periodDec: string;
};

async function seedEntity(tenant: string = tenantId): Promise<Entity> {
  const e: Entity = {
    tenant,
    id: randomUUID(),
    bankGl: randomUUID(),
    clearing: randomUUID(),
    mdr: randomUUID(),
    vaFee: randomUUID(),
    bankAccountId: randomUUID(),
    importId: randomUUID(),
    periodNov: randomUUID(),
    periodDec: randomUUID(),
  };
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [e.id, tenant, `Gateway recon entity ${uid()}`],
  );
  entityIds.push(e.id);
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $5, $6, '1102', 'Bank', 'asset', 'cash_and_equivalents'),
            ($2, $5, $6, '1201', 'Gateway clearing', 'asset', 'current_asset'),
            ($3, $5, $6, '6101', 'Biaya MDR', 'expense', 'operating_expense'),
            ($4, $5, $6, '6102', 'Biaya layanan VA', 'expense', 'operating_expense')`,
    [e.bankGl, e.clearing, e.mdr, e.vaFee, tenant, e.id],
  );
  await owner.query(
    `INSERT INTO fiscal_periods (id, tenant_id, legal_entity_id, period)
     VALUES ($1, $3, $4, '2026-11'), ($2, $3, $4, '2026-12')`,
    [e.periodNov, e.periodDec, tenant, e.id],
  );
  await owner.query(
    `INSERT INTO bank_accounts
       (id, tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
        account_number_hmac, account_number_last4, account_number_key_version, gl_account_id, created_by)
     VALUES ($1, $2, $3, 'BCA', 'Rekening utama', $4, $5, '1234', 1, $6, 'seed')`,
    [
      e.bankAccountId,
      tenant,
      e.id,
      randomBytes(32),
      randomBytes(32).toString("hex"),
      e.bankGl,
    ],
  );
  await owner.query(
    `INSERT INTO bank_statement_imports
       (id, tenant_id, bank_account_id, file_name, file_sha256, imported_by, line_count, duplicate_count, auto_matched_count)
     VALUES ($1, $2, $3, 'seed.csv', $4, 'seed', 0, 0, 0)`,
    [e.importId, tenant, e.bankAccountId, randomBytes(32).toString("hex")],
  );
  return e;
}

type JLine = { account: string; debit?: number; credit?: number };

async function seedJournal(
  e: Entity,
  o: {
    date: string;
    sourceType?: string;
    sourceId: string;
    description: string;
    lines: JLine[];
  },
): Promise<string> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type, source_id,
          description, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        e.tenant,
        e.id,
        o.date,
        o.date.startsWith("2026-12") ? e.periodDec : e.periodNov,
        o.sourceType ?? "gateway_settlement",
        o.sourceId,
        o.description,
        `gwr-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const id = rows[0]!.id;
    let no = 1;
    for (const l of o.lines) {
      await client.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [e.tenant, id, l.account, no++, l.debit ?? 0, l.credit ?? 0],
      );
    }
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** A statement line of `amount`, matched to the settlement `sourceId`. */
async function seedMatchedLine(
  e: Entity,
  sourceId: string,
  amount: number,
  postedOn: string,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO bank_statement_lines
       (id, tenant_id, bank_account_id, import_id, posted_on, amount_idr, description,
        dedupe_key, match_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Settlement gateway', $7, 'manually_matched')`,
    [id, e.tenant, e.bankAccountId, e.importId, postedOn, amount, `k-${id}`],
  );
  await owner.query(
    `INSERT INTO bank_statement_line_matches
       (tenant_id, bank_account_id, line_id, ref_type, ref_id, amount_idr, source, matched_by)
     VALUES ($1, $2, $3, 'gateway_settlement', $4, $5, 'manual', 'seed')`,
    [e.tenant, e.bankAccountId, id, sourceId, amount],
  );
  return id;
}

const query = (
  client: ReturnType<typeof agent>,
  params: Record<string, string>,
) => client.get(`${PATH}?${new URLSearchParams(params).toString()}`);

const params = (e: Entity, from = "2026-11-01", to = "2026-11-30") => ({
  legalEntityId: e.id,
  bankAccountId: e.bankAccountId,
  from,
  to,
});

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

/**
 * Settlement journals (Dr bank net, Dr fee accounts, Cr clearing gross):
 *   S1 2026-11-05  gross 100000  fees MDR 500 + VA 200  net 99300   statement 99300  variance 0
 *   S2 2026-11-07  gross 250000 (two credit lines 120000+130000) fee MDR 1750 net 248250
 *                  statement 240000 -> variance +8250
 *   S3 2026-11-09  gross 50000   fee MDR 350            net 49650   no statement -> variance 49650
 *   S4 2026-11-11  gross 10000   fee MDR 70             net 9930    statement 12000 -> variance -2070
 *   excluded: a manual journal in range, a settlement dated 2026-12-15.
 */
async function seedFixture() {
  const e = await seedEntity();
  const s = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const j1 = await seedJournal(e, {
    date: "2026-11-05",
    sourceId: s[0]!,
    description: "Settlement DOIT 05 Nov",
    lines: [
      { account: e.bankGl, debit: 99300 },
      { account: e.mdr, debit: 500 },
      { account: e.vaFee, debit: 200 },
      { account: e.clearing, credit: 100000 },
    ],
  });
  const j2 = await seedJournal(e, {
    date: "2026-11-07",
    sourceId: s[1]!,
    description: "Settlement DOIT 07 Nov",
    lines: [
      { account: e.bankGl, debit: 248250 },
      { account: e.mdr, debit: 1750 },
      { account: e.clearing, credit: 120000 },
      { account: e.clearing, credit: 130000 },
    ],
  });
  const j3 = await seedJournal(e, {
    date: "2026-11-09",
    sourceId: s[2]!,
    description: "Settlement DOIT 09 Nov",
    lines: [
      { account: e.bankGl, debit: 49650 },
      { account: e.mdr, debit: 350 },
      { account: e.clearing, credit: 50000 },
    ],
  });
  const j4 = await seedJournal(e, {
    date: "2026-11-11",
    sourceId: s[3]!,
    description: "Settlement DOIT 11 Nov",
    lines: [
      { account: e.bankGl, debit: 9930 },
      { account: e.mdr, debit: 70 },
      { account: e.clearing, credit: 10000 },
    ],
  });
  await seedJournal(e, {
    date: "2026-11-06",
    sourceType: "manual",
    sourceId: randomUUID(),
    description: "Penyesuaian manual",
    lines: [
      { account: e.bankGl, debit: 777 },
      { account: e.clearing, credit: 777 },
    ],
  });
  await seedJournal(e, {
    date: "2026-12-15",
    sourceId: randomUUID(),
    description: "Settlement DOIT Desember",
    lines: [
      { account: e.bankGl, debit: 4000 },
      { account: e.clearing, credit: 4000 },
    ],
  });
  const l1 = await seedMatchedLine(e, s[0]!, 99300, "2026-11-06");
  const l2 = await seedMatchedLine(e, s[1]!, 240000, "2026-11-08");
  const l4 = await seedMatchedLine(e, s[3]!, 12000, "2026-11-12");
  return { e, s, j: [j1, j2, j3, j4], l: [l1, l2, l4] };
}

let fx: Fixture;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn("finance");
  nobody = await signedIn(null);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Gateway recon other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `gwr-${uid()}`, tenantId],
  );
  fx = await seedFixture();
});

afterAll(async () => {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const args = [entityIds];
    const byEntity = "legal_entity_id = ANY($1::uuid[])";
    await client.query(
      `DELETE FROM bank_statement_line_matches WHERE bank_account_id IN (SELECT id FROM bank_accounts WHERE ${byEntity})`,
      args,
    );
    await client.query(
      `DELETE FROM bank_statement_lines WHERE bank_account_id IN (SELECT id FROM bank_accounts WHERE ${byEntity})`,
      args,
    );
    await client.query(
      `DELETE FROM bank_statement_imports WHERE bank_account_id IN (SELECT id FROM bank_accounts WHERE ${byEntity})`,
      args,
    );
    await client.query(`DELETE FROM bank_accounts WHERE ${byEntity}`, args);
    await client.query(
      `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE ${byEntity})`,
      args,
    );
    await client.query(
      `DELETE FROM app.journal_entry_seals WHERE entry_id IN (SELECT id FROM journal_entries WHERE ${byEntity})`,
      args,
    );
    await client.query(`DELETE FROM journal_entries WHERE ${byEntity}`, args);
    await client.query(`DELETE FROM fiscal_periods WHERE ${byEntity}`, args);
    await client.query(`DELETE FROM chart_of_accounts WHERE ${byEntity}`, args);
    await client.query(
      "DELETE FROM legal_entities WHERE id = ANY($1::uuid[])",
      args,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.query(
    "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
    [userIds],
  );
  await owner.end();
});

describe("ACC-04 legend-ds1o gateway settlement recon", () => {
  it("ACC-04 returns gross, fee, net and variance per settlement, computed on the server", async () => {
    const response = await query(finance, params(fx.e));
    expect(response.status).toBe(200);
    expect(response.body.data.truncated).toBe(false);
    const rows = response.body.data.rows as Record<string, any>[];
    // Newest first; only settlement journals of this entity inside the period.
    expect(rows.map((r) => r.journalId)).toEqual([
      fx.j[3],
      fx.j[2],
      fx.j[1],
      fx.j[0],
    ]);

    expect(rows[3]).toMatchObject({
      journalId: fx.j[0],
      settlementId: fx.s[0],
      description: "Settlement DOIT 05 Nov",
      entryDate: "2026-11-05",
      grossIdr: 100000,
      feeIdr: 700,
      netIdr: 99300,
      statementLineId: fx.l[0],
      matchedAmountIdr: 99300,
      varianceIdr: 0,
    });
    // One row per fee account (MDR, VA service fee).
    expect(rows[3].fees).toHaveLength(2);
    expect(rows[3].fees).toEqual(
      expect.arrayContaining([
        { accountId: fx.e.mdr, amountIdr: 500 },
        { accountId: fx.e.vaFee, amountIdr: 200 },
      ]),
    );

    // Credit lines add up to gross; statement lower than net is a positive variance.
    expect(rows[2]).toMatchObject({
      journalId: fx.j[1],
      settlementId: fx.s[1],
      description: "Settlement DOIT 07 Nov",
      entryDate: "2026-11-07",
      grossIdr: 250000,
      feeIdr: 1750,
      netIdr: 248250,
      statementLineId: fx.l[1],
      matchedAmountIdr: 240000,
      varianceIdr: 8250,
    });
    expect(rows[2].fees).toEqual([{ accountId: fx.e.mdr, amountIdr: 1750 }]);

    // Not on the bank statement yet: the whole net is the variance.
    expect(rows[1]).toMatchObject({
      journalId: fx.j[2],
      grossIdr: 50000,
      feeIdr: 350,
      netIdr: 49650,
      statementLineId: null,
      matchedAmountIdr: 0,
      varianceIdr: 49650,
    });

    // Bank received more than the journal booked: negative variance.
    expect(rows[0]).toMatchObject({
      journalId: fx.j[3],
      grossIdr: 10000,
      feeIdr: 70,
      netIdr: 9930,
      statementLineId: fx.l[2],
      matchedAmountIdr: 12000,
      varianceIdr: -2070,
    });

    for (const r of rows) {
      expect(r.grossIdr - r.feeIdr).toBe(r.netIdr);
      expect(r.netIdr - r.matchedAmountIdr).toBe(r.varianceIdr);
      expect(
        (r.fees as { amountIdr: number }[]).reduce(
          (s, f) => s + f.amountIdr,
          0,
        ),
      ).toBe(r.feeIdr);
    }
  });

  it("ACC-04 the period filter is inclusive on both ends", async () => {
    const one = await query(finance, params(fx.e, "2026-11-05", "2026-11-05"));
    expect(one.status).toBe(200);
    expect(one.body.data.rows.map((r: any) => r.journalId)).toEqual([fx.j[0]]);

    const middle = await query(
      finance,
      params(fx.e, "2026-11-06", "2026-11-09"),
    );
    expect(middle.body.data.rows.map((r: any) => r.journalId)).toEqual([
      fx.j[2],
      fx.j[1],
    ]);

    const december = await query(
      finance,
      params(fx.e, "2026-12-01", "2026-12-31"),
    );
    expect(december.body.data.rows).toHaveLength(1);
    expect(december.body.data.rows[0]).toMatchObject({
      grossIdr: 4000,
      feeIdr: 0,
      netIdr: 4000,
      fees: [],
      statementLineId: null,
      varianceIdr: 4000,
    });
  });

  it("ACC-04 empty state: a period without settlements answers 200 with no rows", async () => {
    const response = await query(
      finance,
      params(fx.e, "2025-01-01", "2025-01-31"),
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ rows: [], truncated: false });
  });

  it("ACC-04 a client cannot override the computed totals", async () => {
    for (const extra of [
      { grossIdr: "1" },
      { varianceIdr: "0" },
      { netIdr: "1" },
    ]) {
      const response = await query(finance, { ...params(fx.e), ...extra });
      expect([400, 422]).toContain(response.status);
    }
  });

  it("ACC-04 rejects missing or malformed query parameters", async () => {
    const base = params(fx.e);
    for (const bad of [
      { ...base, bankAccountId: "not-a-uuid" },
      { ...base, legalEntityId: "not-a-uuid" },
      { ...base, from: "2026-13-01" },
      { ...base, to: "yesterday" },
    ]) {
      expect([400, 422]).toContain((await query(finance, bad)).status);
    }
    for (const key of Object.keys(base)) {
      const partial: Record<string, string> = { ...base };
      delete partial[key];
      expect([400, 422], key).toContain((await query(finance, partial)).status);
    }
  });

  it("ACC-04 is read-only: no journal, statement line or match is written", async () => {
    const count = async () =>
      (
        await owner.query(
          `SELECT
             (SELECT count(*)::int FROM journal_entries WHERE legal_entity_id = $1) AS entries,
             (SELECT count(*)::int FROM journal_lines WHERE entry_id IN
                (SELECT id FROM journal_entries WHERE legal_entity_id = $1)) AS lines,
             (SELECT count(*)::int FROM bank_statement_lines WHERE bank_account_id = $2) AS statement,
             (SELECT count(*)::int FROM bank_statement_line_matches WHERE bank_account_id = $2) AS matches,
             (SELECT count(*)::int FROM bank_reconciliation_cases WHERE legal_entity_id = $1) AS cases`,
          [fx.e.id, fx.e.bankAccountId],
        )
      ).rows[0];
    const before = await count();
    expect((await query(finance, params(fx.e))).status).toBe(200);
    expect(await count()).toEqual(before);
  });
});

describe("TEN-01 TEN-02 legend-ds1o gateway recon access and isolation", () => {
  it("TEN-02 needs a session and a role that may view journals", async () => {
    const anonymous = await query(agent(app), params(fx.e));
    expect(anonymous.status).toBe(401);
    const noRole = await query(nobody, params(fx.e));
    expect(noRole.status).toBe(403);
  });

  it("TEN-01 another tenant's entity and bank account are not readable", async () => {
    const foreign = await seedEntity(otherTenant);
    const response = await query(finance, params(foreign));
    expect([403, 404]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain(foreign.bankGl);
  });

  it("TEN-01 a bank account of another entity does not mix totals", async () => {
    const second = await seedEntity();
    await seedJournal(second, {
      date: "2026-11-05",
      sourceId: randomUUID(),
      description: "Settlement entitas kedua",
      lines: [
        { account: second.bankGl, debit: 1900 },
        { account: second.mdr, debit: 100 },
        { account: second.clearing, credit: 2000 },
      ],
    });
    const mine = await query(finance, params(second));
    expect(mine.status).toBe(200);
    expect(mine.body.data.rows).toHaveLength(1);
    expect(mine.body.data.rows[0]).toMatchObject({
      grossIdr: 2000,
      feeIdr: 100,
      netIdr: 1900,
    });
    // The first entity is unchanged by the second entity's journal.
    const first = await query(finance, params(fx.e));
    expect(first.body.data.rows).toHaveLength(4);
    // Entity of one account paired with the bank account of another: refused.
    const crossed = await query(finance, {
      ...params(fx.e),
      bankAccountId: second.bankAccountId,
    });
    expect([400, 403, 404]).toContain(crossed.status);
  });
});

describe("ACC-04 legend-ds1o gateway recon statement lines respect the period (L4)", () => {
  // Parity with the old card: a bank statement line only counts as the match of
  // a settlement when its posting date lies inside [from, to].
  it("ACC-04 a matched statement line dated outside the period is not counted as matched", async () => {
    const e = await seedEntity();
    const sAfter = randomUUID();
    const sBefore = randomUUID();
    const sEdge = randomUUID();
    const jAfter = await seedJournal(e, {
      date: "2026-11-20",
      sourceId: sAfter,
      description: "Settlement garis setelah periode",
      lines: [
        { account: e.bankGl, debit: 4950 },
        { account: e.mdr, debit: 50 },
        { account: e.clearing, credit: 5000 },
      ],
    });
    const jBefore = await seedJournal(e, {
      date: "2026-11-25",
      sourceId: sBefore,
      description: "Settlement garis sebelum periode",
      lines: [
        { account: e.bankGl, debit: 9900 },
        { account: e.mdr, debit: 100 },
        { account: e.clearing, credit: 10000 },
      ],
    });
    const jEdge = await seedJournal(e, {
      date: "2026-11-18",
      sourceId: sEdge,
      description: "Settlement garis tepat di batas",
      lines: [
        { account: e.bankGl, debit: 1980 },
        { account: e.mdr, debit: 20 },
        { account: e.clearing, credit: 2000 },
      ],
    });
    await seedMatchedLine(e, sAfter, 4950, "2026-12-03"); // after `to`
    await seedMatchedLine(e, sBefore, 9900, "2026-10-30"); // before `from`
    const edgeLine = await seedMatchedLine(e, sEdge, 1980, "2026-11-30"); // on `to`

    const narrow = await query(finance, params(e, "2026-11-15", "2026-11-30"));
    expect(narrow.status).toBe(200);
    const byJournal = new Map(
      (narrow.body.data.rows as Record<string, any>[]).map((r) => [
        r.journalId,
        r,
      ]),
    );
    expect(byJournal.size).toBe(3);
    // Statement lines outside the period: not matched, the whole net is variance.
    expect(byJournal.get(jAfter)).toMatchObject({
      netIdr: 4950,
      statementLineId: null,
      matchedAmountIdr: 0,
      varianceIdr: 4950,
    });
    expect(byJournal.get(jBefore)).toMatchObject({
      netIdr: 9900,
      statementLineId: null,
      matchedAmountIdr: 0,
      varianceIdr: 9900,
    });
    // A line posted exactly on `to` counts (inclusive).
    expect(byJournal.get(jEdge)).toMatchObject({
      netIdr: 1980,
      statementLineId: edgeLine,
      matchedAmountIdr: 1980,
      varianceIdr: 0,
    });

    // Widen the period around the statement lines: now every one is matched.
    const wide = await query(finance, params(e, "2026-10-01", "2026-12-31"));
    expect(wide.status).toBe(200);
    const wideRows = wide.body.data.rows as Record<string, any>[];
    expect(wideRows).toHaveLength(3);
    for (const r of wideRows) {
      expect(r.statementLineId, r.description).not.toBeNull();
      expect(r.varianceIdr, r.description).toBe(0);
    }
  });
});
