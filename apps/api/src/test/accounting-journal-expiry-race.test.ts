// Approval expiry race for manual and recurring journals (sub-brief 100,
// piece D; tingkat K). The bug: settle read the chain outcome without the
// chain lock, saw "pending" past the deadline and rejected the module row,
// while an inbox decision that had started before the deadline (holding the
// chain-head lock, not yet committed) then committed "approved" and the
// posting/effect was lost.
//
// Deterministic, no sleeps: a raw owner connection plays the in-flight inbox
// decision (BEGIN, lock the chain head FOR UPDATE, mark the level approved by
// a legitimate approver, no COMMIT yet). Settle runs with `now` far past the
// deadline in parallel. We prove settle is blocked on that lock through
// pg_blocking_pids (a condition, not a delay), then COMMIT and expect the
// decision to win. The no-decision case must still expire cleanly.
//
// The race cases are expected to FAIL on the old code (reproduction).

import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext, TenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { decideApprovalRequest } from "../services/platform-approval.service";
import { settleManualJournalForApproval } from "../services/accounting-journal-manual.service";
import { settleRecurringJournalForApproval } from "../services/accounting-journal-recurring.service";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const BASE = "/api/accounting";
// Each file owns its tenant and matrix, including during parallel Vitest runs.
const tenantId = randomUUID();
const outletId = randomUUID();
const hostname = `journal-expiry-race-${tenantId}.example.test`;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 6,
});
const createdUserIds: string[] = [];
const trackedTemplateIds: string[] = [];
const ACTIONS = ["manual_journal", "recurring_journal"];
const unique = () => randomBytes(4).toString("hex");
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

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

async function signedIn(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  client.set("Host", hostname);
  createdUserIds.push(userId);
  return { client, userId };
}

async function financeUser(name: string) {
  const user = await signedIn(name);
  await owner.query(
    // Backdate: the container clock can drift from Node's clock.
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 hour', $2)`,
    [tenantId, user.userId, await financeRoleId()],
  );
  return user;
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

/** A fresh entity with a chart, a requester and a different approver. */
async function scenario(name: string) {
  const requester = await financeUser(`${name} requester`);
  const approver = await financeUser(`${name} approver`);
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, `${name} ${unique()}`],
  );
  const entity = rows[0]!.id;
  const cash = await createAccount(requester.client, entity, {
    code: "1101",
    name: "Kas Outlet",
    type: "asset",
    reportGroup: "cash_and_equivalents",
  });
  const revenue = await createAccount(requester.client, entity, {
    code: "4101",
    name: "Penjualan",
    type: "revenue",
    reportGroup: "revenue",
  });
  return { requester, approver, entity, cash, revenue };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

function lines(s: Scenario, amount: number) {
  const side = (accountId: string, debitIdr: number, creditIdr: number) => ({
    accountId,
    debitIdr,
    creditIdr,
    outletId,
    costCenter: null,
  });
  return [side(s.cash, amount, 0), side(s.revenue, 0, amount)];
}

// ---- Manual journal setup -----------------------------------------------------------

/** Creates and submits a Rp2.000.000 journal so the approval chain opens. */
async function submittedJournal(s: Scenario): Promise<string> {
  const created = await s.requester.client
    .post(`${BASE}/manual-journals`)
    .set(originHeader)
    .send({
      legalEntityId: s.entity,
      outletId,
      entryDate: "2026-11-02",
      kind: "general",
      description: "Jurnal umum penyesuaian kas (race test)",
      lines: lines(s, 2_000_000),
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

async function manualRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    decided_by: string | null;
    rejection_reason: string | null;
    posted_entry_id: string | null;
  }>(
    `SELECT status, decided_by, rejection_reason, posted_entry_id
       FROM manual_journals WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0]!;
}

async function entryCount(entity: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    "SELECT count(*) FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, entity],
  );
  return Number(rows[0]?.count);
}

// ---- Recurring template setup -------------------------------------------------------

async function submittedTemplate(s: Scenario): Promise<string> {
  const created = await s.requester.client
    .post(`${BASE}/recurring-journals`)
    .set(originHeader)
    .send({
      legalEntityId: s.entity,
      outletId,
      description: "Akrual sewa bulanan (race test)",
      lines: lines(s, 2_000_000),
      dayOfMonth: 10,
      startPeriod: "2026-01",
      endPeriod: null,
      idempotencyKey: `recurring-${randomUUID()}`,
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  trackedTemplateIds.push(id);
  const submitted = await s.requester.client
    .post(`${BASE}/recurring-journals/${id}/transition`)
    .set(originHeader)
    .send({ type: "submit" });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  return id;
}

async function templateRow(id: string) {
  const { rows } = await owner.query<{ status: string }>(
    `SELECT status FROM recurring_journals WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0]!;
}

// ---- Approval chain helpers ---------------------------------------------------------

async function chainHeadOf(objectType: string, objectId: string) {
  const { rows } = await owner.query<{ id: string; status: string }>(
    `SELECT id, status FROM approval_requests
      WHERE tenant_id = $1 AND source_module = 'accounting'
        AND object_type = $2 AND object_id = $3 AND level = 1`,
    [tenantId, objectType, objectId],
  );
  return rows[0]!;
}

async function approvalStatus(requestId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM approval_requests WHERE tenant_id = $1 AND id = $2",
    [tenantId, requestId],
  );
  return rows[0]!.status;
}

