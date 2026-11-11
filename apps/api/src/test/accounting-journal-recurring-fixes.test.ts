// Regression tests for the legend-vmyg review-K recurring fixes: T2 (resume
// keeps pre-pause arrears and records the months it skips), T3 (skip when
// posting would fail PERIOD_CLOSED), T4 (job failures are recorded and
// cleared), T5 (system rejections are audited). Setup mirrors
// accounting-journal.test.ts; times are fixed through the services' `now`
// argument so no test depends on the wall clock.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  userIdSchema,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  runDueRecurringJournals,
  settleRecurringJournalForApproval,
  transitionRecurringJournal,
} from "../services/accounting-journal-recurring.service";
import { decideApprovalRequest } from "../services/platform-approval.service";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const BASE = "/api/accounting";
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUserIds: string[] = [];
const trackedTemplateIds: string[] = [];
const createdRoleIds: string[] = [];
const ACTIONS = ["manual_journal", "recurring_journal"];
let savedPolicies: Record<string, unknown>[] = [];
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

async function signedIn(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
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

async function setClosed(entity: string, period: string, closed: boolean) {
  const actor = createdUserIds[0]!;
  if (closed)
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period, status, closed_by, closed_at)
       VALUES ($1, $2, $3, 'closed', $4, now())
       ON CONFLICT (tenant_id, legal_entity_id, period)
       DO UPDATE SET status = 'closed', closed_by = $4, closed_at = now(),
         version = fiscal_periods.version + (CASE WHEN fiscal_periods.status = 'closed' THEN 0 ELSE 1 END)`,
      [tenantId, entity, period, actor],
    );
  else
    await owner.query(
      `UPDATE fiscal_periods
          SET status = 'open', closed_by = NULL, closed_at = NULL, version = version + 1
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3`,
      [tenantId, entity, period],
    );
}

async function setPolicy(actionType: string) {
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, $2, 1000000, $3, 1)`,
    [tenantId, actionType, await financeRoleId()],
  );
}

