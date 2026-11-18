// legend-5qqb9 P3: a manual journal or a recurring journal month that CREDITS
// the entity's petty cash account (GL 1102, the `petty_cash` mapping) must not
// post when the credit is above the available 1102 cash. Written fail-first
// from the brief (scratchpad brief-5qqb9.md, Design P3), the founder rule "GL
// 1102 never goes negative" and the public HTTP / service surface, NOT from the
// posting code.
//
// Rules:
// - Net credit to 1102 = sum(credit - debit) over the journal's 1102 lines.
//   Net credit above available 1102 cash: refused 422 PETTY_CASH_GL_INSUFFICIENT,
//   no journal entry, GL 1102 unchanged (never negative).
// - Net credit within available cash: posts. Net debit (or zero) to 1102: no
//   guard, posts even when 1102 is empty.
// - Recurring month: a refused month is not generated (no entry, cursor does
//   not move), the job does not throw, and the same month is retried by the
//   next run and posts after a top-up.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - "Available" is the plain GL 1102 balance here: the world has no other
//   pending 1102 credit (no payroll, kasbon or supplier payment), so available
//   equals GL.
// - Direct approve = the approval inbox decides first, then the approve
//   endpoint settles (the chain must be finished, else 409 APPROVAL_PENDING);
//   that endpoint answers 422 with the refusal code. The journal is not
//   asserted to stay pending (the brief allows pending/retry or 422); what is
//   asserted is that no entry exists and GL is unchanged.
// - Recurring templates are Rp900.000 / Rp500.000, below the Rp1.000.000
//   approval threshold of the test policy, so activation needs no inbox step.
// - Manual settle after an approved chain (inbox approval, then the settle
//   service): the refusal is retryable (the call throws HttpError with the
//   refusal code, the journal is NOT ended `rejected`); after a top-up the same
//   settle posts exactly once.
// - The seeded funding of 1102 is a direct DB insert (setup only).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext, TenantContext } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { settleManualJournalForApproval } from "../services/accounting-journal-manual.service";
import { runDueRecurringJournals } from "../services/accounting-journal-recurring.service";
import { decideApprovalRequest } from "../services/platform-approval.service";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const BASE = "/api/accounting";
const REFUSAL = "PETTY_CASH_GL_INSUFFICIENT";
const tenantId = randomUUID();
const outletId = randomUUID();
const hostname = `cash-1102-manual-recurring-${tenantId}.example.test`;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUserIds: string[] = [];
const trackedTemplateIds: string[] = [];
const ACTIONS = ["manual_journal", "recurring_journal"];
const unique = () => randomBytes(4).toString("hex");

const tenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});

function scopedContext(): ScopedTenantContext {
  return establishScopedTenantContext(tenant, { kind: "tenant" });
}

type Client = ReturnType<typeof agent>;

async function financeRoleId(): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'finance'",
    [tenantId],
  );
  if (!rows[0]) throw new Error("No finance role template");
  return rows[0].id;
}

async function financeUser(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  client.set("Host", hostname);
  createdUserIds.push(userId);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 hour', $2)`,
    [tenantId, userId, await financeRoleId()],
  );
  return { client, userId };
}

