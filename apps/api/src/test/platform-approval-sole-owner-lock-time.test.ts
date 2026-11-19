// legend-1151 (brief 1151, finding P2 of second opinion 1148, money-adjacent):
// on the sole-Owner self-approval path the decision may queue on a SECOND lock
// (the tenant's role-assignment lock, taken to prove the requester is the only
// Owner). The decision must be judged with the time after that last lock, not
// with a clock read before waiting for it.
//
// Expected behaviour (CTO decision, fail-safe: when in doubt, refuse):
// - a sole Owner who starts approving their own `shareholder_version` request
//   before the deadline, and who waited on the tenant role-assignment lock
//   past the deadline, is refused as expired (APPROVAL_REQUEST_EXPIRED); the
//   transaction rolls back: no decision stored, no audit of a decision, no
//   `approval.resolved` event;
// - a decision that waited on that lock but is still inside the deadline
//   succeeds, and `decided_at` is the post-lock time.
//
// Method (two connections + a barrier, no fixed sleeps): a second connection
// holds the tenant's role-assignment advisory lock
// (`pg_advisory_xact_lock(hashtextextended('legend:role-assignment-end:' ||
// tenantId, 0))`, the lock named in the brief) without touching any role
// assignment, so the requester stays the sole Owner. The decision starts
// (no `now` option: the service takes the real clock) and the test waits until
// PostgreSQL shows a session waiting for exactly that advisory lock; only then
// does it wait (on a condition) for the real clock to pass the point, and
// releases the lock. Real Better Auth, tenant resolver, RBAC, PostgreSQL and
// RLS, like profit-share-sole-owner-self-approval.test.ts, whose fixtures are
// adapted here.
//
// Assumptions: the deadline of the open level is moved with SQL to a few
// seconds ahead (the policy's own deadline is far longer). The version is
// submitted through the HTTP endpoints; the decision is the inbox decision
// (`decideApprovalRequest`).
import { randomUUID } from "node:crypto";
import express from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProfitEntity,
  createShareholder,
  listShareAllocationVersions,
  submitShareAllocationVersion,
} from "@starter/shared/accounting";
import { establishTenantContext } from "@starter/shared/core/server";
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
import { decideApprovalRequest } from "../services/platform-approval.service";
import { db } from "../db";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

const pg = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const key = (label: string) => `${label}-${randomUUID()}`;
// Room between starting the decision and the deadline, so the call's own
// clock is reliably before it even on a loaded machine.
const DEADLINE_MARGIN_MS = 8_000;
// Hold time in the "still inside the deadline" test: long enough that a
// pre-lock clock is clearly earlier than the post-lock one.
const HOLD_MS = 2_000;
// Tolerance for clock drift between Node and the container, far below HOLD_MS.
const DRIFT_TOLERANCE_MS = 500;

// ---- Tenant and people (adapted from profit-share-sole-owner-self-approval) -----

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

type Tenant = { id: string; app: express.Express; ownerRoleId: string };
type Person = { client: ReturnType<typeof agent>; userId: string };

/** A fresh tenant with the template roles and the default seeded matrix. */
async function newTenant(): Promise<Tenant> {
  const id = randomUUID();
  await pg.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Sole owner lock time', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [id, `sole-owner-lock-${id}`, randomUUID()],
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
  return { id, app: buildApp(id), ownerRoleId: roles.rows[0]!.id };
}

/** The tenant's single Owner: an active tenant-scope Owner assignment. */
async function newSoleOwner(tenant: Tenant): Promise<Person> {
  const client = agent(tenant.app);
  const email = await signUp(client, "Sole Owner lock time");
  await verifySessionMfa(email);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await pg.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', NULL, $2)`,
    [tenant.id, userId, tenant.ownerRoleId],
  );
  return { client, userId };
}

const fill = (path: string, params: Record<string, string | number>) =>
  path.replace(/:(\w+)/g, (_m, name: string) =>
    encodeURIComponent(String(params[name])),
  );
const post = (who: Person, path: string, body: unknown) =>
  who.client
    .post(path)
    .set(originHeader)
    .send(body as object);

