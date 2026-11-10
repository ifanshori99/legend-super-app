// Sole Owner may self-approve a `shareholder_version` request (bead
// legend-b8y6l, founder decision 2026-11-10). Written from the brief
// `.claude-brief-b8y6l.md`, not from the implementation.
//
// Rule under test: a tenant with exactly ONE Owner may APPROVE (never reject) a
// `shareholder_version` request it submitted itself: a share allocation version
// and a statement-recipient change. With 2+ Owners nothing changes
// (APPROVER_IS_REQUESTER, 403, "Penyetuju tidak boleh sama dengan pemohon.").
// Every other action type is unchanged. "Owner" = an assignment of the role
// with template_key 'owner' at tenant scope that has not ended
// (valid_until IS NULL OR valid_until > now); a future-dated one counts, so it
// fails closed.
//
// Real Better Auth, tenant resolver, RBAC, PostgreSQL and RLS. Every test gets
// its OWN tenant (fresh Owner template role, default seeded `shareholder_version`
// policy = Owner, level 1), so the number of Owners is exactly what the test
// sets up. Versions are created/submitted through the HTTP endpoints; the inbox
// decision is `decideApprovalRequest`; the consumer is
// `handleProfitShareApprovalResolved` (as in profit-share-share-version-approval).
//
// Assumptions (the brief does not pin these down):
// - A refused self-approval is AccessError code APPROVER_IS_REQUESTER, status
//   403, message "Penyetuju tidak boleh sama dengan pemohon." (brief).
// - The audit rows live in `audit_logs.event`: `reason` is the top-level reason
//   and `maskedChanges.after.selfApproval` carries "sole_owner".
// - For the recipient settle the brief says "note/reason": the test only checks
//   that the `shareholder.recipient_change_approved` audit row mentions
//   "self-approval: sole owner" anywhere and has `after.selfApproval`.
// - "Cancelled, reason containing 'not sole owner'" (case 4) is read from any
//   audit row of the tenant (the cancel carries no decision note on a share
//   version, like a cancelled chain in the approval suite).
// - Case 9 uses the `void` action type with an Owner level-1 policy opened
//   through `openApprovalRequest` (the platform approval suite does the same).
// - Tenants are not cleaned up: the test database is disposable.
import { randomUUID } from "node:crypto";
import express from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProfitEntity,
  createShareholder,
  decideShareAllocationVersion,
  getShareAllocationVersion,
  listShareAllocationVersions,
  submitShareAllocationVersion,
} from "@starter/shared/accounting";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import {
  approvalInboxQuerySchema,
  createApprovalRequestSchema,
} from "@starter/shared/identity";
import { auth } from "../lib/auth";
import { requestContext } from "../lib/request-context";
import { limitAuthBody } from "../middleware/body";
import { errorHandler, notFound } from "../middleware/error-handler";
import { tenantContext } from "../middleware/tenant";
import { createProfitShareRegistryRouter } from "../routes/profit-share-registry.routes";
import { seedTenantRoleTemplates } from "../services/access.service";
import { resolveHostname } from "../services/org-resolve.service";
import { deviceTenantCredential } from "../services/platform-tenant.service";
import { setAuditWriter } from "../services/audit-writer";
import { coreAuditWriter } from "../services/core-audit-writer";
import {
  createApprovalRequestFromInbox,
  decideApprovalRequest,
  getApprovalRequest,
  listApprovalRequests,
  openApprovalRequest,
} from "../services/platform-approval.service";
import { handleProfitShareApprovalResolved } from "../services/profit-share-approval-consumers";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

const pg = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const key = (label: string) => `${label}-${randomUUID()}`;
const REFUSED = {
  status: 403,
  code: "APPROVER_IS_REQUESTER",
  message: "Penyetuju tidak boleh sama dengan pemohon.",
};

// ---- Tenants and people -------------------------------------------------------

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
  app.use("/api/accounting", createProfitShareRegistryRouter());
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

type Tenant = {
  id: string;
  app: express.Express;
  ownerRoleId: string;
};
type Person = { client: ReturnType<typeof agent>; userId: string };

/** A fresh tenant with the template roles and the default seeded matrix. */
async function newTenant(): Promise<Tenant> {
  const id = randomUUID();
  await pg.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Sole owner self approval', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [id, `sole-owner-${id}`, randomUUID()],
  );
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${id}, true)`);
    await seedTenantRoleTemplates(tx, id);
  });
  const roles = await pg.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [id],
  );
  expect(roles.rows, "the Owner template role is seeded").toHaveLength(1);
  const policy = await pg.query<{ levels: number; role_id: string }>(
    `SELECT levels, approver_role_id AS role_id FROM approval_policies
      WHERE tenant_id = $1 AND action_type = 'shareholder_version'`,
    [id],
  );
  expect(policy.rows, "default shareholder_version policy").toEqual([
    { levels: 1, role_id: roles.rows[0]!.id },
  ]);
  return { id, app: buildApp(id), ownerRoleId: roles.rows[0]!.id };
}

async function signedIn(tenant: Tenant, name: string): Promise<Person> {
  const client = agent(tenant.app);
  const email = await signUp(client, name);
  await verifySessionMfa(email);
  const session = await client.get("/api/auth/get-session");
  return { client, userId: session.body.user.id as string };
}

/** Owner assignment window, in SQL so the DB clock decides (Node clock may drift). */
const ACTIVE = { from: "now() - interval '1 minute'", until: null };
const FUTURE = { from: "now() + interval '1 day'", until: null };
const ENDED = {
  from: "now() - interval '2 days'",
  until: "now() - interval '1 day'",
};

async function assignOwner(
  tenant: Tenant,
  userId: string,
  window: { from: string; until: string | null } = ACTIVE,
) {
  await pg.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, 'tenant', ${window.from}, ${window.until ?? "NULL"}, $2)`,
    [tenant.id, userId, tenant.ownerRoleId],
  );
}

