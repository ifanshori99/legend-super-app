// Share allocation versions through the approval matrix (bead legend-3sy9b,
// SH-03). Written from the brief `docs/briefs/sub-3sy9b-share-version-approval.md`,
// not from the implementation.
//
// Before the fix `decideShareAllocationVersionService` approved a pending
// version straight from the decide route: any non-requester holding
// `profit_share.distribution.approve` approved, and the tenant's
// `shareholder_version` matrix (roles, levels) was never consulted. Same class
// of bug as the distribution run (Codex 377). Now submit opens a
// `shareholder_version` chain, the inbox decides it, and the
// `approval.resolved` consumer settles the version as the last level's decider.
//
// These tests run the real Better Auth, tenant resolver, RBAC, PostgreSQL and
// RLS. Versions are created and submitted through the HTTP endpoints; the
// inbox decision is `decideApprovalRequest`, the consumer is
// `handleProfitShareApprovalResolved` (as in profit-share-recipient-version).
//
// Assumptions (the brief does not pin these down):
// - The approval object id is the version's new `id` column (uuid), and the
//   level-1 request of a chain has `id = chain_id`.
// - A chain cancelled by the module (`cancelApprovalRequest`, system actor)
//   stands in for "cancelled / expired": both emit `approval.resolved` and
//   settle the version as `cancelled` with no decider and no note.
// - The version DTO shows `decidedBy` and `decisionNote` (as the registry
//   suite reads them); a cancelled version is read from the raw response body.
// - Rejecting from the inbox sets the note `approval rejected` (brief, design 5).
// - The decide route's four-eyes and state-machine guard run before the chain
//   check, so a draft answers INVALID_TRANSITION (registry suite).
// - Expiry (T11): the settle is driven with `now` past the chain's
//   `deadline_at` through `settleShareAllocationVersionForApproval(tx, context,
//   profitEntityId, version, now)` (brief, design 5); the chain then reads
//   `expired` and the version `cancelled`, as for a cancelled chain.
// - T14: a route reject that lands after the inbox rejected, before the
//   consumer ran, answers 200 and settles the version as the chain decided
//   (rejected by the inbox approver, note `approval rejected`), not by the
//   route caller.
// - T10 (approved by chain, refused by the effective-date order, settled as
//   `rejected` with `approval refused: <code>`) is covered in
//   profit-share-registry.test.ts, which already builds that fixture.
import { randomUUID } from "node:crypto";
import express from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { Pool } from "pg";
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
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { auth } from "../lib/auth";
import { requestContext } from "../lib/request-context";
import { limitAuthBody } from "../middleware/body";
import { errorHandler, notFound } from "../middleware/error-handler";
import { tenantContext } from "../middleware/tenant";
import { createProfitShareRegistryRouter } from "../routes/profit-share-registry.routes";
import { resolveHostname } from "../services/org-resolve.service";
import { deviceTenantCredential } from "../services/platform-tenant.service";
import { setAuditWriter } from "../services/audit-writer";
import { coreAuditWriter } from "../services/core-audit-writer";
import {
  cancelApprovalRequest,
  decideApprovalRequest,
} from "../services/platform-approval.service";
import { handleProfitShareApprovalResolved } from "../services/profit-share-approval-consumers";
import { settleShareAllocationVersionForApproval } from "../services/profit-share-registry.service";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { agent, originHeader, signUp } from "./helpers";

const tenantA = cafeLegendPlatformFixtures.tenant.id;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
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
  app.use("/api/accounting", createProfitShareRegistryRouter());
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
async function giveRole(userId: string, permissions: string[]) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantA,
      `Share version approval test ${roleId.slice(0, 8)}`,
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
const SHARE_CHANGE = "profit_share.share_allocation.change";
const APPROVE = "profit_share.distribution.approve";
const DECIDE = "approval.request.decide";

const fill = (path: string, params: Record<string, string | number>) =>
  path.replace(/:(\w+)/g, (_m, name: string) =>
    encodeURIComponent(String(params[name])),
  );
const post = (who: Person, path: string, body: unknown) =>
  who.client
    .post(path)
    .set(originHeader)
    .send(body as object);
const get = (who: Person, path: string) => who.client.get(path);

const baseContext = () =>
  establishTenantContext({
    tenantId: tenantA,
    brandId: null,
    source: "session",
  });