async function newShareholder(requester: Person): Promise<string> {
  const response = await post(requester, createShareholder.path, {
    name: `Pemegang ${randomUUID().slice(0, 8)}`,
    type: "person",
    userId: null,
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

/** A 60/40 share version submitted by `requester`: pending, its chain open. */
async function submittedVersion(tenant: Tenant, requester: Person) {
  const entityId = await newEntity(tenant, requester);
  const created = await post(
    requester,
    fill(listShareAllocationVersions.path, { profitEntityId: entityId }),
    {
      effectiveFrom: "2025-01-01",
      allocations: [
        { shareholderId: await newShareholder(requester), shareBp: 6000 },
        { shareholderId: await newShareholder(requester), shareBp: 4000 },
      ],
      idempotencyKey: key("ver"),
    },
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const version = created.body.data.version as number;
  const submitted = await post(
    requester,
    fill(submitShareAllocationVersion.path, {
      profitEntityId: entityId,
      version,
    }),
    { idempotencyKey: key("submit") },
  );
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  const { rows } = await pg.query<{ id: string }>(
    `SELECT r.id FROM approval_requests r
       JOIN share_allocation_versions v
         ON v.id::text = r.object_id AND v.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1 AND r.source_module = 'profit_share'
        AND r.object_type = 'share_allocation_version'
        AND v.profit_entity_id = $2 AND v.version = $3
        AND r.status = 'pending'
      ORDER BY r.level LIMIT 1`,
    [tenant.id, entityId, version],
  );
  expect(rows, "the submit opened a pending approval level").toHaveLength(1);
  return rows[0]!.id;
}

// ---- Rows and barrier -------------------------------------------------------------

type LevelRow = {
  id: string;
  chain_id: string;
  status: string;
  deadline_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
};

async function levelOf(tenant: Tenant, requestId: string): Promise<LevelRow> {
  const { rows } = await pg.query<LevelRow>(
    `SELECT id, chain_id, status, deadline_at, decided_at, decided_by
       FROM approval_requests WHERE tenant_id = $1 AND id = $2`,
    [tenant.id, requestId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function setDeadline(tenant: Tenant, requestId: string, at: Date) {
  const done = await pg.query(
    `UPDATE approval_requests SET deadline_at = $3
      WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
    [tenant.id, requestId, at],
  );
  expect(done.rowCount).toBe(1);
}

async function resolvedOutcomes(
  tenant: Tenant,
  chainId: string,
): Promise<unknown[]> {
  const { rows } = await pg.query<{ outcome: unknown }>(
    `SELECT event->'payload'->'outcome' AS outcome FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_type = 'approval' AND aggregate_id = $2
        AND event->>'name' = 'approval.resolved'`,
    [tenant.id, chainId],
  );
  return rows.map((row) => row.outcome);
}

async function decidedAuditCount(
  tenant: Tenant,
  requestId: string,
): Promise<number> {
  const { rows } = await pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = 'approval.decided'
        AND event->>'objectId' = $2`,
    [tenant.id, requestId],
  );
  return rows[0]?.n ?? 0;
}

async function waitFor(
  condition: () => Promise<boolean> | boolean,
  what: string,
): Promise<void> {
  // ~15 s budget; the wait is on a condition, not a fixed delay.
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A session is waiting for the advisory lock that `holderPid` holds. */
async function waiterOnHeldAdvisoryLock(holderPid: number): Promise<boolean> {
  const { rows } = await pg.query<{ waiting: number }>(
    `SELECT count(*)::int AS waiting
       FROM pg_locks w
       JOIN pg_locks h
         ON h.locktype = 'advisory' AND h.granted AND h.pid = $1
        AND h.classid = w.classid AND h.objid = w.objid
        AND h.objsubid = w.objsubid AND h.database = w.database
      WHERE w.locktype = 'advisory' AND NOT w.granted`,
    [holderPid],
  );
  return (rows[0]?.waiting ?? 0) > 0;
}

/**
 * The sole Owner approves their own request while another connection holds
 * the tenant role-assignment lock. The decision (real clock, no `now`) must
 * be queued on that exact lock before `releaseWhen()` is awaited and the lock
 * is released. Returns the settled outcome and the clock just before release.
 */
async function approveQueuedBehindRoleLock(options: {
  tenant: Tenant;
  owner: Person;
  requestId: string;
  /** The call's own clock must be before this boundary (setup guard). */
  boundary: Date;
  releaseWhen: () => boolean;
}) {
  const holder = await pg.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('legend:role-assignment-end:' || $1::text, 0))`,
      [options.tenant.id],
    );
    const pid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    if (Date.now() >= options.boundary.getTime())
      throw new Error("setup too slow: call started after the boundary");
    let settled = false;
    const deciding = decideApprovalRequest(
      establishTenantContext({
        tenantId: options.tenant.id,
        brandId: null,
        source: "session",
      }),
      options.owner.userId,
      options.requestId,
      { decision: "approved", reason: "Pembagian sudah diverifikasi." },
      { mfaVerified: true, idempotencyKey: null },
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    void deciding.finally(() => {
      settled = true;
    });
    await waitFor(
      () => waiterOnHeldAdvisoryLock(pid),
      "the decision to queue behind the tenant role-assignment lock",
    );
    expect(settled).toBe(false);
    await waitFor(options.releaseWhen, "the clock to pass the release point");
    const releasedAt = Date.now();
    await holder.query("COMMIT");
    return { outcome: await deciding, releasedAt };
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // The API bootstrap installs this; these service calls run without the app.
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  await pg.end();
});

describe("legend-1151 sole Owner self-approval is judged with the time after the role-assignment lock", () => {
  it("a sole Owner approval that started before the deadline but waited on the tenant role-assignment lock past it is refused as expired and rolled back", async () => {
    const tenant = await newTenant();
    const alone = await newSoleOwner(tenant);
    const requestId = await submittedVersion(tenant, alone);
    const deadline = new Date(Date.now() + DEADLINE_MARGIN_MS);
    await setDeadline(tenant, requestId, deadline);
    const { chain_id: chainId } = await levelOf(tenant, requestId);

    const { outcome } = await approveQueuedBehindRoleLock({
      tenant,
      owner: alone,
      requestId,
      boundary: deadline,
      releaseWhen: () => Date.now() > deadline.getTime() + 50,
    });

    expect(outcome.ok).toBe(false);
    expect(
      outcome.ok ? undefined : outcome.error,
      "a late sole Owner approval must be refused as expired",
    ).toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED" });
    // Rolled back: no decision stored, none audited, nothing announced.
    const level = await levelOf(tenant, requestId);
    expect(["approved", "rejected"]).not.toContain(level.status);
    expect(level.decided_by).toBeNull();
    expect(level.decided_at).toBeNull();
    expect(await decidedAuditCount(tenant, requestId)).toBe(0);
    expect(await resolvedOutcomes(tenant, chainId)).toEqual([]);
  });

  it("a sole Owner approval that waited on the role-assignment lock but is still inside the deadline succeeds, and decided_at is the post-lock time", async () => {
    const tenant = await newTenant();
    const alone = await newSoleOwner(tenant);
    const requestId = await submittedVersion(tenant, alone);
    // The policy's own deadline is far away; no need to move it.
    const startedAt = Date.now();
    const { outcome, releasedAt } = await approveQueuedBehindRoleLock({
      tenant,
      owner: alone,
      requestId,
      boundary: new Date(startedAt + 60_000),
      releaseWhen: () => Date.now() >= startedAt + HOLD_MS,
    });

    expect(
      outcome.ok ? undefined : outcome.error,
      "an in-time sole Owner approval succeeds",
    ).toBeUndefined();
    expect(outcome.ok).toBe(true);
    const level = await levelOf(tenant, requestId);
    expect(level.status).toBe("approved");
    expect(level.decided_by).toBe(alone.userId);
    // The decision happened after the lock was released, so it may not
    // carry the earlier pre-lock clock.
    expect(level.decided_at!.getTime()).toBeGreaterThanOrEqual(
      releasedAt - DRIFT_TOLERANCE_MS,
    );
  });
});
