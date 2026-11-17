// Profit-share distribution approval goes through the matrix (Codex 377, bead
// legend-33im6 S1). Before the fix any non-maker holding
// `profit_share.distribution.approve` approved any amount straight from the
// decide route; the tenant's `dividend_distribution` policy (roles, levels,
// thresholds) was never consulted.
//
// Fixtures that are not the unit under test (legal entity, chart of accounts,
// closed fiscal period, share version, policy rows, inbox users) are written
// as the migration owner or through the services, like profit-share-distribution.
// The approval chain itself runs through the real approval service
// (`decideApprovalRequest`) and the real `approval.resolved` consumer.
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
  type DistributionRun,
} from "@starter/shared/accounting";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { auth } from "../lib/auth";
import { requestContext } from "../lib/request-context";
import { limitAuthBody } from "../middleware/body";
import { errorHandler, notFound } from "../middleware/error-handler";
import { tenantContext } from "../middleware/tenant";
import { createProfitShareDistributionRouter } from "../routes/profit-share-distribution.routes";
import { createProfitShareRegistryRouter } from "../routes/profit-share-registry.routes";
import { resolveHostname } from "../services/org-resolve.service";
import { deviceTenantCredential } from "../services/platform-tenant.service";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import { closeFiscalPeriod } from "../services/accounting-period-close.service";
import { setAuditWriter } from "../services/audit-writer";
import { coreAuditWriter } from "../services/core-audit-writer";
import { decideApprovalRequest } from "../services/platform-approval.service";
import { handleProfitShareApprovalResolved } from "../services/profit-share-approval-consumers";
import { agent, originHeader, signUp } from "./helpers";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const API = "/api/accounting";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");
const key = (label: string) => `${label}-${randomUUID()}`;

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

type Person = { client: ReturnType<typeof agent>; userId: string };

async function signedIn(name: string): Promise<Person> {
  const client = agent(appA);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  return { client, userId: session.body.user.id as string };
}

/** A tenant-wide custom role holding `permissions`, assigned to the user. */
async function giveRole(
  userId: string,
  permissions: string[],
  roleId = randomUUID(),
): Promise<string> {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantA,
      `Approval chain test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(["tenant"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantA, userId, roleId],
  );
  return roleId;
}

const MANAGE = "profit_share.registry.manage";
const APPROVE = "profit_share.distribution.approve";
const DECIDE = "approval.request.decide";

const post = (who: Person, path: string, body: unknown) =>
  who.client
    .post(`${API}${path}`)
    .set(originHeader)
    .send(body as object);

const base = () =>
  establishTenantContext({
    tenantId: tenantA,
    brandId: null,
    source: "session",
  });
const tenantScope = (): ScopedTenantContext =>
  establishScopedTenantContext(base(), { kind: "tenant" });
/** What the worker hands a consumer: tenant-wide scope minted from the job. */
const workerContext = establishScopedTenantContext(
  establishTenantContext({ tenantId: tenantA, brandId: null, source: "job" }),
  { kind: "tenant" },
);

// ---- Fixtures ----------------------------------------------------------------

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
  nextPeriod: number;
};

async function makeLegalEntity() {
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
    [legalEntityId, tenantA, `Rantai approval ${unique()}`],
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
  await owner.query(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, $3)`,
    [tenantA, legalEntityId, jakartaDate(new Date()).slice(0, 7)],
  );
  return { legalEntityId, accounts };
}