async function createAccount(
  client: Client,
  entity: string,
  input: { code: string; name: string; type: string; reportGroup: string },
) {
  const response = await client
    .post(`${BASE}/legal-entities/${entity}/accounts`)
    .set(originHeader)
    .send({ parentId: null, ...input });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

/** A fresh entity with a 1102 account mapped as `petty_cash`, and an expense account. */
async function scenario(name: string) {
  const requester = await financeUser(`${name} requester`);
  const approver = await financeUser(`${name} approver`);
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, `${name} ${unique()}`],
  );
  const entity = rows[0]!.id;
  const petty = await createAccount(requester.client, entity, {
    code: "1102",
    name: "Kas Kecil",
    type: "asset",
    reportGroup: "cash_and_equivalents",
  });
  const expense = await createAccount(requester.client, entity, {
    code: "6101",
    name: "Beban Operasional",
    type: "expense",
    reportGroup: "operating_expense",
  });
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'petty_cash', $3)`,
    [tenantId, entity, petty],
  );
  return { requester, approver, entity, petty, expense };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

/** Puts cash into the entity's 1102 by a seeded journal (setup only). */
async function fund1102(s: Scenario, amountIdr: number) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period, status)
       VALUES ($1, $2, '2026-01', 'open') ON CONFLICT DO NOTHING`,
      [tenantId, s.entity],
    );
    const period = (
      await client.query<{ id: string }>(
        "SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-01'",
        [tenantId, s.entity],
      )
    ).rows[0]!.id;
    const entry = (
      await client.query<{ id: string }>(
        `INSERT INTO journal_entries
           (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
            source_id, description, idempotency_key, request_fingerprint)
         VALUES ($1, $2, '2026-01-01', $3, 'sale', NULL, 'Saldo kas kecil uji 5qqb9', $4, $5)
         RETURNING id`,
        [
          tenantId,
          s.entity,
          period,
          `5qqb9-fund-${randomUUID()}`,
          randomBytes(32).toString("hex"),
        ],
      )
    ).rows[0]!.id;
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
      [tenantId, entry, s.petty, s.expense, amountIdr],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function gl1102(s: Scenario): Promise<number> {
  const { rows } = await owner.query<{ balance: string }>(
    `SELECT coalesce(sum(debit_idr - credit_idr), 0)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [tenantId, s.petty],
  );
  return Number(rows[0]!.balance);
}

async function entryCount(s: Scenario, sourceType: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_type = $3`,
    [tenantId, s.entity, sourceType],
  );
  return Number(rows[0]!.n);
}

/** Journal lines: debit side and credit side, each optionally on 1102. */
function side(accountId: string, debitIdr: number, creditIdr: number) {
  return { accountId, debitIdr, creditIdr, outletId, costCenter: null };
}

/** Dr expense / Cr 1102 for `amount`. */
const creditPettyLines = (s: Scenario, amount: number) => [
  side(s.expense, amount, 0),
  side(s.petty, 0, amount),
];

async function submittedJournal(
  s: Scenario,
  lines: ReturnType<typeof side>[],
): Promise<string> {
  const created = await s.requester.client
    .post(`${BASE}/manual-journals`)
    .set(originHeader)
    .send({
      legalEntityId: s.entity,
      outletId,
      entryDate: "2026-11-02",
      kind: "general",
      description: "Jurnal umum kas kecil (test 5qqb9)",
      lines,
      idempotencyKey: `manual-${randomUUID()}`,
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  const submitted = await s.requester.client
    .post(`${BASE}/manual-journals/${id}/submit`)
    .set(originHeader)
    .send({ idempotencyKey: `cmd-${randomUUID()}` });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  expect(submitted.body.data.status).toBe("pending_approval");
  return id;
}

/** The approval inbox decides first; the approve endpoint then settles (posts). */
const approveDirect = async (s: Scenario, id: string) => {
  await approveInbox(s, id);
  return s.approver.client
    .post(`${BASE}/manual-journals/${id}/approve`)
    .set(originHeader)
    .send({ idempotencyKey: `cmd-${randomUUID()}` });
};

async function approveInbox(s: Scenario, id: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM approval_requests
      WHERE tenant_id = $1 AND source_module = 'accounting'
        AND object_type = 'manual_journal' AND object_id = $2 AND level = 1`,
    [tenantId, id],
  );
  await decideApprovalRequest(
    tenant,
    s.approver.userId,
    rows[0]!.id,
    { decision: "approved", reason: "Sesuai dokumen pendukung." },
    { mfaVerified: true, idempotencyKey: null },
  );
}

async function journalRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    posted_entry_id: string | null;
  }>(
    "SELECT status, posted_entry_id FROM manual_journals WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );
  return rows[0]!;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const fixture = cafeLegendPlatformFixtures;
  const brandId = randomUUID();
  const entityId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, $4, 'active', 'shared', $5, $6, $7)`,
    [
      tenantId,
      `kas-1102-mr-${tenantId}`,
      "Kas 1102 manual recurring test",
      fixture.tenant.plan,
      JSON.stringify(fixture.tenant.featureFlags),
      JSON.stringify(fixture.tenant.limits),
      fixture.tenant.createdBy,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'kas', 'Kas test')`,
    [brandId, tenantId],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, 'Kas outlet entity')`,
    [entityId, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'KAS5Q', 'Kas test', 'Jl. Uji', 'Asia/Jakarta', '{}', 'active')`,
    [outletId, tenantId, brandId, entityId],
  );
  await owner.query(
    `INSERT INTO tenant_domains (tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, 'custom', 'active', now())`,
    [tenantId, brandId, hostname],
  );
  const finance = ROLE_TEMPLATES.find((role) => role.key === "finance")!;
  await owner.query(
    `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, true, 'finance', $3, $4, $5)`,
    [
      tenantId,
      finance.defaultName,
      JSON.stringify(finance.permissions),
      finance.mfaRequired,
      JSON.stringify(finance.allowedScopeTypes),
    ],
  );
  for (const action of ACTIONS)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, $2, 1000000, $3, 1)`,
      [tenantId, action, await financeRoleId()],
    );
});

