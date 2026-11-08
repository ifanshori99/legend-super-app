// Manual + recurring journal tests (bead legend-vmyg; PRD v1.7 §3.19 Jurnal
// Umum/Penyesuaian/Berulang, ACC-01, ACC-02, AUTH-06, TEN-01, TEN-03).
// Runs the real Express app, Better Auth and PostgreSQL (RLS on).
//
// Assumptions (the brief does not pin them down):
// - An approval policy is mandatory for action types "manual_journal" and
//   "recurring_journal" (no policy fails closed). The suite installs one tier
//   at Rp1.000.000: below it no approval chain is opened (the approve endpoint
//   decides directly), from it one level of the `finance` role applies.
// - A replayed create with the same key and body answers 200 or 201 with the
//   same row.
// - A caller whose outlet scope does not cover the row gets NOT_FOUND.
// - Every test owns a fresh legal entity; journal rows are append-only and
//   stay in the disposable database.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { decideApprovalRequest } from "../services/platform-approval.service";
import {
  getManualJournal,
  approveManualJournal,
  settleManualJournalForApproval,
} from "../services/accounting-journal-manual.service";
import { runDueRecurringJournals } from "../services/accounting-journal-recurring.service";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const BASE = "/api/accounting";
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendPlatformFixtures.outlets[0].id;
const secondOutletId = cafeLegendPlatformFixtures.outlets[1].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const createdUserIds: string[] = [];
const trackedTemplateIds: string[] = [];
const ACTIONS = ["manual_journal", "recurring_journal"];
let savedPolicies: Record<string, unknown>[] = [];
const tenantB = randomUUID();
const tenantBUser = randomUUID();
const unique = () => randomBytes(4).toString("hex");

const tenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});

function scopedContext(tenantOverride = tenantId): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantOverride,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

