// Manual journal settle after an approved chain (bead legend-vmyg review fix
// T1 + T5; PRD v1.7 §3.19, ACC-02, AUTH-06). Real Express app, Better Auth and
// PostgreSQL (RLS on).
//
// - T1: a chain that ended "approved" but whose posting is then refused by a
//   business rule (closed period, inactive account) must not leave the journal
//   pending forever: settle ends it rejected by the system (decidedBy null),
//   the outbox consumer does not throw, and no ledger row is written.
// - T5: system rejections write an audit row (actorType "system").
// - Infra errors are not swallowed (covered by the consumer rethrowing).

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext, TenantContext } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { decideApprovalRequest } from "../services/platform-approval.service";
import { settleManualJournalForApproval } from "../services/accounting-journal-manual.service";
import { handleJournalApprovalResolved } from "../services/accounting-journal-consumers";
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

async function createEntity(name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, `${name} ${unique()}`],
  );
  return rows[0]!.id;
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
  const entity = await createEntity(name);
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

function command(client: Client, id: string, action: "submit" | "approve") {
  return client
    .post(`${BASE}/manual-journals/${id}/${action}`)
    .set(originHeader)
    .send({ idempotencyKey: `cmd-${randomUUID()}` });
}

/** Creates and submits a journal of Rp2.000.000 so the approval chain opens. */
async function submittedJournal(s: Scenario): Promise<string> {
  const amount = 2_000_000;
  const side = (accountId: string, debitIdr: number, creditIdr: number) => ({
    accountId,
    debitIdr,
    creditIdr,
    outletId,
    costCenter: null,
  });
  const created = await s.requester.client
    .post(`${BASE}/manual-journals`)
    .set(originHeader)
    .send({
      legalEntityId: s.entity,
      outletId,
      entryDate: "2026-11-02",
      kind: "general",
      description: "Jurnal umum penyesuaian kas (test)",
      lines: [side(s.cash, amount, 0), side(s.revenue, 0, amount)],
      idempotencyKey: `manual-${randomUUID()}`,
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.data.id as string;
  const submitted = await command(s.requester.client, id, "submit");
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  expect(submitted.body.data.status).toBe("pending_approval");
  return id;
}

async function approvalRequestOf(objectId: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM approval_requests
      WHERE tenant_id = $1 AND source_module = 'accounting'
        AND object_type = 'manual_journal' AND object_id = $2 AND level = 1`,
    [tenantId, objectId],
  );
  return rows[0]!;
}

/** Inbox approval by the approver (§3.7), as the approval inbox does it. */
function approveInbox(userId: string, requestId: string) {
  return decideApprovalRequest(
    tenant,
    userId,
    requestId,
    { decision: "approved", reason: "Sesuai dokumen pendukung." },
    { mfaVerified: true, idempotencyKey: null },
  );
}

async function entryCount(entity: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    "SELECT count(*) FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, entity],
  );
  return Number(rows[0]?.count);
}

async function setClosed(entity: string, period: string) {
  await owner.query(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period, status, closed_by, closed_at)
     VALUES ($1, $2, $3, 'closed', $4, now())
     ON CONFLICT (tenant_id, legal_entity_id, period)
     DO UPDATE SET status = 'closed', closed_by = $4, closed_at = now(),
         version = fiscal_periods.version + (CASE WHEN fiscal_periods.status = 'closed' THEN 0 ELSE 1 END)`,
    [tenantId, entity, period, createdUserIds[0]],
  );
}

async function rowOf(id: string) {
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

async function rejectionAudits(id: string) {
  const { rows } = await owner.query<{
    actor_type: string;
    actor_id: string | null;
    reason: string | null;
  }>(
    `SELECT event->>'actorType' AS actor_type, event->>'actorId' AS actor_id,
            event->>'reason' AS reason
       FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2
        AND event->>'action' = 'accounting.manual_journal.rejected'`,
    [tenantId, id],
  );
  return rows;
}

/** The real approval.resolved envelope the approval service appended. */
async function resolvedEventOf(chainId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [tenantId, chainId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]?.event);
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
  for (const action of ACTIONS)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, $2, 1000000, $3, 1)`,
      [tenantId, action, await financeRoleId()],
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
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    createdUserIds,
  ]);
  await owner.end();
});

describe("legend-vmyg T1/T5 approved chain whose posting is refused", () => {
  it("T1 chain approved, then the period closes: settle rejects by the system, no ledger row, audit written, replay is a no-op", async () => {
    const s = await scenario("settle closed");
    const id = await submittedJournal(s);
    await approveInbox(s.approver.userId, (await approvalRequestOf(id)).id);
    await setClosed(s.entity, "2026-11");

    const context = scopedContext();
    const settled = await withTenant(db, context, (tx) =>
      settleManualJournalForApproval(tx, context, id, new Date()),
    );
    expect(settled.status).toBe("rejected");
    expect(settled.decidedBy).toBeNull();
    expect(settled.rejectionReason).toBe("posting refused: PERIOD_CLOSED");
    expect(await entryCount(s.entity)).toBe(0);
    expect(await rowOf(id)).toMatchObject({
      status: "rejected",
      decided_by: null,
      posted_entry_id: null,
    });

    const audits = await rejectionAudits(id);
    expect(audits).toEqual([
      {
        actor_type: "system",
        actor_id: null,
        reason: "posting refused: PERIOD_CLOSED",
      },
    ]);

    const replayed = await withTenant(db, context, (tx) =>
      settleManualJournalForApproval(tx, context, id, new Date()),
    );
    expect(replayed).toEqual(settled);
    expect(await rejectionAudits(id)).toHaveLength(1);
  });

  it("T1 the approval.resolved consumer does not throw and settles the journal as rejected", async () => {
    const s = await scenario("consumer closed");
    const id = await submittedJournal(s);
    const request = await approvalRequestOf(id);
    await approveInbox(s.approver.userId, request.id);
    await setClosed(s.entity, "2026-11");

    const event = await resolvedEventOf(request.id);
    const context = scopedContext();
    await expect(
      handleJournalApprovalResolved(context, event, new Date()),
    ).resolves.toBeUndefined();
    expect(await rowOf(id)).toMatchObject({
      status: "rejected",
      decided_by: null,
      rejection_reason: "posting refused: PERIOD_CLOSED",
      posted_entry_id: null,
    });
    expect(await entryCount(s.entity)).toBe(0);
    // Outbox redelivery of the same event changes nothing.
    await expect(
      handleJournalApprovalResolved(context, event, new Date()),
    ).resolves.toBeUndefined();
    expect(await rejectionAudits(id)).toHaveLength(1);
  });

  it("T1 the approve endpoint settling such a chain answers 200 rejected instead of failing", async () => {
    const s = await scenario("endpoint closed");
    const id = await submittedJournal(s);
    await approveInbox(s.approver.userId, (await approvalRequestOf(id)).id);
    await setClosed(s.entity, "2026-11");

    const response = await command(s.approver.client, id, "approve");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe("rejected");
    expect(await entryCount(s.entity)).toBe(0);
  });

  it("T1 an account deactivated after the chain was approved also ends the journal rejected", async () => {
    const s = await scenario("settle inactive");
    const id = await submittedJournal(s);
    await approveInbox(s.approver.userId, (await approvalRequestOf(id)).id);
    const deactivate = await s.requester.client
      .patch(`${BASE}/accounts/${s.cash}`)
      .set(originHeader)
      .send({ isActive: false });
    expect(deactivate.status, JSON.stringify(deactivate.body)).toBe(200);

    const context = scopedContext();
    const settled = await withTenant(db, context, (tx) =>
      settleManualJournalForApproval(tx, context, id, new Date()),
    );
    expect(settled.status).toBe("rejected");
    expect(settled.decidedBy).toBeNull();
    expect(settled.rejectionReason).toBe("posting refused: ACCOUNT_INACTIVE");
    expect(await entryCount(s.entity)).toBe(0);
    expect(await rejectionAudits(id)).toHaveLength(1);
  });

  it("T5 an expired chain rejects by the system and writes an audit row", async () => {
    const s = await scenario("expired");
    const id = await submittedJournal(s);
    const context = scopedContext();
    // Far past any approval deadline: settle treats a pending chain as expired.
    const settled = await withTenant(db, context, (tx) =>
      settleManualJournalForApproval(
        tx,
        context,
        id,
        new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      ),
    );
    expect(settled.status).toBe("rejected");
    expect(settled.decidedBy).toBeNull();
    expect(settled.rejectionReason).toBe("approval expired");
    expect(await rejectionAudits(id)).toEqual([
      { actor_type: "system", actor_id: null, reason: "approval expired" },
    ]);
  });
});