// An active template keeps generating for later runs; end it after each test.
afterEach(async () => {
  if (trackedTemplateIds.length > 0)
    await owner.query(
      `UPDATE recurring_journals SET status = 'ended'
        WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status IN ('active', 'paused')`,
      [tenantId, trackedTemplateIds],
    );
});

afterAll(async () => {
  await owner.query(
    `DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
    [tenantId, ACTIONS],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    createdUserIds,
  ]);
  await owner.end();
});

describe("legend-5qqb9 P3 manual journal crediting GL 1102", () => {
  it("[5qqb9-manual-credit-above-available-refused] 1102 holds Rp300.000 and a Rp2.000.000 manual journal credits it: direct approve is refused 422 PETTY_CASH_GL_INSUFFICIENT, no journal entry, GL 1102 unchanged and never negative", async () => {
    const s = await scenario("manual refused");
    await fund1102(s, 300_000);
    const id = await submittedJournal(s, creditPettyLines(s, 2_000_000));

    const response = await approveDirect(s, id);
    const detail = JSON.stringify(response.body);
    expect(response.status, detail).toBe(422);
    expect(response.body.error?.code, detail).toBe(REFUSAL);
    expect((await journalRow(id)).posted_entry_id).toBeNull();
    expect(await entryCount(s, "manual")).toBe(0);
    expect(await gl1102(s)).toBe(300_000);
  });

  it("[5qqb9-manual-credit-within-available-posts] 1102 holds Rp5.000.000 and a Rp2.000.000 manual journal credits it: posts, GL 1102 is Rp3.000.000", async () => {
    const s = await scenario("manual fits");
    await fund1102(s, 5_000_000);
    const id = await submittedJournal(s, creditPettyLines(s, 2_000_000));

    const response = await approveDirect(s, id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await journalRow(id)).posted_entry_id).not.toBeNull();
    expect(await entryCount(s, "manual")).toBe(1);
    expect(await gl1102(s)).toBe(3_000_000);
  });

  it("[5qqb9-manual-net-credit-counts] Cr 1102 Rp2.000.000 and Dr 1102 Rp1.900.000 in one journal is a net credit of Rp100.000: with Rp100.000 in 1102 it posts (GL 0), with only Rp50.000 it is refused", async () => {
    const netLines = (s: Scenario) => [
      side(s.expense, 100_000, 0),
      side(s.petty, 1_900_000, 0),
      side(s.petty, 0, 2_000_000),
    ];

    const fits = await scenario("manual net fits");
    await fund1102(fits, 100_000);
    const fitsId = await submittedJournal(fits, netLines(fits));
    const posted = await approveDirect(fits, fitsId);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(await gl1102(fits)).toBe(0);

    const short = await scenario("manual net short");
    await fund1102(short, 50_000);
    const shortId = await submittedJournal(short, netLines(short));
    const refused = await approveDirect(short, shortId);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error?.code).toBe(REFUSAL);
    expect(await entryCount(short, "manual")).toBe(0);
    expect(await gl1102(short)).toBe(50_000);
  });

  it("[5qqb9-manual-net-debit-no-guard] a manual journal that DEBITS 1102 Rp2.000.000 posts while 1102 is empty (no guard on a net debit)", async () => {
    const s = await scenario("manual debit");
    const id = await submittedJournal(s, [
      side(s.petty, 2_000_000, 0),
      side(s.expense, 0, 2_000_000),
    ]);

    const response = await approveDirect(s, id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await entryCount(s, "manual")).toBe(1);
    expect(await gl1102(s)).toBe(2_000_000);
  });

  it("[5qqb9-manual-settle-short-retryable] chain approved, then 1102 is short at settle: settle throws PETTY_CASH_GL_INSUFFICIENT, the journal is not ended rejected, no entry; after a top-up the same settle posts once", async () => {
    const s = await scenario("manual settle");
    await fund1102(s, 300_000);
    const id = await submittedJournal(s, creditPettyLines(s, 2_000_000));
    await approveInbox(s, id);

    const context = scopedContext();
    const settle = () =>
      withTenant(db, context, (tx) =>
        settleManualJournalForApproval(tx, context, id, new Date()),
      );
    await expect(settle()).rejects.toMatchObject({ code: REFUSAL });
    expect((await journalRow(id)).status).not.toBe("rejected");
    expect(await entryCount(s, "manual")).toBe(0);
    expect(await gl1102(s)).toBe(300_000);

    await fund1102(s, 2_000_000);
    const settled = await settle();
    expect(settled.status).toBe("posted");
    expect(await entryCount(s, "manual")).toBe(1);
    expect(await gl1102(s)).toBe(300_000);
    await settle(); // replay is a no-op
    expect(await entryCount(s, "manual")).toBe(1);
  });
});

describe("legend-5qqb9 P3 recurring journal crediting GL 1102", () => {
  async function createTemplate(s: Scenario, amount: number): Promise<string> {
    const response = await s.requester.client
      .post(`${BASE}/recurring-journals`)
      .set(originHeader)
      .send({
        legalEntityId: s.entity,
        outletId,
        description: "Akrual kas kecil bulanan (test 5qqb9)",
        lines: creditPettyLines(s, amount),
        dayOfMonth: 10,
        startPeriod: "2026-01",
        endPeriod: null,
        idempotencyKey: `recurring-${randomUUID()}`,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    trackedTemplateIds.push(response.body.data.id);
    const id = response.body.data.id as string;
    for (const [who, type] of [
      [s.requester, "submit"],
      [s.approver, "approve"],
    ] as const) {
      const step = await who.client
        .post(`${BASE}/recurring-journals/${id}/transition`)
        .set(originHeader)
        .send({ type });
      expect(step.status, JSON.stringify(step.body)).toBe(200);
    }
    return id;
  }

  async function generated(id: string): Promise<string[]> {
    const { rows } = await owner.query<{ entry_date: string }>(
      `SELECT to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date
         FROM journal_entries e
        WHERE e.tenant_id = $1 AND e.source_type = 'recurring' AND e.source_id = $2
        ORDER BY e.entry_date`,
      [tenantId, id],
    );
    return rows.map((row) => row.entry_date);
  }

  it("[5qqb9-recurring-credit-above-available-failed-then-retried] a Rp900.000 monthly credit to 1102 with Rp300.000 in 1102: the January run generates nothing (GL unchanged, run does not throw); after a top-up the next run posts January once", async () => {
    const s = await scenario("recurring retry");
    await fund1102(s, 300_000);
    const id = await createTemplate(s, 900_000);

    await expect(
      runDueRecurringJournals(
        scopedContext(),
        new Date("2026-01-15T05:00:00Z"),
      ),
    ).resolves.toBeDefined();
    expect(await generated(id)).toEqual([]);
    expect(await entryCount(s, "recurring")).toBe(0);
    expect(await gl1102(s)).toBe(300_000);

    await fund1102(s, 900_000);
    await runDueRecurringJournals(
      scopedContext(),
      new Date("2026-01-16T05:00:00Z"),
    );
    expect(await generated(id)).toEqual(["2026-01-10"]);
    expect(await gl1102(s)).toBe(300_000);

    // A further run the same month does not generate it twice.
    await runDueRecurringJournals(
      scopedContext(),
      new Date("2026-01-17T05:00:00Z"),
    );
    expect(await generated(id)).toEqual(["2026-01-10"]);
  });

  it("[5qqb9-recurring-credit-within-available-posts] a Rp500.000 monthly credit to 1102 with Rp2.000.000 in 1102 posts on its day", async () => {
    const s = await scenario("recurring fits");
    await fund1102(s, 2_000_000);
    const id = await createTemplate(s, 500_000);

    await runDueRecurringJournals(
      scopedContext(),
      new Date("2026-01-15T05:00:00Z"),
    );
    expect(await generated(id)).toEqual(["2026-01-10"]);
    expect(await gl1102(s)).toBe(1_500_000);
  });
});