async function newOwner(
  tenant: Tenant,
  name: string,
  window?: { from: string; until: string | null },
) {
  const person = await signedIn(tenant, name);
  await assignOwner(tenant, person.userId, window);
  return person;
}

async function assignTemplate(
  tenant: Tenant,
  userId: string,
  templateKey: string,
) {
  const done = await pg.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
      WHERE tenant_id = $1 AND template_key = $3`,
    [tenant.id, userId, templateKey],
  );
  expect(done.rowCount).toBe(1);
}

// ---- Contexts, HTTP, helpers --------------------------------------------------

const baseContext = (tenantId: string) =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
const scopedContext = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );

const fill = (path: string, params: Record<string, string | number>) =>
  path.replace(/:(\w+)/g, (_m, name: string) =>
    encodeURIComponent(String(params[name])),
  );
const post = (who: Person, path: string, body: unknown) =>
  who.client
    .post(path)
    .set(originHeader)
    .send(body as object);
const patch = (who: Person, path: string, body: unknown) =>
  who.client
    .patch(path)
    .set(originHeader)
    .send(body as object);
const get = (who: Person, path: string) => who.client.get(path);

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // The API bootstrap installs this; these service calls run without the app.
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  await pg.end();
});

async function newShareholder(
  tenant: Tenant,
  requester: Person,
  userId: string | null = null,
): Promise<string> {
  const response = await post(requester, createShareholder.path, {
    name: `Pemegang ${randomUUID().slice(0, 8)}`,
    type: "person",
    userId,
    npwp: null,
    payoutAccount: null,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

async function newEntity(tenant: Tenant, requester: Person): Promise<string> {
  const legalEntityId = randomUUID();
  await pg.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [legalEntityId, tenant.id, `PT Porsi ${legalEntityId.slice(0, 8)}`],
  );
  const response = await post(requester, createProfitEntity.path, {
    name: `Entitas ${legalEntityId.slice(0, 6)}`,
    type: "legal_entity",
    legalEntityId,
    outletId: null,
    policy: {
      basis: "closed_period_net_profit",
      reserveBp: 1000,
      frequency: "quarterly",
      taxWithholdingBp: 1000,
    },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

type Version = { entityId: string; version: number };

/** A draft 60/40 version of `entityId` (a fresh entity when omitted). */
async function draftVersion(
  tenant: Tenant,
  requester: Person,
  options: { entityId?: string; effectiveFrom?: string } = {},
): Promise<Version> {
  const entityId = options.entityId ?? (await newEntity(tenant, requester));
  const created = await post(
    requester,
    fill(listShareAllocationVersions.path, { profitEntityId: entityId }),
    {
      effectiveFrom: options.effectiveFrom ?? "2025-01-01",
      allocations: [
        {
          shareholderId: await newShareholder(tenant, requester),
          shareBp: 6000,
        },
        {
          shareholderId: await newShareholder(tenant, requester),
          shareBp: 4000,
        },
      ],
      idempotencyKey: key("ver"),
    },
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { entityId, version: created.body.data.version as number };
}

/** Submit a draft: pending, its chain open. */
async function submitDraft(requester: Person, target: Version) {
  const submitted = await post(
    requester,
    fill(submitShareAllocationVersion.path, {
      profitEntityId: target.entityId,
      version: target.version,
    }),
    { idempotencyKey: key("submit") },
  );
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  expect(submitted.body.data.status).toBe("pending_approval");
}

/** A share version submitted by `requester`: pending, its chain open. */
async function submittedVersion(
  tenant: Tenant,
  requester: Person,
  options: { entityId?: string; effectiveFrom?: string } = {},
): Promise<Version> {
  const target = await draftVersion(tenant, requester, options);
  await submitDraft(requester, target);
  return target;
}

/** The direct decide endpoint (what a user without the inbox calls). */
const decideRoute = (
  who: Person,
  target: Version,
  decision: "approve" | "reject" = "approve",
) =>
  post(
    who,
    fill(decideShareAllocationVersion.path, {
      profitEntityId: target.entityId,
      version: target.version,
    }),
    {
      decision,
      note: decision === "reject" ? "Porsi tidak sesuai." : null,
      idempotencyKey: key("decide"),
    },
  );

async function versionRow(tenant: Tenant, target: Version) {
  const { rows } = await pg.query<{
    id: string;
    status: string;
    requested_by: string;
    decided_by: string | null;
  }>(
    `SELECT id, status, requested_by, decided_by FROM share_allocation_versions
      WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = $3`,
    [tenant.id, target.entityId, target.version],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** What the user reads: the version through the endpoint. */
async function shown(tenant: Tenant, reader: Person, target: Version) {
  const read = await get(
    reader,
    fill(getShareAllocationVersion.path, {
      profitEntityId: target.entityId,
      version: target.version,
    }),
  );
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.data as { status: string; decidedBy: string | null };
}

async function chainOfVersion(
  tenant: Tenant,
  target: Version,
): Promise<string> {
  const { id } = await versionRow(tenant, target);
  const { rows } = await pg.query<{ chain_id: string }>(
    `SELECT chain_id FROM approval_requests
      WHERE tenant_id = $1 AND source_module = 'profit_share'
        AND object_type = 'share_allocation_version' AND object_id = $2
      ORDER BY created_at, level LIMIT 1`,
    [tenant.id, id],
  );
  expect(rows, "the submit opened an approval chain").toHaveLength(1);
  return rows[0]!.chain_id;
}

/** Id of the open (pending) level-1 request of the chain. */
async function openRequestId(tenant: Tenant, chainId: string): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `SELECT id FROM approval_requests
      WHERE tenant_id = $1 AND chain_id = $2 AND status = 'pending'
      ORDER BY level LIMIT 1`,
    [tenant.id, chainId],
  );
  expect(rows, "an open approval level").toHaveLength(1);
  return rows[0]!.id;
}

async function requestStatus(tenant: Tenant, requestId: string) {
  const { rows } = await pg.query<{ status: string }>(
    "SELECT status FROM approval_requests WHERE tenant_id = $1 AND id = $2",
    [tenant.id, requestId],
  );
  return rows[0]?.status;
}

/** The inbox decision of a request, exactly as the inbox route performs it. */
function inboxDecide(
  tenant: Tenant,
  who: Person,
  requestId: string,
  decision: "approved" | "rejected",
) {
  return decideApprovalRequest(
    baseContext(tenant.id),
    who.userId,
    requestId,
    { decision, reason: "Perubahan sudah diverifikasi." },
    { mfaVerified: true, idempotencyKey: null },
  );
}

/** The `approval.resolved` the outbox holds for the chain, then the consumer. */
async function settle(tenant: Tenant, chainId: string) {
  const { rows } = await pg.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [tenant.id, chainId],
  );
  expect(rows, "approval.resolved was emitted").toHaveLength(1);
  await handleProfitShareApprovalResolved(
    scopedContext(tenant.id),
    eventEnvelopeSchema.parse(rows[0]!.event),
  );
}

type AuditRow = {
  actorId: string | null;
  objectId: string | null;
  reason: string | null;
  after: Record<string, unknown> | null;
  raw: string;
};

async function auditRows(
  tenant: Tenant,
  action: string,
  objectId?: string,
): Promise<AuditRow[]> {
  const { rows } = await pg.query<{
    actor_id: string | null;
    object_id: string | null;
    reason: string | null;
    after: Record<string, unknown> | null;
    raw: string;
  }>(
    `SELECT event->>'actorId' AS actor_id, event->>'objectId' AS object_id,
            event->>'reason' AS reason, event->'maskedChanges'->'after' AS after,
            event::text AS raw
       FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2
        AND ($3::text IS NULL OR event->>'objectId' = $3)`,
    [tenant.id, action, objectId ?? null],
  );
  return rows.map((row) => ({
    actorId: row.actor_id,
    objectId: row.object_id,
    reason: row.reason,
    after: row.after,
    raw: row.raw,
  }));
}

// ---- Tests ----------------------------------------------------------------------

describe("legend-b8y6l sole Owner self-approves a share allocation version", () => {
  it("1 sole Owner submits, approves in the inbox, the settle approves the version; audited", async () => {
    const tenant = await newTenant();
    const alone = await newOwner(tenant, "Sole Owner One");
    const target = await submittedVersion(tenant, alone);
    expect(await shown(tenant, alone, target)).toMatchObject({
      status: "pending_approval",
    });
    const chainId = await chainOfVersion(tenant, target);
    const requestId = await openRequestId(tenant, chainId);

    const decided = await inboxDecide(tenant, alone, requestId, "approved");
    expect(decided).toMatchObject({
      status: "approved",
      decidedBy: alone.userId,
    });
    // The decision alone does not touch the version; the consumer applies it.
    expect((await versionRow(tenant, target)).status).toBe("pending_approval");
    await settle(tenant, chainId);

    expect(await versionRow(tenant, target)).toMatchObject({
      status: "approved",
      decided_by: alone.userId,
      requested_by: alone.userId,
    });
    expect(await shown(tenant, alone, target)).toMatchObject({
      status: "approved",
      decidedBy: alone.userId,
    });

    const inboxAudit = await auditRows(tenant, "approval.decided", requestId);
    expect(inboxAudit).toHaveLength(1);
    expect(inboxAudit[0]!.actorId).toBe(alone.userId);
    expect(inboxAudit[0]!.after).toMatchObject({ selfApproval: "sole_owner" });

    const versionAudit = await auditRows(tenant, "share_version.approved");
    expect(versionAudit).toHaveLength(1);
    expect(versionAudit[0]!.actorId).toBe(alone.userId);
    expect(versionAudit[0]!.reason).toBe("self-approval: sole owner");
    expect(versionAudit[0]!.after).toMatchObject({
      selfApproval: "sole_owner",
    });
  });

  it("2 with two Owners the requester cannot self-approve (403); the other Owner can", async () => {
    const tenant = await newTenant();
    const a = await newOwner(tenant, "Two Owners A");
    const b = await newOwner(tenant, "Two Owners B");
    const target = await submittedVersion(tenant, a);
    const chainId = await chainOfVersion(tenant, target);
    const requestId = await openRequestId(tenant, chainId);

    await expect(
      inboxDecide(tenant, a, requestId, "approved"),
    ).rejects.toMatchObject(REFUSED);
    expect(await requestStatus(tenant, requestId)).toBe("pending");
    expect((await versionRow(tenant, target)).status).toBe("pending_approval");

    const decided = await inboxDecide(tenant, b, requestId, "approved");
    expect(decided).toMatchObject({ status: "approved", decidedBy: b.userId });
    await settle(tenant, chainId);
    expect(await versionRow(tenant, target)).toMatchObject({
      status: "approved",
      decided_by: b.userId,
      requested_by: a.userId,
    });
    // A normal approval carries no self-approval mark.
    const inboxAudit = await auditRows(tenant, "approval.decided", requestId);
    expect(inboxAudit).toHaveLength(1);
    expect(inboxAudit[0]!.after?.selfApproval).toBeUndefined();
    const versionAudit = await auditRows(tenant, "share_version.approved");
    expect(
      versionAudit.every((row) => !row.raw.includes("self-approval")),
    ).toBe(true);
  });

  it("3 a 2nd Owner granted after the submit blocks the self-approval (403)", async () => {
    const tenant = await newTenant();
    const a = await newOwner(tenant, "Late Second Owner A");
    const target = await submittedVersion(tenant, a);
    const requestId = await openRequestId(
      tenant,
      await chainOfVersion(tenant, target),
    );
    await newOwner(tenant, "Late Second Owner B");

    await expect(
      inboxDecide(tenant, a, requestId, "approved"),
    ).rejects.toMatchObject(REFUSED);
    expect(await requestStatus(tenant, requestId)).toBe("pending");
    expect((await versionRow(tenant, target)).status).toBe("pending_approval");
  });

  it("3b race: a self-approval waits for an in-flight 'add 2nd Owner' (same advisory lock), then is refused (403)", async () => {
    const tenant = await newTenant();
    const a = await newOwner(tenant, "Lock Race Owner A");
    const bUser = await signedIn(tenant, "Lock Race Owner B");
    const target = await submittedVersion(tenant, a);
    const requestId = await openRequestId(
      tenant,
      await chainOfVersion(tenant, target),
    );

    // A raw transaction plays "grant the 2nd Owner": it holds the role
    // assignment lock key (the one grant/end/offboarding use) and inserts an
    // active 2nd Owner, uncommitted. The pool connection is the migration
    // owner, so RLS does not apply (as for every other raw insert here).
    const raw = await pg.connect();
    let rawOpen = false;
    try {
      await raw.query("BEGIN");
      rawOpen = true;
      await raw.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('legend:role-assignment-end:' || $1::text, 0))",
        [tenant.id],
      );
      await raw.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
        [tenant.id, bUser.userId, tenant.ownerRoleId],
      );

      // Start the self-approval WITHOUT awaiting; capture its outcome so a
      // rejection is never an unhandled one.
      const outcome = inboxDecide(tenant, a, requestId, "approved").then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      // Evidence that it is blocked on an advisory lock (not merely slow):
      // some session is waiting for one. Poll, bounded, no fixed guess.
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        const { rows } = await pg.query(
          "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
        );
        waiting = rows.length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting, "the self-approval waits on the advisory lock").toBe(
        true,
      );
      // And it has not settled while the lock is held.
      const pending = Symbol("pending");
      const early = await Promise.race([
        outcome,
        new Promise<symbol>((resolve) =>
          setTimeout(() => resolve(pending), 300),
        ),
      ]);
      expect(early, "still pending before the 2nd Owner commits").toBe(pending);
      expect(await requestStatus(tenant, requestId)).toBe("pending");

      await raw.query("COMMIT");
      rawOpen = false;

      const settled = await outcome;
      expect(settled.ok, "the self-approval is refused").toBe(false);
      if (!settled.ok) expect(settled.error).toMatchObject(REFUSED);
    } finally {
      if (rawOpen) await raw.query("ROLLBACK");
      raw.release();
    }
    expect(await requestStatus(tenant, requestId)).toBe("pending");
    expect((await versionRow(tenant, target)).status).toBe("pending_approval");
  });

  it("4 a 2nd Owner granted between the inbox decision and the settle cancels the version", async () => {
    const tenant = await newTenant();
    const a = await newOwner(tenant, "Race Owner A");
    const target = await submittedVersion(tenant, a);
    const chainId = await chainOfVersion(tenant, target);
    const requestId = await openRequestId(tenant, chainId);
    await inboxDecide(tenant, a, requestId, "approved");

    await newOwner(tenant, "Race Owner B"); // appears BEFORE the settle
    await settle(tenant, chainId);

    const row = await versionRow(tenant, target);
    expect(row.status).toBe("cancelled");
    expect(row.decided_by).toBeNull();
    expect(await shown(tenant, a, target)).toMatchObject({
      status: "cancelled",
      decidedBy: null,
    });
    // Never approved: no approval audit, and the cancel states why.
    expect(await auditRows(tenant, "share_version.approved")).toHaveLength(0);
    const { rows } = await pg.query<{ raw: string }>(
      `SELECT event::text AS raw FROM audit_logs
        WHERE tenant_id = $1 AND event->>'reason' LIKE '%not sole owner%'`,
      [tenant.id],
    );
    expect(
      rows.length,
      "a cancel reason naming 'not sole owner'",
    ).toBeGreaterThan(0);
  });

  it("5 a future-dated 2nd Owner counts (fail closed): self-approval refused (403)", async () => {
    const tenant = await newTenant();
    const a = await newOwner(tenant, "Future Owner A");
    const target = await submittedVersion(tenant, a);
    const requestId = await openRequestId(
      tenant,
      await chainOfVersion(tenant, target),
    );
    await newOwner(tenant, "Future Owner B", FUTURE);

    await expect(
      inboxDecide(tenant, a, requestId, "approved"),
    ).rejects.toMatchObject(REFUSED);
    expect(await requestStatus(tenant, requestId)).toBe("pending");
  });

  it("5b an ENDED 2nd Owner does not count: the sole Owner still self-approves", async () => {
    const tenant = await newTenant();
    const a = await newOwner(tenant, "Ended Owner A");
    await newOwner(tenant, "Ended Owner B", ENDED);
    const target = await submittedVersion(tenant, a);
    const chainId = await chainOfVersion(tenant, target);
    const requestId = await openRequestId(tenant, chainId);

    const decided = await inboxDecide(tenant, a, requestId, "approved");
    expect(decided).toMatchObject({ status: "approved", decidedBy: a.userId });
    await settle(tenant, chainId);
    expect(await versionRow(tenant, target)).toMatchObject({
      status: "approved",
      decided_by: a.userId,
    });
  });

  it("6 tenants are isolated: another tenant's Owner neither counts nor can decide", async () => {
    const tenantX = await newTenant();
    const tenantY = await newTenant();
    const xOwner = await newOwner(tenantX, "Isolation X Owner");
    const yOwner = await newOwner(tenantY, "Isolation Y Owner");
    const target = await submittedVersion(tenantX, xOwner);
    const chainId = await chainOfVersion(tenantX, target);
    const requestId = await openRequestId(tenantX, chainId);

    // Y's Owner holds no role in X: the request is out of reach.
    await expect(
      inboxDecide(tenantX, yOwner, requestId, "approved"),
    ).rejects.toThrow();
    expect(await requestStatus(tenantX, requestId)).toBe("pending");

    // X has ONE Owner (Y's does not count): the self-approval goes through.
    const decided = await inboxDecide(tenantX, xOwner, requestId, "approved");
    expect(decided).toMatchObject({
      status: "approved",
      decidedBy: xOwner.userId,
    });
    await settle(tenantX, chainId);
    expect(await versionRow(tenantX, target)).toMatchObject({
      status: "approved",
      decided_by: xOwner.userId,
    });
  });

  it("7 the sole Owner cannot self-REJECT (403)", async () => {
    const tenant = await newTenant();
    const alone = await newOwner(tenant, "Sole Owner Reject");
    const target = await submittedVersion(tenant, alone);
    const requestId = await openRequestId(
      tenant,
      await chainOfVersion(tenant, target),
    );

    await expect(
      inboxDecide(tenant, alone, requestId, "rejected"),
    ).rejects.toMatchObject(REFUSED);
    expect(await requestStatus(tenant, requestId)).toBe("pending");
    expect((await versionRow(tenant, target)).status).toBe("pending_approval");
  });

  it("9 another action type (void): the sole Owner still cannot approve their own request (403)", async () => {
    const tenant = await newTenant();
    const alone = await newOwner(tenant, "Sole Owner Void");
    await pg.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'void', NULL, $2, 1)`,
      [tenant.id, tenant.ownerRoleId],
    );
    const context = scopedContext(tenant.id);
    const opened = await withTenant(db, context, (tx) =>
      openApprovalRequest(tx, context, {
        sourceModule: "payment",
        actionType: "void",
        objectType: "order",
        objectId: randomUUID(),
        amountIdr: null,
        outletId: null,
        requestedBy: alone.userId,
        source: "user",
        requestReason: "Pelanggan membatalkan pesanan sebelum dapur mulai.",
      }),
    );
    if (!opened.required) throw new Error("expected an approval requirement");

    await expect(
      inboxDecide(tenant, alone, opened.request.id, "approved"),
    ).rejects.toMatchObject(REFUSED);
    expect(await requestStatus(tenant, opened.request.id)).toBe("pending");
  });

  it("11 a self-approved version the effective-date order now refuses is cancelled at settle: no 500, no decider", async () => {
    const tenant = await newTenant();
    const alone = await newOwner(tenant, "Order Sole Owner");
    // v1 approved, so later drafts are checked against it.
    const v1 = await submittedVersion(tenant, alone, {
      effectiveFrom: "2025-01-01",
    });
    const v1Chain = await chainOfVersion(tenant, v1);
    await inboxDecide(
      tenant,
      alone,
      await openRequestId(tenant, v1Chain),
      "approved",
    );
    await settle(tenant, v1Chain);
    expect((await versionRow(tenant, v1)).status).toBe("approved");

    // Both drafts are valid against v1 when created: v2 March, v3 June.
    const entityId = v1.entityId;
    const v2 = await draftVersion(tenant, alone, {
      entityId,
      effectiveFrom: "2025-03-01",
    });
    const v3 = await draftVersion(tenant, alone, {
      entityId,
      effectiveFrom: "2025-06-01",
    });
    expect([v2.version, v3.version]).toEqual([2, 3]);
    await submitDraft(alone, v2);
    await submitDraft(alone, v3);
    const v2Chain = await chainOfVersion(tenant, v2);
    const v3Chain = await chainOfVersion(tenant, v3);
    const v2Request = await openRequestId(tenant, v2Chain);

    // v3 (June) is approved first ...
    await inboxDecide(
      tenant,
      alone,
      await openRequestId(tenant, v3Chain),
      "approved",
    );
    await settle(tenant, v3Chain);
    expect(await versionRow(tenant, v3)).toMatchObject({
      status: "approved",
      decided_by: alone.userId,
    });

    // ... so v2 (March) no longer advances. The inbox still lets the sole
    // Owner approve it; the settle must refuse it cleanly. Assumption: a
    // refusal that would have to name the requester as decider closes the
    // version `cancelled` with no decider (the DB forbids requester = decider),
    // and the audit reason says "approval refused".
    await inboxDecide(tenant, alone, v2Request, "approved");
    await expect(settle(tenant, v2Chain)).resolves.toBeUndefined();

    const row = await versionRow(tenant, v2);
    expect(row.status).toBe("cancelled");
    expect(row.decided_by).toBeNull();
    expect(await shown(tenant, alone, v2)).toMatchObject({
      status: "cancelled",
      decidedBy: null,
    });
    const { rows } = await pg.query(
      `SELECT 1 FROM audit_logs
        WHERE tenant_id = $1 AND event->>'reason' LIKE '%approval refused%'`,
      [tenant.id],
    );
    expect(
      rows.length,
      "an audit reason naming 'approval refused'",
    ).toBeGreaterThan(0);
    // v3 stays the approved one.
    expect((await versionRow(tenant, v3)).status).toBe("approved");
  });

  it("13 two-level policy: the sole Owner self-approves level 1, another role approves level 2, the settle approves", async () => {
    const tenant = await newTenant();
    const alone = await newOwner(tenant, "Two Level Sole Owner");
    const second = await signedIn(tenant, "Two Level Approver");
    const roleId = randomUUID();
    await pg.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, 'Level 2 approver', false, $3, $4)`,
      [
        roleId,
        tenant.id,
        JSON.stringify(["approval.request.decide"]),
        JSON.stringify(["tenant"]),
      ],
    );
    await pg.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
      [tenant.id, second.userId, roleId],
    );
    // Matrix: level 1 Owner (seeded at floor 0), level 2 the custom role in
    // the same tier (same threshold), so the chain has two levels.
    await pg.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'shareholder_version', 0, $2, 2)`,
      [tenant.id, roleId],
    );

    const target = await submittedVersion(tenant, alone);
    const chainId = await chainOfVersion(tenant, target);
    const level1 = await openRequestId(tenant, chainId);
    // The level-2 approver cannot decide level 1 (wrong role for the level).
    await expect(
      inboxDecide(tenant, second, level1, "approved"),
    ).rejects.toThrow();

    const first = await inboxDecide(tenant, alone, level1, "approved");
    expect(first).toMatchObject({
      status: "approved",
      decidedBy: alone.userId,
    });
    // One level left: the version is not settled yet.
    expect((await versionRow(tenant, target)).status).toBe("pending_approval");
    const level2 = await openRequestId(tenant, chainId);
    expect(level2).not.toBe(level1);

    const last = await inboxDecide(tenant, second, level2, "approved");
    expect(last).toMatchObject({
      status: "approved",
      decidedBy: second.userId,
    });
    await settle(tenant, chainId);

    expect(await versionRow(tenant, target)).toMatchObject({
      status: "approved",
      decided_by: second.userId,
      requested_by: alone.userId,
    });
    const level1Audit = await auditRows(tenant, "approval.decided", level1);
    expect(level1Audit[0]!.after).toMatchObject({ selfApproval: "sole_owner" });
    const level2Audit = await auditRows(tenant, "approval.decided", level2);
    expect(level2Audit[0]!.after?.selfApproval).toBeUndefined();
  });

  it("14 a hand-made inbox request of this action type is not self-approvable (403)", async () => {
    const tenant = await newTenant();
    const alone = await newOwner(tenant, "Inbox Sole Owner");
    // Created from the inbox: sourceModule 'inbox', no module applies an effect.
    const { request } = await createApprovalRequestFromInbox(
      baseContext(tenant.id),
      alone.userId,
      createApprovalRequestSchema.parse({
        actionType: "shareholder_version",
        objectType: "share_allocation_version",
        objectId: randomUUID(),
        requestReason: "Permintaan buatan sendiri dari kotak masuk.",
      }),
      { idempotencyKey: null },
    );
    expect(request).toMatchObject({
      actionType: "shareholder_version",
      status: "pending",
    });

    await expect(
      inboxDecide(tenant, alone, request.id, "approved"),
    ).rejects.toMatchObject(REFUSED);
    expect(await requestStatus(tenant, request.id)).toBe("pending");
    // The inbox does not offer an action that would be refused.
    const page = await listApprovalRequests(
      baseContext(tenant.id),
      alone.userId,
      approvalInboxQuerySchema.parse({
        status: "pending",
        actionType: "shareholder_version",
      }),
    );
    const view = (
      page.data as unknown as { id: string; selfApprovalAllowed?: boolean }[]
    ).find((row) => row.id === request.id);
    expect(view, "the hand-made request is listed").toBeDefined();
    expect(view!.selfApprovalAllowed).toBeUndefined();
  });

  it("15 direct decide by the sole Owner: 409 APPROVAL_PENDING while the chain is open, settles as approved after the inbox self-approval", async () => {
    const tenant = await newTenant();
    const alone = await newOwner(tenant, "Direct Sole Owner");
    const target = await submittedVersion(tenant, alone);
    const chainId = await chainOfVersion(tenant, target);

    const early = await decideRoute(alone, target, "approve");
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    expect(early.body.error?.code).toBe("APPROVAL_PENDING");
    expect((await versionRow(tenant, target)).status).toBe("pending_approval");

    await inboxDecide(
      tenant,
      alone,
      await openRequestId(tenant, chainId),
      "approved",
    );
    const settled = await decideRoute(alone, target, "approve");
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.data).toMatchObject({
      status: "approved",
      decidedBy: alone.userId,
    });
    expect(await versionRow(tenant, target)).toMatchObject({
      status: "approved",
      decided_by: alone.userId,
    });
    const audit = await auditRows(tenant, "share_version.approved");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.reason).toBe("self-approval: sole owner");
  });
});