function outletScopedContext(...outlets: string[]): ScopedTenantContext {
  return establishScopedTenantContext(tenant, {
    kind: "outlets",
    outletIds: outlets.map((id) => outletIdSchema.parse(id)),
  });
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

async function financeUser(name = "Finance") {
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

function lines(s: Scenario, amount: number, credit = amount) {
  const side = (accountId: string, debitIdr: number, creditIdr: number) => ({
    accountId,
    debitIdr,
    creditIdr,
    outletId,
    costCenter: null,
  });
  return [side(s.cash, amount, 0), side(s.revenue, 0, credit)];
}

function manualBody(
  s: Scenario,
  overrides: Record<string, unknown> = {},
  amount = 500_000,
) {
  return {
    legalEntityId: s.entity,
    outletId,
    entryDate: "2026-11-02",
    kind: "general",
    description: "Jurnal umum penyesuaian kas (test)",
    lines: lines(s, amount),
    idempotencyKey: `manual-${randomUUID()}`,
    ...overrides,
  };
}

async function createManual(
  s: Scenario,
  overrides: Record<string, unknown> = {},
  amount = 500_000,
): Promise<string> {
  const response = await s.requester.client
    .post(`${BASE}/manual-journals`)
    .set(originHeader)
    .send(manualBody(s, overrides, amount));
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(response.body.data.status).toBe("draft");
  return response.body.data.id as string;
}

function command(
  client: Client,
  id: string,
  action: "submit" | "withdraw" | "approve" | "cancel",
) {
  return client
    .post(`${BASE}/manual-journals/${id}/${action}`)
    .set(originHeader)
    .send({ idempotencyKey: `cmd-${randomUUID()}` });
}

async function submitManual(s: Scenario, id: string) {
  const response = await command(s.requester.client, id, "submit");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.data.status).toBe("pending_approval");
}

async function getManualApi(client: Client, id: string) {
  const response = await client.get(`${BASE}/manual-journals/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as {
    status: string;
    postedEntryId: string | null;
    decidedBy: string | null;
    rejectionReason: string | null;
    requestedBy: string;
  };
}

async function entriesOf(sourceType: string, sourceId: string) {
  const { rows } = await owner.query<{
    id: string;
    entry_date: string;
    total: string;
  }>(
    `SELECT e.id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
            (SELECT sum(debit_idr) FROM journal_lines l WHERE l.entry_id = e.id) AS total
       FROM journal_entries e
      WHERE e.tenant_id = $1 AND e.source_type = $2 AND e.source_id = $3
      ORDER BY e.entry_date`,
    [tenantId, sourceType, sourceId],
  );
  return rows;
}

async function entryCountOfEntity(entity: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    "SELECT count(*) FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, entity],
  );
  return Number(rows[0]?.count);
}

/** The approval chain a journal opened (level 1 request id). */
async function approvalRequestOf(objectType: string, objectId: string) {
  const { rows } = await owner.query<{ id: string; status: string }>(
    `SELECT id, status FROM approval_requests
      WHERE tenant_id = $1 AND source_module = 'accounting'
        AND object_type = $2 AND object_id = $3 AND level = 1`,
    [tenantId, objectType, objectId],
  );
  return rows[0];
}

/** Inbox decision by the approver (§3.7), as the approval inbox does it. */
function decideInbox(
  userId: string,
  requestId: string,
  decision: "approved" | "rejected",
) {
  return decideApprovalRequest(
    tenant,
    userId,
    requestId,
    { decision, reason: "Sesuai dokumen pendukung." },
    { mfaVerified: true, idempotencyKey: null },
  );
}

async function setClosed(entity: string, period: string, closed: boolean) {
  const { rows } = await owner.query<{ id: string }>(
    'SELECT id FROM "user" WHERE id = $1',
    [createdUserIds[0]],
  );
  const actor = rows[0]!.id;
  if (closed)
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period, status, closed_by, closed_at)
       VALUES ($1, $2, $3, 'closed', $4, now())
       ON CONFLICT (tenant_id, legal_entity_id, period)
       DO UPDATE SET status = 'closed', closed_by = $4, closed_at = now()`,
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

  // A second tenant for isolation checks (TEN-01).
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Journal test tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantB, `journal-${tenantB}`, tenantBUser],
  );
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'B', $2)`,
    [tenantBUser, `${tenantBUser}@example.test`],
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
  await owner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    [...createdUserIds, tenantBUser],
  ]);
  await owner.end();
  await appPool.end();
});

describe("legend-vmyg manual journals (§3.19 Jurnal Umum / Penyesuaian)", () => {
  it("ACC-01 refuses an unbalanced or fractional journal and stores nothing", async () => {
    const s = await scenario("unbalanced");
    const unbalanced = await s.requester.client
      .post(`${BASE}/manual-journals`)
      .set(originHeader)
      .send(manualBody(s, { lines: lines(s, 100_000, 90_000) }));
    expect([400, 422]).toContain(unbalanced.status);

    const fractional = await s.requester.client
      .post(`${BASE}/manual-journals`)
      .set(originHeader)
      .send(manualBody(s, { lines: lines(s, 100_000.5, 100_000.5) }));
    expect([400, 422]).toContain(fractional.status);

    const oneLine = await s.requester.client
      .post(`${BASE}/manual-journals`)
      .set(originHeader)
      .send(manualBody(s, { lines: lines(s, 100_000).slice(0, 1) }));
    expect([400, 422]).toContain(oneLine.status);

    const list = await s.requester.client.get(
      `${BASE}/manual-journals?legalEntityId=${s.entity}`,
    );
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
  });

  it("AUTH: anonymous, origin-less and non-finance callers are refused", async () => {
    const s = await scenario("authz");
    expect(
      (
        await agent(app).get(
          `${BASE}/manual-journals?legalEntityId=${s.entity}`,
        )
      ).status,
    ).toBe(401);
    const noOrigin = await s.requester.client
      .post(`${BASE}/manual-journals`)
      .send(manualBody(s));
    expect(noOrigin.status).toBe(403);

    const outsider = await signedIn("No role");
    const denied = await outsider.client
      .post(`${BASE}/manual-journals`)
      .set(originHeader)
      .send(manualBody(s));
    expect(denied.status).toBe(403);
    const deniedView = await outsider.client.get(
      `${BASE}/manual-journals?legalEntityId=${s.entity}`,
    );
    expect(deniedView.status).toBe(403);
  });

  it("ACC-01 create and submit write no ledger entry; approval by another user posts exactly one manual entry", async () => {
    const s = await scenario("manual flow");
    const id = await createManual(s);
    expect(await entryCountOfEntity(s.entity)).toBe(0);
    const created = await getManualApi(s.requester.client, id);
    expect(created).toMatchObject({
      status: "draft",
      requestedBy: s.requester.userId,
      postedEntryId: null,
    });

    await submitManual(s, id);
    expect(await entryCountOfEntity(s.entity)).toBe(0);

    const approved = await command(s.approver.client, id, "approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: "posted",
      decidedBy: s.approver.userId,
      requestedBy: s.requester.userId,
    });
    const entries = await entriesOf("manual", id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entry_date: "2026-11-02",
      total: "500000",
    });
    expect(approved.body.data.postedEntryId).toBe(entries[0]!.id);

    // The entry shows up in the general ledger API.
    const entry = await s.approver.client.get(
      `${BASE}/journals/${entries[0]!.id}`,
    );
    expect(entry.status).toBe(200);
    expect(entry.body.data.entry.sourceType).toBe("manual");

    // Listing filters by status.
    const posted = await s.requester.client.get(
      `${BASE}/manual-journals?legalEntityId=${s.entity}&status=posted`,
    );
    expect(posted.body.data.map((row: { id: string }) => row.id)).toEqual([id]);
    const drafts = await s.requester.client.get(
      `${BASE}/manual-journals?legalEntityId=${s.entity}&status=draft`,
    );
    expect(drafts.body.data).toEqual([]);
  });

  it("AUTH-06 the requester cannot approve or reject their own journal", async () => {
    const s = await scenario("self approval");
    const id = await createManual(s);
    await submitManual(s, id);

    const approve = await command(s.requester.client, id, "approve");
    expect(approve.status).toBe(403);
    expect(approve.body.error.code).toBe("APPROVER_IS_REQUESTER");
    const reject = await s.requester.client
      .post(`${BASE}/manual-journals/${id}/reject`)
      .set(originHeader)
      .send({ reason: "Saya tolak sendiri" });
    expect(reject.status).toBe(403);

    expect(await getManualApi(s.requester.client, id)).toMatchObject({
      status: "pending_approval",
    });
    expect(await entriesOf("manual", id)).toHaveLength(0);
  });

  it("ACC-01 a rejection needs a reason, ends the request without ledger entry, and an edit reopens it as draft", async () => {
    const s = await scenario("reject");
    const id = await createManual(s);
    await submitManual(s, id);

    const noReason = await s.approver.client
      .post(`${BASE}/manual-journals/${id}/reject`)
      .set(originHeader)
      .send({ reason: "  " });
    expect([400, 422]).toContain(noReason.status);

    const rejected = await s.approver.client
      .post(`${BASE}/manual-journals/${id}/reject`)
      .set(originHeader)
      .send({ reason: "Bukti pendukung tidak lengkap" });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.data).toMatchObject({
      status: "rejected",
      rejectionReason: "Bukti pendukung tidak lengkap",
      decidedBy: s.approver.userId,
    });
    expect(await entriesOf("manual", id)).toHaveLength(0);

    // Only the requester edits; the edit returns the request to draft.
    const foreignEdit = await s.approver.client
      .patch(`${BASE}/manual-journals/${id}`)
      .set(originHeader)
      .send({ description: "Diubah orang lain" });
    expect(foreignEdit.status).toBeGreaterThanOrEqual(400);
    const edited = await s.requester.client
      .patch(`${BASE}/manual-journals/${id}`)
      .set(originHeader)
      .send({ description: "Jurnal diperbaiki", lines: lines(s, 600_000) });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data).toMatchObject({
      status: "draft",
      description: "Jurnal diperbaiki",
    });
    const unbalancedEdit = await s.requester.client
      .patch(`${BASE}/manual-journals/${id}`)
      .set(originHeader)
      .send({ lines: lines(s, 600_000, 1) });
    expect([400, 422]).toContain(unbalancedEdit.status);

    await submitManual(s, id);
    const approved = await command(s.approver.client, id, "approve");
    expect(approved.body.data.status).toBe("posted");
    const entries = await entriesOf("manual", id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.total).toBe("600000");
  });

  it("legend-vmyg the requester can cancel a rejected journal; the rejection fields are cleared", async () => {
    const s = await scenario("cancel rejected");
    const id = await createManual(s);
    await submitManual(s, id);
    const rejected = await s.approver.client
      .post(`${BASE}/manual-journals/${id}/reject`)
      .set(originHeader)
      .send({ reason: "Tidak diperlukan" });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

    const cancelled = await command(s.requester.client, id, "cancel");
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data).toMatchObject({
      status: "cancelled",
      rejectionReason: null,
      decidedBy: null,
      decidedAt: null,
    });
    expect(await entriesOf("manual", id)).toHaveLength(0);
  });

  it("ACC-01 the requester can withdraw a pending request and cancel a draft; a posted journal is final", async () => {
    const s = await scenario("withdraw cancel");
    const id = await createManual(s);
    await submitManual(s, id);
    const withdrawn = await command(s.requester.client, id, "withdraw");
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.data.status).toBe("draft");
    // Approving a withdrawn (draft) request is refused.
    const lateApprove = await command(s.approver.client, id, "approve");
    expect(lateApprove.status).toBeGreaterThanOrEqual(400);
    const cancelled = await command(s.requester.client, id, "cancel");
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.status).toBe("cancelled");
    expect((await command(s.requester.client, id, "submit")).status).toBe(409);

    const finalId = await createManual(s);
    await submitManual(s, finalId);
    expect((await command(s.approver.client, finalId, "approve")).status).toBe(
      200,
    );
    const edit = await s.requester.client
      .patch(`${BASE}/manual-journals/${finalId}`)
      .set(originHeader)
      .send({ description: "Ubah setelah posting" });
    expect(edit.status).toBeGreaterThanOrEqual(400);
    expect(
      (await command(s.requester.client, finalId, "cancel")).status,
    ).toBeGreaterThanOrEqual(400);
    expect(await entriesOf("manual", finalId)).toHaveLength(1);
  });

  it("legend-vmyg double approval, including a concurrent one, still posts exactly one entry", async () => {
    const s = await scenario("double approve");
    const id = await createManual(s);
    await submitManual(s, id);
    const [first, second] = await Promise.all([
      command(s.approver.client, id, "approve"),
      command(s.approver.client, id, "approve"),
    ]);
    expect([first.status, second.status]).toContain(200);
    expect(await entriesOf("manual", id)).toHaveLength(1);
    const replay = await command(s.approver.client, id, "approve");
    expect(replay.status === 200 || replay.status >= 400).toBe(true);
    expect(await entriesOf("manual", id)).toHaveLength(1);
    expect(await entryCountOfEntity(s.entity)).toBe(1);
  });

  it("legend-vmyg create is idempotent per key; the same key with another body is refused", async () => {
    const s = await scenario("idempotent");
    const body = manualBody(s);
    const first = await s.requester.client
      .post(`${BASE}/manual-journals`)
      .set(originHeader)
      .send(body);
    expect(first.status).toBe(201);
    const replay = await s.requester.client
      .post(`${BASE}/manual-journals`)
      .set(originHeader)
      .send(body);
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.data.id).toBe(first.body.data.id);

    const reused = await s.requester.client
      .post(`${BASE}/manual-journals`)
      .set(originHeader)
      .send({ ...body, description: "Isi lain, kunci sama" });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const list = await s.requester.client.get(
      `${BASE}/manual-journals?legalEntityId=${s.entity}`,
    );
    expect(list.body.data).toHaveLength(1);
  });

  it("ACC-02 a closed period blocks submit and approval; nothing posts until the period reopens", async () => {
    const s = await scenario("closed period");
    await setClosed(s.entity, "2026-11", true);
    const blockedId = await createManual(s);
    const blocked = await command(s.requester.client, blockedId, "submit");
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(blocked.body.error.code).toBe("PERIOD_CLOSED");
    expect((await getManualApi(s.requester.client, blockedId)).status).toBe(
      "draft",
    );

    // Submitted while open, period closed before approval.
    await setClosed(s.entity, "2026-11", false);
    await submitManual(s, blockedId);
    await setClosed(s.entity, "2026-11", true);
    const refused = await command(s.approver.client, blockedId, "approve");
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.error.code).toBe("PERIOD_CLOSED");
    expect((await getManualApi(s.approver.client, blockedId)).status).toBe(
      "pending_approval",
    );
    expect(await entriesOf("manual", blockedId)).toHaveLength(0);

    await setClosed(s.entity, "2026-11", false);
    const approved = await command(s.approver.client, blockedId, "approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await entriesOf("manual", blockedId)).toHaveLength(1);
  });
});

describe("legend-vmyg manual journals behind the approval matrix (§3.7)", () => {
  it("the approve endpoint answers 409 while the chain is pending; an inbox decision by another user then lets settle post once", async () => {
    const s = await scenario("chain");
    const id = await createManual(s, {}, 2_000_000);
    await submitManual(s, id);
    const request = await approvalRequestOf("manual_journal", id);
    expect(request?.status).toBe("pending");

    const pending = await command(s.approver.client, id, "approve");
    expect(pending.status).toBe(409);
    expect(pending.body.error.code).toBe("APPROVAL_PENDING");
    expect(await entriesOf("manual", id)).toHaveLength(0);

    await decideInbox(s.approver.userId, request!.id, "approved");
    // Still no ledger entry until the journal is settled from the chain.
    const context = scopedContext();
    const settled = await withTenant(db, context, (tx) =>
      settleManualJournalForApproval(
        tx,
        context,
        id,
        new Date("2026-11-03T05:00:00Z"),
      ),
    );
    expect(settled.status).toBe("posted");
    expect(settled.decidedBy).toBe(s.approver.userId);
    expect(await entriesOf("manual", id)).toHaveLength(1);

    // Replayed settle (outbox redelivery) and a late approve call change nothing.
    const replayed = await withTenant(db, context, (tx) =>
      settleManualJournalForApproval(
        tx,
        context,
        id,
        new Date("2026-11-03T06:00:00Z"),
      ),
    );
    expect(replayed).toEqual(settled);
    await command(s.approver.client, id, "approve");
    expect(await entriesOf("manual", id)).toHaveLength(1);
    expect(await getManualApi(s.requester.client, id)).toMatchObject({
      status: "posted",
      postedEntryId: settled.postedEntryId,
    });
  });

  it("the approve endpoint itself settles a chain that was already approved in the inbox", async () => {
    const s = await scenario("chain approve");
    const id = await createManual(s, {}, 2_000_000);
    await submitManual(s, id);
    const request = await approvalRequestOf("manual_journal", id);
    await decideInbox(s.approver.userId, request!.id, "approved");
    const approved = await command(s.approver.client, id, "approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe("posted");
    expect(await entriesOf("manual", id)).toHaveLength(1);
  });

  it("an inbox rejection rejects the journal on settle and nothing posts", async () => {
    const s = await scenario("chain reject");
    const id = await createManual(s, {}, 2_000_000);
    await submitManual(s, id);
    const request = await approvalRequestOf("manual_journal", id);
    await decideInbox(s.approver.userId, request!.id, "rejected");
    const context = scopedContext();
    const settled = await withTenant(db, context, (tx) =>
      settleManualJournalForApproval(
        tx,
        context,
        id,
        new Date("2026-11-03T05:00:00Z"),
      ),
    );
    expect(settled.status).toBe("rejected");
    expect(settled.rejectionReason).toBeTruthy();
    expect(await entriesOf("manual", id)).toHaveLength(0);
  });

  it("withdrawing a pending request cancels its approval chain", async () => {
    const s = await scenario("chain withdraw");
    const id = await createManual(s, {}, 2_000_000);
    await submitManual(s, id);
    const withdrawn = await command(s.requester.client, id, "withdraw");
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.data.status).toBe("draft");
    expect((await approvalRequestOf("manual_journal", id))?.status).toBe(
      "cancelled",
    );
  });

  it("the requester cannot settle their own journal through the approve endpoint even after an inbox approval", async () => {
    const s = await scenario("chain self");
    const id = await createManual(s, {}, 2_000_000);
    await submitManual(s, id);
    const request = await approvalRequestOf("manual_journal", id);
    await decideInbox(s.approver.userId, request!.id, "approved");
    const self = await command(s.requester.client, id, "approve");
    expect(self.status).toBe(403);
    expect(await entriesOf("manual", id)).toHaveLength(0);
  });
});

describe("legend-vmyg recurring journals (§3.19 Jurnal Berulang)", () => {
  function recurringBody(
    s: Scenario,
    overrides: Record<string, unknown> = {},
    amount = 500_000,
  ) {
    return {
      legalEntityId: s.entity,
      outletId,
      description: "Akrual sewa bulanan (test)",
      lines: lines(s, amount),
      dayOfMonth: 10,
      startPeriod: "2026-01",
      endPeriod: null,
      idempotencyKey: `recurring-${randomUUID()}`,
      ...overrides,
    };
  }

  async function createTemplate(
    s: Scenario,
    overrides: Record<string, unknown> = {},
    amount = 500_000,
  ): Promise<string> {
    const response = await s.requester.client
      .post(`${BASE}/recurring-journals`)
      .set(originHeader)
      .send(recurringBody(s, overrides, amount));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.status).toBe("draft");
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
    expect(submit.body.data.status).toBe("pending_approval");
    const approve = await transition(s.approver.client, id, {
      type: "approve",
    });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    expect(approve.body.data).toMatchObject({
      status: "active",
      approvedBy: s.approver.userId,
    });
  }

  async function templateOf(s: Scenario, id: string) {
    const response = await s.requester.client.get(
      `${BASE}/recurring-journals?legalEntityId=${s.entity}`,
    );
    expect(response.status).toBe(200);
    return (
      response.body.data as {
        id: string;
        status: string;
        lastGeneratedPeriod: string | null;
      }[]
    ).find((row) => row.id === id);
  }

  async function runPeriods(id: string): Promise<string[]> {
    const { rows } = await owner.query<{ period: string }>(
      `SELECT period FROM recurring_journal_runs
        WHERE tenant_id = $1 AND recurring_journal_id = $2 ORDER BY period`,
      [tenantId, id],
    );
    return rows.map((row) => row.period);
  }

  const march15 = new Date("2026-03-15T05:00:00Z");

  it("AUTH-06 an unbalanced template is refused, the requester cannot approve it and a draft template generates nothing", async () => {
    const s = await scenario("recurring approval");
    const bad = await s.requester.client
      .post(`${BASE}/recurring-journals`)
      .set(originHeader)
      .send(recurringBody(s, { lines: lines(s, 100_000, 90_000) }));
    expect([400, 422]).toContain(bad.status);

    const id = await createTemplate(s);
    await runDueRecurringJournals(scopedContext(), march15);
    expect(await entriesOf("recurring", id)).toHaveLength(0);

    await transition(s.requester.client, id, { type: "submit" });
    const self = await transition(s.requester.client, id, { type: "approve" });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("APPROVER_IS_REQUESTER");
    await runDueRecurringJournals(scopedContext(), march15);
    expect(await entriesOf("recurring", id)).toHaveLength(0);

    const rejected = await transition(s.approver.client, id, {
      type: "reject",
      reason: "Nilai sewa belum sesuai kontrak",
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.data.status).toBe("rejected");
    await runDueRecurringJournals(scopedContext(), march15);
    expect(await entriesOf("recurring", id)).toHaveLength(0);
  });

  it("an approved template posts one entry per due period, only on or after its day, and never twice", async () => {
    const s = await scenario("recurring job");
    const monthly = await createTemplate(s);
    const lateInMonth = await createTemplate(s, {
      dayOfMonth: 20,
      startPeriod: "2026-03",
    });
    await activate(s, monthly);
    await activate(s, lateInMonth);
    expect(await entryCountOfEntity(s.entity)).toBe(0);

    await runDueRecurringJournals(scopedContext(), march15);
    const entries = await entriesOf("recurring", monthly);
    expect(entries.map((row) => row.entry_date)).toEqual([
      "2026-01-10",
      "2026-02-10",
      "2026-03-10",
    ]);
    expect(entries.every((row) => row.total === "500000")).toBe(true);
    expect(await runPeriods(monthly)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    expect((await templateOf(s, monthly))?.lastGeneratedPeriod).toBe("2026-03");
    // March 20 is still ahead on March 15.
    expect(await entriesOf("recurring", lateInMonth)).toHaveLength(0);

    // A second run is a no-op.
    await runDueRecurringJournals(scopedContext(), march15);
    expect(await entriesOf("recurring", monthly)).toHaveLength(3);

    // Once the day has come, the late template posts its March entry.
    await runDueRecurringJournals(
      scopedContext(),
      new Date("2026-03-21T05:00:00Z"),
    );
    expect(
      (await entriesOf("recurring", lateInMonth)).map((row) => row.entry_date),
    ).toEqual(["2026-03-20"]);
    expect(await entriesOf("recurring", monthly)).toHaveLength(3);
  });

  it("concurrent job runs still post one entry per period and keep run rows unique", async () => {
    const s = await scenario("recurring concurrent");
    const id = await createTemplate(s, { startPeriod: "2026-02" });
    await activate(s, id);
    const results = await Promise.all([
      runDueRecurringJournals(scopedContext(), march15),
      runDueRecurringJournals(scopedContext(), march15),
      runDueRecurringJournals(scopedContext(), march15),
    ]);
    for (const result of results)
      expect(result).toEqual({
        posted: expect.any(Number),
        skipped: expect.any(Number),
        failed: expect.any(Number),
      });
    expect(await entriesOf("recurring", id)).toHaveLength(2);
    expect(await runPeriods(id)).toEqual(["2026-02", "2026-03"]);
    expect(await entryCountOfEntity(s.entity)).toBe(2);
  });

  it("ACC-02 a closed period stops that template; after it reopens the next run resumes from lastGeneratedPeriod", async () => {
    const s = await scenario("recurring resume");
    const id = await createTemplate(s);
    await activate(s, id);
    await setClosed(s.entity, "2026-02", true);

    const first = await runDueRecurringJournals(scopedContext(), march15);
    expect(first.failed).toBeGreaterThanOrEqual(1);
    // January posted; February is blocked; March must wait for February.
    expect(
      (await entriesOf("recurring", id)).map((row) => row.entry_date),
    ).toEqual(["2026-01-10"]);
    expect(await runPeriods(id)).toEqual(["2026-01"]);
    expect((await templateOf(s, id))?.lastGeneratedPeriod).toBe("2026-01");

    await setClosed(s.entity, "2026-02", false);
    await runDueRecurringJournals(scopedContext(), march15);
    expect(
      (await entriesOf("recurring", id)).map((row) => row.entry_date),
    ).toEqual(["2026-01-10", "2026-02-10", "2026-03-10"]);
    expect(await runPeriods(id)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect((await templateOf(s, id))?.lastGeneratedPeriod).toBe("2026-03");
  });

  it("pause stops generation, resume continues, end stops it for good and respects endPeriod", async () => {
    const s = await scenario("recurring lifecycle");
    const id = await createTemplate(s, {
      startPeriod: "2026-01",
      endPeriod: "2026-02",
    });
    await activate(s, id);
    const paused = await transition(s.approver.client, id, { type: "pause" });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(paused.body.data.status).toBe("paused");
    await runDueRecurringJournals(scopedContext(), march15);
    expect(await entriesOf("recurring", id)).toHaveLength(0);

    const resumed = await transition(s.approver.client, id, { type: "resume" });
    expect(resumed.body.data.status).toBe("active");
    await runDueRecurringJournals(scopedContext(), march15);
    // endPeriod 2026-02: March is never generated.
    expect(await runPeriods(id)).toEqual(["2026-01", "2026-02"]);

    const ended = await transition(s.approver.client, id, { type: "end" });
    expect(ended.body.data.status).toBe("ended");
    const again = await transition(s.approver.client, id, { type: "resume" });
    expect(again.status).toBeGreaterThanOrEqual(400);
    await runDueRecurringJournals(
      scopedContext(),
      new Date("2026-06-15T05:00:00Z"),
    );
    expect(await entriesOf("recurring", id)).toHaveLength(2);
  });

  it("a template behind an approval chain stays pending (409) until the inbox approves it", async () => {
    const s = await scenario("recurring chain");
    const id = await createTemplate(s, {}, 2_000_000);
    const submit = await transition(s.requester.client, id, { type: "submit" });
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);
    const request = await approvalRequestOf("recurring_journal", id);
    expect(request?.status).toBe("pending");

    const pending = await transition(s.approver.client, id, {
      type: "approve",
    });
    expect(pending.status).toBe(409);
    expect(pending.body.error.code).toBe("APPROVAL_PENDING");
    await runDueRecurringJournals(scopedContext(), march15);
    expect(await entriesOf("recurring", id)).toHaveLength(0);

    await decideInbox(s.approver.userId, request!.id, "approved");
    const approved = await transition(s.approver.client, id, {
      type: "approve",
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe("active");
    await runDueRecurringJournals(scopedContext(), march15);
    expect(await entriesOf("recurring", id)).toHaveLength(3);
  });
});

describe("legend-vmyg tenant and outlet isolation (TEN-01, TEN-03)", () => {
  it("TEN-01 tenant B cannot read, list or approve tenant A journals and RLS hides the rows", async () => {
    const s = await scenario("isolation");
    const id = await createManual(s);
    await submitManual(s, id);
    const recurring = await s.requester.client
      .post(`${BASE}/recurring-journals`)
      .set(originHeader)
      .send({
        legalEntityId: s.entity,
        outletId,
        description: "Template tenant A",
        lines: lines(s, 500_000),
        dayOfMonth: 5,
        startPeriod: "2026-01",
        endPeriod: null,
        idempotencyKey: `recurring-${randomUUID()}`,
      });
    expect(recurring.status, JSON.stringify(recurring.body)).toBe(201);
    trackedTemplateIds.push(recurring.body.data.id);

    const contextB = scopedContext(tenantIdSchema.parse(tenantB));
    await expect(getManualJournal(contextB, id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      approveManualJournal(contextB, userIdSchema.parse(tenantBUser), id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await entriesOf("manual", id)).toHaveLength(0);
    expect(await getManualApi(s.requester.client, id)).toMatchObject({
      status: "pending_approval",
    });

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantB],
      );
      for (const table of [
        "manual_journals",
        "recurring_journals",
        "recurring_journal_runs",
      ])
        expect(
          (await client.query(`SELECT 1 FROM ${table}`)).rowCount,
          `${table} visible to tenant B`,
        ).toBe(0);
      expect(
        (
          await client.query(
            "UPDATE manual_journals SET status = 'cancelled' WHERE id = $1",
            [id],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    // Control: the owning tenant still sees both rows through the same role.
    const control = await appPool.connect();
    try {
      await control.query("BEGIN");
      await control.query("SET LOCAL ROLE legend_app");
      await control.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      expect(
        (
          await control.query("SELECT 1 FROM manual_journals WHERE id = $1", [
            id,
          ])
        ).rowCount,
      ).toBe(1);
    } finally {
      await control.query("ROLLBACK");
      control.release();
    }
  });

  it("TEN-03 an outlet-scoped caller cannot see or approve a journal of another outlet", async () => {
    const s = await scenario("outlet scope");
    const id = await createManual(s);
    await submitManual(s, id);
    const elsewhere = outletScopedContext(secondOutletId);
    await expect(getManualJournal(elsewhere, id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      approveManualJournal(
        elsewhere,
        userIdSchema.parse(s.approver.userId),
        id,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await entriesOf("manual", id)).toHaveLength(0);

    const home = outletScopedContext(outletId);
    const visible = await getManualJournal(home, id);
    expect(visible.id).toBe(id);
  });
});
