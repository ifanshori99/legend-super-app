// legend-5qqb9 round 2 C): two more posters that can CREDIT the entity's petty
// cash account (GL 1102, the `petty_cash` mapping) must not take it below zero:
// a fixed asset (depreciation) journal and the reversal of a journal that
// DEBITED 1102 (the mirrored reversal credits 1102). Written fail-first from the
// brief (scratchpad brief-5qqb9.md, ROUND 2 C), the founder rule "GL 1102 never
// goes negative" and the public surface (HTTP reversal endpoint, fixed asset
// service), NOT from the posting code.
//
// Rules:
// - Net credit to 1102 above the available 1102 cash: refused with
//   PETTY_CASH_GL_INSUFFICIENT (reversal over HTTP: 422), no journal entry,
//   GL 1102 unchanged and never negative.
// - Net credit within available cash: posts. A reversal of an entry that
//   CREDITED 1102 debits 1102 and is never guarded (posts even at GL 0).
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - The only fixed asset journal that can credit 1102 is a monthly depreciation
//   posting whose `accumulated_depreciation` mapping points at the 1102
//   account. The test world aliases that role to the petty cash account (a
//   direct DB insert, setup only) to exercise the guard; no real chart does so.
// - "Available" is the plain GL 1102 balance here: the world has no other
//   pending 1102 credit (no payroll, kasbon or supplier payment).
// - Reversal targets are seeded journals (direct DB insert, setup only) with
//   source types `petty_cash_topup` (Dr 1102) and `petty_cash_return` (Cr
//   1102); the reversal endpoint is POST /api/accounting/journals/:id/reversal.
// - The consumer-level case (a refused auto-journal reversal is retried, not
//   dropped) and a reversal whose credit is already reserved by its caller are
//   NOT covered: no caller of reverseJournalInTransaction (sale void, refund
//   item rejected, payroll.reversed, the manual endpoint) mirrors a journal
//   whose 1102 credit is already in the pending reserve.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  userIdSchema,
  type ScopedTenantContext,
  type TenantContext,
  type UserId,
} from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import {
  createFixedAsset,
  runDepreciation,
} from "../services/accounting-fixed-assets.service";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const REFUSAL = "PETTY_CASH_GL_INSUFFICIENT";
const tenantId = randomUUID();
const outletId = randomUUID();
const hostname = `cash-1102-fa-reversal-${tenantId}.example.test`;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUserIds: string[] = [];
const unique = () => randomBytes(4).toString("hex");
/** Fixed "now" for service calls: every test date below is in the past. */
const NOW = new Date("2026-11-03T03:00:00Z");
const actor: UserId = userIdSchema.parse(randomUUID());

const tenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});

function scopedContext(): ScopedTenantContext {
  return establishScopedTenantContext(tenant, { kind: "tenant" });
}

async function financeClient(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  client.set("Host", hostname);
  createdUserIds.push(userId);
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'finance'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 hour', $2)`,
    [tenantId, userId, rows[0]!.id],
  );
  return client;
}

/**
 * A fresh entity with a 1102 account mapped as `petty_cash`, an expense account
 * mapped as `depreciation_expense`, and a finance user for the HTTP calls.
 */
async function scenario(name: string) {
  const client = await financeClient(`${name} finance`);
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, `${name} ${unique()}`],
  );
  const entity = rows[0]!.id;
  const account = async (
    code: string,
    label: string,
    type: string,
    group: string,
  ) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [tenantId, entity, code, label, type, group],
      )
    ).rows[0]!.id;
  const petty = await account(
    "1102",
    "Kas Kecil",
    "asset",
    "cash_and_equivalents",
  );
  const expense = await account(
    "6101",
    "Beban Operasional",
    "expense",
    "operating_expense",
  );
  const map = (role: string, accountId: string) =>
    owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entity, role, accountId],
    );
  await map("petty_cash", petty);
  await map("depreciation_expense", expense);
  return { client, entity, petty, expense, map };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

/**
 * Seeds a posted journal (setup only): `petty` side is a debit (cash in) or a
 * credit (cash out) of `amountIdr` against the expense account.
 */