async function entriesOf(sourceId: string) {
  const { rows } = await owner.query<{ entry_date: string }>(
    `SELECT to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date
       FROM journal_entries e
      WHERE e.tenant_id = $1 AND e.source_type = 'recurring' AND e.source_id = $2
      ORDER BY e.entry_date`,
    [tenantId, sourceId],
  );
  return rows.map((row) => row.entry_date);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  savedPolicies = (
    await owner.query(
      `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
      [tenantId, ACTIONS],
    )
  ).rows;
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
    [tenantId, ACTIONS],
  );
  for (const action of ACTIONS) await setPolicy(action);
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
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.tenant_id,
        row.action_type,
        row.threshold_idr,
        row.approver_role_id,
        row.levels,
        row.requires_distinct_actor,
      ],
    );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await owner.query(
    "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
    [tenantId, createdRoleIds],
  );
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    createdUserIds,
  ]);
  await owner.end();
});

describe("legend-vmyg recurring review-K fixes", () => {
  async function createTemplate(
    s: Scenario,
    overrides: Record<string, unknown> = {},
    amount = 500_000,
  ): Promise<string> {
    const response = await s.requester.client
      .post(`${BASE}/recurring-journals`)
      .set(originHeader)
      .send({
        legalEntityId: s.entity,
        outletId,
        description: "Akrual sewa bulanan (test)",
        lines: lines(s, amount),
        dayOfMonth: 10,
        startPeriod: "2026-01",
        endPeriod: null,
        idempotencyKey: `recurring-${randomUUID()}`,
        ...overrides,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    trackedTemplateIds.push(response.body.data.id);
    return response.body.data.id as string;
  }

  function transition(
    client: Client,
    id: string,
    body: { type: string; reason?: string },
  ) {
    return client
      .post(`${BASE}/recurring-journals/${id}/transition`)
      .set(originHeader)
      .send(body);
  }

  async function activate(s: Scenario, id: string) {
    const submit = await transition(s.requester.client, id, { type: "submit" });
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);
    const approve = await transition(s.approver.client, id, {
      type: "approve",
    });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    expect(approve.body.data.status).toBe("active");
  }

  /** pause / resume at a fixed instant (the endpoint uses the real clock). */
  function transitionAt(
    s: Scenario,
    id: string,
    type: "pause" | "resume",
    at: string,
  ) {
    return transitionRecurringJournal(
      scopedContext(),
      userIdSchema.parse(s.approver.userId),
      id,
      { type },
      new Date(at),
    );
  }

  async function rowOf(id: string) {
    const { rows } = await owner.query<{
      status: string;
      last_generated_period: string | null;
      paused_at: Date | null;
      last_error: string | null;
      failed_at: Date | null;
    }>(
      `SELECT status, last_generated_period, paused_at, last_error, failed_at
         FROM recurring_journals WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return rows[0]!;
  }

  async function runRows(id: string) {
    const { rows } = await owner.query<{
      period: string;
      journal_entry_id: string | null;
      skipped_by: string | null;
      skip_reason: string | null;
    }>(
      `SELECT period, journal_entry_id, skipped_by, skip_reason
         FROM recurring_journal_runs
        WHERE tenant_id = $1 AND recurring_journal_id = $2 ORDER BY period`,
      [tenantId, id],
    );
    return rows;
  }

  async function auditCount(action: string, id: string): Promise<number> {
    const { rows } = await owner.query<{ count: string }>(
      `SELECT count(*) FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' LIKE $2 AND event->>'objectId' = $3`,
      [tenantId, `%${action}`, id],
    );
    return Number(rows[0]?.count);
  }

  it("T2 resume skips only months that fell due after the pause, records each as a skipped run with an audit row, and clears paused_at", async () => {
    const s = await scenario("t2 resume");
    const id = await createTemplate(s);
    await activate(s, id);
    await runDueRecurringJournals(
      scopedContext(),
      new Date("2026-01-15T05:00:00Z"),
    );
    expect(await entriesOf(id)).toEqual(["2026-01-10"]);

    await transitionAt(s, id, "pause", "2026-01-20T05:00:00Z");
    expect((await rowOf(id)).paused_at?.toISOString()).toBe(
      "2026-01-20T05:00:00.000Z",
    );

    await transitionAt(s, id, "resume", "2026-05-12T05:00:00Z");
    const after = await rowOf(id);
    expect(after).toMatchObject({
      status: "active",
      last_generated_period: "2026-04",
      paused_at: null,
    });
    // Feb, Mar and Apr fell due while paused: one skipped run each, attributed
    // to the resuming actor with a system reason, plus one audit row each.
    const skipped = (await runRows(id)).filter(
      (row) => row.skipped_by !== null,
    );
    expect(skipped.map((row) => row.period)).toEqual([
      "2026-02",
      "2026-03",
      "2026-04",
    ]);
    for (const row of skipped) {
      expect(row.journal_entry_id).toBeNull();
      expect(row.skipped_by).toBe(s.approver.userId);
      expect(row.skip_reason).toBeTruthy();
    }
    expect(await auditCount("recurring_journal.period_skipped", id)).toBe(3);

    // The current month still posts on its day; no paused month is backfilled.
    await runDueRecurringJournals(
      scopedContext(),
      new Date("2026-05-12T06:00:00Z"),
    );
    expect(await entriesOf(id)).toEqual(["2026-01-10", "2026-05-10"]);
  });

  it("T2 arrears that were already due before the pause still post, while the months due during the pause stay skipped", async () => {
    const s = await scenario("t2 arrears");
    const id = await createTemplate(s);
    await activate(s, id);
    // The job never ran: Jan, Feb and Mar (day 10) were due before the pause;
    // Apr and May fell due while paused.
    await transitionAt(s, id, "pause", "2026-03-15T05:00:00Z");
    await transitionAt(s, id, "resume", "2026-06-12T05:00:00Z");

    // The cursor stays before the arrears; the paused months get skip rows.
    expect(await rowOf(id)).toMatchObject({
      last_generated_period: null,
      paused_at: null,
    });
    expect(
      (await runRows(id))
        .filter((row) => row.skipped_by !== null)
        .map((row) => row.period),
    ).toEqual(["2026-04", "2026-05"]);
    expect(await auditCount("recurring_journal.period_skipped", id)).toBe(2);

    await runDueRecurringJournals(
      scopedContext(),
      new Date("2026-06-12T06:00:00Z"),
    );
    expect(await entriesOf(id)).toEqual([
      "2026-01-10",
      "2026-02-10",
      "2026-03-10",
      "2026-06-10",
    ]);
    expect((await rowOf(id)).last_generated_period).toBe("2026-06");
  });

  it("T3 skip-period is allowed for an open, row-less month whose next month is closed, and creates no period row", async () => {
    const s = await scenario("t3 skip");
    const id = await createTemplate(s, { startPeriod: "2026-02" });
    await activate(s, id);
    await setClosed(s.entity, "2026-03", true);
    // The job cannot post February (a later month is closed) and records it.
    await runDueRecurringJournals(
      scopedContext(),
      new Date("2026-02-15T05:00:00Z"),
    );
    expect((await rowOf(id)).last_error).toContain("PERIOD_CLOSED");

    const response = await s.requester.client
      .post(`${BASE}/recurring-journals/${id}/skip-period`)
      .set(originHeader)
      .send({ period: "2026-02", reason: "Maret sudah ditutup" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.lastGeneratedPeriod).toBe("2026-02");
    // Skipping the blocked month clears the failure shown to finance.
    expect(await rowOf(id)).toMatchObject({
      last_error: null,
      failed_at: null,
    });
    expect(await runRows(id)).toEqual([
      expect.objectContaining({
        period: "2026-02",
        journal_entry_id: null,
        skipped_by: s.requester.userId,
      }),
    ]);
    const { rows } = await owner.query(
      `SELECT 1 FROM fiscal_periods
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-02'`,
      [tenantId, s.entity],
    );
    expect(rows).toHaveLength(0);
  });

  it("T4 a failing template records last_error and failed_at; the next success clears them", async () => {
    const s = await scenario("t4 failure");
    const id = await createTemplate(s, { startPeriod: "2026-02" });
    await activate(s, id);
    await setClosed(s.entity, "2026-03", true);

    const failedRun = await runDueRecurringJournals(
      scopedContext(),
      new Date("2026-03-15T05:00:00Z"),
    );
    expect(failedRun.failed).toBeGreaterThanOrEqual(1);
    const failed = await rowOf(id);
    expect(failed.last_error).toContain("PERIOD_CLOSED");
    expect(failed.failed_at).not.toBeNull();
    expect(failed.last_generated_period).toBeNull();

    await setClosed(s.entity, "2026-03", false);
    await runDueRecurringJournals(
      scopedContext(),
      new Date("2026-03-15T06:00:00Z"),
    );
    expect(await rowOf(id)).toMatchObject({
      last_generated_period: "2026-03",
      last_error: null,
      failed_at: null,
    });
  });

  it("T5 a chain that expired rejects the template and writes a system audit row", async () => {
    const s = await scenario("t5 expired");
    const id = await createTemplate(s, {}, 2_000_000);
    const submit = await transition(s.requester.client, id, { type: "submit" });
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);

    const settled = await withTenant(db, scopedContext(), (tx) =>
      settleRecurringJournalForApproval(
        tx,
        scopedContext(),
        id,
        new Date(Date.now() + 400 * 24 * 60 * 60 * 1000),
      ),
    );
    expect(settled.status).toBe("rejected");
    expect(await auditCount("recurring_journal.reject", id)).toBe(1);
    const { rows } = await owner.query<{ actor_type: string | null }>(
      `SELECT event->>'actorType' AS actor_type FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' LIKE '%recurring_journal.reject'
          AND event->>'objectId' = $2`,
      [tenantId, id],
    );
    expect(rows[0]?.actor_type).toBe("system");
  });

  it("T5 a chain approved by a user without accounting.journal.post rejects the template and audits it", async () => {
    const s = await scenario("t5 no post");
    const weak = await signedIn("t5 weak approver");
    const { rows: roleRows } = await owner.query<{ id: string }>(
      `INSERT INTO roles (tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, false, $3::jsonb, '["outlet"]'::jsonb) RETURNING id`,
      [
        tenantId,
        `Journal approver ${unique()}`,
        JSON.stringify(["approval.inbox.view", "approval.request.decide"]),
      ],
    );
    const roleId = roleRows[0]!.id;
    createdRoleIds.push(roleId);
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenantId, weak.userId, roleId, outletId],
    );
    const setRole = (role: string) =>
      owner.query(
        `UPDATE approval_policies SET approver_role_id = $3
          WHERE tenant_id = $1 AND action_type = ANY($2::text[])`,
        [tenantId, ACTIONS, role],
      );
    await setRole(roleId);
    try {
      const id = await createTemplate(s, {}, 2_000_000);
      const submit = await transition(s.requester.client, id, {
        type: "submit",
      });
      expect(submit.status, JSON.stringify(submit.body)).toBe(200);
      const { rows } = await owner.query<{ id: string }>(
        `SELECT id FROM approval_requests
          WHERE tenant_id = $1 AND source_module = 'accounting'
            AND object_type = 'recurring_journal' AND object_id = $2 AND level = 1`,
        [tenantId, id],
      );
      await decideApprovalRequest(
        tenant,
        weak.userId,
        rows[0]!.id,
        { decision: "approved", reason: "Sesuai dokumen pendukung." },
        { mfaVerified: true, idempotencyKey: null },
      );
      await transition(s.approver.client, id, { type: "approve" });
      expect((await rowOf(id)).status).toBe("rejected");
      expect(await auditCount("recurring_journal.reject", id)).toBe(1);
    } finally {
      await setRole(await financeRoleId());
    }
  });
});