/** What the worker hands a consumer: tenant-wide scope minted from the job. */
const workerContext = establishScopedTenantContext(
  establishTenantContext({ tenantId: tenantA, brandId: null, source: "job" }),
  { kind: "tenant" },
);

// ---- People and policy ---------------------------------------------------------

let manager: Person; // registry.manage + share_allocation.change: the requester
let directApprover: Person; // distribution.approve, no seat in the matrix
let inbox: Person; // approval.request.decide: the matrix approver
let inboxRoleId: string;
let level2: Person; // approval.request.decide, seat of level 2 only
let level2RoleId: string;
let savedPolicies: Record<string, unknown>[] = [];

/** The tenant's matrix for `shareholder_version`: one level, the inbox role. */
async function setPolicy(present: boolean) {
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'shareholder_version'`,
    [tenantA],
  );
  if (present)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'shareholder_version', NULL, $2, 1)`,
      [tenantA, inboxRoleId],
    );
}

/** Two levels, always required: inbox role at level 1, level2 role at level 2. */
async function setTwoLevelPolicy() {
  await setPolicy(false);
  for (const [roleId, level] of [
    [inboxRoleId, 1],
    [level2RoleId, 2],
  ] as const)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'shareholder_version', NULL, $2, $3)`,
      [tenantA, roleId, level],
    );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // The API bootstrap installs this; these service calls run without the app.
  setAuditWriter(coreAuditWriter);
  manager = await signedIn("Share Version Manager");
  await giveRole(manager.userId, [MANAGE, SHARE_CHANGE]);
  directApprover = await signedIn("Share Version Direct Approver");
  await giveRole(directApprover.userId, [APPROVE]);
  inbox = await signedIn("Share Version Inbox Approver");
  inboxRoleId = await giveRole(inbox.userId, [DECIDE]);
  level2 = await signedIn("Share Version Level 2 Approver");
  level2RoleId = await giveRole(level2.userId, [DECIDE]);
  const saved = await owner.query(
    `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'shareholder_version'`,
    [tenantA],
  );
  savedPolicies = saved.rows;
  await setPolicy(true);
}, 120_000);

afterAll(async () => {
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'shareholder_version'`,
    [tenantA],
  );
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'shareholder_version', $2, $3, $4)`,
      [tenantA, row.threshold_idr, row.approver_role_id, row.levels],
    );
  await owner.end();
});

// ---- Fixtures ---------------------------------------------------------------

let counter = 0;
async function newShareholder(): Promise<string> {
  counter += 1;
  const response = await post(manager, createShareholder.path, {
    name: `Pemegang ${counter} ${randomUUID().slice(0, 6)}`,
    type: "person",
    userId: null,
    npwp: null,
    payoutAccount: null,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

async function newEntity(): Promise<string> {
  const legalEntityId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [legalEntityId, tenantA, `PT Versi Porsi ${legalEntityId.slice(0, 8)}`],
  );
  const response = await post(manager, createProfitEntity.path, {
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

const versionsPath = (entityId: string) =>
  fill(listShareAllocationVersions.path, { profitEntityId: entityId });
const versionPath = (entityId: string, version: number) =>
  fill(getShareAllocationVersion.path, { profitEntityId: entityId, version });
const submitPath = (entityId: string, version: number) =>
  fill(submitShareAllocationVersion.path, {
    profitEntityId: entityId,
    version,
  });
const decisionPath = (entityId: string, version: number) =>
  fill(decideShareAllocationVersion.path, {
    profitEntityId: entityId,
    version,
  });

type Version = { entityId: string; version: number };

/** A draft 60/40 version of `entityId` (a fresh entity when omitted). */
async function draft(
  effectiveFrom = "2025-01-01",
  entityId?: string,
): Promise<Version> {
  const entity = entityId ?? (await newEntity());
  const response = await post(manager, versionsPath(entity), {
    effectiveFrom,
    allocations: [
      { shareholderId: await newShareholder(), shareBp: 6000 },
      { shareholderId: await newShareholder(), shareBp: 4000 },
    ],
    idempotencyKey: key("ver"),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return { entityId: entity, version: response.body.data.version as number };
}

const submit = (target: Version) =>
  post(manager, submitPath(target.entityId, target.version), {
    idempotencyKey: key("submit"),
  });

/** A version submitted through the endpoint: pending, with its chain open. */
async function submitted(
  effectiveFrom = "2025-01-01",
  entityId?: string,
): Promise<Version> {
  const target = await draft(effectiveFrom, entityId);
  const response = await submit(target);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.data.status).toBe("pending_approval");
  return target;
}

const decideRoute = (
  who: Person,
  target: Version,
  decision: "approve" | "reject" = "approve",
) =>
  post(who, decisionPath(target.entityId, target.version), {
    decision,
    note: decision === "reject" ? "Porsi tidak sesuai." : null,
    idempotencyKey: key("decide"),
  });

async function rowOf(target: Version) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    requested_by: string;
    decided_by: string | null;
    decided_at: Date | null;
  }>(
    `SELECT id, status, requested_by, decided_by, decided_at
       FROM share_allocation_versions
      WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = $3`,
    [tenantA, target.entityId, target.version],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** What the user reads: the version through the endpoint (raw body). */
async function shown(target: Version) {
  const read = await get(manager, versionPath(target.entityId, target.version));
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.data as {
    status: string;
    decidedBy: string | null;
    decisionNote: string | null;
  };
}

type RequestRow = {
  id: string;
  chain_id: string;
  level: number;
  status: string;
  source_module: string;
  object_type: string;
  object_id: string;
  requested_by: string;
};

/** Every approval request raised for the version, level order. */
async function requestsOf(target: Version): Promise<RequestRow[]> {
  const { id } = await rowOf(target);
  const { rows } = await owner.query<RequestRow>(
    `SELECT id, chain_id, level, status, source_module, object_type, object_id, requested_by
       FROM approval_requests
      WHERE tenant_id = $1 AND source_module = 'profit_share'
        AND object_type = 'share_allocation_version' AND object_id = $2
      ORDER BY created_at, level`,
    [tenantA, id],
  );
  return rows;
}

async function chainOf(target: Version): Promise<string> {
  const rows = await requestsOf(target);
  expect(rows, "the submit opened an approval chain").not.toHaveLength(0);
  return rows[0]!.chain_id;
}

/** The inbox decision of the open level of the version's chain. */
async function inboxDecide(
  target: Version,
  decision: "approved" | "rejected",
  approver: Person = inbox,
) {
  const open = await owner.query<{ id: string }>(
    `SELECT id FROM approval_requests
      WHERE tenant_id = $1 AND chain_id = $2 AND status = 'pending'
      ORDER BY level LIMIT 1`,
    [tenantA, await chainOf(target)],
  );
  expect(open.rows, "an open approval level").toHaveLength(1);
  await decideApprovalRequest(
    baseContext(),
    approver.userId,
    open.rows[0]!.id,
    { decision, reason: "Porsi saham sudah diverifikasi." },
    { mfaVerified: true, idempotencyKey: null },
  );
}

/** The `approval.resolved` event the outbox holds for the version's chain. */
async function resolvedEventOf(target: Version) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [tenantA, await chainOf(target)],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** The inbox decision, then the settle the outbox consumer performs. */
async function decideAndSettle(
  target: Version,
  decision: "approved" | "rejected",
) {
  await inboxDecide(target, decision);
  await handleProfitShareApprovalResolved(
    workerContext,
    await resolvedEventOf(target),
  );
}

// ---- Tests -------------------------------------------------------------------

describe("SH-03 share allocation versions are approved through the approval matrix", () => {
  it("T1 submit opens a shareholder_version chain for the version", async () => {
    const target = await submitted();
    const row = await rowOf(target);
    expect(row.status).toBe("pending_approval");

    const requests = await requestsOf(target);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      level: 1,
      status: "pending",
      source_module: "profit_share",
      object_type: "share_allocation_version",
      object_id: row.id,
      requested_by: manager.userId,
    });
    // The level-1 request names its own chain.
    expect(requests[0]!.chain_id).toBe(requests[0]!.id);
    expect((await shown(target)).status).toBe("pending_approval");
  });

  it("T2 a direct approve by a non-requester gets 409 APPROVAL_PENDING while the chain is open", async () => {
    const target = await submitted();
    const response = await decideRoute(directApprover, target);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error?.code).toBe("APPROVAL_PENDING");

    const row = await rowOf(target);
    expect(row.status).toBe("pending_approval");
    expect(row.decided_by).toBeNull();
    const approved = await owner.query(
      `SELECT 1 FROM share_allocation_versions
        WHERE tenant_id = $1 AND profit_entity_id = $2 AND status = 'approved'`,
      [tenantA, target.entityId],
    );
    expect(approved.rows).toHaveLength(0);
    // The refusal left the chain open for the inbox.
    expect((await requestsOf(target)).map((r) => r.status)).toEqual([
      "pending",
    ]);
  });

  it("T3 approving in the inbox approves the version as the inbox approver", async () => {
    const target = await submitted();
    await inboxDecide(target, "approved");
    // The decision alone does not touch the version; the consumer applies it.
    expect((await rowOf(target)).status).toBe("pending_approval");
    await handleProfitShareApprovalResolved(
      workerContext,
      await resolvedEventOf(target),
    );

    const row = await rowOf(target);
    expect(row).toMatchObject({
      status: "approved",
      decided_by: inbox.userId,
      requested_by: manager.userId,
    });
    expect(row.decided_at).not.toBeNull();
    expect(await shown(target)).toMatchObject({
      status: "approved",
      decidedBy: inbox.userId,
      decisionNote: null,
    });
    const usable = await get(
      manager,
      `${versionsPath(target.entityId)}?status=approved`,
    );
    expect(
      usable.body.data.map((entry: { version: number }) => entry.version),
    ).toEqual([target.version]);
  });

  it("T4 rejecting in the inbox rejects the version with a note, by the inbox approver", async () => {
    const target = await submitted();
    await decideAndSettle(target, "rejected");

    const row = await rowOf(target);
    expect(row.status).toBe("rejected");
    expect(row.decided_by).toBe(inbox.userId);
    const read = await shown(target);
    expect(read).toMatchObject({
      status: "rejected",
      decidedBy: inbox.userId,
    });
    expect(read.decisionNote).toBe("approval rejected");
    // A rejected version is final: a later approve is refused.
    const again = await decideRoute(directApprover, target);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error?.code).toBe("INVALID_TRANSITION");
  });

  it("T5 a cancelled chain cancels the version: no decider, no note", async () => {
    const target = await submitted();
    const chainId = await chainOf(target);
    const context = workerContext;
    await withTenant(db, context, (tx) =>
      cancelApprovalRequest(tx, context, {
        chainId,
        sourceModule: "profit_share",
        actorUserId: null,
      }),
    );
    // Not settled until the consumer runs.
    expect((await rowOf(target)).status).toBe("pending_approval");
    await handleProfitShareApprovalResolved(
      workerContext,
      await resolvedEventOf(target),
    );

    const row = await rowOf(target);
    expect(row.status).toBe("cancelled");
    expect(row.decided_by).toBeNull();
    expect(await shown(target)).toMatchObject({
      status: "cancelled",
      decidedBy: null,
      decisionNote: null,
    });
  });

  it("T6 fails closed when the matrix has no policy: 409 APPROVAL_POLICY_MISSING, version stays a draft", async () => {
    const target = await draft();
    await setPolicy(false);
    try {
      const refused = await submit(target);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error?.code).toBe("APPROVAL_POLICY_MISSING");
    } finally {
      await setPolicy(true);
    }
    expect((await rowOf(target)).status).toBe("draft");
    expect((await shown(target)).status).toBe("draft");
    expect(await requestsOf(target)).toHaveLength(0);
  });

  it("T7 rejecting from the route cancels the open chain and rejects the version", async () => {
    const target = await submitted();
    const response = await decideRoute(directApprover, target, "reject");
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    expect(await shown(target)).toMatchObject({
      status: "rejected",
      decidedBy: directApprover.userId,
      decisionNote: "Porsi tidak sesuai.",
    });
    const requests = await requestsOf(target);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((row) => row.status === "cancelled")).toBe(true);
    // The consumer's later pass over the cancelled chain changes nothing.
    await handleProfitShareApprovalResolved(
      workerContext,
      await resolvedEventOf(target),
    );
    expect(await shown(target)).toMatchObject({
      status: "rejected",
      decidedBy: directApprover.userId,
    });
  });

  it("T8 the consumer is idempotent on replay and ignores events for unknown objects", async () => {
    const target = await submitted();
    const other = await submitted();
    await inboxDecide(target, "approved");
    const event = await resolvedEventOf(target);

    await handleProfitShareApprovalResolved(workerContext, event);
    const first = await rowOf(target);
    expect(first).toMatchObject({
      status: "approved",
      decided_by: inbox.userId,
    });
    // Replays are no-ops.
    await handleProfitShareApprovalResolved(workerContext, event);
    await handleProfitShareApprovalResolved(workerContext, event);
    const replayed = await rowOf(target);
    expect(replayed.status).toBe("approved");
    expect(replayed.decided_by).toBe(inbox.userId);
    expect(replayed.decided_at).toEqual(first.decided_at);

    // An event whose chain names no profit-share object settles nothing.
    const unknown = {
      ...event,
      payload: { ...event.payload, chainId: randomUUID() },
    } as typeof event;
    await expect(
      handleProfitShareApprovalResolved(workerContext, unknown),
    ).resolves.toBeUndefined();
    // Nor does an event of another object type reach a pending version.
    await inboxDecide(other, "approved");
    const foreign = await resolvedEventOf(other);
    const wrongType = {
      ...foreign,
      payload: { ...foreign.payload, objectType: "bogus_object" },
    } as typeof foreign;
    await handleProfitShareApprovalResolved(workerContext, wrongType);
    expect((await rowOf(other)).status).toBe("pending_approval");
    await handleProfitShareApprovalResolved(workerContext, foreign);
    expect((await rowOf(other)).status).toBe("approved");
    expect((await rowOf(target)).status).toBe("approved");
  });

  it("T9 a legacy pending version with no chain opens one on decide and answers 409, twice", async () => {
    const target = await draft();
    // Legacy: pending_approval written without any approval chain.
    await owner.query(
      `UPDATE share_allocation_versions SET status = 'pending_approval'
        WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = $3`,
      [tenantA, target.entityId, target.version],
    );
    expect(await requestsOf(target)).toHaveLength(0);

    const first = await decideRoute(directApprover, target);
    expect(first.status, JSON.stringify(first.body)).toBe(409);
    expect(first.body.error?.code).toBe("APPROVAL_PENDING");
    // The chain survived the 409, opened for the version's requester.
    const requests = await requestsOf(target);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      level: 1,
      status: "pending",
      requested_by: manager.userId,
    });
    expect((await rowOf(target)).status).toBe("pending_approval");

    const second = await decideRoute(directApprover, target);
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body.error?.code).toBe("APPROVAL_PENDING");
    // Still one chain, and the inbox can now settle it.
    expect(await requestsOf(target)).toHaveLength(1);
    await decideAndSettle(target, "approved");
    expect(await shown(target)).toMatchObject({
      status: "approved",
      decidedBy: inbox.userId,
    });
  });

  it("T11 a chain past its deadline cancels the version when settled: no decider, no note", async () => {
    const target = await submitted();
    const chainId = await chainOf(target);
    const head = await owner.query<{ deadline_at: Date }>(
      "SELECT deadline_at FROM approval_requests WHERE tenant_id = $1 AND id = $2",
      [tenantA, chainId],
    );
    const afterDeadline = new Date(
      head.rows[0]!.deadline_at.getTime() + 60_000,
    );
    await withTenant(db, workerContext, (tx) =>
      settleShareAllocationVersionForApproval(
        tx,
        workerContext,
        target.entityId,
        target.version,
        afterDeadline,
      ),
    );

    const row = await rowOf(target);
    expect(row.status).toBe("cancelled");
    expect(row.decided_by).toBeNull();
    expect(await shown(target)).toMatchObject({
      status: "cancelled",
      decidedBy: null,
      decisionNote: null,
    });
    expect((await requestsOf(target)).map((r) => r.status)).toEqual([
      "expired",
    ]);
    // The expired chain refuses a late inbox decision and the version stays
    // cancelled: a cancelled version is final.
    await expect(
      decideApprovalRequest(
        baseContext(),
        inbox.userId,
        chainId,
        { decision: "approved", reason: "Terlambat." },
        { mfaVerified: true, idempotencyKey: null },
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED" });
    const late = await decideRoute(directApprover, target);
    expect(late.status, JSON.stringify(late.body)).toBe(409);
    expect(late.body.error?.code).toBe("INVALID_TRANSITION");
    expect((await rowOf(target)).status).toBe("cancelled");
  });

  it("T12 a route reject after the inbox approved is refused with INVALID_TRANSITION, then the consumer approves", async () => {
    const target = await submitted();
    await inboxDecide(target, "approved");

    const refused = await decideRoute(directApprover, target, "reject");
    expect([409, 422], JSON.stringify(refused.body)).toContain(refused.status);
    expect(refused.body.error?.code).toBe("INVALID_TRANSITION");
    // The refused reject touched neither the version nor the approved chain.
    expect((await rowOf(target)).status).toBe("pending_approval");
    expect((await requestsOf(target)).map((r) => r.status)).toEqual([
      "approved",
    ]);

    await handleProfitShareApprovalResolved(
      workerContext,
      await resolvedEventOf(target),
    );
    expect(await shown(target)).toMatchObject({
      status: "approved",
      decidedBy: inbox.userId,
      decisionNote: null,
    });
  });

  it("T13 two levels: level 1 approved keeps the version pending, level 2 approves it", async () => {
    await setTwoLevelPolicy();
    try {
      const target = await submitted();
      await inboxDecide(target, "approved", inbox);

      // Level 1 is decided, level 2 is open: nothing to settle yet.
      const midway = await requestsOf(target);
      expect(midway.map((r) => [r.level, r.status])).toEqual([
        [1, "approved"],
        [2, "pending"],
      ]);
      expect((await rowOf(target)).status).toBe("pending_approval");
      const direct = await decideRoute(directApprover, target);
      expect(direct.status, JSON.stringify(direct.body)).toBe(409);
      expect(direct.body.error?.code).toBe("APPROVAL_PENDING");
      expect((await rowOf(target)).status).toBe("pending_approval");

      await inboxDecide(target, "approved", level2);
      expect((await rowOf(target)).status).toBe("pending_approval");
      await handleProfitShareApprovalResolved(
        workerContext,
        await resolvedEventOf(target),
      );
      // The last level's decider is the version's decider.
      expect(await shown(target)).toMatchObject({
        status: "approved",
        decidedBy: level2.userId,
        decisionNote: null,
      });
    } finally {
      await setPolicy(true);
    }
  });

  it("T14 inbox reject, then a route reject before the consumer: rejected by the inbox approver, note `approval rejected`", async () => {
    const target = await submitted();
    await inboxDecide(target, "rejected");
    // The consumer has not run yet.
    expect((await rowOf(target)).status).toBe("pending_approval");

    const response = await decideRoute(directApprover, target, "reject");
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const row = await rowOf(target);
    expect(row.status).toBe("rejected");
    expect(row.decided_by).toBe(inbox.userId);
    expect(await shown(target)).toMatchObject({
      status: "rejected",
      decidedBy: inbox.userId,
      decisionNote: "approval rejected",
    });
    // The consumer's later pass changes nothing.
    await handleProfitShareApprovalResolved(
      workerContext,
      await resolvedEventOf(target),
    );
    expect(await shown(target)).toMatchObject({
      status: "rejected",
      decidedBy: inbox.userId,
      decisionNote: "approval rejected",
    });
  });

  it("T15 a forged approval.resolved of type share_allocation_version with a foreign or unknown chain changes nothing", async () => {
    const victim = await submitted();
    const victimId = (await rowOf(victim)).id;
    const template = await submitted();
    await inboxDecide(template, "approved");
    const real = await resolvedEventOf(template);
    const templateId = (await rowOf(template)).id;

    // A chain of another object type in the same module (a distribution run),
    // made by copying the victim's open head row.
    const foreignChain = randomUUID();
    await owner.query(
      `INSERT INTO approval_requests
         (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type,
          object_id, payload, requested_by, source, level, required_levels,
          required_steps, threshold_idr, amount_idr, status, request_reason,
          deadline_at, created_at, updated_at)
       SELECT $3::uuid, tenant_id, outlet_id, $3::uuid, source_module, action_type, 'distribution_run',
              $4, payload, requested_by, source, level, required_levels,
              required_steps, threshold_idr, amount_idr, status, request_reason,
              deadline_at, now(), now()
         FROM approval_requests WHERE tenant_id = $1 AND id = $2`,
      [tenantA, await chainOf(victim), foreignChain, randomUUID()],
    );

    // Every id of the template version in the payload now points at the victim.
    const forge = (chainId: string) => {
      const payload: Record<string, unknown> = { ...real.payload, chainId };
      for (const [name, value] of Object.entries(payload))
        if (value === templateId) payload[name] = victimId;
      payload.objectType = "share_allocation_version";
      return { ...real, payload } as typeof real;
    };
    await handleProfitShareApprovalResolved(workerContext, forge(foreignChain));
    await handleProfitShareApprovalResolved(workerContext, forge(randomUUID()));

    expect(await rowOf(victim)).toMatchObject({
      status: "pending_approval",
      decided_by: null,
    });
    // The template was never settled either: only forged events ran.
    expect((await rowOf(template)).status).toBe("pending_approval");
    expect((await requestsOf(victim)).map((r) => r.status)).toEqual([
      "pending",
    ]);
  });
});