const periodKey = (index: number) =>
  `${2021 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;

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
  const context = tenantScope();
  await withTenant(db, context, (tx) =>
    postJournalInTransaction(tx, context, {
      legalEntityId,
      outletId: null,
      entryDate: businessDateSchema.parse(date),
      sourceType: "sale" as const,
      sourceId: randomUUID(),
      description: "Penjualan dan beban (uji rantai approval)",
      lines,
      postedBy: null,
      idempotencyKey: `post-${randomUUID()}`,
    }),
  );
}

/** A CLOSED fiscal period whose P&L net profit is exactly `netProfit`. */
async function closedPeriod(world: World, netProfit: number) {
  const period = periodKey(world.nextPeriod++);
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantA, world.legalEntityId, period],
  );
  const revenue = netProfit + 1_000_000;
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
  await closeFiscalPeriod(
    tenantScope(),
    rows[0]!.id,
    { expectedVersion: 1, idempotencyKey: `close-${randomUUID()}` },
    userIdSchema.parse(randomUUID()),
  );
  return { id: rows[0]!.id, period };
}

let manager: Person; // registry.manage: the maker
let directApprover: Person; // distribution.approve, no seat in the chain
let level1: Person; // inbox approver, level 1
let level2: Person; // inbox approver, level 2
let holderId: string;
let level1RoleId: string;
let level2RoleId: string;
let savedPolicies: Record<string, unknown>[] = [];

/** Replaces the tenant's `dividend_distribution` rows with `rows`. */
async function setPolicy(
  rows: { threshold: number | null; roleId: string; level: number }[],
) {
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'dividend_distribution'`,
    [tenantA],
  );
  for (const row of rows)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'dividend_distribution', $2, $3, $4)`,
      [tenantA, row.threshold, row.roleId, row.level],
    );
}

/** Two levels, always required (threshold null), one role per level. */
const twoLevelPolicy = () =>
  setPolicy([
    { threshold: null, roleId: level1RoleId, level: 1 },
    { threshold: null, roleId: level2RoleId, level: 2 },
  ]);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // The API bootstrap installs this; these service calls run without the app.
  setAuditWriter(coreAuditWriter);
  manager = await signedIn("Chain Manager");
  await giveRole(manager.userId, [MANAGE]);
  directApprover = await signedIn("Chain Direct Approver");
  await giveRole(directApprover.userId, [APPROVE]);
  level1 = await signedIn("Chain Level 1");
  level1RoleId = await giveRole(level1.userId, [DECIDE]);
  level2 = await signedIn("Chain Level 2");
  level2RoleId = await giveRole(level2.userId, [DECIDE]);
  const saved = await owner.query(
    `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'dividend_distribution'`,
    [tenantA],
  );
  savedPolicies = saved.rows;
  const holder = await post(manager, "/shareholders", {
    name: `Pemegang ${unique()}`,
    type: "person",
    userId: null,
    npwp: null,
    payoutAccount: null,
  });
  expect(holder.status, JSON.stringify(holder.body)).toBe(201);
  holderId = holder.body.data.id as string;
}, 120_000);

afterAll(async () => {
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'dividend_distribution'`,
    [tenantA],
  );
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'dividend_distribution', $2, $3, $4)`,
      [tenantA, row.threshold_idr, row.approver_role_id, row.levels],
    );
  await owner.end();
});

async function makeWorld(): Promise<World> {
  const { legalEntityId, accounts } = await makeLegalEntity();
  const entity = await post(manager, "/profit-entities", {
    name: `Entitas ${unique()}`,
    type: "legal_entity",
    legalEntityId,
    outletId: null,
    policy: {
      basis: "closed_period_net_profit",
      frequency: "monthly",
      reserveBp: 1000,
      taxWithholdingBp: 500,
    },
  });
  expect(entity.status, JSON.stringify(entity.body)).toBe(201);
  const profitEntityId = entity.body.data.id as string;
  // A share version in force: the version endpoints are the registry suite's.
  await owner.query(
    `INSERT INTO share_allocation_versions
       (tenant_id, profit_entity_id, version, effective_from, status, requested_by, idempotency_key)
     VALUES ($1, $2, 1, '2020-01-01', 'draft', $3, $4)`,
    [tenantA, profitEntityId, manager.userId, key("seed-ver")],
  );
  await owner.query(
    `INSERT INTO share_allocations
       (tenant_id, profit_entity_id, version, shareholder_id, share_bp, position)
     VALUES ($1, $2, 1, $3, 10000, 0)`,
    [tenantA, profitEntityId, holderId],
  );
  await owner.query(
    `UPDATE share_allocation_versions SET status = 'pending_approval'
     WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = 1`,
    [tenantA, profitEntityId],
  );
  await owner.query(
    `UPDATE share_allocation_versions
     SET status = 'approved', decided_by = $3, decided_at = now()
     WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = 1`,
    [tenantA, profitEntityId, directApprover.userId],
  );
  return { legalEntityId, accounts, profitEntityId, nextPeriod: 0 };
}

const parseRun = (body: { data: unknown }): DistributionRun =>
  distributionRunSchema.parse(body.data);

/** A submitted (pending_approval) run for a fresh world and closed period. */
async function pendingRun(netProfit = 1_000_001) {
  const world = await makeWorld();
  const period = await closedPeriod(world, netProfit);
  const created = await post(
    manager,
    `/profit-entities/${world.profitEntityId}/distributions`,
    { fiscalPeriodId: period.id, idempotencyKey: key("run") },
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const submitted = await post(
    manager,
    `/distributions/${parseRun(created.body).id}/submit`,
    { idempotencyKey: key("submit") },
  );
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  return parseRun(submitted.body);
}

const decideRoute = (
  who: Person,
  runId: string,
  decision: "approve" | "reject" = "approve",
) =>
  post(who, `/distributions/${runId}/decision`, {
    decision,
    note: decision === "reject" ? "Angka belum final" : null,
    idempotencyKey: key("decide"),
  });

async function statusOf(runId: string) {
  const { rows } = await owner.query<{
    status: string;
    approved_by: string | null;
    cancel_reason: string | null;
  }>(
    `SELECT status, approved_by, cancel_reason FROM distribution_runs
      WHERE tenant_id = $1 AND id = $2`,
    [tenantA, runId],
  );
  return rows[0]!;
}

async function chainOf(runId: string): Promise<string> {
  // Each run is created by this test; its level-one request identifies the chain.
  const { rows } = await owner.query<{ chain_id: string }>(
    `SELECT chain_id FROM approval_requests
      WHERE tenant_id = $1 AND source_module = 'profit_share'
        AND object_type = 'distribution_run' AND object_id = $2 AND level = 1`,
    [tenantA, runId],
  );
  expect(rows, "the submit opened an approval chain").toHaveLength(1);
  return rows[0]!.chain_id;
}

async function openLevelRow(chainId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM approval_requests
      WHERE tenant_id = $1 AND chain_id = $2 AND status = 'pending'
      ORDER BY level LIMIT 1`,
    [tenantA, chainId],
  );
  if (!rows[0]) throw new Error("No pending approval level");
  return rows[0].id;
}