async function seedEntry(
  s: Scenario,
  kind: "debit_1102" | "credit_1102",
  amountIdr: number,
): Promise<string> {
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
    const debit = kind === "debit_1102";
    const entry = (
      await client.query<{ id: string }>(
        `INSERT INTO journal_entries
           (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
            source_id, description, idempotency_key, request_fingerprint)
         VALUES ($1, $2, '2026-01-02', $3, $4, NULL, 'Kas kecil uji 5qqb9 C', $5, $6)
         RETURNING id`,
        [
          tenantId,
          s.entity,
          period,
          debit ? "petty_cash_topup" : "petty_cash_return",
          `5qqb9c-${randomUUID()}`,
          randomBytes(32).toString("hex"),
        ],
      )
    ).rows[0]!.id;
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, $6), ($1, $2, $4, 2, $6, $5)`,
      [
        tenantId,
        entry,
        s.petty,
        s.expense,
        debit ? amountIdr : 0,
        debit ? 0 : amountIdr,
      ],
    );
    await client.query("COMMIT");
    return entry;
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

const reverse = (s: Scenario, entryId: string) =>
  s.client
    .post(`/api/accounting/journals/${entryId}/reversal`)
    .set(originHeader)
    .send({
      entryDate: "2026-11-02",
      reason: "Koreksi uji 5qqb9",
      idempotencyKey: `rev-${randomUUID()}`,
    });

/**
 * Registers a Rp12.000.000 / 12 month asset starting 2026-10 (Rp1.000.000 a
 * month) and runs October's depreciation, whose credit lands on 1102 because the
 * `accumulated_depreciation` role is aliased to the petty cash account. Settles
 * to the thrown error (or null when the run posted).
 */
async function depreciateOntoPettyCash(s: Scenario): Promise<unknown> {
  await s.map("accumulated_depreciation", s.petty);
  await createFixedAsset(
    scopedContext(),
    {
      legalEntityId: s.entity,
      outletId: null,
      name: "Mesin espresso uji 5qqb9",
      acquiredOn: "2026-10-01",
      costIdr: 12_000_000,
      residualValueIdr: 0,
      usefulLifeMonths: 12,
      depreciationStartPeriod: "2026-10",
      sourceDocumentId: null,
      idempotencyKey: `fa-${randomUUID()}`,
    },
    actor,
    NOW,
  );
  return runDepreciation(
    scopedContext(),
    {
      legalEntityId: s.entity,
      period: "2026-10",
      idempotencyKey: `run-${randomUUID()}`,
    },
    actor,
    NOW,
  ).then(
    () => null,
    (error: unknown) => error,
  );
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
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    createdUserIds,
  ]);
  await owner.end();
});

describe("legend-5qqb9 C fixed asset journal crediting GL 1102", () => {
  it("[5qqb9-fixed-asset-credit-above-available-refused] 1102 holds Rp300.000 and October depreciation of Rp1.000.000 credits it: refused PETTY_CASH_GL_INSUFFICIENT, no depreciation journal, GL 1102 unchanged and never negative", async () => {
    const s = await scenario("fa refused");
    await seedEntry(s, "debit_1102", 300_000);

    const failure = await depreciateOntoPettyCash(s);

    expect(await entryCount(s, "depreciation")).toBe(0);
    expect(await gl1102(s)).toBe(300_000);
    expect(failure, "the run must be refused").toMatchObject({ code: REFUSAL });
  });

  it("[5qqb9-fixed-asset-credit-within-available-posts] 1102 holds Rp5.000.000 and October depreciation of Rp1.000.000 credits it: posts one journal, GL 1102 is Rp4.000.000", async () => {
    const s = await scenario("fa fits");
    await seedEntry(s, "debit_1102", 5_000_000);

    const failure = await depreciateOntoPettyCash(s);

    expect(failure).toBeNull();
    expect(await entryCount(s, "depreciation")).toBe(1);
    expect(await gl1102(s)).toBe(4_000_000);
  });
});

describe("legend-5qqb9 C reversal of a journal that debited GL 1102", () => {
  it("[5qqb9-reversal-of-debit-above-available-refused] top-up of Rp2.000.000 then Rp1.800.000 paid out leaves Rp200.000: reversing the top-up is refused 422 PETTY_CASH_GL_INSUFFICIENT, no reversal journal, GL 1102 stays Rp200.000", async () => {
    const s = await scenario("rev refused");
    const topUp = await seedEntry(s, "debit_1102", 2_000_000);
    await seedEntry(s, "credit_1102", 1_800_000);

    const response = await reverse(s, topUp);

    const detail = JSON.stringify(response.body);
    expect(await entryCount(s, "reversal")).toBe(0);
    expect(await gl1102(s)).toBe(200_000);
    expect(response.status, detail).toBe(422);
    expect(response.body.error?.code, detail).toBe(REFUSAL);
  });

  it("[5qqb9-reversal-of-debit-within-available-posts] top-up of Rp2.000.000 plus Rp1.000.000 more leaves Rp3.000.000: reversing the Rp2.000.000 top-up posts one reversal, GL 1102 is Rp1.000.000", async () => {
    const s = await scenario("rev fits");
    const topUp = await seedEntry(s, "debit_1102", 2_000_000);
    await seedEntry(s, "debit_1102", 1_000_000);

    const response = await reverse(s, topUp);

    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    expect(await entryCount(s, "reversal")).toBe(1);
    expect(await gl1102(s)).toBe(1_000_000);
  });

  it("[5qqb9-reversal-exact-available-posts] reversing a top-up equal to the whole Rp2.000.000 balance posts (credit equals available), GL 1102 is zero", async () => {
    const s = await scenario("rev exact");
    const topUp = await seedEntry(s, "debit_1102", 2_000_000);

    const response = await reverse(s, topUp);

    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    expect(await entryCount(s, "reversal")).toBe(1);
    expect(await gl1102(s)).toBe(0);
  });

  it("[5qqb9-reversal-of-credit-never-guarded] reversing a Rp1.800.000 payout that credited 1102 debits 1102: posts although 1102 holds nothing else, GL 1102 rises to Rp1.800.000", async () => {
    const s = await scenario("rev credit");
    await seedEntry(s, "debit_1102", 1_800_000);
    const payout = await seedEntry(s, "credit_1102", 1_800_000);
    expect(await gl1102(s)).toBe(0);

    const response = await reverse(s, payout);

    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    expect(await entryCount(s, "reversal")).toBe(1);
    expect(await gl1102(s)).toBe(1_800_000);
  });
});
