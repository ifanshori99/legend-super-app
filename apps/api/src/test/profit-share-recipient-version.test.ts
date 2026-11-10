// Profit-share recipient versions (Codex 379, bead legend-33im6, S3): changing
// the login a shareholder row points at is a versioned change decided through
// the approval matrix (`shareholder_version`), and a past statement stays with
// the login it was created for.
//
// Before the fix `updateShareholderService` overwrote `shareholders.user_id`
// and statement access compared the live value, so the new login could read the
// previous login's paid history. These tests run the real Better Auth, tenant
// resolver, RBAC, PostgreSQL and RLS. Runs are created through the HTTP
// endpoint (the line snapshot is written by `insertRun`); the approve/pay steps
// are seeded as the migration owner, so this suite does not depend on how the
// run approval itself is wired (S1).
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
  type DistributionRun,
} from "@starter/shared/accounting";
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
import { decideApprovalRequest } from "../services/platform-approval.service";
import { settleShareholderRecipientVersionForApproval } from "../services/profit-share-registry.service";
import { issueDistributionStatement } from "../services/profit-share-statement.service";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import { closeFiscalPeriod } from "../services/accounting-period-close.service";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { agent, originHeader, signUp } from "./helpers";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
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

type Person = { client: ReturnType<typeof agent>; userId: string };

async function signedIn(name: string): Promise<Person> {
  const client = agent(appA);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  return { client, userId: session.body.user.id as string };
}

async function customRole(userId: string, permissions: string[]) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantA,
      `Recipient version test ${roleId.slice(0, 8)}`,
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