async function resolvedEventCount(chainId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*) FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [tenantId, chainId],
  );
  return Number(rows[0]?.count);
}

/**
 * A raw connection that behaves like an inbox decision caught in flight: it
 * holds the chain-head lock and has marked the (single) level approved, but
 * has not committed.
 */
async function startInFlightDecision(requestId: string, approverId: string) {
  const client: PoolClient = await owner.connect();
  let finished = false;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const { rows: pidRows } = await client.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const locked = await client.query(
      "SELECT id FROM approval_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId, requestId],
    );
    expect(locked.rowCount).toBe(1);
    const updated = await client.query(
      `UPDATE approval_requests
          SET status = 'approved', decided_by = $3, decided_at = now(),
              reason = 'Sesuai dokumen pendukung.', updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
      [tenantId, requestId, approverId],
    );
    expect(updated.rowCount).toBe(1);
    const pid = pidRows[0]!.pid;
    const end = async (sql: "COMMIT" | "ROLLBACK") => {
      if (finished) return;
      finished = true;
      try {
        await client.query(sql);
      } finally {
        client.release();
      }
    };
    return {
      pid,
      commit: () => end("COMMIT"),
      rollback: () => end("ROLLBACK"),
    };
  } catch (error) {
    if (!finished) {
      finished = true;
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    throw error;
  }
}

/**
 * True once some backend waits on a lock held by `holderPid`; false if
 * `isDone()` turns true first (settle finished without waiting, i.e. it never
 * took the chain lock). Polls a condition, not a fixed delay.
 */
async function settleIsWaitingOn(
  holderPid: number,
  isDone: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (isDone()) return false;
    const { rows } = await owner.query<{ waiting: string }>(
      `SELECT count(*) AS waiting FROM pg_locks l
        WHERE NOT l.granted AND $1::int = ANY(pg_blocking_pids(l.pid))`,
      [holderPid],
    );
    if (Number(rows[0]?.waiting) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** Runs `settle` in parallel with a held, uncommitted decision, then commits it. */
async function settleAgainstInFlightDecision<T>(
  requestId: string,
  approverId: string,
  settle: () => Promise<T>,
): Promise<T> {
  const decision = await startInFlightDecision(requestId, approverId);
  try {
    let done = false;
    const running = settle().finally(() => {
      done = true;
    });
    // Avoid an unhandled rejection if an assertion below throws first.
    running.catch(() => undefined);
    const waiting = await settleIsWaitingOn(decision.pid, () => done);
    expect(
      waiting,
      "settle must wait on the chain-head lock held by the in-flight decision",
    ).toBe(true);
    expect(done).toBe(false);
    await decision.commit();
    return await running;
  } finally {
    await decision.rollback();
  }
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
      `expiry-race-${tenantId}`,
      "Journal expiry-race test",
      fixture.tenant.plan,
      JSON.stringify(fixture.tenant.featureFlags),
      JSON.stringify(fixture.tenant.limits),
      fixture.tenant.createdBy,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'journal', 'Journal test')`,
    [brandId, tenantId],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, 'Journal outlet entity')`,
    [entityId, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'JOURNAL', 'Journal test', 'Jl. Uji', 'Asia/Jakarta', '{}', 'active')`,
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

function expiredDecide(userId: string, requestId: string) {
  return decideApprovalRequest(
    tenant,
    userId,
    requestId,
    { decision: "approved", reason: "Sesuai dokumen pendukung." },
    { mfaVerified: true, idempotencyKey: null },
  );
}

describe("manual journal settle vs an in-flight inbox decision", () => {
  it("settle past the deadline waits for the in-flight approval, then posts the journal", async () => {
    const s = await scenario("manual race");
    const id = await submittedJournal(s);
    const head = await chainHeadOf("manual_journal", id);
    const context = scopedContext();

    const settled = await settleAgainstInFlightDecision(
      head.id,
      s.approver.userId,
      () =>
        withTenant(db, context, (tx) =>
          settleManualJournalForApproval(
            tx,
            context,
            id,
            new Date(Date.now() + YEAR_MS),
          ),
        ),
    );

    expect(settled.status).toBe("posted");
    expect(settled.decidedBy?.toLowerCase()).toBe(
      s.approver.userId.toLowerCase(),
    );
    expect(await manualRow(id)).toMatchObject({
      status: "posted",
      rejection_reason: null,
    });
    expect((await manualRow(id)).posted_entry_id).not.toBeNull();
    expect(await entryCount(s.entity)).toBe(1);
    expect(await approvalStatus(head.id)).toBe("approved");
  });

  it("settle past the deadline with no decision expires the request and rejects the journal; a late decision is refused", async () => {
    const s = await scenario("manual expiry");
    const id = await submittedJournal(s);
    const head = await chainHeadOf("manual_journal", id);
    const context = scopedContext();

    const settled = await withTenant(db, context, (tx) =>
      settleManualJournalForApproval(
        tx,
        context,
        id,
        new Date(Date.now() + YEAR_MS),
      ),
    );

    expect(settled.status).toBe("rejected");
    expect(settled.decidedBy).toBeNull();
    expect(settled.rejectionReason).toBe("approval expired");
    expect(await manualRow(id)).toMatchObject({
      status: "rejected",
      posted_entry_id: null,
    });
    expect(await entryCount(s.entity)).toBe(0);
    expect(await approvalStatus(head.id)).toBe("expired");
    expect(await resolvedEventCount(head.id)).toBe(1);

    await expect(
      expiredDecide(s.approver.userId, head.id),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED" });
    // The refused decision leaves everything as settle left it.
    expect(await approvalStatus(head.id)).toBe("expired");
    expect((await manualRow(id)).status).toBe("rejected");
    expect(await resolvedEventCount(head.id)).toBe(1);
  });

  it("settling twice after expiry stays expired and emits approval.resolved once", async () => {
    const s = await scenario("manual expiry twice");
    const id = await submittedJournal(s);
    const head = await chainHeadOf("manual_journal", id);
    const context = scopedContext();
    const late = () =>
      withTenant(db, context, (tx) =>
        settleManualJournalForApproval(
          tx,
          context,
          id,
          new Date(Date.now() + YEAR_MS),
        ),
      );

    const first = await late();
    const second = await late();
    expect(first.status).toBe("rejected");
    expect(second).toEqual(first);
    expect(await resolvedEventCount(head.id)).toBe(1);
  });
});

describe("recurring template settle vs an in-flight inbox decision", () => {
  it("settle past the deadline waits for the in-flight approval, then activates the template", async () => {
    const s = await scenario("recurring race");
    const id = await submittedTemplate(s);
    const head = await chainHeadOf("recurring_journal", id);
    const context = scopedContext();

    const settled = await settleAgainstInFlightDecision(
      head.id,
      s.approver.userId,
      () =>
        withTenant(db, context, (tx) =>
          settleRecurringJournalForApproval(
            tx,
            context,
            id,
            new Date(Date.now() + YEAR_MS),
          ),
        ),
    );

    expect(settled.status).toBe("active");
    expect((await templateRow(id)).status).toBe("active");
    expect(await approvalStatus(head.id)).toBe("approved");
  });

  it("settle past the deadline with no decision expires the request and rejects the template; a late decision is refused", async () => {
    const s = await scenario("recurring expiry");
    const id = await submittedTemplate(s);
    const head = await chainHeadOf("recurring_journal", id);
    const context = scopedContext();

    const settled = await withTenant(db, context, (tx) =>
      settleRecurringJournalForApproval(
        tx,
        context,
        id,
        new Date(Date.now() + YEAR_MS),
      ),
    );

    expect(settled.status).toBe("rejected");
    expect((await templateRow(id)).status).toBe("rejected");
    expect(await approvalStatus(head.id)).toBe("expired");
    expect(await resolvedEventCount(head.id)).toBe(1);

    await expect(
      expiredDecide(s.approver.userId, head.id),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED" });
    expect((await templateRow(id)).status).toBe("rejected");
    expect(await resolvedEventCount(head.id)).toBe(1);
  });
});