const inboxDecide = (
  who: Person,
  requestId: string,
  decision: "approved" | "rejected",
) =>
  decideApprovalRequest(
    base(),
    who.userId,
    requestId,
    { decision, reason: "Sesuai laporan keuangan." },
    { mfaVerified: true, idempotencyKey: null },
  );

/** The `approval.resolved` event the chain's last decision appended. */
async function resolvedEventOf(chainId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [tenantA, chainId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

describe("S1 a distribution run is approved through the approval matrix", () => {
  it("answers 409 APPROVAL_PENDING to a direct approve while the chain is open", async () => {
    await twoLevelPolicy();
    const run = await pendingRun();
    const response = await decideRoute(directApprover, run.id);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error?.code).toBe("APPROVAL_PENDING");
    expect((await statusOf(run.id)).status).toBe("pending_approval");
  });

  it("approves only after the last level, as that level's user", async () => {
    await twoLevelPolicy();
    const run = await pendingRun();
    const chainId = await chainOf(run.id);

    await inboxDecide(level1, await openLevelRow(chainId), "approved");
    // Level 1 alone settles nothing, even if the consumer runs.
    expect((await statusOf(run.id)).status).toBe("pending_approval");

    await inboxDecide(level2, await openLevelRow(chainId), "approved");
    // The decision alone does not touch the run; the consumer applies it.
    expect((await statusOf(run.id)).status).toBe("pending_approval");
    const event = await resolvedEventOf(chainId);
    await handleProfitShareApprovalResolved(workerContext, event);

    const settled = await statusOf(run.id);
    expect(settled.status).toBe("approved");
    expect(settled.approved_by).toBe(level2.userId);
    // Replays are no-ops.
    await handleProfitShareApprovalResolved(workerContext, event);
    expect((await statusOf(run.id)).approved_by).toBe(level2.userId);

    // The decide route returns the settled run unchanged for a later caller.
    const again = await decideRoute(directApprover, run.id);
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("INVALID_TRANSITION");
  });

  it("settles from the decide route once the chain is approved", async () => {
    await twoLevelPolicy();
    const run = await pendingRun();
    const chainId = await chainOf(run.id);
    await inboxDecide(level1, await openLevelRow(chainId), "approved");
    await inboxDecide(level2, await openLevelRow(chainId), "approved");
    const response = await decideRoute(directApprover, run.id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const settled = await statusOf(run.id);
    expect(settled.status).toBe("approved");
    expect(settled.approved_by).toBe(level2.userId);
  });

  it("cancels the run when the inbox rejects", async () => {
    await twoLevelPolicy();
    const run = await pendingRun();
    const chainId = await chainOf(run.id);
    await inboxDecide(level1, await openLevelRow(chainId), "rejected");
    const event = await resolvedEventOf(chainId);
    await handleProfitShareApprovalResolved(workerContext, event);
    const settled = await statusOf(run.id);
    expect(settled.status).toBe("cancelled");
    expect(settled.cancel_reason).toContain("rejected");
  });

  it("refuses to reject the run from the route once the chain approved it", async () => {
    await twoLevelPolicy();
    const run = await pendingRun();
    const chainId = await chainOf(run.id);
    await inboxDecide(level1, await openLevelRow(chainId), "approved");
    await inboxDecide(level2, await openLevelRow(chainId), "approved");
    const response = await decideRoute(directApprover, run.id, "reject");
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error?.code).toBe("INVALID_TRANSITION");
    expect((await statusOf(run.id)).status).toBe("pending_approval");
  });

  it("cancels the open chain when the route rejects the run", async () => {
    await twoLevelPolicy();
    const run = await pendingRun();
    const chainId = await chainOf(run.id);
    const response = await decideRoute(directApprover, run.id, "reject");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await statusOf(run.id)).status).toBe("cancelled");
    const { rows } = await owner.query<{ status: string }>(
      `SELECT status FROM approval_requests WHERE tenant_id = $1 AND chain_id = $2`,
      [tenantA, chainId],
    );
    expect(rows.every((row) => row.status === "cancelled")).toBe(true);
  });

  it("keeps the direct path when the amount is below every threshold", async () => {
    // Applies only from Rp 1 trillion: this run is far below it.
    await setPolicy([
      { threshold: 1_000_000_000_000, roleId: level1RoleId, level: 1 },
    ]);
    const run = await pendingRun();
    const response = await decideRoute(directApprover, run.id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const settled = await statusOf(run.id);
    expect(settled.status).toBe("approved");
    expect(settled.approved_by).toBe(directApprover.userId);
  });
});

describe("R2 a policy tightened after submit is honoured at decide", () => {
  it("opens the chain and answers 409 instead of approving directly", async () => {
    // Below every threshold at submit: no chain opened.
    await setPolicy([
      { threshold: 1_000_000_000_000, roleId: level1RoleId, level: 1 },
    ]);
    const run = await pendingRun();
    const before = await owner.query(
      `SELECT 1 FROM approval_requests
        WHERE tenant_id = $1 AND source_module = 'profit_share' AND object_id = $2`,
      [tenantA, run.id],
    );
    expect(before.rows).toHaveLength(0);

    await twoLevelPolicy();
    const response = await decideRoute(directApprover, run.id);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error?.code).toBe("APPROVAL_PENDING");
    expect((await statusOf(run.id)).status).toBe("pending_approval");

    // The chain now exists, opened for the run's requester, and survived the 409.
    const chainId = await chainOf(run.id);
    const { rows } = await owner.query<{ requested_by: string }>(
      `SELECT requested_by FROM approval_requests
        WHERE tenant_id = $1 AND chain_id = $2 AND level = 1`,
      [tenantA, chainId],
    );
    expect(rows[0]!.requested_by).toBe(manager.userId);
  });
});