/** The seeded `shareholder` template holds `profit_share.own.view`. */
async function shareholderUser(name: string) {
  const person = await signedIn(name);
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
const patch = (who: Person, path: string, body: unknown) =>
  who.client
    .patch(`${API}${path}`)
    .set(originHeader)
    .send(body as object);
const get = (who: Person, path: string) => who.client.get(`${API}${path}`);

// ---- Fixtures ---------------------------------------------------------------

const baseContext = () =>
  establishTenantContext({
    tenantId: tenantA,
    brandId: null,
    source: "session",
  });
const scopedContext = (): ScopedTenantContext =>
  establishScopedTenantContext(baseContext(), { kind: "tenant" });

type Accounts = { cash: string; revenue: string; expense: string };

/** Legal entity + the three accounts a closed period's profit needs. */
async function makeLegalEntity() {
  const legalEntityId = randomUUID();
  const accounts: Accounts = {
    cash: randomUUID(),
    revenue: randomUUID(),
    expense: randomUUID(),
  };
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [legalEntityId, tenantA, `Versi penerima ${unique()}`],
  );
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $4, $5, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $4, $5, '4101', 'Penjualan', 'revenue', 'revenue'),
            ($3, $4, $5, '6101', 'Beban operasional', 'expense', 'operating_expense')`,
    [accounts.cash, accounts.revenue, accounts.expense, tenantA, legalEntityId],
  );
  return { legalEntityId, accounts };
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
      description: "Penjualan dan beban (uji versi penerima)",
      lines,
      postedBy: null,
      idempotencyKey: `post-${randomUUID()}`,
    }),
  );
}

const closer = randomUUID();
const NET_PROFIT = 1_000_000;

/** A CLOSED fiscal period whose P&L net profit is exactly NET_PROFIT. */
async function closedPeriod(
  world: { legalEntityId: string; accounts: Accounts },
  period: string,
) {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantA, world.legalEntityId, period],
  );
  const date = `${period}-15`;
  await postEntry(world.legalEntityId, date, [
    journalLine(world.accounts.cash, NET_PROFIT + 1_000_000, 0),
    journalLine(world.accounts.revenue, 0, NET_PROFIT + 1_000_000),
  ]);
  await postEntry(world.legalEntityId, date, [
    journalLine(world.accounts.expense, 1_000_000, 0),
    journalLine(world.accounts.cash, 0, 1_000_000),
  ]);
  await closeFiscalPeriod(
    scopedContext(),
    rows[0]!.id,
    { expectedVersion: 1, idempotencyKey: `close-${randomUUID()}` },
    userIdSchema.parse(closer),
  );
  return rows[0]!.id;
}

// ---- People (created once) ---------------------------------------------------

let manager: Person; // registry.manage: requests the recipient change
let approver: Person; // approval.request.decide: decides it in the inbox
let approverRoleId: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  manager = await signedIn("Recipient Manager");
  await customRole(manager.userId, ["profit_share.registry.manage"]);
  approver = await signedIn("Recipient Approver");
  approverRoleId = await customRole(approver.userId, [
    "approval.request.decide",
  ]);
  await setPolicy(true);
}, 120_000);

afterAll(async () => {
  await owner.end();
});

/** The tenant's matrix for `shareholder_version`: one level, the approver role. */
async function setPolicy(present: boolean) {
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'shareholder_version'`,
    [tenantA],
  );
  if (present)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'shareholder_version', NULL, $2, 1)`,
      [tenantA, approverRoleId],
    );
}

/**
 * One shareholder row linked to `login`, holding 50% of a fresh entity; an
 * unlinked second holder keeps the other half. A run whose every line is paid
 * must be `paid` (journal and all), so the second line stays pending and the
 * run stays `approved`: enough for statements, which only need a paid line.
 */
async function makeWorld(login: Person | null) {
  const created = await post(manager, "/shareholders", {
    name: `Pemegang ${unique()}`,
    type: "person",
    userId: login?.userId ?? null,
    npwp: null,
    payoutAccount: null,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const shareholderId = created.body.data.id as string;
  const other = await post(manager, "/shareholders", {
    name: `Pasangan ${unique()}`,
    type: "person",
    userId: null,
    npwp: null,
    payoutAccount: null,
  });
  expect(other.status, JSON.stringify(other.body)).toBe(201);
  const otherId = other.body.data.id as string;
  const { legalEntityId, accounts } = await makeLegalEntity();
  const entity = await post(manager, "/profit-entities", {
    name: `Entitas ${unique()}`,
    type: "legal_entity",
    legalEntityId,
    outletId: null,
    policy: {
      basis: "closed_period_net_profit",
      frequency: "monthly",
      reserveBp: 0,
      taxWithholdingBp: 500,
    },
  });
  expect(entity.status, JSON.stringify(entity.body)).toBe(201);
  const profitEntityId = entity.body.data.id as string;
  // The share version is seeded as owner (the registry suite owns its endpoints).
  await owner.query(
    `INSERT INTO share_allocation_versions
       (tenant_id, profit_entity_id, version, effective_from, status, requested_by, idempotency_key)
     VALUES ($1, $2, 1, '2020-01-01', 'draft', $3, $4)`,
    [tenantA, profitEntityId, manager.userId, key("seed-ver")],
  );
  await owner.query(
    `INSERT INTO share_allocations
       (tenant_id, profit_entity_id, version, shareholder_id, share_bp, position)
     VALUES ($1, $2, 1, $3, 5000, 0), ($1, $2, 1, $4, 5000, 1)`,
    [tenantA, profitEntityId, shareholderId, otherId],
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
    [tenantA, profitEntityId, approver.userId],
  );
  return { shareholderId, legalEntityId, accounts, profitEntityId, next: 0 };
}

type World = Awaited<ReturnType<typeof makeWorld>>;

/**
 * A run created through the endpoint (so `insertRun` snapshots the recipient),
 * then approved and its line paid as the migration owner.
 */
async function approvedRun(world: World): Promise<PaidRun> {
  const period = await closedPeriod(
    world,
    `${2021 + Math.floor(world.next / 12)}-${String((world.next++ % 12) + 1).padStart(2, "0")}`,
  );
  const response = await post(
    manager,
    `/profit-entities/${world.profitEntityId}/distributions`,
    { fiscalPeriodId: period, idempotencyKey: key("run") },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const run = distributionRunSchema.parse(response.body.data);
  await owner.query(
    `UPDATE distribution_runs SET status = 'pending_approval'
     WHERE tenant_id = $1 AND id = $2`,
    [tenantA, run.id],
  );
  await owner.query(
    `UPDATE distribution_runs
     SET status = 'approved', approved_by = $3, approved_at = now() - interval '1 hour'
     WHERE tenant_id = $1 AND id = $2`,
    [tenantA, run.id, approver.userId],
  );
  const lineId = run.lines.find(
    (line) => line.shareholderId === world.shareholderId,
  )!.id;
  return { run, lineId };
}

/** An approved run whose line of the world's shareholder is paid as owner. */
async function paidRun(world: World): Promise<PaidRun> {
  const { run, lineId } = await approvedRun(world);
  await owner.query(
    `UPDATE distribution_lines
     SET payment_status = 'paid', payment_ref = $3, paid_at = now(), paid_by = $4
     WHERE tenant_id = $1 AND distribution_run_id = $2 AND shareholder_id = $5`,
    [tenantA, run.id, `TRF-${unique()}`, manager.userId, world.shareholderId],
  );
  return { run, lineId };
}

type PaidRun = { run: DistributionRun; lineId: string };

const statementPath = ({ run, lineId }: PaidRun) =>
  `/distributions/${run.id}/lines/${lineId}/statement`;

async function userIdOf(shareholderId: string) {
  const { rows } = await owner.query<{ user_id: string | null }>(
    "SELECT user_id FROM shareholders WHERE tenant_id = $1 AND id = $2",
    [tenantA, shareholderId],
  );
  return rows[0]!.user_id;
}

async function versionsOf(shareholderId: string) {
  const { rows } = await owner.query<{
    id: string;
    version: number;
    status: string;
    previous_user_id: string | null;
    user_id: string | null;
    approval_chain_id: string | null;
    requested_by: string;
    decided_by: string | null;
  }>(
    `SELECT id, version, status, previous_user_id, user_id, approval_chain_id,
            requested_by, decided_by
     FROM shareholder_recipient_versions
     WHERE tenant_id = $1 AND shareholder_id = $2 ORDER BY version`,
    [tenantA, shareholderId],
  );
  return rows;
}

/** The inbox decision, then the settle the outbox consumer performs. */
async function decideAndSettle(
  versionId: string,
  chainId: string,
  decision: "approved" | "rejected",
) {
  const open = await owner.query<{ id: string }>(
    `SELECT id FROM approval_requests
     WHERE tenant_id = $1 AND chain_id = $2 AND status = 'pending'
     ORDER BY level LIMIT 1`,
    [tenantA, chainId],
  );
  await decideApprovalRequest(
    baseContext(),
    approver.userId,
    open.rows[0]!.id,
    { decision, reason: "Pergantian penerima sudah diverifikasi." },
    { mfaVerified: true, idempotencyKey: null },
  );
  const context = scopedContext();
  await withTenant(db, context, (tx) =>
    settleShareholderRecipientVersionForApproval(
      tx,
      context,
      versionId,
      new Date(),
    ),
  );
}

// ---- Tests -------------------------------------------------------------------

describe("S3 recipient change: versioned, approved, history stays with its login", () => {
  it("a PATCH to another login only opens a pending version; the statement stays Alice's", async () => {
    const alice = await shareholderUser("Alice Pemegang");
    const bob = await shareholderUser("Bob Pengganti");
    const world = await makeWorld(alice);
    const oldRun = await paidRun(world);
    const path = statementPath(oldRun);
    const first = await get(alice, path);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await get(bob, path)).status).toBe(404);

    const changed = await patch(
      manager,
      `/shareholders/${world.shareholderId}`,
      {
        userId: bob.userId,
        name: "Nama Baru Setelah Ganti",
      },
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    // The contract is unchanged: the response shows the CURRENT login, and the
    // other fields of the same PATCH apply right away.
    expect(changed.body.data.userId).toBe(alice.userId);
    expect(changed.body.data.name).toBe("Nama Baru Setelah Ganti");
    expect(await userIdOf(world.shareholderId)).toBe(alice.userId);
    const [pending, ...rest] = await versionsOf(world.shareholderId);
    expect(rest).toHaveLength(0);
    expect(pending).toMatchObject({
      version: 1,
      status: "pending_approval",
      previous_user_id: alice.userId,
      user_id: bob.userId,
      requested_by: manager.userId,
    });
    expect(pending!.approval_chain_id).not.toBeNull();

    // Bob cannot read Alice's paid history while the change is pending.
    expect((await get(bob, path)).status).toBe(404);
    expect((await get(alice, path)).status).toBe(200);
  });

  it("an approved change moves future statements only: Bob 404 on the old one, Alice still reads it, a new run snapshots Bob", async () => {
    const alice = await shareholderUser("Alice Dua");
    const bob = await shareholderUser("Bob Dua");
    const world = await makeWorld(alice);
    const oldRun = await paidRun(world);
    const oldPath = statementPath(oldRun);

    const changed = await patch(
      manager,
      `/shareholders/${world.shareholderId}`,
      {
        userId: bob.userId,
      },
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const [pending] = await versionsOf(world.shareholderId);
    expect(pending?.status).toBe("pending_approval");
    await decideAndSettle(pending!.id, pending!.approval_chain_id!, "approved");

    expect(await userIdOf(world.shareholderId)).toBe(bob.userId);
    const [settled] = await versionsOf(world.shareholderId);
    expect(settled).toMatchObject({
      status: "approved",
      decided_by: approver.userId,
    });

    // The paid history belongs to the login it was issued to.
    expect((await get(bob, oldPath)).status).toBe(404);
    const aliceRead = await get(alice, oldPath);
    expect(aliceRead.status, JSON.stringify(aliceRead.body)).toBe(200);
    expect(
      distributionStatementSchema.parse(aliceRead.body.data).distributionLineId,
    ).toBe(oldRun.lineId);

    // A run created after the change snapshots Bob, and only Bob reads it.
    const newRun = await paidRun(world);
    const lines = await owner.query<{ id: string; recipient_user_id: string }>(
      `SELECT id, recipient_user_id FROM distribution_lines
       WHERE tenant_id = $1 AND shareholder_id = $2`,
      [tenantA, world.shareholderId],
    );
    const snapshot = new Map(
      lines.rows.map((row) => [row.id, row.recipient_user_id]),
    );
    expect(snapshot.get(oldRun.lineId)).toBe(alice.userId);
    expect(snapshot.get(newRun.lineId)).toBe(bob.userId);
    expect((await get(bob, statementPath(newRun))).status).toBe(200);
    expect((await get(alice, statementPath(newRun))).status).toBe(404);
  });

  it("a rejected change leaves the login as it was", async () => {
    const alice = await shareholderUser("Alice Tiga");
    const bob = await shareholderUser("Bob Tiga");
    const world = await makeWorld(alice);
    const changed = await patch(
      manager,
      `/shareholders/${world.shareholderId}`,
      {
        userId: bob.userId,
      },
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const [pending] = await versionsOf(world.shareholderId);
    await decideAndSettle(pending!.id, pending!.approval_chain_id!, "rejected");
    expect(await userIdOf(world.shareholderId)).toBe(alice.userId);
    expect((await versionsOf(world.shareholderId))[0]?.status).toBe("rejected");
  });

  it("repeating the same PATCH while it is pending opens no second version", async () => {
    const alice = await shareholderUser("Alice Empat");
    const bob = await shareholderUser("Bob Empat");
    const world = await makeWorld(alice);
    const path = `/shareholders/${world.shareholderId}`;
    expect((await patch(manager, path, { userId: bob.userId })).status).toBe(
      200,
    );
    expect((await patch(manager, path, { userId: bob.userId })).status).toBe(
      200,
    );
    expect(await versionsOf(world.shareholderId)).toHaveLength(1);
    // A different target while one change is open is a conflict.
    const other = await shareholderUser("Carol Empat");
    const clash = await patch(manager, path, { userId: other.userId });
    expect(clash.status, JSON.stringify(clash.body)).toBe(409);
  });

  it("fails closed when the matrix has no policy: no version, login unchanged", async () => {
    const alice = await shareholderUser("Alice Lima");
    const bob = await shareholderUser("Bob Lima");
    const world = await makeWorld(alice);
    await setPolicy(false);
    try {
      const refused = await patch(
        manager,
        `/shareholders/${world.shareholderId}`,
        {
          userId: bob.userId,
        },
      );
      expect(
        refused.status,
        JSON.stringify(refused.body),
      ).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
    } finally {
      await setPolicy(true);
    }
    expect(await userIdOf(world.shareholderId)).toBe(alice.userId);
    expect(await versionsOf(world.shareholderId)).toHaveLength(0);
  });
});

describe("R2 statement recipient is the login of the paid line", () => {
  it("emails the paid-time recipient (Alice) after an approved change to Bob", async () => {
    const alice = await shareholderUser("Alice Email");
    const bob = await shareholderUser("Bob Email");
    const world = await makeWorld(alice);
    const paid = await paidRun(world);
    const changed = await patch(
      manager,
      `/shareholders/${world.shareholderId}`,
      { userId: bob.userId },
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const [pending] = await versionsOf(world.shareholderId);
    await decideAndSettle(pending!.id, pending!.approval_chain_id!, "approved");
    expect(await userIdOf(world.shareholderId)).toBe(bob.userId);

    const emails = await owner.query<{ id: string; email: string }>(
      `SELECT id, email FROM "user" WHERE id = ANY($1)`,
      [[alice.userId, bob.userId]],
    );
    const emailOf = (id: string) =>
      emails.rows.find((row) => row.id === id)!.email;
    const sent: string[] = [];
    await issueDistributionStatement(
      scopedContext(),
      { distributionRunId: paid.run.id, distributionLineId: paid.lineId },
      {
        storage: { put: async () => ({}) } as never,
        email: {
          send: async (_context: unknown, message: { to: string }) => {
            sent.push(message.to);
            return {};
          },
        } as never,
      },
    );
    expect(sent).toEqual([emailOf(alice.userId)]);
    expect(sent).not.toContain(emailOf(bob.userId));
  });
});

describe("R2 payment-time recipient and the former login", () => {
  it("a login linked after the run was created reads the statement once paid", async () => {
    const bob = await shareholderUser("Bob Bayar");
    const world = await makeWorld(null);
    const { run, lineId } = await approvedRun(world);
    const path = statementPath({ run, lineId });
    const snapshot = await owner.query<{ recipient_user_id: string | null }>(
      "SELECT recipient_user_id FROM distribution_lines WHERE id = $1",
      [lineId],
    );
    expect(snapshot.rows[0]!.recipient_user_id).toBeNull();

    const changed = await patch(
      manager,
      `/shareholders/${world.shareholderId}`,
      { userId: bob.userId },
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const [pending] = await versionsOf(world.shareholderId);
    await decideAndSettle(pending!.id, pending!.approval_chain_id!, "approved");

    const paid = await post(
      manager,
      `/distributions/${run.id}/lines/${lineId}/payment`,
      {
        paymentRef: `TRF-${unique()}`,
        paidAt: new Date(Date.now() - 60_000).toISOString(),
        idempotencyKey: key("pay"),
      },
    );
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const after = await owner.query<{ recipient_user_id: string | null }>(
      "SELECT recipient_user_id FROM distribution_lines WHERE id = $1",
      [lineId],
    );
    expect(after.rows[0]!.recipient_user_id).toBe(bob.userId);
    const read = await get(bob, path);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
  });

  it("an approved removal of the login leaves the paid line with no recipient: Alice 404, no email", async () => {
    const alice = await shareholderUser("Alice Dicabut");
    const world = await makeWorld(alice);
    const { run, lineId } = await approvedRun(world);
    const path = statementPath({ run, lineId });
    const snapshot = await owner.query<{ recipient_user_id: string | null }>(
      "SELECT recipient_user_id FROM distribution_lines WHERE id = $1",
      [lineId],
    );
    expect(snapshot.rows[0]!.recipient_user_id).toBe(alice.userId);

    const changed = await patch(
      manager,
      `/shareholders/${world.shareholderId}`,
      { userId: null },
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const [pending] = await versionsOf(world.shareholderId);
    await decideAndSettle(pending!.id, pending!.approval_chain_id!, "approved");
    expect(await userIdOf(world.shareholderId)).toBeNull();

    const paid = await post(
      manager,
      `/distributions/${run.id}/lines/${lineId}/payment`,
      {
        paymentRef: `TRF-${unique()}`,
        paidAt: new Date(Date.now() - 60_000).toISOString(),
        idempotencyKey: key("pay"),
      },
    );
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const after = await owner.query<{ recipient_user_id: string | null }>(
      "SELECT recipient_user_id FROM distribution_lines WHERE id = $1",
      [lineId],
    );
    expect(after.rows[0]!.recipient_user_id).toBeNull();
    const read = await get(alice, path);
    expect(read.status, JSON.stringify(read.body)).toBe(404);

    const sent: string[] = [];
    await issueDistributionStatement(
      scopedContext(),
      { distributionRunId: run.id, distributionLineId: lineId },
      {
        storage: { put: async () => ({}) } as never,
        email: {
          send: async (_context: unknown, message: { to: string }) => {
            sent.push(message.to);
            return {};
          },
        } as never,
      },
    );
    expect(sent).toEqual([]);
  });

  it("a former login still lists its own paid lines instead of 404", async () => {
    const alice = await shareholderUser("Alice Lama");
    const bob = await shareholderUser("Bob Baru");
    const world = await makeWorld(alice);
    const paid = await paidRun(world);
    const changed = await patch(
      manager,
      `/shareholders/${world.shareholderId}`,
      { userId: bob.userId },
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const [pending] = await versionsOf(world.shareholderId);
    await decideAndSettle(pending!.id, pending!.approval_chain_id!, "approved");

    const mine = await get(alice, "/my-profit-share");
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const lines = (
      mine.body.data.distributionHistory as { distributionLineId: string }[]
    ).map((entry) => entry.distributionLineId);
    expect(lines).toEqual([paid.lineId]);
    expect(mine.body.data.holdings).toEqual([]);
    // A login with neither a row nor a paid line still gets 404.
    const stranger = await shareholderUser("Orang Asing");
    expect((await get(stranger, "/my-profit-share")).status).toBe(404);
  });
});
