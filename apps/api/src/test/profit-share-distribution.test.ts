// Profit-share distribution cycle (PRD v1.7 §3.37 "Siklus Distribusi", §4 P,
// §6 I; SH-01, SH-02, SH-03, SH-04; bead legend-2ljb slice E). Written from the
// contract in `@starter/shared/accounting` (profit-share*.ts), not from the
// services: HTTP tests run the real Better Auth, tenant resolver, RBAC, RLS and
// PostgreSQL; the two profit-share routers are mounted on a test express app
// with the same auth + tenant middleware as app.ts (the real app factory is not
// needed to prove the contract). Fixtures that are not part of the unit under
// test (legal entity, chart of accounts, account mappings, posted revenue and
// expense, a CLOSED fiscal period) are written as the migration owner and
// through the journal / period-close services, like accounting-period-close.
//
// Assumptions (the contract does not pin these down):
// - Error bodies are `{ error: { code } }` (like every other API test) and the
//   statuses follow `accountingErrorHttpStatus` / `accessErrorHttpStatus`;
//   body validation answers 422 VALIDATION_ERROR.
// - Share versions are seeded in SQL through the contract state machine (the
//   version endpoints are the registry suite's concern).
// - A user holding the approve permission but not the registry permission may
//   only decide; the "dual" user holds both so it can be requester AND decider.
// - Raw-SQL guard tests run as the migration owner: the guards are triggers
//   and apply to every role. They assert "the statement is refused and the row
//   is unchanged", not a specific SQLSTATE. UPDATEs are chosen so every CHECK
//   constraint still holds, so only the freeze guard can refuse them.
// - paidAt is sent as "now": the current Asia/Jakarta month gets an open
//   fiscal period in every fixture entity, so the completion journal can post.
// - The distribution router is built with its default dependencies (the real
//   statement issuer); a failing statement issue must not break a payment
//   (brief), which these tests rely on implicitly.
// - A negative adjustment stores only `reversalJournalEntryId` (and leaves
//   `journalEntryId` null); a positive one stores only `journalEntryId`.
// - Tenant B is left in the disposable database: profit-share rows cannot be
//   deleted (SH-04), so no cleanup of tenant B is attempted.
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateSchema,
  idr,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  accountIdSchema,
  distributionRunSchema,
  distributionStatementSchema,
  listDistributionRuns,
  myProfitShareSchema,
  type DistributionRun,
} from "@starter/shared/accounting";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { FakeEmailProvider, FakeObjectStorage } from "@starter/shared/adapters";
import { auth } from "../lib/auth";
import { requestContext } from "../lib/request-context";
import { limitAuthBody } from "../middleware/body";
import { errorHandler, notFound } from "../middleware/error-handler";
import { tenantContext } from "../middleware/tenant";
import { createProfitShareDistributionRouter } from "../routes/profit-share-distribution.routes";
import { createProfitShareRegistryRouter } from "../routes/profit-share-registry.routes";
import { resolveHostname } from "../services/org-resolve.service";
import { installProfitShareStatementPorts } from "../services/profit-share-statement-ports";
import {
  configureProfitShareStatementDeps,
  statementFileKey,
} from "../services/profit-share-statement.service";
import { deviceTenantCredential } from "../services/platform-tenant.service";
import { db } from "../db";
import { isAutoJournalEvent } from "../services/accounting-auto-journal-amounts";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import {
  approvePeriodReopen,
  closeFiscalPeriod,
  requestPeriodReopen,
} from "../services/accounting-period-close.service";
import { agent, originHeader, signUp } from "./helpers";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const tenantB = randomUUID();
const API = "/api/accounting";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");
const key = (label: string) => `${label}-${randomUUID()}`;

// ---- Test app ---------------------------------------------------------------

function buildApp(tenantId: string): express.Express {
  const app = express();
  app.use(requestContext);
  app.all("/api/auth/*splat", limitAuthBody, toNodeHandler(auth));
  app.use(
    "/api",
    tenantContext({
      required: false,
      resolveDomain: async (hostname) => {
        const resolution = await resolveHostname(hostname);
        return resolution.ok
          ? { tenantId: resolution.tenantId, brandId: resolution.brandId }
          : null;
      },
      verifyCredential: deviceTenantCredential,
      // Test stand-in for the development tenant fallback: the signed-in
      // caller's tenant is the one this app instance was built for.
      fallback: async (req) => {
        const session = await auth.api.getSession({
          headers: fromNodeHeaders(req.headers),
          query: { disableCookieCache: true },
        });
        return session ? { tenantId, brandId: null, source: "session" } : null;
      },
    }),
  );
  const router = express.Router();
  router.use(createProfitShareRegistryRouter());
  router.use(createProfitShareDistributionRouter({} as never));
  app.use(API, router);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

const appA = buildApp(tenantA);
const appB = buildApp(tenantB);

type Person = { client: ReturnType<typeof agent>; userId: string };

async function signedIn(app: express.Express, name: string): Promise<Person> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  return { client, userId: session.body.user.id as string };
}

async function customRole(
  tenantId: string,
  userId: string,
  permissions: string[],
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantId,
      `Distribution test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(["tenant"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
}

const MANAGE = "profit_share.registry.manage";
const APPROVE = "profit_share.distribution.approve";

async function withPermissions(
  app: express.Express,
  tenantId: string,
  name: string,
  permissions: string[],
) {
  const person = await signedIn(app, name);
  await customRole(tenantId, person.userId, permissions);
  return person;
}

/** The seeded `shareholder` template holds `profit_share.own.view`. */
async function shareholderUser(name: string) {
  const person = await signedIn(appA, name);
  const assigned = await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'shareholder'`,
    [tenantA, person.userId],
  );
  expect(assigned.rowCount).toBe(1);
  return person;
}

const post = (who: Person, path: string, body: unknown) =>
  who.client
    .post(`${API}${path}`)
    .set(originHeader)
    .send(body as object);
const get = (who: Person, path: string) => who.client.get(`${API}${path}`);

// ---- Fixtures ---------------------------------------------------------------

function scopedContext(tenant: string = tenantA): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** Today's business date in Asia/Jakarta, and its YYYY-MM period. */
const jakartaDate = (at: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);

type Accounts = {
  cash: string;
  revenue: string;
  expense: string;
  bank: string;
  retainedEarnings: string;
  dividendTaxPayable: string;
};

type World = {
  legalEntityId: string;
  accounts: Accounts;
  profitEntityId: string;
  /** Next free past period index for `closedPeriod`. */
  nextPeriod: number;
};