describe("legend-b8y6l the inbox tells the sole Owner the self-approval is allowed", () => {
  type View = { id: string; selfApprovalAllowed?: boolean };
  const query = approvalInboxQuerySchema.parse({
    status: "pending",
    actionType: "shareholder_version",
  });

  async function listed(tenant: Tenant, who: Person, requestId: string) {
    const page = await listApprovalRequests(
      baseContext(tenant.id),
      who.userId,
      query,
    );
    return (page.data as unknown as View[]).find((row) => row.id === requestId);
  }
  async function fetched(tenant: Tenant, who: Person, requestId: string) {
    return (await getApprovalRequest(
      baseContext(tenant.id),
      who.userId,
      requestId,
    )) as unknown as View;
  }

  it("10 selfApprovalAllowed is true on the sole Owner's own pending row, absent with 2 Owners", async () => {
    const solo = await newTenant();
    const alone = await newOwner(solo, "Flag Sole Owner");
    const soloTarget = await submittedVersion(solo, alone);
    const soloRequest = await openRequestId(
      solo,
      await chainOfVersion(solo, soloTarget),
    );
    expect((await listed(solo, alone, soloRequest))?.selfApprovalAllowed).toBe(
      true,
    );
    expect((await fetched(solo, alone, soloRequest)).selfApprovalAllowed).toBe(
      true,
    );

    const duo = await newTenant();
    const a = await newOwner(duo, "Flag Duo A");
    const b = await newOwner(duo, "Flag Duo B");
    const duoTarget = await submittedVersion(duo, a);
    const duoRequest = await openRequestId(
      duo,
      await chainOfVersion(duo, duoTarget),
    );
    const requesterView = await listed(duo, a, duoRequest);
    expect(requesterView, "the row is listed").toBeDefined();
    expect(requesterView!.selfApprovalAllowed).toBeUndefined();
    expect(
      (await fetched(duo, a, duoRequest)).selfApprovalAllowed,
    ).toBeUndefined();
    // The other Owner is not the requester: nothing to flag for them either.
    expect(
      (await listed(duo, b, duoRequest))?.selfApprovalAllowed,
    ).toBeUndefined();
    expect(
      (await fetched(duo, b, duoRequest)).selfApprovalAllowed,
    ).toBeUndefined();
  });

  it("10b the flag disappears once a 2nd Owner exists", async () => {
    const tenant = await newTenant();
    const a = await newOwner(tenant, "Flag Late A");
    const target = await submittedVersion(tenant, a);
    const requestId = await openRequestId(
      tenant,
      await chainOfVersion(tenant, target),
    );
    expect((await fetched(tenant, a, requestId)).selfApprovalAllowed).toBe(
      true,
    );
    await newOwner(tenant, "Flag Late B");
    expect(
      (await fetched(tenant, a, requestId)).selfApprovalAllowed,
    ).toBeUndefined();
    expect(
      (await listed(tenant, a, requestId))?.selfApprovalAllowed,
    ).toBeUndefined();
  });
});

