// legend-e3qgo (tier K, money path). The sole-Owner self-approval check must
// count Owners with the DATABASE clock read AFTER the per-tenant advisory lock
// (`legend:role-assignment-end:<tenant>`), not with the application clock.
// Written from the brief docs/briefs/1172-access-audit-guard.md ("Tambahan:
// legend-e3qgo") and the rule of legend-b8y6l, not from the implementation.
//
// Rule (profit-share-sole-owner-self-approval.test.ts): a tenant with exactly
// ONE Owner may approve (never reject) a `shareholder_version` request it
// submitted itself. "Owner" = a tenant-scope assignment of the role with
// template_key 'owner' that has not ended (valid_until IS NULL OR valid_until >
// now); a future-dated one counts (fail closed). With 2+ Owners the requester is
// refused: AccessError APPROVER_IS_REQUESTER, 403.
//
// Assumptions:
// - The "second Owner just granted" has valid_from = DB clock (clock_timestamp())
//   and is either open-ended or ends in the future by the DB clock. A grant
//   made now must count as an Owner whichever way the app clock is skewed.
// - The skewed app clock is derived from the DB clock (not from Node's), so
//   drift between Node and the container cannot change the outcome. Only the
//   application `Date` is faked (vi.useFakeTimers({ toFake: ["Date"] })) and only
//   while the service under test runs; sign-ups and fixtures run on real time.
// - Money safety first: app clock AHEAD must never make a still-active second
//   Owner disappear (that would loosen the self-approval). App clock BEHIND
//   must not keep an Owner that already ended by the DB clock (exactness).
// - Proof that the time is read AFTER the lock: the lock holder waits 200 ms
//   after the call parked, then inserts a second Owner whose valid_until is its
//   own clock_timestamp() (T) and commits. A time read at call start is < T (the
//   Owner counts, refused); a time read after the lock is > T (the Owner has
//   ended, the sole Owner may approve). All comparisons are made in SQL on DB
//   timestamps. The barrier is best effort and never throws without a waiter.
// - The settle (`handleProfitShareApprovalResolved`) re-checks the same rule; a
//   second Owner active by the DB clock but "ended" by an app clock running ahead
//   must still cancel the version at settle.
// - Tenants are not cleaned up: the test database is disposable.
import { randomUUID } from "node:crypto";
import express from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { Pool, type PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createProfitEntity,
  createShareholder,
  listShareAllocationVersions,
  submitShareAllocationVersion,
} from "@starter/shared/accounting";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
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
import { handleProfitShareApprovalResolved } from "../services/profit-share-approval-consumers";
import { db } from "../db";
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
const APP_CLOCK_SKEW_MS = 60_000;

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
     VALUES ($1, $2, 'Sole owner DB clock', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [id, `sole-owner-clock-${id}`, randomUUID()],
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

async function signedIn(tenant: Tenant, name: string): Promise<Person> {
  const client = agent(tenant.app);
  const email = await signUp(client, name);
  await verifySessionMfa(email);
  const session = await client.get("/api/auth/get-session");
  return { client, userId: session.body.user.id as string };
}

/** Owner assignment window in SQL, so the DB clock decides. */
type Window = { from: string; until: string | null };
const ACTIVE: Window = { from: "now() - interval '1 minute'", until: null };
/** Granted just now by the DB clock, open-ended. */
const JUST_GRANTED: Window = { from: "clock_timestamp()", until: null };
/** Granted just now, ends 30 s from now by the DB clock (still active). */
const JUST_GRANTED_ENDS_SOON: Window = {
  from: "clock_timestamp()",
  until: "clock_timestamp() + interval '30 seconds'",
};
/** Ended 30 s ago by the DB clock. */
const ENDED_30S_AGO: Window = {
  from: "clock_timestamp() - interval '10 minutes'",
  until: "clock_timestamp() - interval '30 seconds'",
};

async function assignOwner(tenant: Tenant, userId: string, window: Window) {
  await pg.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, 'tenant', ${window.from}, ${window.until ?? "NULL"}, $2)`,
    [tenant.id, userId, tenant.ownerRoleId],
  );
}

async function newOwner(tenant: Tenant, name: string, window: Window = ACTIVE) {
  const person = await signedIn(tenant, name);
  await assignOwner(tenant, person.userId, window);
  return person;
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

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // The API bootstrap installs this; these service calls run without the app.
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  vi.useRealTimers();
  setAuditWriter(null);
  await pg.end();
});

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

type Version = { entityId: string; version: number };

/** A 60/40 share version submitted by `requester`: pending, its chain open. */
async function submittedVersion(
  tenant: Tenant,
  requester: Person,
): Promise<Version> {
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
  const target = { entityId, version: created.body.data.version as number };
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
  return target;
}

async function versionRow(tenant: Tenant, target: Version) {
  const { rows } = await pg.query<{
    id: string;
    status: string;
    decided_by: string | null;
  }>(
    `SELECT id, status, decided_by FROM share_allocation_versions
      WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = $3`,
    [tenant.id, target.entityId, target.version],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
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

/**
 * Backdate the chain's requests by SQL so a decision made while the app Date is
 * faked BEHIND still has decidedAt >= createdAt (the decision's own validation,
 * not under test here). Fixtures are created on real time; only the clock the
 * service sees is skewed. The skew (60 s) is far below the 10 minutes used.
 */
async function backdateChain(tenant: Tenant, chainId: string) {
  await pg.query(
    `UPDATE approval_requests
        SET created_at = created_at - interval '10 minutes'
      WHERE tenant_id = $1 AND chain_id = $2`,
    [tenant.id, chainId],
  );
}

/** The inbox decision of a request, exactly as the inbox route performs it. */
function inboxDecide(tenant: Tenant, who: Person, requestId: string) {
  return decideApprovalRequest(
    baseContext(tenant.id),
    who.userId,
    requestId,
    { decision: "approved", reason: "Perubahan sudah diverifikasi." },
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

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settleOutcome = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/** Fake only the app `Date` to DB clock + offsetMs while `run` executes. */
async function withAppDateAtDbClock<T>(
  offsetMs: number,
  run: () => Promise<T>,
): Promise<T> {
  const { rows } = await pg.query<{ ms: number }>(
    "SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms",
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(rows[0]!.ms + offsetMs));
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

/** Poll (by iteration count, the app Date is faked) until a session waits. */
async function waitForLockWaiter(
  client: PoolClient,
  lockKey: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const { rows } = await client.query<{ waiting: boolean }>(
      `WITH k AS (SELECT hashtextextended($1, 0) AS key)
       SELECT EXISTS (
         SELECT 1 FROM pg_locks l, k
         WHERE l.locktype = 'advisory'
           AND NOT l.granted
           AND l.classid::bigint = ((k.key >> 32) & 4294967295)
           AND l.objid::bigint = (k.key & 4294967295)
       ) AS waiting`,
      [lockKey],
    );
    if (rows[0]!.waiting) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

// ---- Tests ----------------------------------------------------------------------

describe("legend-e3qgo sole-Owner self-approval counts Owners with the DB clock", () => {
  it("legend-e3qgo app clock AHEAD: a just-granted 2nd Owner that is still active by the DB clock blocks the self-approval (403)", async () => {
    const tenant = await newTenant();
    const a = await newOwner(tenant, "Ahead Block Owner A");
    const target = await submittedVersion(tenant, a);
    const requestId = await openRequestId(
      tenant,
      await chainOfVersion(tenant, target),
    );
    // Granted now (valid_from = DB clock), ends 30 s from now by the DB clock.
    // An app clock 60 s ahead would call this Owner ended and loosen the rule.
    await newOwner(tenant, "Ahead Block Owner B", JUST_GRANTED_ENDS_SOON);

    const outcome = await withAppDateAtDbClock(APP_CLOCK_SKEW_MS, () =>
      settleOutcome(inboxDecide(tenant, a, requestId)),
    );

    expect(outcome.ok, "the self-approval is refused").toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatchObject(REFUSED);
    expect(await requestStatus(tenant, requestId)).toBe("pending");
    expect((await versionRow(tenant, target)).status).toBe("pending_approval");
  }, 30_000);

  it("legend-e3qgo app clock BEHIND: a 2nd Owner that already ended by the DB clock does not count, the sole Owner still self-approves", async () => {
    const tenant = await newTenant();
    const a = await newOwner(tenant, "Behind Ended Owner A");
    await newOwner(tenant, "Behind Ended Owner B", ENDED_30S_AGO);
    const target = await submittedVersion(tenant, a);
    const chainId = await chainOfVersion(tenant, target);
    const requestId = await openRequestId(tenant, chainId);
    await backdateChain(tenant, chainId);

    // The app clock (60 s behind) still sees the ended Owner as active.
    const outcome = await withAppDateAtDbClock(-APP_CLOCK_SKEW_MS, () =>
      settleOutcome(inboxDecide(tenant, a, requestId)),
    );

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toMatchObject({
        status: "approved",
        decidedBy: a.userId,
      });
    }
    await settle(tenant, chainId);
    expect(await versionRow(tenant, target)).toMatchObject({
      status: "approved",
      decided_by: a.userId,
    });
  }, 30_000);

  it.each([
    ["BEHIND", -APP_CLOCK_SKEW_MS],
    ["AHEAD", APP_CLOCK_SKEW_MS],
  ])(
    "legend-e3qgo app clock %s: a newly granted open-ended 2nd Owner (valid_from at the DB clock) blocks the self-approval (403)",
    async (_label, skewMs) => {
      const tenant = await newTenant();
      const a = await newOwner(tenant, `New Grant Owner A ${skewMs}`);
      const target = await submittedVersion(tenant, a);
      const grantChainId = await chainOfVersion(tenant, target);
      const requestId = await openRequestId(tenant, grantChainId);
      await backdateChain(tenant, grantChainId);
      await newOwner(tenant, `New Grant Owner B ${skewMs}`, JUST_GRANTED);

      const outcome = await withAppDateAtDbClock(skewMs, () =>
        settleOutcome(inboxDecide(tenant, a, requestId)),
      );

      expect(outcome.ok, "the self-approval is refused").toBe(false);
      if (!outcome.ok) expect(outcome.error).toMatchObject(REFUSED);
      expect(await requestStatus(tenant, requestId)).toBe("pending");
      expect((await versionRow(tenant, target)).status).toBe(
        "pending_approval",
      );
    },
    30_000,
  );

  it.each([
    ["BEHIND", -APP_CLOCK_SKEW_MS],
    ["AHEAD", APP_CLOCK_SKEW_MS],
  ])(
    "legend-e3qgo app clock %s: a truly sole Owner still self-approves (the rule is neither tightened nor loosened)",
    async (_label, skewMs) => {
      const tenant = await newTenant();
      const a = await newOwner(tenant, `Alone Owner ${skewMs}`);
      const target = await submittedVersion(tenant, a);
      const chainId = await chainOfVersion(tenant, target);
      const requestId = await openRequestId(tenant, chainId);
      await backdateChain(tenant, chainId);

      const outcome = await withAppDateAtDbClock(skewMs, () =>
        settleOutcome(inboxDecide(tenant, a, requestId)),
      );

      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      await settle(tenant, chainId);
      expect(await versionRow(tenant, target)).toMatchObject({
        status: "approved",
        decided_by: a.userId,
      });
    },
    30_000,
  );

  it("legend-e3qgo app clock AHEAD at the settle: a 2nd Owner granted after the inbox decision and still active by the DB clock cancels the version", async () => {
    const tenant = await newTenant();
    const a = await newOwner(tenant, "Settle Ahead Owner A");
    const target = await submittedVersion(tenant, a);
    const chainId = await chainOfVersion(tenant, target);
    const requestId = await openRequestId(tenant, chainId);
    await inboxDecide(tenant, a, requestId);

    await newOwner(tenant, "Settle Ahead Owner B", JUST_GRANTED_ENDS_SOON);
    await withAppDateAtDbClock(APP_CLOCK_SKEW_MS, () =>
      settle(tenant, chainId),
    );

    const row = await versionRow(tenant, target);
    expect(row.status).toBe("cancelled");
    expect(row.decided_by).toBeNull();
    const { rows } = await pg.query(
      `SELECT 1 FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'share_version.approved'`,
      [tenant.id],
    );
    expect(rows, "never approved: no approval audit").toHaveLength(0);
  }, 30_000);

  it("legend-e3qgo the Owner count reads the DB clock AFTER the tenant lock, not at call start", async () => {
    const tenant = await newTenant();
    const a = await newOwner(tenant, "After Lock Owner A");
    const b = await signedIn(tenant, "After Lock Owner B"); // no Owner role yet
    const target = await submittedVersion(tenant, a);
    const chainId = await chainOfVersion(tenant, target);
    const requestId = await openRequestId(tenant, chainId);
    await backdateChain(tenant, chainId);

    const lockKey = `legend:role-assignment-end:${tenant.id}`;
    const holder = await pg.connect();
    let pending: Promise<Outcome<unknown>> | null = null;
    let sawWaiter = false;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey],
      );

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() - APP_CLOCK_SKEW_MS));
      pending = settleOutcome(inboxDecide(tenant, a, requestId));

      sawWaiter = await waitForLockWaiter(holder, lockKey);
      await new Promise((resolve) => setTimeout(resolve, 200));
      // A 2nd Owner whose assignment ends exactly now (T), on the holder's
      // clock: before T for any read taken at call start, after T for any read
      // taken once the lock is released.
      await holder.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
         VALUES ($1, $2, $3, 'tenant', clock_timestamp() - interval '1 minute',
                 date_trunc('milliseconds', clock_timestamp()), $2)`,
        [tenant.id, b.userId, tenant.ownerRoleId],
      );
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }
    let outcome: Outcome<unknown>;
    try {
      outcome = await pending!;
    } finally {
      vi.useRealTimers();
    }

    // The 2nd Owner had ended by the time the lock was released: the sole Owner
    // may approve. A read taken before the lock would count it and refuse (403).
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await requestStatus(tenant, requestId)).toBe("approved");
    // Last on purpose: on code without the lock the checks above fail first.
    expect(sawWaiter, "the self-approval waited on the tenant lock").toBe(true);
  }, 30_000);
});