/** Legal entity + chart of accounts + the three posting-role mappings. */
async function makeLegalEntity(): Promise<{
  legalEntityId: string;
  accounts: Accounts;
}> {
  const legalEntityId = randomUUID();
  const accounts: Accounts = {
    cash: randomUUID(),
    revenue: randomUUID(),
    expense: randomUUID(),
    bank: randomUUID(),
    retainedEarnings: randomUUID(),
    dividendTaxPayable: randomUUID(),
  };
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [legalEntityId, tenantA, `Bagi hasil ${unique()}`],
  );
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $7, $8, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $7, $8, '4101', 'Penjualan', 'revenue', 'revenue'),
            ($3, $7, $8, '6101', 'Beban operasional', 'expense', 'operating_expense'),
            ($4, $7, $8, '1102', 'Bank', 'asset', 'cash_and_equivalents'),
            ($5, $7, $8, '3102', 'Laba ditahan', 'equity', 'equity'),
            ($6, $7, $8, '2301', 'Utang pajak dividen', 'liability', 'current_liability')`,
    [
      accounts.cash,
      accounts.revenue,
      accounts.expense,
      accounts.bank,
      accounts.retainedEarnings,
      accounts.dividendTaxPayable,
      tenantA,
      legalEntityId,
    ],
  );
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'bank', $3),
            ($1, $2, 'retained_earnings', $4),
            ($1, $2, 'dividend_tax_payable', $5)`,
    [
      tenantA,
      legalEntityId,
      accounts.bank,
      accounts.retainedEarnings,
      accounts.dividendTaxPayable,
    ],
  );
  // The completion journal is dated at payment time: keep that month open.
  await owner.query(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, $3)`,
    [tenantA, legalEntityId, jakartaDate(new Date()).slice(0, 7)],
  );
  return { legalEntityId, accounts };
}

function periodKey(index: number): string {
  // 2021-01, 2021-02, ... all long past, so "the period has ended" holds.
  const year = 2021 + Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function journalLine(accountId: string, debit: number, credit: number) {
  return {
    accountId: accountIdSchema.parse(accountId),
    debitIdr: idr(debit),
    creditIdr: idr(credit),
    outletId: null,
    costCenter: null,
  };
}

async function postEntry(
  legalEntityId: string,
  date: string,
  lines: ReturnType<typeof journalLine>[],
) {
  const context = scopedContext();
  await withTenant(db, context, (tx) =>
    postJournalInTransaction(tx, context, {
      legalEntityId,
      outletId: null,
      entryDate: businessDateSchema.parse(date),
      sourceType: "sale" as const,
      sourceId: randomUUID(),
      description: "Penjualan dan beban (uji bagi hasil)",
      lines,
      postedBy: null,
      idempotencyKey: `post-${randomUUID()}`,
    }),
  );
}

/** An OPEN fiscal period row with posted revenue/expense, net profit known. */
async function openPeriod(
  world: Pick<World, "legalEntityId" | "accounts">,
  period: string,
  netProfit: number,
): Promise<{ id: string; period: string }> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantA, world.legalEntityId, period],
  );
  const revenue = netProfit > 0 ? netProfit + 1_000_000 : 1_000_000;
  const expense = revenue - netProfit;
  const date = `${period}-15`;
  await postEntry(world.legalEntityId, date, [
    journalLine(world.accounts.cash, revenue, 0),
    journalLine(world.accounts.revenue, 0, revenue),
  ]);
  await postEntry(world.legalEntityId, date, [
    journalLine(world.accounts.expense, expense, 0),
    journalLine(world.accounts.cash, 0, expense),
  ]);
  return { id: rows[0]!.id, period };
}

const closer = randomUUID();

/** A CLOSED fiscal period whose P&L net profit is exactly `netProfit`. */
async function closedPeriod(world: World, netProfit: number) {
  const period = await openPeriod(
    world,
    periodKey(world.nextPeriod++),
    netProfit,
  );
  await closeFiscalPeriod(
    scopedContext(),
    period.id,
    { expectedVersion: 1, idempotencyKey: `close-${randomUUID()}` },
    userIdSchema.parse(closer),
  );
  return period;
}

// ---- People and shareholders (created once) ----------------------------------

let manager: Person; // registry.manage: requester
let approver: Person; // distribution.approve: decides
let dual: Person; // both: can be requester AND (wrongly) decider
let sh1User: Person; // login of shareholder S1
let sh2User: Person; // login of shareholder S2
let managerB: Person;
let approverB: Person;

type Holder = { id: string; name: string };
let s1: Holder;
let s2: Holder;
let s3: Holder;
let s4: Holder;
let s5: Holder;

async function newShareholder(
  name: string,
  userId: string | null,
): Promise<Holder> {
  const response = await post(manager, "/shareholders", {
    name,
    type: "person",
    userId,
    npwp: null,
    payoutAccount: null,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return { id: response.body.data.id as string, name };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Distribution tenant B', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantB,
      `dist-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ modules: [], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  // Submit opens a `dividend_distribution` approval request (the matrix, not
  // the permission alone, decides). These tests approve through the decide
  // route, so the policy applies only from an amount far above any test run:
  // `required: false` keeps the direct approve. The chain itself is covered by
  // profit-share-approval-chain.test.ts.
  const saved = await owner.query(
    `SELECT threshold_idr, approver_role_id, levels FROM approval_policies
      WHERE tenant_id = $1 AND action_type = 'dividend_distribution'`,
    [tenantA],
  );
  savedDividendPolicies = saved.rows;
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'dividend_distribution'`,
    [tenantA],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     SELECT $1, 'dividend_distribution', 1000000000000000, id, 1 FROM roles
      WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenantA],
  );
  manager = await withPermissions(appA, tenantA, "Dist Manager", [MANAGE]);
  approver = await withPermissions(appA, tenantA, "Dist Approver", [APPROVE]);
  dual = await withPermissions(appA, tenantA, "Dist Dual", [MANAGE, APPROVE]);
  sh1User = await shareholderUser("Dist Shareholder 1");
  sh2User = await shareholderUser("Dist Shareholder 2");
  // Tenant B holds BOTH permissions: a 404 below can only come from tenancy.
  managerB = await withPermissions(appB, tenantB, "Dist Manager B", [
    MANAGE,
    APPROVE,
  ]);
  approverB = await withPermissions(appB, tenantB, "Dist Approver B", [
    APPROVE,
  ]);
  const tag = unique();
  s1 = await newShareholder(`Andi Satu ${tag}`, sh1User.userId);
  s2 = await newShareholder(`Budi Dua ${tag}`, sh2User.userId);
  s3 = await newShareholder(`Citra Tiga ${tag}`, null);
  s4 = await newShareholder(`Dewi Empat ${tag}`, null);
  s5 = await newShareholder(`Eko Lima ${tag}`, null);
}, 120_000);

let savedDividendPolicies: {
  threshold_idr: string | null;
  approver_role_id: string;
  levels: number;
}[] = [];

afterAll(async () => {
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'dividend_distribution'`,
    [tenantA],
  );
  for (const row of savedDividendPolicies)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'dividend_distribution', $2, $3, $4)`,
      [tenantA, row.threshold_idr, row.approver_role_id, row.levels],
    );
  await owner.end();
});

// ---- Register helpers --------------------------------------------------------

type Policy = { reserveBp: number; taxWithholdingBp: number };
type Share = { holder: Holder; bp: number };

async function createProfitEntity(legalEntityId: string, policy: Policy) {
  const response = await post(manager, "/profit-entities", {
    name: `Entitas ${unique()}`,
    type: "legal_entity",
    legalEntityId,
    outletId: null,
    policy: {
      basis: "closed_period_net_profit",
      frequency: "monthly",
      ...policy,
    },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

/**
 * Seeds a share version as the migration owner, walking the contract state
 * machine draft -> pending_approval -> approved (requester != approver). The
 * version HTTP endpoints belong to the registry suite; this suite only needs a
 * version in force, and must not depend on them.
 */
async function seedVersion(
  profitEntityId: string,
  shares: Share[],
  status: "pending_approval" | "approved",
  effectiveFrom = "2020-01-01",
  version = 1,
) {
  const requestedBy = manager.userId;
  await owner.query(
    `INSERT INTO share_allocation_versions
       (tenant_id, profit_entity_id, version, effective_from, status, requested_by, idempotency_key)
     VALUES ($1, $2, $6, $3, 'draft', $4, $5)`,
    [
      tenantA,
      profitEntityId,
      effectiveFrom,
      requestedBy,
      key("seed-ver"),
      version,
    ],
  );
  for (const [position, share] of shares.entries())
    await owner.query(
      `INSERT INTO share_allocations
         (tenant_id, profit_entity_id, version, shareholder_id, share_bp, position)
       VALUES ($1, $2, $6, $3, $4, $5)`,
      [tenantA, profitEntityId, share.holder.id, share.bp, position, version],
    );
  await owner.query(
    `UPDATE share_allocation_versions SET status = 'pending_approval'
     WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = $3`,
    [tenantA, profitEntityId, version],
  );
  if (status === "approved")
    await owner.query(
      `UPDATE share_allocation_versions
       SET status = 'approved', decided_by = $3, decided_at = now()
       WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = $4`,
      [tenantA, profitEntityId, approver.userId, version],
    );
  return version;
}

async function makeWorld(
  policy: Policy,
  shares: Share[] | null,
): Promise<World> {
  const { legalEntityId, accounts } = await makeLegalEntity();
  const profitEntityId = await createProfitEntity(legalEntityId, policy);
  if (shares) await seedVersion(profitEntityId, shares, "approved");
  return { legalEntityId, accounts, profitEntityId, nextPeriod: 0 };
}

/** The rounding world: reserve 10%, tax 5%, shares 33.33/33.33/33.34%. */
const roundingPolicy: Policy = { reserveBp: 1000, taxWithholdingBp: 500 };
const roundingShares = (): Share[] => [
  { holder: s1, bp: 3333 },
  { holder: s2, bp: 3333 },
  { holder: s3, bp: 3334 },
];
const NET_PROFIT = 1_000_001;

// ---- Distribution helpers ----------------------------------------------------

const createRun = (
  who: Person,
  world: World,
  fiscalPeriodId: string,
  k = key("run"),
) =>
  post(who, `/profit-entities/${world.profitEntityId}/distributions`, {
    fiscalPeriodId,
    idempotencyKey: k,
  });
const submitRun = (who: Person, runId: string, k = key("submit")) =>
  post(who, `/distributions/${runId}/submit`, { idempotencyKey: k });
const decideRun = (
  who: Person,
  runId: string,
  decision: "approve" | "reject" = "approve",
  k = key("decide"),
) =>
  post(who, `/distributions/${runId}/decision`, {
    decision,
    note: decision === "reject" ? "Angka belum final" : null,
    idempotencyKey: k,
  });
const payLine = (
  who: Person,
  runId: string,
  lineId: string,
  k = key("pay"),
  ref = `TRF-${unique()}`,
  paidAt = new Date().toISOString(),
) =>
  post(who, `/distributions/${runId}/lines/${lineId}/payment`, {
    paymentRef: ref,
    paidAt,
    idempotencyKey: k,
  });
const getRun = (who: Person, runId: string) =>
  get(who, `/distributions/${runId}`);
const adjust = (
  who: Person,
  runId: string,
  body: { fiscalPeriodId: string; adjustmentIdr: number; reason?: string },
) =>
  post(who, `/distributions/${runId}/adjustment`, {
    reason: "Koreksi angka",
    idempotencyKey: key("adj"),
    ...body,
  });

const parseRun = (body: { data: unknown }): DistributionRun =>
  distributionRunSchema.parse(body.data);

async function draftRun(world: World, netProfit = NET_PROFIT) {
  const period = await closedPeriod(world, netProfit);
  const response = await createRun(manager, world, period.id);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return { period, run: parseRun(response.body) };
}

async function pendingRun(world: World) {
  const drafted = await draftRun(world);
  const submitted = await submitRun(manager, drafted.run.id);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  return { ...drafted, run: parseRun(submitted.body) };
}

async function approvedRun(world: World) {
  const pending = await pendingRun(world);
  const decided = await decideRun(approver, pending.run.id);
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  return { ...pending, run: parseRun(decided.body) };
}

async function payAll(who: Person, run: DistributionRun) {
  let last = null;
  for (const line of run.lines) {
    // A line the carry absorbed to zero was settled on approval.
    if (line.paymentStatus === "paid") continue;
    last = await payLine(who, run.id, line.id);
    expect(last.status, JSON.stringify(last.body)).toBe(200);
  }
  return parseRun(last ? last.body : (await getRun(who, run.id)).body);
}

async function paidRun(world: World) {
  const approved = await approvedRun(world);
  return { ...approved, run: await payAll(manager, approved.run) };
}

async function journalOf(entryId: string) {
  const entry = await owner.query<{
    source_type: string;
    source_id: string;
    entry_date: string;
    legal_entity_id: string;
  }>(
    `SELECT source_type, source_id, entry_date::text AS entry_date, legal_entity_id
     FROM journal_entries WHERE tenant_id = $1 AND id = $2`,
    [tenantA, entryId],
  );
  expect(entry.rowCount).toBe(1);
  const lines = await owner.query<{
    account_id: string;
    debit_idr: string;
    credit_idr: string;
  }>(
    `SELECT account_id, debit_idr::text, credit_idr::text
     FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2`,
    [tenantA, entryId],
  );
  const byAccount = (accountId: string) => {
    const rows = lines.rows.filter((row) => row.account_id === accountId);
    return {
      debit: rows.reduce((sum, row) => sum + Number(row.debit_idr), 0),
      credit: rows.reduce((sum, row) => sum + Number(row.credit_idr), 0),
    };
  };
  return {
    entry: entry.rows[0]!,
    totalDebit: lines.rows.reduce((sum, row) => sum + Number(row.debit_idr), 0),
    totalCredit: lines.rows.reduce(
      (sum, row) => sum + Number(row.credit_idr),
      0,
    ),
    byAccount,
  };
}

/** The run contract exposes only the reversal id; read the posted-journal id from the row. */
async function postedJournalId(runId: string): Promise<string | null> {
  const { rows } = await owner.query<{ journal_entry_id: string | null }>(
    "SELECT journal_entry_id FROM distribution_runs WHERE tenant_id = $1 AND id = $2",
    [tenantA, runId],
  );
  return rows[0]!.journal_entry_id;
}

const errorCode = (response: { body: { error?: { code?: string } } }) =>
  response.body.error?.code;

// ---- SH-02 / SH-03: creating the draft ---------------------------------------

describe("SH-02 a run needs a closed period and an approved share version", () => {
  it("refuses a run on an OPEN period with PERIOD_NOT_CLOSED", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const open = await openPeriod(
      world,
      periodKey(world.nextPeriod++),
      NET_PROFIT,
    );
    const response = await createRun(manager, world, open.id);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(errorCode(response)).toBe("PERIOD_NOT_CLOSED");
    // Nothing was stored for the entity.
    const list = await get(
      manager,
      `/profit-entities/${world.profitEntityId}/distributions`,
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(listDistributionRuns.response.parse(list.body).data).toEqual([]);
  });

  it("refuses a closed period with zero or negative profit (NOTHING_TO_DISTRIBUTE)", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const loss = await closedPeriod(world, -500_000);
    const response = await createRun(manager, world, loss.id);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(errorCode(response)).toBe("NOTHING_TO_DISTRIBUTE");
  });

  it("refuses a run when no approved share version is in force (SH-03)", async () => {
    const world = await makeWorld(roundingPolicy, null);
    const period = await closedPeriod(world, NET_PROFIT);
    const none = await createRun(manager, world, period.id);
    expect(none.status, JSON.stringify(none.body)).toBe(422);
    expect(errorCode(none)).toBe("SHARE_VERSION_NOT_EFFECTIVE");

    // A version that is only submitted (pending) is not usable either.
    await seedVersion(
      world.profitEntityId,
      roundingShares(),
      "pending_approval",
    );
    const pending = await createRun(manager, world, period.id);
    expect(pending.status, JSON.stringify(pending.body)).toBe(422);
    expect(errorCode(pending)).toBe("SHARE_VERSION_NOT_EFFECTIVE");
  });

  it("creates a draft with one line per shareholder from a closed period", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run, period } = await draftRun(world);
    expect(run).toMatchObject({
      type: "regular",
      basis: "closed_period_net_profit",
      status: "draft",
      period: period.period,
      fiscalPeriodId: period.id,
      shareVersion: 1,
      periodNetProfitIdr: NET_PROFIT,
      requestedBy: manager.userId,
      approvedBy: null,
      paidAt: null,
      adjustsRunId: null,
    });
    expect(run.lines).toHaveLength(3);
    expect(run.lines.map((line) => line.shareholderId).sort()).toEqual(
      [s1.id, s2.id, s3.id].sort(),
    );
    for (const line of run.lines) {
      expect(line.paymentStatus).toBe("pending");
      expect(line.paymentRef).toBeNull();
      expect(line.paidAt).toBeNull();
      expect(line.statementFileKey).toBeNull();
    }
    // The draft is readable again and appears in the entity's run list.
    const again = await getRun(manager, run.id);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(parseRun(again.body)).toEqual(run);
    const list = listDistributionRuns.response.parse(
      (
        await get(
          manager,
          `/profit-entities/${world.profitEntityId}/distributions`,
        )
      ).body,
    );
    expect(list.data).toEqual([
      expect.objectContaining({
        id: run.id,
        status: "draft",
        lineCount: 3,
        paidLineCount: 0,
        distributableIdr: run.distributableIdr,
      }),
    ]);
  });
});

// ---- Rounding ----------------------------------------------------------------

describe("SH-02 rounding is exact and documented", () => {
  it("net profit Rp1.000.001, reserve 10%, shares 3333/3333/3334, tax 5%", async () => {
    // Hand-computed from DISTRIBUTION_ROUNDING (reserve half-up, split by
    // largest remainder, tax half-up per line):
    //   reserve        = round(1,000,001 x 10%)          = 100,000
    //   distributable  = 1,000,001 - 100,000             = 900,001
    //   floors         = 299,970 / 299,970 / 300,060 (sum 900,000), remainder 1
    //   the .3334 remainder (the 3334 bp holder) gets the extra rupiah
    //   gross          = 299,970 / 299,970 / 300,061
    //   tax (5% half-up) = 14,999 / 14,999 / 15,003 ; net = 284,971 / 284,971 / 285,058
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await draftRun(world);
    expect(run.periodNetProfitIdr).toBe(1_000_001);
    expect(run.reserveIdr).toBe(100_000);
    expect(run.distributableIdr).toBe(900_001);
    expect(run.totalGrossIdr).toBe(900_001);

    const sum = (pick: (line: DistributionRun["lines"][number]) => number) =>
      run.lines.reduce((total, line) => total + pick(line), 0);
    expect(sum((line) => line.grossIdr)).toBe(run.distributableIdr);
    expect(
      sum((line) => line.netIdr) + sum((line) => line.taxWithheldIdr),
    ).toBe(sum((line) => line.grossIdr));
    expect(run.totalTaxWithheldIdr).toBe(sum((line) => line.taxWithheldIdr));
    expect(run.totalNetIdr).toBe(sum((line) => line.netIdr));
    for (const line of run.lines)
      expect(line.grossIdr - line.taxWithheldIdr).toBe(line.netIdr);

    const bp = (shareBp: number) =>
      run.lines.filter((line) => line.shareBp === shareBp);
    expect(bp(3333)).toHaveLength(2);
    expect(bp(3334)).toHaveLength(1);
    for (const line of bp(3333)) {
      expect(line.grossIdr).toBe(299_970);
      expect(line.taxWithheldIdr).toBe(14_999);
      expect(line.netIdr).toBe(284_971);
    }
    expect(bp(3334)[0]).toMatchObject({
      shareholderId: s3.id,
      grossIdr: 300_061,
      taxWithheldIdr: 15_003,
      netIdr: 285_058,
    });
    expect(run.totalTaxWithheldIdr).toBe(45_001);
    expect(run.totalNetIdr).toBe(855_000);
  });

  it("a tie on the largest remainder goes to the lowest shareholderId", async () => {
    // reserve 0, tax 0, shares 50/50: 1,000,001 splits 500,000.5 / 500,000.5,
    // so the single leftover rupiah goes to the lower shareholderId.
    const world = await makeWorld({ reserveBp: 0, taxWithholdingBp: 0 }, [
      { holder: s4, bp: 5000 },
      { holder: s5, bp: 5000 },
    ]);
    const { run } = await draftRun(world);
    expect(run.distributableIdr).toBe(1_000_001);
    const [lowest, highest] = [...run.lines].sort((a, b) =>
      a.shareholderId < b.shareholderId ? -1 : 1,
    );
    expect(lowest!.grossIdr).toBe(500_001);
    expect(highest!.grossIdr).toBe(500_000);
    expect(lowest!.taxWithheldIdr).toBe(0);
    expect(lowest!.netIdr).toBe(500_001);
  });
});

// ---- Duplicate and idempotency ----------------------------------------------

describe("SH-04 one regular run per entity and closed period", () => {
  it("refuses a second regular run with DISTRIBUTION_ALREADY_EXISTS", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { period, run } = await draftRun(world);
    const second = await createRun(manager, world, period.id);
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(errorCode(second)).toBe("DISTRIBUTION_ALREADY_EXISTS");
    const list = listDistributionRuns.response.parse(
      (
        await get(
          manager,
          `/profit-entities/${world.profitEntityId}/distributions`,
        )
      ).body,
    );
    expect(list.data.map((row) => row.id)).toEqual([run.id]);
  });

  it("replays a create with the same key and body, refuses the same key with another body", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const first = await closedPeriod(world, NET_PROFIT);
    const second = await closedPeriod(world, NET_PROFIT);
    const k = key("run-replay");
    const created = await createRun(manager, world, first.id, k);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const replay = await createRun(manager, world, first.id, k);
    expect([200, 201]).toContain(replay.status);
    expect(parseRun(replay.body).id).toBe(parseRun(created.body).id);
    const clash = await createRun(manager, world, second.id, k);
    expect(clash.status, JSON.stringify(clash.body)).toBe(409);
    const list = listDistributionRuns.response.parse(
      (
        await get(
          manager,
          `/profit-entities/${world.profitEntityId}/distributions`,
        )
      ).body,
    );
    expect(list.data).toHaveLength(1);
  });

  it("replays submit, decision and payment commands without a second transition", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await draftRun(world);
    const submitKey = key("submit");
    const first = await submitRun(manager, run.id, submitKey);
    const replay = await submitRun(manager, run.id, submitKey);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(parseRun(replay.body).status).toBe("pending_approval");

    const decideKey = key("decide");
    const approved = await decideRun(approver, run.id, "approve", decideKey);
    const approvedAgain = await decideRun(
      approver,
      run.id,
      "approve",
      decideKey,
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approvedAgain.status, JSON.stringify(approvedAgain.body)).toBe(200);
    expect(parseRun(approvedAgain.body).approvedAt).toBe(
      parseRun(approved.body).approvedAt,
    );

    const line = parseRun(approved.body).lines[0]!;
    const payKey = key("pay");
    // A retry resends the identical body, including the same paidAt.
    const paidAt = new Date().toISOString();
    const paid = await payLine(
      manager,
      run.id,
      line.id,
      payKey,
      "REF-REPLAY-1",
      paidAt,
    );
    const paidAgain = await payLine(
      manager,
      run.id,
      line.id,
      payKey,
      "REF-REPLAY-1",
      paidAt,
    );
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paidAgain.status, JSON.stringify(paidAgain.body)).toBe(200);
    const after = parseRun(paidAgain.body);
    expect(after.lines.find((row) => row.id === line.id)?.paymentRef).toBe(
      "REF-REPLAY-1",
    );
    // A different key on the already paid line is a real second payment.
    const second = await payLine(manager, run.id, line.id, key("pay"), "REF-2");
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(errorCode(second)).toBe("DISTRIBUTION_LINE_ALREADY_PAID");
  });
});

// ---- Submit / decide / four-eyes --------------------------------------------

describe("SH-04 approval cycle (four-eyes)", () => {
  it("draft -> pending_approval -> approved, approver differs from requester", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await draftRun(world);

    const submitted = parseRun((await submitRun(manager, run.id)).body);
    expect(submitted.status).toBe("pending_approval");

    // The requester cannot approve even when allowed to (AUTH-06).
    const own = await draftRun(world);
    const ownSubmitted = await submitRun(dual, own.run.id);
    // `dual` did not create this run, so it cannot submit it (INVALID_TRANSITION).
    expect(ownSubmitted.status, JSON.stringify(ownSubmitted.body)).toBe(409);
    expect(errorCode(ownSubmitted)).toBe("INVALID_TRANSITION");

    const approved = await decideRun(approver, run.id);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(parseRun(approved.body)).toMatchObject({
      status: "approved",
      approvedBy: approver.userId,
      requestedBy: manager.userId,
    });
    expect(parseRun(approved.body).approvedAt).not.toBeNull();
  });

  it("refuses the requester deciding their own run (APPROVER_IS_REQUESTER)", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const period = await closedPeriod(world, NET_PROFIT);
    const created = await createRun(dual, world, period.id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const run = parseRun(created.body);
    expect((await submitRun(dual, run.id)).status).toBe(200);
    const self = await decideRun(dual, run.id);
    expect(self.status, JSON.stringify(self.body)).toBe(403);
    expect(errorCode(self)).toBe("APPROVER_IS_REQUESTER");
    expect(parseRun((await getRun(dual, run.id)).body).status).toBe(
      "pending_approval",
    );
  });

  it("refuses a decision from a user without the approve permission", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await pendingRun(world);
    const denied = await decideRun(manager, run.id);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(parseRun((await getRun(manager, run.id)).body).status).toBe(
      "pending_approval",
    );
  });

  it("a rejected run is cancelled and a new regular run may be calculated", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run, period } = await pendingRun(world);
    const rejected = await decideRun(approver, run.id, "reject");
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(parseRun(rejected.body).status).toBe("cancelled");
    // The cancelled run does not block a fresh calculation for the period.
    const fresh = await createRun(manager, world, period.id);
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
    expect(parseRun(fresh.body).id).not.toBe(run.id);
    expect(parseRun(fresh.body).status).toBe("draft");
    // A cancelled run cannot be approved or paid afterwards.
    const late = await decideRun(approver, run.id);
    expect(late.status, JSON.stringify(late.body)).toBe(409);
    expect(errorCode(late)).toBe("INVALID_TRANSITION");
  });

  it("a rejection without a note is a validation error", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await pendingRun(world);
    const response = await post(approver, `/distributions/${run.id}/decision`, {
      decision: "reject",
      note: null,
      idempotencyKey: key("decide"),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(errorCode(response)).toBe("VALIDATION_ERROR");
  });

  it("refuses to record a payment before approval", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await pendingRun(world);
    const early = await payLine(manager, run.id, run.lines[0]!.id);
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    expect(errorCode(early)).toBe("INVALID_TRANSITION");
  });
});

// ---- Payment, completion journal ---------------------------------------------

describe("§4 P step 4 payment and the completion journal", () => {
  it("pays each line; the last payment posts a balanced journal and the run is paid", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const approved = await approvedRun(world);
    const { run } = approved;
    expect(run.status).toBe("approved");

    // Pay all but the last line: the run stays approved, no journal yet.
    const [first, second, last] = run.lines;
    const afterFirst = parseRun(
      (await payLine(manager, run.id, first!.id, key("pay"), "TRF-001")).body,
    );
    expect(afterFirst.status).toBe("approved");
    expect(afterFirst.lines.find((l) => l.id === first!.id)).toMatchObject({
      paymentStatus: "paid",
      paymentRef: "TRF-001",
    });
    expect(
      afterFirst.lines.find((l) => l.id === second!.id)?.paymentStatus,
    ).toBe("pending");
    const mid = await payLine(
      manager,
      run.id,
      second!.id,
      key("pay"),
      "TRF-002",
    );
    expect(parseRun(mid.body).status).toBe("approved");
    expect(parseRun(mid.body).paidAt).toBeNull();
    const summaryMid = listDistributionRuns.response.parse(
      (
        await get(
          manager,
          `/profit-entities/${world.profitEntityId}/distributions`,
        )
      ).body,
    );
    expect(summaryMid.data[0]).toMatchObject({
      status: "approved",
      lineCount: 3,
      paidLineCount: 2,
    });
    const noJournalYet = await owner.query(
      "SELECT 1 FROM journal_entries WHERE tenant_id = $1 AND source_type = 'dividend' AND source_id = $2",
      [tenantA, run.id],
    );
    expect(noJournalYet.rowCount).toBe(0);

    const paidAt = new Date();
    const final = await post(
      manager,
      `/distributions/${run.id}/lines/${last!.id}/payment`,
      {
        paymentRef: "TRF-003",
        paidAt: paidAt.toISOString(),
        idempotencyKey: key("pay"),
      },
    );
    expect(final.status, JSON.stringify(final.body)).toBe(200);
    const paid = parseRun(final.body);
    expect(paid.status).toBe("paid");
    expect(paid.paidAt).not.toBeNull();
    expect(new Date(paid.paidAt!).getTime()).toBe(paidAt.getTime());
    expect(paid.lines.every((line) => line.paymentStatus === "paid")).toBe(
      true,
    );
    const journalId = await postedJournalId(run.id);
    expect(journalId).not.toBeNull();
    expect(paid.reversalJournalEntryId).toBeNull();

    // The journal: Dr retained earnings gross, Cr bank net, Cr tax payable tax.
    const journal = await journalOf(journalId as string);
    expect(journal.entry).toMatchObject({
      source_type: "dividend",
      source_id: run.id,
      legal_entity_id: world.legalEntityId,
      entry_date: jakartaDate(paidAt),
    });
    expect(journal.totalDebit).toBe(journal.totalCredit);
    expect(journal.byAccount(world.accounts.retainedEarnings)).toEqual({
      debit: 900_001,
      credit: 0,
    });
    expect(journal.byAccount(world.accounts.bank)).toEqual({
      debit: 0,
      credit: 855_000,
    });
    expect(journal.byAccount(world.accounts.dividendTaxPayable)).toEqual({
      debit: 0,
      credit: 45_001,
    });

    // The list now reports it as paid with every line paid.
    const summary = listDistributionRuns.response.parse(
      (
        await get(
          manager,
          `/profit-entities/${world.profitEntityId}/distributions`,
        )
      ).body,
    );
    expect(summary.data[0]).toMatchObject({
      status: "paid",
      lineCount: 3,
      paidLineCount: 3,
    });
    const paidList = listDistributionRuns.response.parse(
      (
        await get(
          manager,
          `/profit-entities/${world.profitEntityId}/distributions?status=approved`,
        )
      ).body,
    );
    expect(paidList.data).toEqual([]);
  });

  it("refuses a payment without a reference and a payment from a non-manager", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await approvedRun(world);
    const line = run.lines[0]!;
    const blank = await post(
      manager,
      `/distributions/${run.id}/lines/${line.id}/payment`,
      {
        paymentRef: "  ",
        paidAt: new Date().toISOString(),
        idempotencyKey: key("pay"),
      },
    );
    expect(blank.status, JSON.stringify(blank.body)).toBe(422);
    const denied = await payLine(approver, run.id, line.id);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    const unchanged = parseRun((await getRun(manager, run.id)).body);
    expect(unchanged.lines.every((l) => l.paymentStatus === "pending")).toBe(
      true,
    );
  });
});

// ---- Immutability (SH-04) ----------------------------------------------------

describe("SH-04 an approved run is immutable in the database", () => {
  it("refuses raw UPDATE and DELETE of the run and its lines", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await approvedRun(world);
    const line = run.lines[0]!;
    const runRow = () =>
      owner.query(
        `SELECT total_gross_idr::text AS gross, tax_withholding_bp, requested_by, status
         FROM distribution_runs WHERE tenant_id = $1 AND id = $2`,
        [tenantA, run.id],
      );
    const lineRow = () =>
      owner.query(
        `SELECT gross_idr::text AS gross, net_idr::text AS net, share_bp
         FROM distribution_lines WHERE tenant_id = $1 AND id = $2`,
        [tenantA, line.id],
      );
    const runBefore = (await runRow()).rows[0];
    const lineBefore = (await lineRow()).rows[0];

    // Each statement keeps every CHECK constraint true, so only the freeze
    // guard can refuse it.
    await expect(
      owner.query(
        "UPDATE distribution_runs SET tax_withholding_bp = tax_withholding_bp + 1 WHERE tenant_id = $1 AND id = $2",
        [tenantA, run.id],
      ),
    ).rejects.toThrow();
    await expect(
      owner.query(
        "UPDATE distribution_runs SET requested_by = 'someone-else' WHERE tenant_id = $1 AND id = $2",
        [tenantA, run.id],
      ),
    ).rejects.toThrow();
    await expect(
      owner.query(
        "UPDATE distribution_runs SET total_gross_idr = total_gross_idr + 1 WHERE tenant_id = $1 AND id = $2",
        [tenantA, run.id],
      ),
    ).rejects.toThrow();
    await expect(
      owner.query(
        "UPDATE distribution_lines SET gross_idr = gross_idr + 1, net_idr = net_idr + 1 WHERE tenant_id = $1 AND id = $2",
        [tenantA, line.id],
      ),
    ).rejects.toThrow();
    await expect(
      owner.query(
        "UPDATE distribution_lines SET share_bp = share_bp - 1 WHERE tenant_id = $1 AND id = $2",
        [tenantA, line.id],
      ),
    ).rejects.toThrow();
    await expect(
      owner.query(
        "DELETE FROM distribution_lines WHERE tenant_id = $1 AND id = $2",
        [tenantA, line.id],
      ),
    ).rejects.toThrow();
    await expect(
      owner.query(
        "DELETE FROM distribution_runs WHERE tenant_id = $1 AND id = $2",
        [tenantA, run.id],
      ),
    ).rejects.toThrow();
    await expect(
      owner.query(
        `INSERT INTO distribution_lines (tenant_id, distribution_run_id, shareholder_id, share_bp, gross_idr, tax_withheld_idr, net_idr, position)
         VALUES ($1, $2, $3, 100, 10, 0, 10, 9)`,
        [tenantA, run.id, s4.id],
      ),
    ).rejects.toThrow();

    expect((await runRow()).rows[0]).toEqual(runBefore);
    expect((await lineRow()).rows[0]).toEqual(lineBefore);
    // The run is still intact through the API.
    expect(parseRun((await getRun(manager, run.id)).body)).toEqual(run);
  });

  it("refuses to INSERT a run for an OPEN fiscal period (control: a closed one works)", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    // Periods close in order, so the closed one comes first.
    const closed = await closedPeriod(world, NET_PROFIT);
    const open = await openPeriod(
      world,
      periodKey(world.nextPeriod++),
      NET_PROFIT,
    );
    // A run and its lines are written in one transaction: the totals trigger
    // (deferred to commit) refuses a run whose lines do not match its totals.
    const insert = async (fiscalPeriodId: string, period: string) => {
      const { rows: periodRows } = await owner.query<{ version: number }>(
        "SELECT version FROM fiscal_periods WHERE tenant_id = $1 AND id = $2",
        [tenantA, fiscalPeriodId],
      );
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{ id: string }>(
          `INSERT INTO distribution_runs
           (tenant_id, profit_entity_id, fiscal_period_id, fiscal_period_version, period, type, basis, status,
            share_version, period_net_profit_idr, reserve_idr, distributable_idr,
            total_gross_idr, total_tax_withheld_idr, total_net_idr, tax_withholding_bp,
            requested_by, idempotency_key)
         VALUES ($1, $2, $3, $7, $4, 'regular', 'closed_period_net_profit', 'draft',
                 1, 1000, 100, 900, 900, 0, 900, 0, $5, $6)
         RETURNING id`,
          [
            tenantA,
            world.profitEntityId,
            fiscalPeriodId,
            period,
            manager.userId,
            key("raw-run"),
            periodRows[0]!.version,
          ],
        );
        await client.query(
          `INSERT INTO distribution_lines
             (tenant_id, distribution_run_id, shareholder_id, share_bp,
              gross_idr, tax_withheld_idr, net_idr, position)
           VALUES ($1, $2, $3, 10000, 900, 0, 900, 0)`,
          [tenantA, result.rows[0]!.id, s1.id],
        );
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    await expect(insert(open.id, open.period)).rejects.toThrow();
    await expect(insert(closed.id, closed.period)).resolves.toBeDefined();
    const rows = await owner.query(
      "SELECT fiscal_period_id FROM distribution_runs WHERE tenant_id = $1 AND profit_entity_id = $2",
      [tenantA, world.profitEntityId],
    );
    expect(rows.rows.map((row) => row.fiscal_period_id)).toEqual([closed.id]);
  });

  it("the API refuses to edit or re-submit an approved run", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await approvedRun(world);
    const again = await submitRun(manager, run.id);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    const decideAgain = await decideRun(approver, run.id, "reject");
    expect(decideAgain.status, JSON.stringify(decideAgain.body)).toBe(409);
    expect(parseRun((await getRun(manager, run.id)).body)).toEqual(run);
  });
});

// ---- Adjustments (SH-04) -----------------------------------------------------

describe("SH-04 adjustment runs correct an approved or paid run", () => {
  it("a positive adjustment is a NEW run with new lines; the original is untouched", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run: original, period } = await paidRun(world);
    const before = parseRun((await getRun(manager, original.id)).body);

    const response = await adjust(manager, original.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: 100_000,
      reason: "Beban akhir tahun terlambat dicatat",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const adjustment = parseRun(response.body);
    expect(adjustment.id).not.toBe(original.id);
    expect(adjustment).toMatchObject({
      type: "adjustment",
      basis: "approved_run_adjustment",
      status: "draft",
      adjustsRunId: original.id,
      adjustmentReason: "Beban akhir tahun terlambat dicatat",
      periodNetProfitIdr: null,
      reserveIdr: 0,
      distributableIdr: 100_000,
      shareVersion: original.shareVersion,
    });
    expect(adjustment.lines).toHaveLength(3);
    // New lines, same split as the corrected run.
    const originalIds = new Set(original.lines.map((line) => line.id));
    for (const line of adjustment.lines)
      expect(originalIds.has(line.id)).toBe(false);
    const split = (lines: DistributionRun["lines"]) =>
      lines.map((line) => `${line.shareholderId}:${line.shareBp}`).sort();
    expect(split(adjustment.lines)).toEqual(split(original.lines));
    expect(adjustment.lines.reduce((sum, line) => sum + line.grossIdr, 0)).toBe(
      100_000,
    );
    expect(adjustment.totalNetIdr + adjustment.totalTaxWithheldIdr).toBe(
      100_000,
    );
    // Frozen tax rate of the corrected run (5%): 100,000 -> 33,330/33,330/33,340.
    expect(adjustment.lines.map((line) => line.grossIdr).sort()).toEqual([
      33_330, 33_330, 33_340,
    ]);

    // The corrected run never changes.
    expect(parseRun((await getRun(manager, original.id)).body)).toEqual(before);

    // The adjustment runs the same cycle and posts its own journal.
    const submitted = parseRun((await submitRun(manager, adjustment.id)).body);
    expect(submitted.status).toBe("pending_approval");
    const approved = parseRun((await decideRun(approver, adjustment.id)).body);
    const paid = await payAll(manager, approved);
    expect(paid.status).toBe("paid");
    const journalId = await postedJournalId(adjustment.id);
    expect(journalId).not.toBeNull();
    expect(paid.reversalJournalEntryId).toBeNull();
    const journal = await journalOf(journalId as string);
    expect(journal.entry.source_id).toBe(adjustment.id);
    expect(journal.totalDebit).toBe(journal.totalCredit);
    expect(journal.byAccount(world.accounts.retainedEarnings).debit).toBe(
      100_000,
    );
    expect(journal.byAccount(world.accounts.bank).credit).toBe(
      paid.totalNetIdr,
    );
    expect(journal.byAccount(world.accounts.dividendTaxPayable).credit).toBe(
      paid.totalTaxWithheldIdr,
    );
    expect(parseRun((await getRun(manager, original.id)).body)).toEqual(before);
  });

  it("a negative adjustment claws back and posts a mirrored (reversal) journal", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run: original, period } = await paidRun(world);
    const before = parseRun((await getRun(manager, original.id)).body);

    const response = await adjust(manager, original.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: -100_000,
      reason: "Pembayaran berlebih dikoreksi",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const adjustment = parseRun(response.body);
    expect(adjustment).toMatchObject({
      type: "adjustment",
      adjustsRunId: original.id,
      distributableIdr: -100_000,
      totalGrossIdr: -100_000,
    });
    for (const line of adjustment.lines) {
      expect(line.grossIdr).toBeLessThan(0);
      expect(line.grossIdr - line.taxWithheldIdr).toBe(line.netIdr);
    }
    expect(adjustment.lines.reduce((sum, line) => sum + line.grossIdr, 0)).toBe(
      -100_000,
    );

    await submitRun(manager, adjustment.id);
    const approved = parseRun((await decideRun(approver, adjustment.id)).body);
    expect(approved.status).toBe("approved");
    const paid = await payAll(manager, approved);
    expect(paid.status).toBe("paid");
    expect(paid.reversalJournalEntryId).not.toBeNull();
    expect(await postedJournalId(adjustment.id)).toBeNull();

    // Mirrored entry: Dr bank |net|, Dr tax payable |tax|, Cr retained |gross|.
    const journal = await journalOf(paid.reversalJournalEntryId as string);
    expect(journal.entry).toMatchObject({
      source_type: "dividend",
      source_id: adjustment.id,
    });
    expect(journal.totalDebit).toBe(journal.totalCredit);
    expect(journal.byAccount(world.accounts.retainedEarnings)).toEqual({
      debit: 0,
      credit: 100_000,
    });
    expect(journal.byAccount(world.accounts.bank)).toEqual({
      debit: Math.abs(paid.totalNetIdr),
      credit: 0,
    });
    expect(journal.byAccount(world.accounts.dividendTaxPayable)).toEqual({
      debit: Math.abs(paid.totalTaxWithheldIdr),
      credit: 0,
    });

    // The original run and its journal are unchanged.
    expect(parseRun((await getRun(manager, original.id)).body)).toEqual(before);
  });

  it("an adjustment may also correct an approved (not yet paid) run", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run, period } = await approvedRun(world);
    const response = await adjust(manager, run.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: 30_000,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(parseRun(response.body).adjustsRunId).toBe(run.id);
    expect(parseRun((await getRun(manager, run.id)).body)).toEqual(run);
  });

  it("refuses an adjustment on a draft or pending run (ADJUSTMENT_TARGET_INVALID)", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run: draft, period } = await draftRun(world);
    const onDraft = await adjust(manager, draft.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: 50_000,
    });
    expect(onDraft.status, JSON.stringify(onDraft.body)).toBe(422);
    expect(errorCode(onDraft)).toBe("ADJUSTMENT_TARGET_INVALID");

    const submitted = await submitRun(manager, draft.id);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const onPending = await adjust(manager, draft.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: 50_000,
    });
    expect(onPending.status, JSON.stringify(onPending.body)).toBe(422);
    expect(errorCode(onPending)).toBe("ADJUSTMENT_TARGET_INVALID");

    // No adjustment row was created for the entity.
    const list = listDistributionRuns.response.parse(
      (
        await get(
          manager,
          `/profit-entities/${world.profitEntityId}/distributions`,
        )
      ).body,
    );
    expect(list.data.map((row) => row.type)).toEqual(["regular"]);
  });

  it("refuses an adjustment on an open period, a zero amount and an unknown run", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await approvedRun(world);
    const open = await openPeriod(world, periodKey(world.nextPeriod++), 1_000);
    const onOpen = await adjust(manager, run.id, {
      fiscalPeriodId: open.id,
      adjustmentIdr: 10_000,
    });
    expect(onOpen.status, JSON.stringify(onOpen.body)).toBe(409);
    expect(errorCode(onOpen)).toBe("PERIOD_NOT_CLOSED");
    const zero = await adjust(manager, run.id, {
      fiscalPeriodId: run.fiscalPeriodId,
      adjustmentIdr: 0,
    });
    expect(zero.status, JSON.stringify(zero.body)).toBe(422);
    expect(errorCode(zero)).toBe("VALIDATION_ERROR");
    const unknown = await adjust(manager, randomUUID(), {
      fiscalPeriodId: run.fiscalPeriodId,
      adjustmentIdr: 10_000,
    });
    expect([404, 422]).toContain(unknown.status);
  });
});

// ---- Statements and the shareholder self view (SH-01) ------------------------

describe("SH-01 statements and my-profit-share show only the caller's rows", () => {
  it("statement: manager and the line's own shareholder read it, any other gets 404", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await paidRun(world);
    const line1 = run.lines.find((line) => line.shareholderId === s1.id)!;
    const path = `/distributions/${run.id}/lines/${line1.id}/statement`;

    const byManager = await get(manager, path);
    expect(byManager.status, JSON.stringify(byManager.body)).toBe(200);
    const statement = distributionStatementSchema.parse(byManager.body.data);
    expect(statement).toMatchObject({
      distributionRunId: run.id,
      distributionLineId: line1.id,
      shareholderId: s1.id,
      shareholderName: s1.name,
      basis: "closed_period",
      period: run.period,
      runType: "regular",
      adjustsRunId: null,
      shareBp: line1.shareBp,
      grossIdr: line1.grossIdr,
      taxWithheldIdr: line1.taxWithheldIdr,
      netIdr: line1.netIdr,
      paymentStatus: "paid",
      paymentRef: line1.paymentRef,
    });
    // Nobody else's name is in the document.
    expect(JSON.stringify(byManager.body)).not.toContain(s2.name);
    expect(JSON.stringify(byManager.body)).not.toContain(s3.name);

    const own = await get(sh1User, path);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(distributionStatementSchema.parse(own.body.data)).toMatchObject({
      shareholderId: s1.id,
      netIdr: line1.netIdr,
    });

    // Another shareholder never learns the line exists.
    const other = await get(sh2User, path);
    expect(other.status, JSON.stringify(other.body)).toBe(404);
    expect(errorCode(other)).toBe("NOT_FOUND");
    // An unknown line looks exactly the same.
    const unknown = await get(
      sh2User,
      `/distributions/${run.id}/lines/${randomUUID()}/statement`,
    );
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(404);
    expect(errorCode(unknown)).toBe("NOT_FOUND");
  });

  it("my-profit-share returns holdings, share history and statements of the caller only", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await paidRun(world);
    const line1 = run.lines.find((line) => line.shareholderId === s1.id)!;

    const mine = await get(sh1User, "/my-profit-share");
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const view = myProfitShareSchema.parse(mine.body.data);
    expect(view.shareholderId).toBe(s1.id);
    expect(view.shareholderName).toBe(s1.name);
    expect(view.holdings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profitEntityId: world.profitEntityId,
          version: 1,
          shareBp: 3333,
        }),
      ]),
    );
    expect(view.shareHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profitEntityId: world.profitEntityId,
          version: 1,
          shareBp: 3333,
        }),
      ]),
    );
    expect(view.distributionHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          distributionRunId: run.id,
          distributionLineId: line1.id,
          grossIdr: line1.grossIdr,
          netIdr: line1.netIdr,
        }),
      ]),
    );
    for (const statement of view.distributionHistory)
      expect(statement.shareholderId).toBe(s1.id);
    // None of the other shareholders' identity or lines leaks.
    const text = JSON.stringify(mine.body);
    for (const other of [s2, s3]) expect(text).not.toContain(other.name);
    for (const other of run.lines.filter((l) => l.shareholderId !== s1.id))
      expect(text).not.toContain(other.id);
    expect(
      view.estimates.every((estimate) => estimate.label === "estimate"),
    ).toBe(true);

    // Shareholder 2 sees their own line, not shareholder 1's.
    const theirs = myProfitShareSchema.parse(
      (await get(sh2User, "/my-profit-share")).body.data,
    );
    expect(theirs.shareholderId).toBe(s2.id);
    expect(
      theirs.distributionHistory.some(
        (statement) => statement.distributionLineId === line1.id,
      ),
    ).toBe(false);
    for (const statement of theirs.distributionHistory)
      expect(statement.shareholderId).toBe(s2.id);
  });

  it("my-profit-share leaves out a zero line settled by the carry", async () => {
    const { run } = await paidRunWithAbsorbedHolders();
    const zero = run.lines.find((line) => line.shareholderId === s1.id)!;
    expect(zero.grossIdr).toBe(0);
    const response = await get(sh1User, "/my-profit-share");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const view = myProfitShareSchema.parse(response.body.data);
    expect(
      view.distributionHistory.some(
        (statement) => statement.distributionLineId === zero.id,
      ),
    ).toBe(false);
  });

  it("the list counts a carry-settled zero line as paid but not as money out", async () => {
    const { world, approved } = await approvedRunWithAbsorbedHolders();
    const list = listDistributionRuns.response.parse(
      (
        await get(
          manager,
          `/profit-entities/${world.profitEntityId}/distributions`,
        )
      ).body,
    );
    const row = list.data.find((entry) => entry.id === approved.id)!;
    expect(row.status).toBe("approved");
    expect(row.paidLineCount).toBeGreaterThan(0);
    expect(row.moneyPaidLineCount).toBe(0);
  });

  it("a shareholder cannot use the manager endpoints", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await approvedRun(world);
    expect((await getRun(sh1User, run.id)).status).toBe(403);
    expect((await payLine(sh1User, run.id, run.lines[0]!.id)).status).toBe(403);
    const list = await get(
      sh1User,
      `/profit-entities/${world.profitEntityId}/distributions`,
    );
    expect(list.status, JSON.stringify(list.body)).toBe(403);
  });
});

// ---- Tenant isolation (TEN-01) -----------------------------------------------

describe("TEN-01 another tenant cannot see or change a distribution run", () => {
  it("tenant B gets 404 on get, decide, payment and statement of tenant A's run", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await approvedRun(world);
    const line = run.lines[0]!;

    const got = await getRun(managerB, run.id);
    expect(got.status, JSON.stringify(got.body)).toBe(404);
    expect(errorCode(got)).toBe("NOT_FOUND");
    const decided = await decideRun(approverB, run.id, "reject");
    expect(decided.status, JSON.stringify(decided.body)).toBe(404);
    const paid = await payLine(managerB, run.id, line.id);
    expect(paid.status, JSON.stringify(paid.body)).toBe(404);
    const statement = await get(
      managerB,
      `/distributions/${run.id}/lines/${line.id}/statement`,
    );
    expect(statement.status, JSON.stringify(statement.body)).toBe(404);
    const submitted = await submitRun(managerB, run.id);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(404);
    const adjusted = await adjust(managerB, run.id, {
      fiscalPeriodId: run.fiscalPeriodId,
      adjustmentIdr: 10_000,
    });
    expect([404, 422]).toContain(adjusted.status);

    // Tenant A's run is untouched, and the same calls work for tenant A.
    expect(parseRun((await getRun(manager, run.id)).body)).toEqual(run);
    const ok = await payLine(manager, run.id, line.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("tenant B cannot run a distribution for tenant A's entity or period", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const period = await closedPeriod(world, NET_PROFIT);
    const response = await createRun(managerB, world, period.id);
    expect([404, 422]).toContain(response.status);
    const list = await get(
      managerB,
      `/profit-entities/${world.profitEntityId}/distributions`,
    );
    expect(
      list.status === 404 ||
        (list.status === 200 && list.body.data.length === 0),
    ).toBe(true);
    // Nothing was created for tenant A's entity.
    const rows = await owner.query(
      "SELECT 1 FROM distribution_runs WHERE tenant_id = $1 AND profit_entity_id = $2",
      [tenantA, world.profitEntityId],
    );
    expect(rows.rowCount).toBe(0);
  });
});

// ---- Architect review gaps (fail-first) ---------------------------------------
//
// Assumptions for this block:
// - paidAt must lie in [approvedAt, now]; anything else is 422.
// - A last payment whose paidAt falls in a closed month still completes the run;
//   its journal is posted into the first open period and marked as a late
//   adjustment (`late_adjustment_from` set). Only that is asserted, not the
//   exact entry date.
// - Approvals are backdated in SQL (pending -> approved) so a payment date can
//   lie in an old, closed month while still being after approvedAt.
// - Errors: PERIOD_CHANGED 409, ADJUSTMENT_EXCEEDS_PAID 422,
//   IDEMPOTENCY_KEY_REUSED 409.

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

const payLineAt = (who: Person, runId: string, lineId: string, paidAt: Date) =>
  post(who, `/distributions/${runId}/lines/${lineId}/payment`, {
    paymentRef: `TRF-${unique()}`,
    paidAt: paidAt.toISOString(),
    idempotencyKey: key("pay"),
  });

/** A submitted run approved by `approver` with approved_at moved back (requested_at is frozen once pending). */
async function backdatedApprovedRun(world: World, approvedAt: Date) {
  const pending = await pendingRun(world);
  await owner.query(
    `UPDATE distribution_runs SET status = 'approved', approved_by = $3, approved_at = $4
     WHERE tenant_id = $1 AND id = $2`,
    [tenantA, pending.run.id, approver.userId, approvedAt],
  );
  const fresh = await getRun(manager, pending.run.id);
  expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
  return { ...pending, run: parseRun(fresh.body) };
}

describe("review (a)-(c) payment dates", () => {
  it("(a) a last payment dated in a CLOSED month still completes the run with a late-adjustment journal", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run, period } = await backdatedApprovedRun(
      world,
      new Date("2021-01-20T03:00:00Z"),
    );
    expect(period.period).toBe("2021-01");
    const closedMonthPayment = new Date("2021-01-25T03:00:00Z");
    let last = null;
    for (const line of run.lines) {
      last = await payLineAt(manager, run.id, line.id, closedMonthPayment);
      expect(last.status, JSON.stringify(last.body)).toBe(200);
    }
    const paid = parseRun(last!.body);
    expect(paid.status).toBe("paid");
    const journalId = await postedJournalId(run.id);
    expect(journalId).not.toBeNull();
    const journal = await journalOf(journalId as string);
    expect(journal.totalDebit).toBe(journal.totalCredit);
    expect(journal.byAccount(world.accounts.retainedEarnings).debit).toBe(
      paid.totalGrossIdr,
    );
    // The entry sits in an OPEN period and is flagged as a late adjustment.
    const placed = await owner.query<{
      status: string;
      late_adjustment_from: string | null;
    }>(
      `SELECT fp.status, je.late_adjustment_from::text AS late_adjustment_from
       FROM journal_entries je
       JOIN fiscal_periods fp ON fp.tenant_id = je.tenant_id AND fp.id = je.fiscal_period_id
       WHERE je.tenant_id = $1 AND je.id = $2`,
      [tenantA, journalId],
    );
    expect(placed.rows[0]!.status).toBe("open");
    expect(placed.rows[0]!.late_adjustment_from).not.toBeNull();
  });

  it("(b) paidAt before approvedAt or in the future is refused with 422", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await approvedRun(world);
    const line = run.lines[0]!;
    const before = new Date(new Date(run.approvedAt!).getTime() - 86_400_000);
    const early = await payLineAt(manager, run.id, line.id, before);
    expect(early.status, JSON.stringify(early.body)).toBe(422);
    const future = await payLineAt(
      manager,
      run.id,
      line.id,
      new Date(Date.now() + 86_400_000),
    );
    expect(future.status, JSON.stringify(future.body)).toBe(422);
    const unchanged = parseRun((await getRun(manager, run.id)).body);
    expect(unchanged.lines.every((l) => l.paymentStatus === "pending")).toBe(
      true,
    );
    // Control: a date between approval and now is accepted.
    const ok = await payLineAt(manager, run.id, line.id, new Date());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("(c) run.paidAt is the LATEST line paidAt, not the last one recorded", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await backdatedApprovedRun(world, hoursAgo(48));
    const latest = hoursAgo(1);
    const [a, b, c] = run.lines;
    expect((await payLineAt(manager, run.id, a!.id, latest)).status).toBe(200);
    expect((await payLineAt(manager, run.id, b!.id, hoursAgo(3))).status).toBe(
      200,
    );
    const final = await payLineAt(manager, run.id, c!.id, hoursAgo(2));
    expect(final.status, JSON.stringify(final.body)).toBe(200);
    const paid = parseRun(final.body);
    expect(paid.status).toBe("paid");
    expect(new Date(paid.paidAt!).getTime()).toBe(latest.getTime());
  });
});

describe("review (d) the fiscal period changed after the run was calculated", () => {
  it("(d) approving after a reopen (and after a re-close) is refused with PERIOD_CHANGED", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run, period } = await pendingRun(world);
    const scope = scopedContext();
    const requester = userIdSchema.parse(randomUUID());
    const reopenApprover = userIdSchema.parse(randomUUID());
    const request = await requestPeriodReopen(
      scope,
      period.id,
      { reason: "Koreksi biaya sewa" },
      requester,
    );
    await approvePeriodReopen(
      scope,
      request.id,
      { note: null },
      reopenApprover,
    );

    const afterReopen = await decideRun(approver, run.id);
    expect(afterReopen.status, JSON.stringify(afterReopen.body)).toBe(409);
    expect(errorCode(afterReopen)).toBe("PERIOD_CHANGED");
    expect(parseRun((await getRun(manager, run.id)).body).status).toBe(
      "pending_approval",
    );

    // Closed again: the version moved on, so the run is still stale.
    await closeFiscalPeriod(
      scope,
      period.id,
      { expectedVersion: 3, idempotencyKey: `close-${randomUUID()}` },
      userIdSchema.parse(closer),
    );
    const afterReclose = await decideRun(approver, run.id);
    expect(afterReclose.status, JSON.stringify(afterReclose.body)).toBe(409);
    expect(errorCode(afterReclose)).toBe("PERIOD_CHANGED");
    expect(parseRun((await getRun(manager, run.id)).body).status).toBe(
      "pending_approval",
    );
  });
});

describe("review (e)-(g) database guards", () => {
  it("(e) refuses raw UPDATE of a draft run's fiscal_period_id, period and share_version", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await draftRun(world);
    const other = await closedPeriod(world, NET_PROFIT);
    // A second approved version, so the share_version FK would accept it.
    await seedVersion(
      world.profitEntityId,
      roundingShares(),
      "approved",
      "2020-06-01",
      2,
    );
    const row = () =>
      owner.query(
        `SELECT fiscal_period_id, period, share_version
         FROM distribution_runs WHERE tenant_id = $1 AND id = $2`,
        [tenantA, run.id],
      );
    const before = (await row()).rows[0];
    for (const [set, params] of [
      ["fiscal_period_id = $3", [other.id]],
      ["period = $3", ["2099-12"]],
      ["share_version = $3", [2]],
    ] as const)
      await expect(
        owner.query(
          `UPDATE distribution_runs SET ${set} WHERE tenant_id = $1 AND id = $2`,
          [tenantA, run.id, ...params],
        ),
        set,
      ).rejects.toThrow();
    expect((await row()).rows[0]).toEqual(before);
  });

  it("(f) refuses raw SQL setting a run to paid without a journal id", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await approvedRun(world);
    // Paying the lines in SQL is allowed on an approved run: isolates the journal rule.
    await owner.query(
      `UPDATE distribution_lines
       SET payment_status = 'paid', payment_ref = 'RAW-1', paid_at = now(), paid_by = $3
       WHERE tenant_id = $1 AND distribution_run_id = $2`,
      [tenantA, run.id, manager.userId],
    );
    await expect(
      owner.query(
        `UPDATE distribution_runs SET status = 'paid', paid_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantA, run.id],
      ),
    ).rejects.toThrow();
    const row = await owner.query(
      "SELECT status, journal_entry_id FROM distribution_runs WHERE tenant_id = $1 AND id = $2",
      [tenantA, run.id],
    );
    expect(row.rows[0]).toEqual({ status: "approved", journal_entry_id: null });
  });

  it("(g) refuses a line with gross 100 and tax -5 or tax 150 (control: tax 10 is accepted)", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await draftRun(world);
    // The bad rows fail at the line CHECK right away, so a plain INSERT suffices.
    const badLine = (tax: number) =>
      owner.query(
        `INSERT INTO distribution_lines
           (tenant_id, distribution_run_id, shareholder_id, share_bp, gross_idr, tax_withheld_idr, net_idr, position)
         VALUES ($1, $2, $3, 100, 100, $4, $5, 9)`,
        [tenantA, run.id, s5.id, tax, 100 - tax],
      );
    await expect(badLine(-5)).rejects.toThrow();
    await expect(badLine(150)).rejects.toThrow();

    // Control: a raw draft run (gross 100 / tax 10 / net 90) with its line, written
    // in one transaction because the totals check is deferred to commit.
    const other = await closedPeriod(world, NET_PROFIT);
    const { rows: periodRows } = await owner.query<{ version: number }>(
      "SELECT version FROM fiscal_periods WHERE tenant_id = $1 AND id = $2",
      [tenantA, other.id],
    );
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO distribution_runs
           (tenant_id, profit_entity_id, fiscal_period_id, fiscal_period_version, period, type, basis, status,
            share_version, period_net_profit_idr, reserve_idr, distributable_idr,
            total_gross_idr, total_tax_withheld_idr, total_net_idr, tax_withholding_bp,
            requested_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'regular', 'closed_period_net_profit', 'draft',
                 1, 200, 100, 100, 100, 10, 90, 1000, $6, $7)
         RETURNING id`,
        [
          tenantA,
          world.profitEntityId,
          other.id,
          periodRows[0]!.version,
          other.period,
          manager.userId,
          key("raw-run"),
        ],
      );
      await client.query(
        `INSERT INTO distribution_lines
           (tenant_id, distribution_run_id, shareholder_id, share_bp, gross_idr, tax_withheld_idr, net_idr, position)
         VALUES ($1, $2, $3, 10000, 100, 10, 90, 0)`,
        [tenantA, inserted.rows[0]!.id, s4.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
});

describe("review (h) founder rule Q83: a claw-back never takes a shareholder below zero", () => {
  const fixedKey = key("adj-fixed");
  const adjustWithKey = (runId: string, periodId: string, amount: number) =>
    post(manager, `/distributions/${runId}/adjustment`, {
      reason: "Koreksi angka",
      idempotencyKey: fixedKey,
      fiscalPeriodId: periodId,
      adjustmentIdr: amount,
    });

  it("(h1) a claw-back above the paid total is clamped per shareholder, the rest is recorded open and the reversal journal mirrors only what was absorbed", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run: original, period } = await paidRun(world);
    const paidGross = original.lines.reduce(
      (sum, line) => sum + line.grossIdr,
      0,
    );
    expect(paidGross).toBe(900_001);
    const response = await adjust(manager, original.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: -1_500_000,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const adjustment = parseRun(response.body);
    // Each line is clamped to that shareholder's own paid gross; nothing is
    // moved to another shareholder.
    for (const line of original.lines) {
      const clamped = adjustment.lines.find(
        (item) => item.shareholderId === line.shareholderId,
      );
      expect(clamped?.grossIdr).toBe(-line.grossIdr);
    }
    expect(adjustment.distributableIdr).toBe(-900_001);
    expect(adjustment.totalGrossIdr).toBe(-900_001);
    expect(adjustment.unabsorbedIdr).toBe(599_999);

    await submitRun(manager, adjustment.id);
    const approved = parseRun((await decideRun(approver, adjustment.id)).body);
    const paid = await payAll(manager, approved);
    expect(paid.status).toBe("paid");
    expect(paid.unabsorbedIdr).toBe(599_999);
    expect(paid.reversalJournalEntryId).not.toBeNull();
    const journal = await journalOf(paid.reversalJournalEntryId as string);
    expect(journal.totalDebit).toBe(journal.totalCredit);
    expect(journal.byAccount(world.accounts.retainedEarnings)).toEqual({
      debit: 0,
      credit: 900_001,
    });

    // Nothing is left to claw back: the next request is refused.
    const more = await adjust(manager, original.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: -1000,
    });
    expect(more.status, JSON.stringify(more.body)).toBe(422);
    expect(errorCode(more)).toBe("ADJUSTMENT_EXCEEDS_PAID");
  });

  it("(h2) a shareholder with nothing left gets no line and the remainder is not charged to the others", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run: original, period } = await paidRun(world);
    const gross = new Map(
      original.lines.map((line) => [line.shareholderId, line.grossIdr]),
    );
    // -300,000 and -600,000 split exactly 33.33/33.33/33.34 %: they leave
    // 0, 0 and 1 rupiah of paid gross.
    for (const amount of [-300_000, -600_000]) {
      const step = await adjust(manager, original.id, {
        fiscalPeriodId: period.id,
        adjustmentIdr: amount,
      });
      expect(step.status, JSON.stringify(step.body)).toBe(201);
      expect(parseRun(step.body).unabsorbedIdr).toBe(0);
    }
    const third = await adjust(manager, original.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: -300_000,
    });
    expect(third.status, JSON.stringify(third.body)).toBe(201);
    const adjustment = parseRun(third.body);
    const holderWithRupiahLeft = [...gross.entries()].find(
      ([, value]) => value === 300_061,
    )![0];
    expect(adjustment.lines).toHaveLength(1);
    expect(adjustment.lines[0]).toMatchObject({
      shareholderId: holderWithRupiahLeft,
      grossIdr: -1,
    });
    expect(adjustment.distributableIdr).toBe(-1);
    expect(adjustment.unabsorbedIdr).toBe(299_999);
  });

  it("(h4) an adjustment can only correct a regular run, so a top-up's room is never counted twice", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run: original, period } = await paidRun(world);
    const topUp = await adjust(manager, original.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: 500_000,
    });
    expect(topUp.status, JSON.stringify(topUp.body)).toBe(201);
    const topUpRun = parseRun(topUp.body);
    await submitRun(manager, topUpRun.id);
    expect((await decideRun(approver, topUpRun.id)).status).toBe(200);
    // Correcting the approved top-up itself is refused: its room is counted
    // against the regular run only.
    const onTopUp = await adjust(manager, topUpRun.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: -100_000,
    });
    expect(onTopUp.status, JSON.stringify(onTopUp.body)).toBe(422);
    expect(errorCode(onTopUp)).toBe("ADJUSTMENT_TARGET_INVALID");
  });

  it("(h5) a top-up that is not approved yet is no room for a claw-back", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run: original, period } = await paidRun(world);
    const draftTopUp = await adjust(manager, original.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: 500_000,
    });
    expect(draftTopUp.status, JSON.stringify(draftTopUp.body)).toBe(201);
    const clawBack = await adjust(manager, original.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: -1_500_000,
    });
    expect(clawBack.status, JSON.stringify(clawBack.body)).toBe(201);
    const run = parseRun(clawBack.body);
    // Room is the 900,001 paid, not 1,400,001.
    expect(run.distributableIdr).toBe(-900_001);
    expect(run.unabsorbedIdr).toBe(599_999);
  });

  it("(h3) the same clamped request replays to the same run", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run: original, period } = await paidRun(world);
    const first = await adjustWithKey(original.id, period.id, -1_500_000);
    const again = await adjustWithKey(original.id, period.id, -1_500_000);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(parseRun(again.body).id).toBe(parseRun(first.body).id);
    // A different amount under the same key is still a reuse error.
    const other = await adjustWithKey(original.id, period.id, -1_400_000);
    expect(errorCode(other)).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("review (i) idempotency key reuse", () => {
  it("(i) a key of an existing run on a different create is IDEMPOTENCY_KEY_REUSED", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const first = await closedPeriod(world, NET_PROFIT);
    const second = await closedPeriod(world, NET_PROFIT);
    const k = key("run-reuse");
    expect((await createRun(manager, world, first.id, k)).status).toBe(201);
    // Same key, other period: not DISTRIBUTION_ALREADY_EXISTS.
    const other = await createRun(manager, world, second.id, k);
    expect(other.status, JSON.stringify(other.body)).toBe(409);
    expect(errorCode(other)).toBe("IDEMPOTENCY_KEY_REUSED");

    // The same key on an adjustment create is a different request as well.
    const approved = await approvedRun(world);
    const adjKey = key("adj-reuse");
    const asAdjustment = await post(
      manager,
      `/distributions/${approved.run.id}/adjustment`,
      {
        fiscalPeriodId: approved.period.id,
        adjustmentIdr: 10_000,
        reason: "Koreksi",
        idempotencyKey: adjKey,
      },
    );
    expect(asAdjustment.status).toBe(201);
    const reuse = await createRun(manager, world, second.id, adjKey);
    expect(reuse.status, JSON.stringify(reuse.body)).toBe(409);
    expect(errorCode(reuse)).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("review (S5) the production statement issuer is wired at startup", () => {
  it("a payment through the default router stores the PDF and sets the line key", async () => {
    // The router in buildApp uses the default dependencies, exactly like
    // server.ts: only the installer decides which storage and email they hold.
    const storage = new FakeObjectStorage();
    const email = new FakeEmailProvider();
    installProfitShareStatementPorts({}, { storage, email });
    try {
      const world = await makeWorld(roundingPolicy, roundingShares());
      const { run } = await paidRun(world);
      for (const line of run.lines) {
        const row = await owner.query<{ statement_file_key: string | null }>(
          "select statement_file_key from distribution_lines where id = $1",
          [line.id],
        );
        expect(row.rows[0]?.statement_file_key).toBe(statementFileKey(line.id));
        const stored = await storage.get(scopedContext(), {
          tenantId: tenantA,
          outletId: null,
          reference: `s5-read:${line.id}`,
          key: statementFileKey(line.id),
          visibility: "private",
        });
        expect(stored.contentType).toBe("application/pdf");
        expect(
          Buffer.from(stored.content as Uint8Array)
            .subarray(0, 5)
            .toString(),
        ).toBe("%PDF-");
      }
    } finally {
      configureProfitShareStatementDeps({});
    }
  });
});

// ---- Q83 carry: an unabsorbed claw-back shortfall is cut from the next split ---

type ShortfallRow = {
  id: string;
  shareholder_id: string;
  distribution_run_id: string;
  amount: number;
};

async function shortfallsOf(runId: string): Promise<ShortfallRow[]> {
  const { rows } = await owner.query<{
    id: string;
    shareholder_id: string;
    distribution_run_id: string;
    amount: string;
  }>(
    `SELECT id, shareholder_id, distribution_run_id, amount_idr::text AS amount
     FROM distribution_run_shortfalls
     WHERE tenant_id = $1 AND distribution_run_id = $2
     ORDER BY shareholder_id`,
    [tenantA, runId],
  );
  return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}

async function deductionRowsOf(runId: string) {
  const { rows } = await owner.query<{
    shortfall_id: string;
    shareholder_id: string;
    amount: string;
  }>(
    `SELECT shortfall_id, shareholder_id, amount_idr::text AS amount
     FROM distribution_carry_deductions
     WHERE tenant_id = $1 AND distribution_run_id = $2
     ORDER BY shareholder_id`,
    [tenantA, runId],
  );
  return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}

async function approveRunFlow(runId: string) {
  const submitted = await submitRun(manager, runId);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  const decided = await decideRun(approver, runId);
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  return parseRun(decided.body);
}

/** A paid regular run plus a draft claw-back that leaves 599,999 unabsorbed. */
async function clawedBack(adjustmentIdr = -1_500_000) {
  const world = await makeWorld(roundingPolicy, roundingShares());
  const { run: original, period } = await paidRun(world);
  const response = await adjust(manager, original.id, {
    fiscalPeriodId: period.id,
    adjustmentIdr,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return { world, original, adjustment: parseRun(response.body) };
}

const halfUpTax = (gross: number) => Math.floor((gross * 500 + 5_000) / 10_000);

/** Scenario (4): s1 and s2 are fully absorbed (zero lines), s3 is paid for real. */
async function approvedRunWithAbsorbedHolders() {
  const { world, adjustment } = await clawedBack();
  await approveRunFlow(adjustment.id);
  const shortfalls = await shortfallsOf(adjustment.id);
  await seedVersion(
    world.profitEntityId,
    [
      { holder: s1, bp: 2000 },
      { holder: s2, bp: 2000 },
      { holder: s3, bp: 6000 },
    ],
    "approved",
    "2021-02-01",
    2,
  );
  const second = (await draftRun(world)).run;
  expect(second.lines).toHaveLength(3);
  const approved = await approveRunFlow(second.id);
  // The zero lines were settled on approval; the real one waits for payment.
  expect(approved.status).toBe("approved");
  expect(
    approved.lines.map((line) => [line.shareholderId, line.paymentStatus]),
  ).toEqual(
    expect.arrayContaining([
      [s1.id, "paid"],
      [s2.id, "paid"],
      [s3.id, "pending"],
    ]),
  );
  return { world, approved, shortfalls, second };
}

async function paidRunWithAbsorbedHolders() {
  const { world, approved, shortfalls, second } =
    await approvedRunWithAbsorbedHolders();
  const paid = await payAll(manager, approved);
  return { world, run: paid, shortfalls, second };
}

describe("Q83 carry: the unabsorbed rest is kept per shareholder and cut from their next split", () => {
  it("(1) a claw-back with an unabsorbed rest writes one shortfall row per shareholder, summing to unabsorbed_idr", async () => {
    const { original, adjustment } = await clawedBack();
    expect(adjustment.unabsorbedIdr).toBe(599_999);
    const rows = await shortfallsOf(adjustment.id);
    expect(rows).toHaveLength(3);
    expect(rows.reduce((sum, row) => sum + row.amount, 0)).toBe(599_999);
    expect(rows.map((row) => row.shareholder_id).sort()).toEqual(
      original.lines.map((line) => line.shareholderId).sort(),
    );
    // A claw-back that is fully absorbed leaves no shortfall row.
    const world = await makeWorld(roundingPolicy, roundingShares());
    const paid = await paidRun(world);
    const small = parseRun(
      (
        await adjust(manager, paid.run.id, {
          fiscalPeriodId: paid.period.id,
          adjustmentIdr: -300_000,
        })
      ).body,
    );
    expect(small.unabsorbedIdr).toBe(0);
    expect(await shortfallsOf(small.id)).toHaveLength(0);
  });

  it("(2) a draft or pending claw-back is not carried, an approved one is", async () => {
    const { world, adjustment } = await clawedBack();
    const period = await closedPeriod(world, NET_PROFIT);
    const regular = async () => {
      const response = await createRun(manager, world, period.id);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return parseRun(response.body);
    };
    const reject = async (runId: string) => {
      await submitRun(manager, runId);
      expect((await decideRun(approver, runId, "reject")).status).toBe(200);
    };

    const whileDraft = await regular();
    expect(whileDraft.carryDeductedIdr).toBe(0);
    expect(whileDraft.carryDeductions).toEqual([]);
    await reject(whileDraft.id);

    expect((await submitRun(manager, adjustment.id)).status).toBe(200);
    const whilePending = await regular();
    expect(whilePending.carryDeductedIdr).toBe(0);
    await reject(whilePending.id);

    expect((await decideRun(approver, adjustment.id)).status).toBe(200);
    const whileApproved = await regular();
    expect(whileApproved.carryDeductedIdr).toBe(599_999);
  });

  it("(3) the next regular run cuts each shareholder's own shortfall before tax, with a trail, and the journal uses the reduced gross", async () => {
    const { world, original, adjustment } = await clawedBack();
    await approveRunFlow(adjustment.id);
    const shortfalls = await shortfallsOf(adjustment.id);
    const next = await draftRun(world);
    const run = next.run;

    expect(run.carryDeductedIdr).toBe(599_999);
    expect(run.distributableIdr).toBe(900_001);
    expect(run.totalGrossIdr).toBe(900_001 - 599_999);
    expect(run.distributableIdr).toBe(run.totalGrossIdr + run.carryDeductedIdr);
    expect(run.totalNetIdr).toBe(run.totalGrossIdr - run.totalTaxWithheldIdr);
    for (const line of run.lines) {
      const share = original.lines.find(
        (item) => item.shareholderId === line.shareholderId,
      )!.grossIdr;
      const cut = shortfalls.find(
        (row) => row.shareholder_id === line.shareholderId,
      )!.amount;
      expect(line.carryDeductedIdr).toBe(cut);
      expect(line.grossIdr).toBe(share - cut);
      expect(line.taxWithheldIdr).toBe(halfUpTax(line.grossIdr));
      expect(line.netIdr).toBe(line.grossIdr - line.taxWithheldIdr);
    }
    // Trail: every deduction names the claw-back run it came from.
    expect(run.carryDeductions).toHaveLength(3);
    for (const deduction of run.carryDeductions) {
      expect(deduction.shortfallRunId).toBe(adjustment.id);
      expect(deduction.amountIdr).toBe(
        shortfalls.find(
          (row) => row.shareholder_id === deduction.shareholderId,
        )!.amount,
      );
    }
    const stored = await deductionRowsOf(run.id);
    expect(stored.map((row) => row.shortfall_id).sort()).toEqual(
      shortfalls.map((row) => row.id).sort(),
    );
    // The same data comes back from a read.
    const read = parseRun((await getRun(manager, run.id)).body);
    expect(read.carryDeductedIdr).toBe(599_999);
    expect(read.carryDeductions).toHaveLength(3);

    const approved = await approveRunFlow(run.id);
    const paid = await payAll(manager, approved);
    expect(paid.status).toBe("paid");
    const journalId = await postedJournalId(paid.id);
    const journal = await journalOf(journalId as string);
    expect(journal.totalDebit).toBe(journal.totalCredit);
    expect(journal.byAccount(world.accounts.retainedEarnings)).toEqual({
      debit: paid.totalGrossIdr,
      credit: 0,
    });
    expect(journal.byAccount(world.accounts.bank).credit).toBe(
      paid.totalNetIdr,
    );
    const { rows } = await owner.query<{ description: string }>(
      "SELECT description FROM journal_entries WHERE tenant_id = $1 AND id = $2",
      [tenantA, journalId],
    );
    expect(rows[0]!.description).toContain("dipotong kekurangan koreksi");
    // The shareholder's statement shows the deduction taken from that share.
    const paidLine = paid.lines[0]!;
    const statement = await get(
      manager,
      `/distributions/${paid.id}/lines/${paidLine.id}/statement`,
    );
    expect(statement.status, JSON.stringify(statement.body)).toBe(200);
    expect(
      distributionStatementSchema.parse(statement.body.data).carryDeductedIdr,
    ).toBe(paidLine.carryDeductedIdr);
    expect(paidLine.carryDeductedIdr).toBeGreaterThan(0);
  });

  it("(4) a shortfall above the share cuts the whole share and the remainder goes to the run after", async () => {
    const { world, adjustment } = await clawedBack();
    await approveRunFlow(adjustment.id);
    const shortfalls = await shortfallsOf(adjustment.id);
    // From the second period on s3 holds most of the split: s1 and s2 get less
    // than their shortfall.
    await seedVersion(
      world.profitEntityId,
      [
        { holder: s1, bp: 2000 },
        { holder: s2, bp: 2000 },
        { holder: s3, bp: 6000 },
      ],
      "approved",
      "2021-02-01",
      2,
    );
    const second = (await draftRun(world)).run;
    const lowHolders = [s1.id, s2.id];
    // s1 and s2 keep a zero line: that is how their carry shrinks.
    expect(second.lines).toHaveLength(3);
    for (const id of lowHolders) {
      const zero = second.lines.find((line) => line.shareholderId === id)!;
      expect(zero.grossIdr).toBe(0);
      expect(zero.taxWithheldIdr).toBe(0);
      expect(zero.netIdr).toBe(0);
      expect(zero.carryDeductedIdr).toBeGreaterThan(0);
    }
    expect(
      second.lines.find((line) => line.shareholderId === s3.id)!.grossIdr,
    ).toBeGreaterThan(0);
    for (const id of lowHolders) {
      const cut = second.carryDeductions.find(
        (row) => row.shareholderId === id,
      );
      const shortfall = shortfalls.find((row) => row.shareholder_id === id)!;
      expect(cut, id).toBeDefined();
      expect(cut!.amountIdr).toBeLessThan(shortfall.amount);
    }
    const third = (await draftRun(world)).run;
    for (const id of lowHolders) {
      const shortfall = shortfalls.find((row) => row.shareholder_id === id)!;
      const first = second.carryDeductions.find(
        (row) => row.shareholderId === id,
      )!;
      const rest = third.carryDeductions.find(
        (row) => row.shareholderId === id,
      )!;
      expect(first.amountIdr + rest.amountIdr).toBe(shortfall.amount);
      expect(
        third.lines.find((line) => line.shareholderId === id)?.carryDeductedIdr,
      ).toBe(rest.amountIdr);
    }
    // s3 was fully settled by the second run: nothing more on the third.
    expect(
      third.carryDeductions.find((row) => row.shareholderId === s3.id),
    ).toBeUndefined();
  });

  it("(5) a rejected regular run releases its deduction", async () => {
    const { world, adjustment } = await clawedBack();
    await approveRunFlow(adjustment.id);
    const period = await closedPeriod(world, NET_PROFIT);
    const first = parseRun((await createRun(manager, world, period.id)).body);
    expect(first.carryDeductedIdr).toBe(599_999);
    await submitRun(manager, first.id);
    expect((await decideRun(approver, first.id, "reject")).status).toBe(200);
    const again = await createRun(manager, world, period.id);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(parseRun(again.body).carryDeductedIdr).toBe(599_999);
  });

  /** Distributable 270,001: every share is under the shortfall of its holder. */
  async function allAbsorbedRun() {
    const { world, adjustment } = await clawedBack();
    await approveRunFlow(adjustment.id);
    const shortfalls = await shortfallsOf(adjustment.id);
    const period = await closedPeriod(world, 300_001);
    const response = await createRun(manager, world, period.id);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return { world, shortfalls, run: parseRun(response.body) };
  }

  it("(6) shares that are all absorbed give a zero line each and the carry shrinks", async () => {
    const { world, shortfalls, run } = await allAbsorbedRun();
    expect(run.distributableIdr).toBe(270_001);
    expect(run.carryDeductedIdr).toBe(270_001);
    expect(run.totalGrossIdr).toBe(0);
    expect(run.totalTaxWithheldIdr).toBe(0);
    expect(run.totalNetIdr).toBe(0);
    expect(run.lines).toHaveLength(3);
    for (const line of run.lines) {
      expect(line.grossIdr).toBe(0);
      expect(line.taxWithheldIdr).toBe(0);
      expect(line.netIdr).toBe(0);
      expect(line.carryDeductedIdr).toBeGreaterThan(0);
      expect(line.paymentStatus).toBe("pending");
    }
    expect(await deductionRowsOf(run.id)).toHaveLength(3);
    // The next run only meets what is still open: 599,999 - 270,001.
    const next = (await draftRun(world)).run;
    expect(next.carryDeductedIdr).toBe(599_999 - 270_001);
    for (const line of next.lines) {
      const before = run.lines.find(
        (item) => item.shareholderId === line.shareholderId,
      )!;
      const open =
        shortfalls.find((row) => row.shareholder_id === line.shareholderId)!
          .amount - before.carryDeductedIdr;
      expect(line.carryDeductedIdr).toBe(open);
    }
  });

  it("(6b) approving a run with only zero lines pays it at once: paid by the approver, POTONG-KEKURANGAN, no statement, no journal", async () => {
    const { run } = await allAbsorbedRun();
    expect((await submitRun(manager, run.id)).status).toBe(200);
    const k = key("zero-decide");
    const decided = await decideRun(approver, run.id, "approve", k);
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const paid = parseRun(decided.body);
    expect(paid.status).toBe("paid");
    expect(paid.paidAt).toBe(paid.approvedAt);
    for (const line of paid.lines) {
      expect(line.paymentStatus).toBe("paid");
      expect(line.paymentRef).toBe("POTONG-KEKURANGAN");
      expect(line.paidAt).toBe(paid.approvedAt);
      expect(line.statementFileKey).toBeNull();
    }
    const stored = await owner.query<{
      status: string;
      journal_entry_id: string | null;
      reversal_journal_entry_id: string | null;
      paid_by: string[];
    }>(
      `SELECT r.status, r.journal_entry_id, r.reversal_journal_entry_id,
              array(SELECT l.paid_by FROM distribution_lines l
                    WHERE l.tenant_id = r.tenant_id AND l.distribution_run_id = r.id) AS paid_by
       FROM distribution_runs r WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantA, run.id],
    );
    expect(stored.rows[0]!.status).toBe("paid");
    expect(stored.rows[0]!.journal_entry_id).toBeNull();
    expect(stored.rows[0]!.reversal_journal_entry_id).toBeNull();
    expect(stored.rows[0]!.paid_by).toEqual([
      approver.userId,
      approver.userId,
      approver.userId,
    ]);
    const journals = await owner.query(
      "SELECT 1 FROM journal_entries WHERE tenant_id = $1 AND source_id = $2",
      [tenantA, run.id],
    );
    expect(journals.rowCount).toBe(0);
    // Replaying the decision returns the same paid run and changes nothing.
    const again = await decideRun(approver, run.id, "approve", k);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(parseRun(again.body).status).toBe("paid");
    expect(parseRun(again.body).paidAt).toBe(paid.paidAt);
    // A paid run takes no payment on its settled lines.
    const pay = await payLine(manager, run.id, paid.lines[0]!.id);
    expect(pay.status).toBe(409);
  });

  it("(6c) a rejected all-zero run releases its carry", async () => {
    const { world, run } = await allAbsorbedRun();
    expect((await submitRun(manager, run.id)).status).toBe(200);
    expect((await decideRun(approver, run.id, "reject")).status).toBe(200);
    const again = (await draftRun(world, 300_001)).run;
    expect(again.carryDeductedIdr).toBe(270_001);
    expect(again.totalGrossIdr).toBe(0);
  });

  it("(7) shareholders without a shortfall are not touched", async () => {
    const { world, original, adjustment } = await clawedBack(-900_002);
    expect(adjustment.unabsorbedIdr).toBe(1);
    await approveRunFlow(adjustment.id);
    const shortfalls = await shortfallsOf(adjustment.id);
    expect(shortfalls).toHaveLength(1);
    const run = (await draftRun(world)).run;
    expect(run.carryDeductedIdr).toBe(1);
    for (const line of run.lines) {
      const share = original.lines.find(
        (item) => item.shareholderId === line.shareholderId,
      )!.grossIdr;
      if (line.shareholderId === shortfalls[0]!.shareholder_id) {
        expect(line.carryDeductedIdr).toBe(1);
        expect(line.grossIdr).toBe(share - 1);
      } else {
        expect(line.carryDeductedIdr).toBe(0);
        expect(line.grossIdr).toBe(share);
      }
    }
  });

  it("(8) the audit row and the approval and completion events carry carryDeductedIdr", async () => {
    const { world, adjustment } = await clawedBack();
    await approveRunFlow(adjustment.id);
    const run = (await draftRun(world)).run;
    const audit = await owner.query<{ cut: string | null }>(
      `SELECT event->'maskedChanges'->'after'->>'carryDeductedIdr' AS cut
       FROM audit_logs
       WHERE tenant_id = $1 AND event->>'action' = 'profit_share.distribution_calculated'
         AND event->>'objectId' = $2`,
      [tenantA, run.id],
    );
    expect(audit.rows.map((row) => row.cut)).toEqual(["599999"]);

    const approved = await approveRunFlow(run.id);
    await payAll(manager, approved);
    const events = await owner.query<{ name: string; cut: string | null }>(
      `SELECT event->>'name' AS name, event->'payload'->>'carryDeductedIdr' AS cut
       FROM domain_event_outbox
       WHERE tenant_id = $1 AND event->>'aggregateId' = $2
         AND event->>'name' IN ('distribution.approved', 'distribution.completed')`,
      [tenantA, run.id],
    );
    expect(events.rows.map((row) => row.name).sort()).toEqual([
      "distribution.approved",
      "distribution.completed",
    ]);
    for (const row of events.rows) expect(row.cut).toBe("599999");
  });

  it("(9) replaying a create returns the same run and writes no second deduction", async () => {
    const { world, adjustment } = await clawedBack();
    await approveRunFlow(adjustment.id);
    const period = await closedPeriod(world, NET_PROFIT);
    const k = key("carry-replay");
    const first = await createRun(manager, world, period.id, k);
    const again = await createRun(manager, world, period.id, k);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const run = parseRun(again.body);
    expect(run.id).toBe(parseRun(first.body).id);
    expect(run.carryDeductedIdr).toBe(599_999);
    expect(run.carryDeductions).toHaveLength(3);
    expect(await deductionRowsOf(run.id)).toHaveLength(3);
  });

  it("(6d) a mixed run completes on its last real payment, the journal uses the reduced gross", async () => {
    const { world, run } = await paidRunWithAbsorbedHolders();
    expect(run.status).toBe("paid");
    expect(run.totalGrossIdr).toBeGreaterThan(0);
    expect(run.distributableIdr).toBe(run.totalGrossIdr + run.carryDeductedIdr);
    const real = run.lines.find((line) => line.shareholderId === s3.id)!;
    const latest = Math.max(
      ...run.lines.map((line) => Date.parse(line.paidAt as string)),
    );
    expect(Date.parse(run.paidAt as string)).toBe(latest);
    expect(real.paymentRef).not.toBe("POTONG-KEKURANGAN");
    const journal = await journalOf((await postedJournalId(run.id)) as string);
    expect(journal.totalDebit).toBe(journal.totalCredit);
    expect(journal.byAccount(world.accounts.retainedEarnings)).toEqual({
      debit: run.totalGrossIdr,
      credit: 0,
    });
    expect(journal.byAccount(world.accounts.bank).credit).toBe(run.totalNetIdr);
  });

  it("(10) a claw-back of a run with a fully absorbed shareholder still leaves a new shortfall for that shareholder", async () => {
    const { world, run } = await paidRunWithAbsorbedHolders();
    const period = await closedPeriod(world, NET_PROFIT);
    const response = await adjust(manager, run.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: -1_000,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const clawBack = parseRun(response.body);
    // The absorbed holders hold 0 of this run: no line, only s3 gives back.
    expect(clawBack.lines.map((line) => line.shareholderId)).toEqual([s3.id]);
    expect(clawBack.lines[0].grossIdr).toBeLessThan(0);
    expect(clawBack.unabsorbedIdr).toBeGreaterThan(0);
    const shortfalls = await shortfallsOf(clawBack.id);
    expect(shortfalls.reduce((sum, row) => sum + row.amount, 0)).toBe(
      clawBack.unabsorbedIdr,
    );
    expect(shortfalls.map((row) => row.shareholder_id).sort()).toEqual(
      expect.arrayContaining([s1.id, s2.id]),
    );
  });

  it("(11) a top-up of a run with an absorbed shareholder is allowed: their open carry goes first, the rest is paid", async () => {
    const { world, run, shortfalls, second } =
      await paidRunWithAbsorbedHolders();
    const period = await closedPeriod(world, NET_PROFIT);
    const response = await adjust(manager, run.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: 1_000_000,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const topUp = parseRun(response.body);
    expect(topUp.lines).toHaveLength(3);
    let deducted = 0;
    for (const id of [s1.id, s2.id]) {
      const line = topUp.lines.find((item) => item.shareholderId === id)!;
      const open =
        shortfalls.find((row) => row.shareholder_id === id)!.amount -
        second.lines.find((item) => item.shareholderId === id)!
          .carryDeductedIdr;
      expect(open).toBeGreaterThan(0);
      expect(line.carryDeductedIdr).toBe(open);
      // 20% of 1,000,000 is more than what is open: the rest is paid, taxed.
      expect(line.grossIdr).toBe(200_000 - open);
      expect(line.taxWithheldIdr).toBe(halfUpTax(line.grossIdr));
      deducted += open;
    }
    // s3 settled its carry on the second run: nothing to take from it.
    expect(
      topUp.lines.find((item) => item.shareholderId === s3.id)!
        .carryDeductedIdr,
    ).toBe(0);
    expect(topUp.carryDeductedIdr).toBe(deducted);
    expect(topUp.distributableIdr).toBe(1_000_000);
    expect(topUp.distributableIdr).toBe(
      topUp.totalGrossIdr + topUp.carryDeductedIdr,
    );
    expect(
      topUp.carryDeductions.map((row) => row.shareholderId).sort(),
    ).toEqual([s1.id, s2.id].sort());
    expect(await deductionRowsOf(topUp.id)).toHaveLength(2);
    // It completes like any run, with the journal on the reduced gross.
    const paid = await payAll(manager, await approveRunFlow(topUp.id));
    expect(paid.status).toBe("paid");
    const journal = await journalOf((await postedJournalId(paid.id)) as string);
    expect(journal.byAccount(world.accounts.retainedEarnings).debit).toBe(
      topUp.totalGrossIdr,
    );
  });

  it("(11b) a top-up the carry absorbs completely gives zero lines, settled on approval", async () => {
    const { world, run } = await paidRunWithAbsorbedHolders();
    const period = await closedPeriod(world, NET_PROFIT);
    const response = await adjust(manager, run.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: 100,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const topUp = parseRun(response.body);
    // 20% of 100 = 20 each for s1 and s2, fully under their open carry.
    for (const id of [s1.id, s2.id]) {
      const line = topUp.lines.find((item) => item.shareholderId === id)!;
      expect(line.grossIdr).toBe(0);
      expect(line.carryDeductedIdr).toBe(20);
    }
    expect(topUp.carryDeductedIdr).toBe(40);
    const approved = await approveRunFlow(topUp.id);
    expect(approved.status).toBe("approved");
    expect(
      approved.lines
        .filter((line) => line.grossIdr === 0)
        .every((line) => line.paymentRef === "POTONG-KEKURANGAN"),
    ).toBe(true);
  });

  /** Round 2 F1: a run whose every line is zero has nothing to claw back. */
  it("(12) a claw-back of a run whose lines are all zero is refused with a clear message", async () => {
    const { run } = await allAbsorbedRun();
    const paid = await approveRunFlow(run.id);
    expect(paid.status).toBe("paid");
    const response = await adjust(manager, run.id, {
      fiscalPeriodId: run.fiscalPeriodId,
      adjustmentIdr: -1_000,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(errorCode(response)).toBe("ADJUSTMENT_TARGET_INVALID");
    expect(JSON.stringify(response.body)).toContain(
      "Run ini seluruhnya terserap kekurangan koreksi; tidak ada yang bisa ditarik kembali",
    );
  });

  /** Round 2 F2: a zero line is a settlement, not a payout: no statement. */
  it("(13) a zero line has no statement for the manager or its own shareholder", async () => {
    const { run } = await paidRunWithAbsorbedHolders();
    const zero = run.lines.find((line) => line.shareholderId === s1.id)!;
    const real = run.lines.find((line) => line.shareholderId === s3.id)!;
    expect(zero.grossIdr).toBe(0);
    expect(zero.paymentStatus).toBe("paid");
    const path = (line: { id: string }) =>
      `/distributions/${run.id}/lines/${line.id}/statement`;
    const byManager = await get(manager, path(zero));
    expect(byManager.status, JSON.stringify(byManager.body)).toBe(404);
    expect(errorCode(byManager)).toBe("NOT_FOUND");
    const own = await get(sh1User, path(zero));
    expect(own.status, JSON.stringify(own.body)).toBe(404);
    // Control: a real line of the same run still has its statement.
    const control = await get(manager, path(real));
    expect(control.status, JSON.stringify(control.body)).toBe(200);
  });

  /** Round 2 F3: a run paid on approval still tells the outbox it completed. */
  it("(14) a run paid on approval appends distribution.completed with a null journal", async () => {
    const { run } = await allAbsorbedRun();
    const paid = await approveRunFlow(run.id);
    expect(paid.status).toBe("paid");
    const events = await owner.query<{
      name: string;
      journal: string | null;
      cut: string | null;
    }>(
      `SELECT event->>'name' AS name,
              event->'payload'->>'journalEntryId' AS journal,
              event->'payload'->>'carryDeductedIdr' AS cut
       FROM domain_event_outbox
       WHERE tenant_id = $1 AND event->>'aggregateId' = $2
         AND event->>'name' IN ('distribution.approved', 'distribution.completed')`,
      [tenantA, run.id],
    );
    expect(events.rows.map((row) => row.name).sort()).toEqual([
      "distribution.approved",
      "distribution.completed",
    ]);
    const completed = events.rows.find(
      (row) => row.name === "distribution.completed",
    )!;
    expect(completed.journal).toBeNull();
    expect(completed.cut).toBe("270001");
  });
});

// ---- 1210: an outlet entity fails closed on unallocated entity-level expense ---

describe("1210 an outlet profit entity refuses unallocated entity-level expense", () => {
  type Extra = { cogs: string; contraRevenue: string };

  async function outletWorld(): Promise<{
    world: World;
    outletId: string;
    extra: Extra;
  }> {
    const { legalEntityId, accounts } = await makeLegalEntity();
    const extra: Extra = { cogs: randomUUID(), contraRevenue: randomUUID() };
    await owner.query(
      `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $3, $4, '5101', 'HPP', 'expense', 'cogs'),
              ($2, $3, $4, '4103', 'Diskon penjualan', 'revenue', 'revenue')`,
      [extra.cogs, extra.contraRevenue, tenantA, legalEntityId],
    );
    const brand = await owner.query<{ id: string }>(
      "SELECT id FROM brands WHERE tenant_id = $1 ORDER BY id LIMIT 1",
      [tenantA],
    );
    const outletId = randomUUID();
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet bagi hasil', 'Jl. Uji', 'Asia/Jakarta', '04:00', '{}', 'active')`,
      [
        outletId,
        tenantA,
        brand.rows[0]!.id,
        legalEntityId,
        `PS-${unique()}`.toUpperCase(),
      ],
    );
    const created = await post(manager, "/profit-entities", {
      name: `Outlet ${unique()}`,
      type: "outlet",
      legalEntityId: null,
      outletId,
      policy: {
        basis: "closed_period_net_profit",
        frequency: "monthly",
        ...roundingPolicy,
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const profitEntityId = created.body.data.id as string;
    await seedVersion(profitEntityId, roundingShares(), "approved");
    return {
      world: { legalEntityId, accounts, profitEntityId, nextPeriod: 0 },
      outletId,
      extra,
    };
  }

  type Untagged = { debit: string; credit: string; amount: number };

  /** Closed period: outlet-tagged sales 10jt and expense 4jt, plus optional untagged lines. */
  async function closedOutletPeriod(
    world: World,
    outletId: string,
    untagged: Untagged | null,
  ) {
    const period = periodKey(world.nextPeriod++);
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) RETURNING id`,
      [tenantA, world.legalEntityId, period],
    );
    const date = `${period}-15`;
    const tagged = (accountId: string, debit: number, credit: number) => ({
      ...journalLine(accountId, debit, credit),
      outletId: outletId as never,
    });
    const context = scopedContext();
    const entry = (
      lines: ReturnType<typeof journalLine>[],
      outlet: string | null,
    ) =>
      withTenant(db, context, (tx) =>
        postJournalInTransaction(tx, context, {
          legalEntityId: world.legalEntityId,
          outletId: outlet as never,
          entryDate: businessDateSchema.parse(date),
          sourceType: "sale" as const,
          sourceId: randomUUID(),
          description: "Uji bagi hasil outlet",
          lines,
          postedBy: null,
          idempotencyKey: `post-${randomUUID()}`,
        }),
      );
    await entry(
      [
        tagged(world.accounts.cash, 10_000_000, 0),
        tagged(world.accounts.revenue, 0, 10_000_000),
      ],
      outletId,
    );
    await entry(
      [
        tagged(world.accounts.expense, 4_000_000, 0),
        tagged(world.accounts.cash, 0, 4_000_000),
      ],
      outletId,
    );
    if (untagged)
      await entry(
        [
          journalLine(untagged.debit, untagged.amount, 0),
          journalLine(untagged.credit, 0, untagged.amount),
        ],
        null,
      );
    await closeFiscalPeriod(
      scopedContext(),
      rows[0]!.id,
      { expectedVersion: 1, idempotencyKey: `close-${randomUUID()}` },
      userIdSchema.parse(closer),
    );
    return { id: rows[0]!.id, period };
  }

  /**
   * Untagged expense that lands in an already closed period (a late fact the
   * period guards would refuse), inserted raw with triggers off.
   */
  async function lateUntaggedExpense(
    world: World,
    period: { id: string; period: string },
  ) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const entryId = randomUUID();
      await client.query(
        `INSERT INTO journal_entries (id, tenant_id, legal_entity_id, outlet_id, entry_date, fiscal_period_id, source_type, source_id, description, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, NULL, $4, $5, 'sale', $6, 'Gaji terlambat', $7, $8)`,
        [
          entryId,
          tenantA,
          world.legalEntityId,
          `${period.period}-20`,
          period.id,
          randomUUID(),
          `late-${randomUUID()}`,
          "0".repeat(64),
        ],
      );
      await client.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
         VALUES ($1, $2, $3, 1, 3000000, 0), ($1, $2, $4, 2, 0, 3000000)`,
        [tenantA, entryId, world.accounts.expense, world.accounts.cash],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }

  const unallocatedMessage = "belum dialokasikan";

  it("refuses with UNALLOCATED_ENTITY_EXPENSE when payroll sits at entity level", async () => {
    const { world, outletId } = await outletWorld();
    const period = await closedOutletPeriod(world, outletId, {
      debit: world.accounts.expense,
      credit: world.accounts.cash,
      amount: 3_000_000,
    });
    const response = await createRun(manager, world, period.id);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(errorCode(response)).toBe("UNALLOCATED_ENTITY_EXPENSE");
    expect(JSON.stringify(response.body)).toContain(unallocatedMessage);
    const runs = await owner.query(
      "SELECT 1 FROM distribution_runs WHERE tenant_id = $1 AND profit_entity_id = $2",
      [tenantA, world.profitEntityId],
    );
    expect(runs.rowCount).toBe(0);
  });

  it("refuses an untagged COGS line", async () => {
    const { world, outletId, extra } = await outletWorld();
    const period = await closedOutletPeriod(world, outletId, {
      debit: extra.cogs,
      credit: world.accounts.cash,
      amount: 2_000_000,
    });
    const response = await createRun(manager, world, period.id);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(errorCode(response)).toBe("UNALLOCATED_ENTITY_EXPENSE");
  });

  it("refuses an untagged debit on a revenue account (sales discount)", async () => {
    const { world, outletId, extra } = await outletWorld();
    const period = await closedOutletPeriod(world, outletId, {
      debit: extra.contraRevenue,
      credit: world.accounts.cash,
      amount: 1_000_000,
    });
    const response = await createRun(manager, world, period.id);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(errorCode(response)).toBe("UNALLOCATED_ENTITY_EXPENSE");
  });

  it("calculates as before when no entity-level expense exists (control)", async () => {
    const { world, outletId } = await outletWorld();
    const period = await closedOutletPeriod(world, outletId, null);
    const response = await createRun(manager, world, period.id);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(parseRun(response.body).periodNetProfitIdr).toBe(6_000_000);
  });

  it("ignores another legal entity's untagged expense in the same month", async () => {
    const { world, outletId } = await outletWorld();
    const other = await makeLegalEntity();
    await openPeriod({ ...other }, periodKey(0), 1_000_000);
    const period = await closedOutletPeriod(world, outletId, null);
    const response = await createRun(manager, world, period.id);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it("a legal-entity profit entity still calculates with untagged expense", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const period = await closedPeriod(world, NET_PROFIT);
    const response = await createRun(manager, world, period.id);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it("refuses a top-up adjustment when expense appeared after the run", async () => {
    const { world, outletId } = await outletWorld();
    const period = await closedOutletPeriod(world, outletId, null);
    const created = await createRun(manager, world, period.id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const run = parseRun(created.body);
    expect((await submitRun(manager, run.id)).status).toBe(200);
    expect((await decideRun(approver, run.id)).status).toBe(200);
    await lateUntaggedExpense(world, period);
    const response = await adjust(manager, run.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: 1_000_000,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(errorCode(response)).toBe("UNALLOCATED_ENTITY_EXPENSE");
  });

  it("does not approve a pending run when expense appeared after it was calculated", async () => {
    const { world, outletId } = await outletWorld();
    const period = await closedOutletPeriod(world, outletId, null);
    const run = parseRun((await createRun(manager, world, period.id)).body);
    expect((await submitRun(manager, run.id)).status).toBe(200);
    await lateUntaggedExpense(world, period);
    const response = await decideRun(approver, run.id);
    const status = await owner.query<{ status: string }>(
      "SELECT status FROM distribution_runs WHERE tenant_id = $1 AND id = $2",
      [tenantA, run.id],
    );
    expect(status.rows[0]!.status, JSON.stringify(response.body)).not.toBe(
      "approved",
    );
    expect(status.rows[0]!.status).not.toBe("paid");
  });

  it("refuses a payment when expense appeared after approval", async () => {
    const { world, outletId } = await outletWorld();
    const period = await closedOutletPeriod(world, outletId, null);
    const run = parseRun((await createRun(manager, world, period.id)).body);
    expect((await submitRun(manager, run.id)).status).toBe(200);
    const approved = parseRun((await decideRun(approver, run.id)).body);
    await lateUntaggedExpense(world, period);
    const response = await payLine(manager, run.id, approved.lines[0]!.id);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(errorCode(response)).toBe("UNALLOCATED_ENTITY_EXPENSE");
    const lines = await owner.query<{ payment_status: string }>(
      "SELECT payment_status FROM distribution_lines WHERE tenant_id = $1 AND distribution_run_id = $2",
      [tenantA, run.id],
    );
    expect(lines.rows.every((row) => row.payment_status === "pending")).toBe(
      true,
    );
  });
});

// ---- 1217 / SO 1216 F-P1a: a distribution paid from a reopened period ---------
//
// Scenario of the report: March closed, a profit distribution of Rp60 jt
// approved, March reopened, a forgotten Rp30 jt payroll posted, closed again
// again: the payment still went out at Rp60 jt. Decision (fail closed, the
// simplest rule that stops the money): a period with an APPROVED (not yet fully
// paid) run cannot be reopened, because an approved run can neither be
// cancelled nor recalculated; a PAID run does not block (the money is out, its
// correction is the existing adjustment run). And a payment is refused unless
// the period is closed at the run's version, in the service and in the DB.
// Review rounds 2-3: an approved run with no money out may be withdrawn
// (cancel-approved, approver permission, reason): zero lines settled by the
// carry are no payment, a live adjustment blocks it, an adjustment of a
// cancelled run is never approved or paid, and a draft or rejected run never
// carries an approval. The badge needsCorrection flags a regular run whose
// period version moved until an approved claw-back follows.

describe("1217 an approved distribution and a reopen of its period", () => {
  const periodRow = async (id: string) =>
    (
      await owner.query<{ status: string; version: number }>(
        "SELECT status, version FROM fiscal_periods WHERE tenant_id = $1 AND id = $2",
        [tenantA, id],
      )
    ).rows[0];

  const requestReopen = (periodId: string) =>
    requestPeriodReopen(
      scopedContext(),
      periodId,
      { reason: "Gaji Maret Rp30 jt terlewat" },
      userIdSchema.parse(randomUUID()),
    );
  const approveReopen = (requestId: string) =>
    approvePeriodReopen(
      scopedContext(),
      requestId,
      { note: null },
      userIdSchema.parse(randomUUID()),
    );

  /** Moves the period with every trigger off: a state the guards now refuse. */
  async function forcePeriod(id: string, status: "open" | "closed") {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        status === "open"
          ? `UPDATE fiscal_periods SET status = 'open', version = version + 1,
               closed_by = NULL, closed_at = NULL
             WHERE tenant_id = $1 AND id = $2`
          : `UPDATE fiscal_periods SET status = 'closed', version = version + 1,
               closed_by = $3, closed_at = now()
             WHERE tenant_id = $1 AND id = $2`,
        status === "open" ? [tenantA, id] : [tenantA, id, closer],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function approved60(world: World) {
    const drafted = await draftRun(world, 60_000_000);
    expect((await submitRun(manager, drafted.run.id)).status).toBe(200);
    const decided = await decideRun(approver, drafted.run.id);
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    return { period: drafted.period, run: parseRun(decided.body) };
  }

  it("Maret Rp60 jt approved: the reopen is refused (service and DB) until the run is paid", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { period, run } = await approved60(world);

    const request = await requestReopen(period.id);
    await expect(approveReopen(request.id)).rejects.toMatchObject({
      status: 409,
      code: "PERIOD_HAS_APPROVED_DISTRIBUTION",
    });
    await expect(
      owner.query(
        `UPDATE fiscal_periods SET status = 'open', version = version + 1,
           closed_by = NULL, closed_at = NULL
         WHERE tenant_id = $1 AND id = $2`,
        [tenantA, period.id],
      ),
    ).rejects.toThrow(/PERIOD_HAS_APPROVED_DISTRIBUTION/);
    expect(await periodRow(period.id)).toEqual({
      status: "closed",
      version: 2,
    });

    // Control: paid at the figures of v1, the period may reopen (a correction
    // is then an adjustment run).
    expect((await payAll(manager, run)).status).toBe("paid");
    // The refused approval left the request pending; it now goes through.
    await approveReopen(request.id);
    expect(await periodRow(period.id)).toEqual({ status: "open", version: 3 });
  });

  it("a run whose period was reopened or closed again is never paid", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { period, run } = await approved60(world);
    const line = run.lines.find((l) => l.paymentStatus === "pending")!;
    const rawPay = () =>
      owner.query(
        `UPDATE distribution_lines SET payment_status = 'paid', payment_ref = 'RAW',
           paid_at = now(), paid_by = 'raw'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantA, line.id],
      );

    await forcePeriod(period.id, "open");
    const whileOpen = await payLine(manager, run.id, line.id);
    expect(whileOpen.status, JSON.stringify(whileOpen.body)).toBe(409);
    expect(errorCode(whileOpen)).toBe("PERIOD_CHANGED");
    // The message points at the way out: withdraw the approval, recalculate.
    expect(JSON.stringify(whileOpen.body)).toContain("Batalkan persetujuannya");
    await expect(rawPay()).rejects.toThrow(/SH-02/);

    await forcePeriod(period.id, "closed");
    expect(await periodRow(period.id)).toEqual({
      status: "closed",
      version: 4,
    });
    const afterReclose = await payLine(manager, run.id, line.id);
    expect(afterReclose.status, JSON.stringify(afterReclose.body)).toBe(409);
    expect(errorCode(afterReclose)).toBe("PERIOD_CHANGED");
    await expect(rawPay()).rejects.toThrow(/SH-02/);

    const after = parseRun((await getRun(manager, run.id)).body);
    expect(after.status).toBe("approved");
    expect(after.lines.every((l) => l.paymentStatus === "pending")).toBe(true);
  });

  // ---- review: withdraw an unpaid approved run, flag a paid stale one ------

  const cancelApproved = (who: Person, runId: string, reason: string) =>
    post(who, `/distributions/${runId}/cancel-approved`, {
      reason,
      idempotencyKey: key("cancel-approved"),
    });
  const listed = async (world: World, runId: string) => {
    const response = await get(
      manager,
      `/profit-entities/${world.profitEntityId}/distributions`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (
      response.body as { data: { id: string; needsCorrection: boolean }[] }
    ).data.find((row) => row.id === runId)!;
  };

  it("Maret paid, reopened, Rp30 jt payroll, closed again: needsCorrection until an approved claw-back", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { period, run } = await approved60(world);
    expect((await payAll(manager, run)).status).toBe("paid");
    expect((await listed(world, run.id)).needsCorrection).toBe(false);

    const request = await requestReopen(period.id);
    await approveReopen(request.id);
    await postEntry(world.legalEntityId, `${period.period}-28`, [
      journalLine(world.accounts.expense, 30_000_000, 0),
      journalLine(world.accounts.cash, 0, 30_000_000),
    ]);
    await closeFiscalPeriod(
      scopedContext(),
      period.id,
      { expectedVersion: 3, idempotencyKey: `close-${randomUUID()}` },
      userIdSchema.parse(closer),
    );
    expect((await listed(world, run.id)).needsCorrection).toBe(true);

    const adjusted = await adjust(manager, run.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: -30_000_000,
      reason: "Gaji Maret Rp30 jt terlewat",
    });
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(201);
    const adjustment = parseRun(adjusted.body);
    expect((await submitRun(manager, adjustment.id)).status).toBe(200);
    // Still flagged while the claw-back only waits for approval.
    expect((await listed(world, run.id)).needsCorrection).toBe(true);
    const decided = await decideRun(approver, adjustment.id);
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect((await listed(world, run.id)).needsCorrection).toBe(false);
  });

  it("cancels an unpaid approved run; refuses one with a paid line (409) and a non-approver (403)", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await approved60(world);

    const noPermission = await cancelApproved(
      manager,
      run.id,
      "Angka basi, dihitung ulang",
    );
    expect(noPermission.status, JSON.stringify(noPermission.body)).toBe(403);
    const shortReason = await cancelApproved(approver, run.id, "basi");
    expect(shortReason.status, JSON.stringify(shortReason.body)).toBe(422);

    const cancelled = await cancelApproved(
      approver,
      run.id,
      "Angka basi, dihitung ulang",
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(parseRun((await getRun(manager, run.id)).body).status).toBe(
      "cancelled",
    );
    const audit = await owner.query(
      `SELECT 1 FROM audit_logs
       WHERE tenant_id = $1 AND event->>'action' = 'profit_share.distribution_cancelled'
         AND event->>'objectId' = $2`,
      [tenantA, run.id],
    );
    expect(audit.rowCount).toBe(1);

    const other = await makeWorld(roundingPolicy, roundingShares());
    const partly = await approved60(other);
    const line = partly.run.lines.find((l) => l.paymentStatus === "pending")!;
    expect((await payLine(manager, partly.run.id, line.id)).status).toBe(200);
    const refused = await cancelApproved(
      approver,
      partly.run.id,
      "Angka basi, dihitung ulang",
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused)).toBe("DISTRIBUTION_PARTIALLY_PAID");
    // The DB refuses the same raw transition.
    await expect(
      owner.query(
        `UPDATE distribution_runs SET status = 'cancelled', cancelled_by = 'raw',
           cancelled_at = now(), cancel_reason = 'Angka basi, dihitung ulang'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantA, partly.run.id],
      ),
    ).rejects.toThrow(/SH-04/);
    expect(parseRun((await getRun(manager, partly.run.id)).body).status).toBe(
      "approved",
    );
  });

  it("a stale approved run (period reopened before) is cancelled, then recalculated", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { period, run } = await approved60(world);
    await forcePeriod(period.id, "open");
    await forcePeriod(period.id, "closed");

    const cancelled = await cancelApproved(
      approver,
      run.id,
      "Periode dibuka ulang sebelum rilis",
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const recalculated = await createRun(manager, world, period.id);
    expect(recalculated.status, JSON.stringify(recalculated.body)).toBe(201);
    expect(parseRun(recalculated.body).status).toBe("draft");
  });

  async function approvedTopUp(world: World) {
    const { period, run } = await approved60(world);
    const adjusted = await adjust(manager, run.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: 10_000_000,
      reason: "Tambahan laba Maret Rp10 jt",
    });
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(201);
    const adjustment = parseRun(adjusted.body);
    expect((await submitRun(manager, adjustment.id)).status).toBe(200);
    const decided = await decideRun(approver, adjustment.id);
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    return { run, adjustment: parseRun(decided.body) };
  }

  it("refuses to cancel an approved run with a live adjustment (service and DB)", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run, adjustment } = await approvedTopUp(world);
    expect(adjustment.status).toBe("approved");

    const refused = await cancelApproved(
      approver,
      run.id,
      "Angka basi, dihitung ulang",
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused)).toBe("DISTRIBUTION_HAS_ADJUSTMENT");
    await expect(
      owner.query(
        `UPDATE distribution_runs SET status = 'cancelled', cancelled_by = 'raw',
           cancelled_at = now(), cancel_reason = 'Angka basi, dihitung ulang'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantA, run.id],
      ),
    ).rejects.toThrow(/live adjustment/);
    expect(parseRun((await getRun(manager, run.id)).body).status).toBe(
      "approved",
    );
  });

  /** Cancels a run with every trigger off: a state the guards now refuse. */
  async function forceCancelled(runId: string) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `UPDATE distribution_runs SET status = 'cancelled', cancelled_by = 'raw',
           cancelled_at = now(), cancel_reason = 'Dipaksa untuk test'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantA, runId],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }

  it("an adjustment of a cancelled run is never paid (service and DB)", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run, adjustment } = await approvedTopUp(world);
    await forceCancelled(run.id);
    const line = adjustment.lines.find((l) => l.paymentStatus === "pending")!;
    const paid = await payLine(manager, adjustment.id, line.id);
    expect(paid.status, JSON.stringify(paid.body)).toBe(422);
    expect(errorCode(paid)).toBe("ADJUSTMENT_TARGET_INVALID");
    await expect(
      owner.query(
        `UPDATE distribution_lines SET payment_status = 'paid', payment_ref = 'RAW',
           paid_at = now(), paid_by = 'raw'
         WHERE tenant_id = $1 AND id = $2`,
        [tenantA, line.id],
      ),
    ).rejects.toThrow(/ADJUSTMENT_TARGET_INVALID/);
  });

  it("an approved run whose zero lines were settled by the carry can be cancelled", async () => {
    const { world, approved } = await approvedRunWithAbsorbedHolders();
    expect(
      approved.lines.some(
        (line) => line.grossIdr === 0 && line.paymentStatus === "paid",
      ),
    ).toBe(true);
    const cancelled = await cancelApproved(
      approver,
      approved.id,
      "Angka basi, dihitung ulang",
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(parseRun(cancelled.body).status).toBe("cancelled");
    expect(world.profitEntityId).toBeTruthy();
  });

  it("cancelling a run whose zero lines took the carry opens that shortfall again", async () => {
    const { world, approved } = await approvedRunWithAbsorbedHolders();
    const carry = async () =>
      (
        await owner.query<{ total: string; open: string }>(
          `SELECT coalesce(sum(s.amount_idr), 0)::text AS total,
                  coalesce(sum(s.amount_idr - coalesce((
                    SELECT sum(d.amount_idr) FROM distribution_carry_deductions d
                    JOIN distribution_runs r
                      ON r.tenant_id = d.tenant_id AND r.id = d.distribution_run_id
                    WHERE d.tenant_id = s.tenant_id AND d.shortfall_id = s.id
                      AND r.status <> 'cancelled'
                  ), 0)), 0)::text AS open
           FROM distribution_run_shortfalls s
           WHERE s.tenant_id = $1 AND s.profit_entity_id = $2`,
          [tenantA, world.profitEntityId],
        )
      ).rows[0]!;
    const before = await carry();
    expect(Number(before.total)).toBeGreaterThan(0);
    // The approved run consumed part of the shortfall.
    expect(Number(before.open)).toBeLessThan(Number(before.total));

    const cancelled = await cancelApproved(
      approver,
      approved.id,
      "Angka basi, dihitung ulang",
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const after = await carry();
    expect(after.open).toBe(after.total);
  });

  it("an adjustment of a cancelled run is never approved (service and DB)", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { period, run } = await approved60(world);
    const adjusted = await adjust(manager, run.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: 10_000_000,
      reason: "Tambahan laba Maret Rp10 jt",
    });
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(201);
    const adjustment = parseRun(adjusted.body);
    expect((await submitRun(manager, adjustment.id)).status).toBe(200);
    await forceCancelled(run.id);

    await expect(
      owner.query(
        `UPDATE distribution_runs SET status = 'approved',
           approved_by = 'raw-approver', approved_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantA, adjustment.id],
      ),
    ).rejects.toThrow(/corrects a cancelled run/);
    const decided = await decideRun(approver, adjustment.id);
    expect(decided.status, JSON.stringify(decided.body)).toBe(422);
    expect(errorCode(decided)).toBe("ADJUSTMENT_TARGET_INVALID");
    expect(parseRun((await getRun(manager, adjustment.id)).body).status).toBe(
      "pending_approval",
    );
  });

  it("a draft or rejected run cannot be cancelled with an approval set (DB)", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const draft = (await draftRun(world, 60_000_000)).run;
    const rawCancel = (id: string) =>
      owner.query(
        `UPDATE distribution_runs SET status = 'cancelled', cancelled_by = 'raw',
           cancelled_at = now(), cancel_reason = 'Dibatalkan mentah',
           approved_by = 'raw-approver', approved_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantA, id],
      );
    await expect(rawCancel(draft.id)).rejects.toThrow(/carries no approval/);
    expect((await submitRun(manager, draft.id)).status).toBe(200);
    await expect(rawCancel(draft.id)).rejects.toThrow(/carries no approval/);
  });
});

// ---- 1251 legend-905j / legend-j7018 -----------------------------------------
// - 905j: one real payment run = exactly one journal. `distribution.paid`
//   (per line) and `distribution.completed` are domain facts for other readers;
//   neither is an auto-journal event, so only the service books the run.
// - j7018: a last payment dated in a closed month never writes to the closed
//   month, for a payout and for a claw-back, whatever later months are closed.

describe("1251 one journal per paid run, and late payments after a close", () => {
  const dividendJournals = async (runId: string) =>
    (
      await owner.query<{ id: string; entry_date: string; fp_status: string }>(
        `SELECT je.id, je.entry_date::text AS entry_date, fp.status AS fp_status
         FROM journal_entries je
         JOIN fiscal_periods fp ON fp.tenant_id = je.tenant_id AND fp.id = je.fiscal_period_id
         WHERE je.tenant_id = $1 AND je.source_type = 'dividend' AND je.source_id = $2`,
        [tenantA, runId],
      )
    ).rows;

  it("905j: paid and completed events are not auto-journal events; a paid run has exactly one dividend journal, and a replayed last payment adds none", async () => {
    expect(isAutoJournalEvent("distribution.paid")).toBe(false);
    expect(isAutoJournalEvent("distribution.completed")).toBe(false);
    expect(isAutoJournalEvent("distribution.approved")).toBe(false);
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run } = await approvedRun(world);
    const last = run.lines[run.lines.length - 1]!;
    const paidKey = key("pay");
    const paidAtIso = new Date().toISOString();
    for (const line of run.lines)
      expect(
        (
          await payLine(
            manager,
            run.id,
            line.id,
            line.id === last.id ? paidKey : key("pay"),
            "TRF-1251",
            paidAtIso,
          )
        ).status,
      ).toBe(200);
    const events = await owner.query<{ event_name: string }>(
      `SELECT event->>'name' AS event_name FROM domain_event_outbox
       WHERE tenant_id = $1 AND event->>'name' LIKE 'distribution.%'
         AND event->'payload'->>'distributionRunId' = $2`,
      [tenantA, run.id],
    );
    const count = (name: string) =>
      events.rows.filter((row) => row.event_name === name).length;
    expect(count("distribution.paid")).toBe(run.lines.length);
    expect(count("distribution.completed")).toBe(1);
    expect(await dividendJournals(run.id)).toHaveLength(1);
    // Replaying the final payment (same key) does not book a second entry.
    const replay = await payLine(
      manager,
      run.id,
      last.id,
      paidKey,
      "TRF-1251",
      paidAtIso,
    );
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(await dividendJournals(run.id)).toHaveLength(1);
  });

  it("j7018: with later months also closed, a payout dated in the first closed month books after the LATEST closed month, in an open period", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run, period } = await backdatedApprovedRun(
      world,
      new Date("2021-01-20T03:00:00Z"),
    );
    expect(period.period).toBe("2021-01");
    await closedPeriod(world, NET_PROFIT); // 2021-02
    const third = await closedPeriod(world, NET_PROFIT); // 2021-03
    expect(third.period).toBe("2021-03");
    let last = null;
    for (const line of run.lines) {
      last = await payLineAt(
        manager,
        run.id,
        line.id,
        new Date("2021-01-25T03:00:00Z"),
      );
      expect(last.status, JSON.stringify(last.body)).toBe(200);
    }
    expect(parseRun(last!.body).status).toBe("paid");
    const [entry, ...rest] = await dividendJournals(run.id);
    expect(rest).toHaveLength(0);
    expect(entry!.fp_status).toBe("open");
    expect(entry!.entry_date).toBe("2021-04-01");
    const late = await owner.query<{ late_adjustment_from: string }>(
      `SELECT late_adjustment_from::text FROM journal_entries WHERE tenant_id = $1 AND id = $2`,
      [tenantA, entry!.id],
    );
    expect(late.rows[0]!.late_adjustment_from).toBe("2021-01-25");
  });

  it("j7018: a claw-back whose last payment is dated in a closed month posts the mirrored entry in an open period and flags the late date", async () => {
    const world = await makeWorld(roundingPolicy, roundingShares());
    const { run: original, period } = await paidRun(world);
    const response = await adjust(manager, original.id, {
      fiscalPeriodId: period.id,
      adjustmentIdr: -100_000,
      reason: "Pembayaran berlebih dikoreksi",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const adjustment = parseRun(response.body);
    expect((await submitRun(manager, adjustment.id)).status).toBe(200);
    await owner.query(
      `UPDATE distribution_runs SET status = 'approved', approved_by = $3, approved_at = $4
       WHERE tenant_id = $1 AND id = $2`,
      [
        tenantA,
        adjustment.id,
        approver.userId,
        new Date("2021-01-20T03:00:00Z"),
      ],
    );
    const approved = parseRun((await getRun(manager, adjustment.id)).body);
    let last = null;
    for (const line of approved.lines) {
      last = await payLineAt(
        manager,
        adjustment.id,
        line.id,
        new Date("2021-01-25T03:00:00Z"),
      );
      expect(last.status, JSON.stringify(last.body)).toBe(200);
    }
    const paid = parseRun(last!.body);
    expect(paid.status).toBe("paid");
    expect(paid.reversalJournalEntryId).not.toBeNull();
    const [entry, ...rest] = await dividendJournals(adjustment.id);
    expect(rest).toHaveLength(0);
    expect(entry!.id).toBe(paid.reversalJournalEntryId);
    expect(entry!.fp_status).toBe("open");
    expect(entry!.entry_date).toBe("2021-02-01");
    const journal = await journalOf(entry!.id);
    expect(journal.totalDebit).toBe(journal.totalCredit);
    expect(journal.byAccount(world.accounts.retainedEarnings).credit).toBe(
      100_000,
    );
  });
});