describe("legend-b8y6l sole Owner self-approves a statement recipient change", () => {
  type Recipient = {
    shareholderId: string;
    versionId: string;
    chainId: string;
  };

  /** A pending recipient change opened by `requester` (alice -> bob). */
  async function pendingRecipientChange(
    tenant: Tenant,
    requester: Person,
  ): Promise<Recipient & { bobId: string }> {
    const alice = await signedIn(tenant, "Recipient Alice");
    const bob = await signedIn(tenant, "Recipient Bob");
    await assignTemplate(tenant, alice.userId, "shareholder");
    await assignTemplate(tenant, bob.userId, "shareholder");
    const shareholderId = await newShareholder(tenant, requester, alice.userId);
    const changed = await patch(
      requester,
      `/api/accounting/shareholders/${shareholderId}`,
      { userId: bob.userId },
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const { rows } = await pg.query<{
      id: string;
      status: string;
      approval_chain_id: string | null;
    }>(
      `SELECT id, status, approval_chain_id FROM shareholder_recipient_versions
        WHERE tenant_id = $1 AND shareholder_id = $2`,
      [tenant.id, shareholderId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending_approval");
    return {
      shareholderId,
      versionId: rows[0]!.id,
      chainId: rows[0]!.approval_chain_id!,
      bobId: bob.userId,
    };
  }

  const loginOf = async (tenant: Tenant, shareholderId: string) =>
    (
      await pg.query<{ user_id: string | null }>(
        "SELECT user_id FROM shareholders WHERE tenant_id = $1 AND id = $2",
        [tenant.id, shareholderId],
      )
    ).rows[0]!.user_id;

  it("8 the sole Owner approves their own recipient change in the inbox and it is applied", async () => {
    const tenant = await newTenant();
    const alone = await newOwner(tenant, "Recipient Sole Owner");
    const change = await pendingRecipientChange(tenant, alone);
    const requestId = await openRequestId(tenant, change.chainId);

    const decided = await inboxDecide(tenant, alone, requestId, "approved");
    expect(decided).toMatchObject({
      status: "approved",
      decidedBy: alone.userId,
    });
    await settle(tenant, change.chainId);

    expect(await loginOf(tenant, change.shareholderId)).toBe(change.bobId);
    const { rows } = await pg.query<{ status: string; decided_by: string }>(
      `SELECT status, decided_by FROM shareholder_recipient_versions
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, change.versionId],
    );
    expect(rows[0]).toMatchObject({
      status: "approved",
      decided_by: alone.userId,
    });
    const inboxAudit = await auditRows(tenant, "approval.decided", requestId);
    expect(inboxAudit[0]!.after).toMatchObject({ selfApproval: "sole_owner" });
    const applied = await auditRows(
      tenant,
      "shareholder.recipient_change_approved",
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]!.after).toMatchObject({ selfApproval: "sole_owner" });
    expect(applied[0]!.raw).toContain("self-approval: sole owner");
  });

  it("8b with two Owners the requester cannot self-approve a recipient change (403)", async () => {
    const tenant = await newTenant();
    const a = await newOwner(tenant, "Recipient Duo A");
    await newOwner(tenant, "Recipient Duo B");
    const change = await pendingRecipientChange(tenant, a);
    const requestId = await openRequestId(tenant, change.chainId);

    await expect(
      inboxDecide(tenant, a, requestId, "approved"),
    ).rejects.toMatchObject(REFUSED);
    expect(await requestStatus(tenant, requestId)).toBe("pending");
    expect(await loginOf(tenant, change.shareholderId)).not.toBe(change.bobId);
  });

  it("8c a 2nd Owner granted before the settle cancels the recipient change; login unchanged", async () => {
    const tenant = await newTenant();
    const a = await newOwner(tenant, "Recipient Race A");
    const change = await pendingRecipientChange(tenant, a);
    const requestId = await openRequestId(tenant, change.chainId);
    await inboxDecide(tenant, a, requestId, "approved");

    await newOwner(tenant, "Recipient Race B");
    await settle(tenant, change.chainId);

    expect(await loginOf(tenant, change.shareholderId)).not.toBe(change.bobId);
    const { rows } = await pg.query<{
      status: string;
      decided_by: string | null;
    }>(
      `SELECT status, decided_by FROM shareholder_recipient_versions
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, change.versionId],
    );
    expect(rows[0]).toMatchObject({ status: "cancelled", decided_by: null });
    expect(
      await auditRows(tenant, "shareholder.recipient_change_approved"),
    ).toHaveLength(0);
  });

  it("12 a self-approved recipient change the settle refuses (stale login) is cancelled: no error, no decider", async () => {
    const tenant = await newTenant();
    const alone = await newOwner(tenant, "Recipient Stale Owner");
    const change = await pendingRecipientChange(tenant, alone);
    const requestId = await openRequestId(tenant, change.chainId);
    await inboxDecide(tenant, alone, requestId, "approved");

    // Between the inbox decision and the settle the shareholder's login moves
    // to someone else: the change was requested against a login that is gone.
    // Assumption: the settle refuses a change whose previous login no longer
    // matches; with self-approval it closes `cancelled`, decided_by NULL (the
    // DB forbids requester = decider), instead of failing.
    const carol = await signedIn(tenant, "Recipient Carol");
    await pg.query(
      "UPDATE shareholders SET user_id = $3 WHERE tenant_id = $1 AND id = $2",
      [tenant.id, change.shareholderId, carol.userId],
    );
    await expect(settle(tenant, change.chainId)).resolves.toBeUndefined();

    const { rows } = await pg.query<{
      status: string;
      decided_by: string | null;
    }>(
      `SELECT status, decided_by FROM shareholder_recipient_versions
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, change.versionId],
    );
    expect(rows[0]).toMatchObject({ status: "cancelled", decided_by: null });
    // The refused change did not touch the login.
    expect(await loginOf(tenant, change.shareholderId)).toBe(carol.userId);
    expect(
      await auditRows(tenant, "shareholder.recipient_change_approved"),
    ).toHaveLength(0);
  });
});
