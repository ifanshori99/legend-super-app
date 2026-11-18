// Profit-share registry (bead legend-2ljb slice D; PRD v1.7 §3.37 "Entitas
// Bagi Hasil", "Daftar Pemegang Saham Berversi", §6 I; SH-03). Written from the
// contract (`@starter/shared/accounting` profit-share.ts + profit-share-endpoints.ts),
// not from the implementation. HTTP tests run the real Better Auth, tenant
// resolver, RBAC resolver, PostgreSQL and RLS; the registry router is mounted on
// a small express app exactly like shareholder-documents.test.ts does, so tenant
// B can be a second app instance. DB guard tests run raw SQL as the restricted
// `legend_app` role.
//
// Assumptions (the contract does not pin these down):
// - Create endpoints answer 201, command endpoints (submit/decision) 200.
// - A duplicate profit entity for the same legal entity/outlet, a duplicate
//   shareholder login, and a reference to an unknown/inactive/foreign
//   shareholder or legal entity are refused with a 4xx (404, 409 or 422);
//   the exact code is not in the contract. A 5xx is always a failure.
// - Editing a version that is no longer a draft answers 409 or 422.
// - Same idempotency key with another body answers 409 (brief; the core code is
//   IDEMPOTENCY_KEY_REUSED but only the status is asserted).
// - Another tenant's entity/version answers 404 on read, list, update, submit
//   and decision (never 403 and never an empty 200).
// - The requester in the four-eyes test holds both registry.manage and
//   distribution.approve, so APPROVER_IS_REQUESTER (not PERMISSION_DENIED) is
//   the reason for the refusal.
// - SH-03 approval matrix (legend-3sy9b): submitting a version opens a
//   `shareholder_version` chain, so the decide route answers 409
//   APPROVAL_PENDING while it is open. Approvals here go through the inbox
//   (`decideApprovalRequest`) and the `approval.resolved` consumer; the
//   decider is the inbox approver. A version the chain approves but the
//   effective-date order refuses is settled as `rejected` with a note naming
//   the code (no HTTP error, since the consumer has no caller). A decide call
//   that finds the chain already approved settles it and answers 200.
// - Profit tables allow no DELETE, so tenant B and the rows stay in the
//   disposable database; every test uses fresh legal entities and shareholders.
import { randomUUID } from "node:crypto";
import express from "express";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProfitEntity,
  createShareholder,
  decideShareAllocationVersion,
  effectiveShareAllocationVersion,
  getShareAllocationVersion,
  listProfitEntities,
  listShareAllocationVersions,
  listShareholders,
  profitEntitySchema,
  shareAllocationVersionSchema,
  shareholderSchema,
  submitShareAllocationVersion,
  updateProfitEntity,
  updateShareholder,
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
import { resolveHostname } from "../services/org-resolve.service";
import { deviceTenantCredential } from "../services/platform-tenant.service";
import { setAuditWriter } from "../services/audit-writer";
import { coreAuditWriter } from "../services/core-audit-writer";
import { decideApprovalRequest } from "../services/platform-approval.service";
import { handleProfitShareApprovalResolved } from "../services/profit-share-approval-consumers";
import { agent, originHeader, signUp } from "./helpers";
import {
  asTenant,
  createAppPool,
  createOwnerPool,
  createSecondTenant,
  requireDisposableDatabase,
  tenantAId,
  type SecondTenant,
} from "./tenant-isolation-harness";

const tenantA = tenantAId;
let tenantB: SecondTenant;
const owner: Pool = createOwnerPool();
const appPool: Pool = createAppPool();

function buildApp(tenantId: () => string): express.Express {
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
        return session
          ? { tenantId: tenantId(), brandId: null, source: "session" }
          : null;
      },
    }),
  );
  app.use("/api/accounting", createProfitShareRegistryRouter());
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

const appA = buildApp(() => tenantA);
const appB = buildApp(() => tenantB.tenantId);

type Client = ReturnType<typeof agent>;
type Person = { client: Client; userId: string; roleId?: string };

async function signedIn(app: express.Express, name: string): Promise<Person> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  return { client, userId: session.body.user.id as string };
}

async function grant(
  tenantId: string,
  userId: string,
  permissions: string[],
): Promise<string> {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantId,
      `Profit share registry test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(["tenant"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
  return roleId;
}

const MANAGE = "profit_share.registry.manage";
const APPROVE = "profit_share.distribution.approve";
const SHARE_CHANGE = "profit_share.share_allocation.change";
const DECIDE = "approval.request.decide";

async function person(
  app: express.Express,
  tenantId: string,
  name: string,
  permissions: string[],
): Promise<Person> {
  const who = await signedIn(app, name);
  if (permissions.length > 0)
    who.roleId = await grant(tenantId, who.userId, permissions);
  return who;
}

// ---- request helpers -------------------------------------------------------

const fill = (path: string, params: Record<string, string | number>) =>
  path.replace(/:(\w+)/g, (_m, key: string) =>
    encodeURIComponent(String(params[key])),
  );
const key = (label = "k") => `${label}-${randomUUID()}`;
const get = (who: Person, path: string) => who.client.get(path);
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

/**
 * A well-formed request the domain refuses: status in `statuses` and a domain
 * error code, never VALIDATION_ERROR (that would mean the body itself was bad)
 * and never a 5xx.
 */
function expectRefused(
  response: { status: number; body: { error?: { code?: string } } },
  statuses: number[],
) {
  const detail = JSON.stringify(response.body);
  expect(statuses, detail).toContain(response.status);
  expect(response.body.error?.code, detail).toBeTruthy();
  expect(response.body.error?.code, detail).not.toBe("VALIDATION_ERROR");
}

const policy = (over: Record<string, unknown> = {}) => ({
  basis: "closed_period_net_profit",
  reserveBp: 1000,
  frequency: "quarterly",
  taxWithholdingBp: 1000,
  ...over,
});

async function freshLegalEntity(tenantId: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [id, tenantId, `PT Registry ${id.slice(0, 8)}`],
  );
  return id;
}

async function newEntity(
  who: Person,
  tenantId: string = tenantA,
  over: Record<string, unknown> = {},
) {
  const legalEntityId = await freshLegalEntity(tenantId);
  const response = await post(who, createProfitEntity.path, {
    name: `Entitas ${legalEntityId.slice(0, 6)}`,
    type: "legal_entity",
    legalEntityId,
    outletId: null,
    policy: policy(),
    ...over,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return profitEntitySchema.parse(response.body.data);
}

let counter = 0;
async function newShareholder(
  who: Person,
  over: Record<string, unknown> = {},
): Promise<string> {
  counter += 1;
  const response = await post(who, createShareholder.path, {
    name: `Pemegang ${counter} ${randomUUID().slice(0, 6)}`,
    type: "person",
    userId: null,
    npwp: null,
    payoutAccount: null,
    ...over,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return shareholderSchema.parse(response.body.data).id;
}

const versionsPath = (entityId: string) =>
  fill(listShareAllocationVersions.path, { profitEntityId: entityId });
const versionPath = (entityId: string, version: number) =>
  fill(getShareAllocationVersion.path, {
    profitEntityId: entityId,
    version,
  });
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

type Alloc = { shareholderId: string; shareBp: number };

function createVersion(
  who: Person,
  entityId: string,
  allocations: Alloc[],
  effectiveFrom = "2025-01-01",
  idempotencyKey = key("ver"),
) {
  return post(who, versionsPath(entityId), {
    effectiveFrom,
    allocations,
    idempotencyKey,
  });
}

async function draftVersion(
  who: Person,
  entityId: string,
  allocations: Alloc[],
  effectiveFrom = "2025-01-01",
) {
  const response = await createVersion(
    who,
    entityId,
    allocations,
    effectiveFrom,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return shareAllocationVersionSchema.parse(response.body.data);
}

const submit = (who: Person, entityId: string, version: number, k = key()) =>
  post(who, submitPath(entityId, version), { idempotencyKey: k });
const approve = (who: Person, entityId: string, version: number, k = key()) =>
  post(who, decisionPath(entityId, version), {
    decision: "approve",
    note: null,
    idempotencyKey: k,
  });
const reject = (
  who: Person,
  entityId: string,
  version: number,
  note: string | null,
) =>
  post(who, decisionPath(entityId, version), {
    decision: "reject",
    note,
    idempotencyKey: key(),
  });

// ---- approval matrix helpers (SH-03 versions go through the inbox) --------

const tenantContextOf = (tenantId: string) =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
/** What the worker hands a consumer: tenant-wide scope minted from the job. */
const workerContextOf = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );

/** The inbox user and a reader of the tenant the version belongs to. */
const seatsOf = (tenantId: string) =>
  tenantId === tenantA
    ? { inbox: approver, reader: manager }
    : { inbox: approverB, reader: managerB };

async function chainOfVersion(
  tenantId: string,
  entityId: string,
  version: number,
): Promise<string> {
  // The test's entity/version identifies one chain, independently of DB time.
  const { rows } = await owner.query<{ chain_id: string }>(
    `SELECT r.chain_id
       FROM approval_requests r
       JOIN share_allocation_versions v
         ON v.tenant_id = r.tenant_id AND v.id::text = r.object_id
      WHERE r.tenant_id = $1 AND r.source_module = 'profit_share'
        AND r.object_type = 'share_allocation_version' AND r.level = 1
        AND v.profit_entity_id = $2 AND v.version = $3`,
    [tenantId, entityId, version],
  );
  expect(rows, "the submit opened an approval chain").toHaveLength(1);
  return rows[0]!.chain_id;
}

/** The inbox decision of the open level of `chainId`. */
async function inboxDecide(
  tenantId: string,
  chainId: string,
  decision: "approved" | "rejected",
) {
  const open = await owner.query<{ id: string }>(
    `SELECT id FROM approval_requests
      WHERE tenant_id = $1 AND chain_id = $2 AND status = 'pending'
      ORDER BY level LIMIT 1`,
    [tenantId, chainId],
  );
  await decideApprovalRequest(
    tenantContextOf(tenantId),
    seatsOf(tenantId).inbox.userId,
    open.rows[0]!.id,
    { decision, reason: "Porsi saham sudah diverifikasi." },
    { mfaVerified: true, idempotencyKey: null },
  );
}

/** The consumer applies the `approval.resolved` event of the chain. */
async function settleChain(tenantId: string, chainId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [tenantId, chainId],
  );
  expect(rows).toHaveLength(1);
  await handleProfitShareApprovalResolved(
    workerContextOf(tenantId),
    eventEnvelopeSchema.parse(rows[0]!.event),
  );
}

/** Approves a submitted version the way a user does: inbox, then consumer. */
async function approveViaInbox(
  entityId: string,
  version: number,
  tenantId: string = tenantA,
) {
  const chainId = await chainOfVersion(tenantId, entityId, version);
  await inboxDecide(tenantId, chainId, "approved");
  await settleChain(tenantId, chainId);
  const read = await get(
    seatsOf(tenantId).reader,
    versionPath(entityId, version),
  );
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return shareAllocationVersionSchema.parse(read.body.data);
}

/** Two shareholders at 60/40 (a valid 100% list). */
async function split6040(who: Person) {
  const a = await newShareholder(who);
  const b = await newShareholder(who);
  return [
    { shareholderId: a, shareBp: 6000 },
    { shareholderId: b, shareBp: 4000 },
  ];
}

let manager: Person;
let manager2: Person;
let approver: Person;
/** Holds both permissions: the four-eyes test needs a requester who could approve. */
let lead: Person;
let nobody: Person;
/** registry.manage only: may not change share percentages. */
let managerOnly: Person;
/** share_allocation.change only: may not manage entities or shareholders. */
let changerOnly: Person;
let managerB: Person;
let approverB: Person;
let savedPolicies: Record<string, unknown>[] = [];

beforeAll(async () => {
  requireDisposableDatabase();
  tenantB = await createSecondTenant(owner, "ps-registry");
  [
    manager,
    manager2,
    approver,
    lead,
    nobody,
    managerOnly,
    changerOnly,
    managerB,
    approverB,
  ] = await Promise.all([
    person(appA, tenantA, "PS Manager", [MANAGE, SHARE_CHANGE]),
    person(appA, tenantA, "PS Manager 2", [MANAGE, SHARE_CHANGE]),
    person(appA, tenantA, "PS Approver", [APPROVE, DECIDE]),
    person(appA, tenantA, "PS Lead", [MANAGE, SHARE_CHANGE, APPROVE]),
    person(appA, tenantA, "PS Nobody", []),
    person(appA, tenantA, "PS Manager Only", [MANAGE]),
    person(appA, tenantA, "PS Changer Only", [SHARE_CHANGE]),
    person(appB, tenantB.tenantId, "PS Manager B", [
      MANAGE,
      SHARE_CHANGE,
      APPROVE,
    ]),
    person(appB, tenantB.tenantId, "PS Approver B", [APPROVE, DECIDE]),
  ]);
  // The approval matrix for `shareholder_version`: one level, the approver's
  // role. Tenant A's own rows are saved and restored.
  setAuditWriter(coreAuditWriter);
  const saved = await owner.query(
    `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'shareholder_version'`,
    [tenantA],
  );
  savedPolicies = saved.rows;
  await owner.query(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'shareholder_version'`,
    [tenantA],
  );
  for (const [tenantId, who] of [
    [tenantA, approver],
    [tenantB.tenantId, approverB],
  ] as const)
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'shareholder_version', NULL, $2, 1)`,
      [tenantId, who.roleId],
    );
}, 60_000);

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
  await Promise.all([owner.end(), appPool.end()]);
});

describe("legend-2ljb registry: profit entities (§3.37 Entitas Bagi Hasil)", () => {
  it("creates a legal-entity profit entity with its policy and lists it", async () => {
    const legalEntityId = await freshLegalEntity(tenantA);
    const response = await post(manager, createProfitEntity.path, {
      name: "PT Kopi Legend",
      type: "legal_entity",
      legalEntityId,
      outletId: null,
      policy: policy({ reserveBp: 2500, frequency: "monthly" }),
    });
    expect(response.status).toBe(201);
    const created = profitEntitySchema.parse(response.body.data);
    expect(created).toMatchObject({
      name: "PT Kopi Legend",
      type: "legal_entity",
      legalEntityId,
      outletId: null,
      isActive: true,
      policy: {
        basis: "closed_period_net_profit",
        reserveBp: 2500,
        frequency: "monthly",
        taxWithholdingBp: 1000,
      },
    });

    const listed = await get(manager, listProfitEntities.path);
    expect(listed.status).toBe(200);
    const rows = listProfitEntities.response.parse(listed.body).data;
    expect(rows.find((row) => row.id === created.id)).toEqual(created);
  });

  it("creates an outlet profit entity", async () => {
    const outlet = await owner.query<{ id: string }>(
      "SELECT id FROM outlets WHERE tenant_id = $1 ORDER BY id LIMIT 1",
      [tenantA],
    );
    const outletId = outlet.rows[0]?.id;
    expect(outletId).toBeTruthy();
    const response = await post(manager, createProfitEntity.path, {
      name: "Outlet Satu",
      type: "outlet",
      legalEntityId: null,
      outletId,
      policy: policy(),
    });
    // The seeded outlet can only back one profit entity per run of the DB.
    if (response.status === 409 || response.status === 422) return;
    expect(response.status).toBe(201);
    expect(profitEntitySchema.parse(response.body.data)).toMatchObject({
      type: "outlet",
      outletId,
      legalEntityId: null,
    });
  });

  it("refuses invalid input with 422 VALIDATION_ERROR", async () => {
    const legalEntityId = await freshLegalEntity(tenantA);
    const base = {
      name: "Invalid",
      type: "legal_entity",
      legalEntityId,
      outletId: null,
      policy: policy(),
    };
    const bodies: Record<string, unknown>[] = [
      // A legal-entity profit entity must not carry an outlet.
      { ...base, outletId: randomUUID() },
      // An outlet profit entity needs its outlet and no legal entity.
      { ...base, type: "outlet" },
      { ...base, policy: policy({ reserveBp: 10_001 }) },
      { ...base, policy: policy({ taxWithholdingBp: -1 }) },
      { ...base, policy: policy({ frequency: "weekly" }) },
      { ...base, name: "   " },
      // The tenant comes from the session (TEN-02): a body tenantId is refused.
      { ...base, tenantId: tenantA },
    ];
    for (const body of bodies) {
      const response = await post(manager, createProfitEntity.path, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("refuses a second profit entity for the same legal entity and a foreign legal entity", async () => {
    const first = await newEntity(manager);
    const dup = await post(manager, createProfitEntity.path, {
      name: "Duplikat",
      type: "legal_entity",
      legalEntityId: first.legalEntityId,
      outletId: null,
      policy: policy(),
    });
    expectRefused(dup, [409, 422]);

    const foreign = await post(manager, createProfitEntity.path, {
      name: "Asing",
      type: "legal_entity",
      legalEntityId: tenantB.legalEntityId,
      outletId: null,
      policy: policy(),
    });
    expectRefused(foreign, [404, 409, 422]);
  });

  it("updates name, policy and active flag; unknown id is 404", async () => {
    const created = await newEntity(manager);
    const path = fill(updateProfitEntity.path, { profitEntityId: created.id });
    const updated = await patch(manager, path, {
      name: "Nama Baru",
      policy: policy({
        reserveBp: 500,
        frequency: "annual",
        taxWithholdingBp: 0,
      }),
      isActive: false,
    });
    expect(updated.status).toBe(200);
    expect(profitEntitySchema.parse(updated.body.data)).toMatchObject({
      id: created.id,
      name: "Nama Baru",
      isActive: false,
      policy: { reserveBp: 500, frequency: "annual", taxWithholdingBp: 0 },
    });
    const listed = listProfitEntities.response.parse(
      (await get(manager, listProfitEntities.path)).body,
    ).data;
    expect(listed.find((row) => row.id === created.id)?.name).toBe("Nama Baru");

    const bad = await patch(manager, path, {
      policy: policy({ reserveBp: 20_000 }),
    });
    expect(bad.status).toBe(422);
    const missing = await patch(
      manager,
      fill(updateProfitEntity.path, { profitEntityId: randomUUID() }),
      { name: "Hantu" },
    );
    expect(missing.status).toBe(404);
  });

  it("guards the endpoints: anonymous 401, no role 403", async () => {
    const anonymous = agent(appA);
    expect((await anonymous.get(listProfitEntities.path)).status).toBe(401);
    expect((await get(nobody, listProfitEntities.path)).status).toBe(403);
    const denied = await post(nobody, createProfitEntity.path, {
      name: "X",
      type: "legal_entity",
      legalEntityId: randomUUID(),
      outletId: null,
      policy: policy(),
    });
    expect(denied.status).toBe(403);
    // The approver may decide but does not manage the registry.
    expect((await get(approver, listProfitEntities.path)).status).toBe(403);
  });
});

describe("legend-2ljb registry: shareholders (§3.37 Daftar Pemegang Saham)", () => {
  const NPWP = "123456789012345";
  const ACCOUNT = "9876543210123";

  it("creates a shareholder and never returns the NPWP or account number", async () => {
    const response = await post(manager, createShareholder.path, {
      name: "Budi Santoso",
      type: "person",
      userId: null,
      npwp: NPWP,
      payoutAccount: {
        bank: "BCA",
        accountNumber: ACCOUNT,
        accountHolder: "Budi Santoso",
      },
    });
    expect(response.status).toBe(201);
    const created = shareholderSchema.parse(response.body.data);
    expect(created).toMatchObject({
      name: "Budi Santoso",
      type: "person",
      status: "active",
      userId: null,
      npwpMasked: "****2345",
      payoutAccount: {
        bank: "BCA",
        accountNumberMasked: "****0123",
        accountHolder: "Budi Santoso",
      },
    });
    const wire = JSON.stringify(response.body);
    expect(wire).not.toContain(NPWP);
    expect(wire).not.toContain(ACCOUNT);

    const listed = await get(manager, listShareholders.path);
    expect(listed.status).toBe(200);
    expect(
      listShareholders.response
        .parse(listed.body)
        .data.find((row) => row.id === created.id),
    ).toEqual(created);
    const listWire = JSON.stringify(listed.body);
    expect(listWire).not.toContain(NPWP);
    expect(listWire).not.toContain(ACCOUNT);

    // §6 I: encrypted at rest, only the last four digits stay readable.
    const row = await owner.query(
      "SELECT npwp_sealed, npwp_last4, payout_account_sealed, payout_account_last4 FROM shareholders WHERE tenant_id = $1 AND id = $2",
      [tenantA, created.id],
    );
    expect(row.rows[0].npwp_last4).toBe("2345");
    expect(row.rows[0].payout_account_last4).toBe("0123");
    expect(row.rows[0].npwp_sealed).not.toContain(NPWP);
    expect(row.rows[0].payout_account_sealed).not.toContain(ACCOUNT);
  });

  it("creates a company shareholder without NPWP or payout account", async () => {
    const response = await post(manager, createShareholder.path, {
      name: "PT Investor Satu",
      type: "company",
      userId: null,
      npwp: null,
      payoutAccount: null,
    });
    expect(response.status).toBe(201);
    expect(shareholderSchema.parse(response.body.data)).toMatchObject({
      type: "company",
      npwpMasked: null,
      payoutAccount: null,
    });
  });

  it("refuses invalid shareholder input with 422", async () => {
    const base = {
      name: "Valid",
      type: "person",
      userId: null,
      npwp: null,
      payoutAccount: null,
    };
    const bodies: Record<string, unknown>[] = [
      { ...base, npwp: "12345" },
      { ...base, npwp: "12345678901234a" },
      {
        ...base,
        payoutAccount: {
          bank: "BCA",
          accountNumber: "12ab",
          accountHolder: "X",
        },
      },
      { ...base, type: "trust" },
      { ...base, name: "" },
      { ...base, tenantId: tenantA },
    ];
    for (const body of bodies) {
      const response = await post(manager, createShareholder.path, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("updates name, status, NPWP and payout account; null clears", async () => {
    const id = await newShareholder(manager, {
      npwp: NPWP,
      payoutAccount: {
        bank: "BNI",
        accountNumber: ACCOUNT,
        accountHolder: "Lama",
      },
    });
    const path = fill(updateShareholder.path, { shareholderId: id });
    const updated = await patch(manager, path, {
      name: "Nama Baru",
      status: "inactive",
      npwp: "999999999999999",
      payoutAccount: {
        bank: "Mandiri",
        accountNumber: "1111222233334444",
        accountHolder: "Baru",
      },
    });
    expect(updated.status).toBe(200);
    expect(shareholderSchema.parse(updated.body.data)).toMatchObject({
      id,
      name: "Nama Baru",
      status: "inactive",
      npwpMasked: "****9999",
      payoutAccount: {
        bank: "Mandiri",
        accountNumberMasked: "****4444",
        accountHolder: "Baru",
      },
    });
    expect(JSON.stringify(updated.body)).not.toContain("999999999999999");
    expect(JSON.stringify(updated.body)).not.toContain("1111222233334444");

    const cleared = await patch(manager, path, {
      npwp: null,
      payoutAccount: null,
    });
    expect(cleared.status).toBe(200);
    expect(shareholderSchema.parse(cleared.body.data)).toMatchObject({
      npwpMasked: null,
      payoutAccount: null,
      name: "Nama Baru",
    });

    const missing = await patch(
      manager,
      fill(updateShareholder.path, { shareholderId: randomUUID() }),
      { name: "Hantu" },
    );
    expect(missing.status).toBe(404);
  });

  it("links a login to at most one shareholder row", async () => {
    const login = await signedIn(appA, "Linked Shareholder");
    await newShareholder(manager, { userId: login.userId });
    const second = await post(manager, createShareholder.path, {
      name: "Kembar",
      type: "person",
      userId: login.userId,
      npwp: null,
      payoutAccount: null,
    });
    expectRefused(second, [409, 422]);
  });

  it("guards the endpoints: no role 403, approver-only 403", async () => {
    expect((await get(nobody, listShareholders.path)).status).toBe(403);
    expect((await get(approver, listShareholders.path)).status).toBe(403);
    const denied = await post(nobody, createShareholder.path, {
      name: "X",
      type: "person",
      userId: null,
      npwp: null,
      payoutAccount: null,
    });
    expect(denied.status).toBe(403);
  });
});

describe("SH-03 versioned shares: sum, approval and effective dates", () => {
  it("creates versions numbered 1, 2 as drafts with the caller as requester", async () => {
    const entity = await newEntity(manager);
    const allocations = await split6040(manager);
    const v1 = await draftVersion(manager, entity.id, allocations);
    expect(v1).toMatchObject({
      profitEntityId: entity.id,
      version: 1,
      effectiveFrom: "2025-01-01",
      status: "draft",
      requestedBy: manager.userId,
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
    });
    expect(
      v1.allocations
        .map((row) => ({
          shareholderId: row.shareholderId,
          shareBp: row.shareBp,
        }))
        .sort((a, b) => a.shareholderId.localeCompare(b.shareholderId)),
    ).toEqual(
      [...allocations].sort((a, b) =>
        a.shareholderId.localeCompare(b.shareholderId),
      ),
    );
    const v2 = await draftVersion(
      manager,
      entity.id,
      allocations,
      "2025-06-01",
    );
    expect(v2.version).toBe(2);

    const listed = await get(manager, versionsPath(entity.id));
    expect(listed.status).toBe(200);
    expect(
      listShareAllocationVersions.response
        .parse(listed.body)
        .data.map((row) => row.version)
        .sort(),
    ).toEqual([1, 2]);
    const one = await get(manager, versionPath(entity.id, 1));
    expect(one.status).toBe(200);
    expect(getShareAllocationVersion.response.parse(one.body).data).toEqual(v1);
  });

  it("refuses submit when shares sum to 9,500 bp or 10,250 bp (SHARE_ALLOCATION_NOT_EXACT_100)", async () => {
    for (const [first, second] of [
      [5500, 4000],
      [6000, 4250],
    ] as const) {
      const entity = await newEntity(manager);
      const a = await newShareholder(manager);
      const b = await newShareholder(manager);
      const draft = await draftVersion(manager, entity.id, [
        { shareholderId: a, shareBp: first },
        { shareholderId: b, shareBp: second },
      ]);
      const refused = await submit(manager, entity.id, draft.version);
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe("SHARE_ALLOCATION_NOT_EXACT_100");
      const after = await get(manager, versionPath(entity.id, draft.version));
      expect(after.body.data.status).toBe("draft");
    }
  });

  it("submits a version that sums to exactly 10,000 bp, also after fixing a short draft", async () => {
    const entity = await newEntity(manager);
    const a = await newShareholder(manager);
    const b = await newShareholder(manager);
    const draft = await draftVersion(manager, entity.id, [
      { shareholderId: a, shareBp: 5000 },
      { shareholderId: b, shareBp: 4500 },
    ]);
    expect((await submit(manager, entity.id, 1)).status).toBe(422);

    const fixed = await patch(manager, versionPath(entity.id, draft.version), {
      allocations: [
        { shareholderId: a, shareBp: 5000 },
        { shareholderId: b, shareBp: 5000 },
      ],
    });
    expect(fixed.status).toBe(200);
    expect(
      shareAllocationVersionSchema
        .parse(fixed.body.data)
        .allocations.reduce((sum, row) => sum + row.shareBp, 0),
    ).toBe(10_000);

    const submitted = await submit(manager, entity.id, 1);
    expect(submitted.status).toBe(200);
    expect(shareAllocationVersionSchema.parse(submitted.body.data).status).toBe(
      "pending_approval",
    );
  });

  it("refuses a duplicate shareholder and an unknown, inactive or foreign shareholder", async () => {
    const entity = await newEntity(manager);
    const a = await newShareholder(manager);
    const duplicate = await createVersion(manager, entity.id, [
      { shareholderId: a, shareBp: 5000 },
      { shareholderId: a, shareBp: 5000 },
    ]);
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.error.code).toBe("SHARE_ALLOCATION_DUPLICATE");

    const unknown = await createVersion(manager, entity.id, [
      { shareholderId: randomUUID(), shareBp: 10_000 },
    ]);
    expectRefused(unknown, [404, 409, 422]);

    const inactive = await newShareholder(manager);
    expect(
      (
        await patch(
          manager,
          fill(updateShareholder.path, { shareholderId: inactive }),
          {
            status: "inactive",
          },
        )
      ).status,
    ).toBe(200);
    const withInactive = await createVersion(manager, entity.id, [
      { shareholderId: inactive, shareBp: 10_000 },
    ]);
    expectRefused(withInactive, [404, 409, 422]);

    const foreign = await newShareholder(managerB);
    const withForeign = await createVersion(manager, entity.id, [
      { shareholderId: foreign, shareBp: 10_000 },
    ]);
    expectRefused(withForeign, [404, 409, 422]);

    // Invalid bodies are refused before anything is stored.
    for (const allocations of [
      [],
      [{ shareholderId: a, shareBp: 0 }],
      [{ shareholderId: a, shareBp: 10_001 }],
    ]) {
      const response = await createVersion(manager, entity.id, allocations);
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    const none = await get(manager, versionsPath(entity.id));
    expect(none.body.data).toEqual([]);
  });

  it("refuses approval by the requester (four-eyes), approves by another user", async () => {
    const entity = await newEntity(lead);
    const allocations = await split6040(lead);
    const draft = await draftVersion(lead, entity.id, allocations);
    expect((await submit(lead, entity.id, draft.version)).status).toBe(200);

    const self = await approve(lead, entity.id, draft.version);
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("APPROVER_IS_REQUESTER");
    expect(
      (await get(lead, versionPath(entity.id, draft.version))).body.data.status,
    ).toBe("pending_approval");

    // A direct approve by a non-requester is held back by the open chain.
    const direct = await approve(approver, entity.id, draft.version);
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe("APPROVAL_PENDING");

    const approved = await approveViaInbox(entity.id, draft.version);
    expect(approved).toMatchObject({
      status: "approved",
      requestedBy: lead.userId,
      decidedBy: approver.userId,
      decisionNote: null,
    });
    expect(approved.decidedAt).not.toBeNull();
    expect(
      (await get(manager, versionPath(entity.id, draft.version))).body.data
        .status,
    ).toBe("approved");
  });

  it("limits who may submit and decide", async () => {
    const entity = await newEntity(manager);
    const draft = await draftVersion(
      manager,
      entity.id,
      await split6040(manager),
    );

    // Only the requester submits; another manager gets INVALID_TRANSITION.
    const other = await submit(manager2, entity.id, draft.version);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("INVALID_TRANSITION");
    // A draft cannot be decided.
    const early = await approve(approver, entity.id, draft.version);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("INVALID_TRANSITION");

    expect((await submit(manager, entity.id, draft.version)).status).toBe(200);
    // Deciding needs profit_share.distribution.approve; a manager alone is refused.
    const denied = await approve(manager2, entity.id, draft.version);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PERMISSION_DENIED");
    expect((await approve(nobody, entity.id, draft.version)).status).toBe(403);
    // The approver alone cannot create or submit versions.
    expect((await createVersion(approver, entity.id, [])).status).toBe(403);
    expect((await submit(approver, entity.id, draft.version)).status).toBe(403);
  });

  it("rejects with a note and a rejected version cannot be approved", async () => {
    const entity = await newEntity(manager);
    const draft = await draftVersion(
      manager,
      entity.id,
      await split6040(manager),
    );
    expect((await submit(manager, entity.id, draft.version)).status).toBe(200);

    const noNote = await reject(approver, entity.id, draft.version, null);
    expect(noNote.status).toBe(422);
    expect(noNote.body.error.code).toBe("VALIDATION_ERROR");

    const rejected = await reject(
      approver,
      entity.id,
      draft.version,
      "Porsi salah",
    );
    expect(rejected.status).toBe(200);
    expect(
      shareAllocationVersionSchema.parse(rejected.body.data),
    ).toMatchObject({
      status: "rejected",
      decidedBy: approver.userId,
      decisionNote: "Porsi salah",
    });
    const again = await approve(approver, entity.id, draft.version);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("refuses to edit a version after it was submitted or approved", async () => {
    const entity = await newEntity(manager);
    const allocations = await split6040(manager);
    const draft = await draftVersion(manager, entity.id, allocations);
    const path = versionPath(entity.id, draft.version);
    const other = await newShareholder(manager);
    const edit = {
      effectiveFrom: "2025-02-01",
      allocations: [{ shareholderId: other, shareBp: 10_000 }],
    };

    expect((await submit(manager, entity.id, draft.version)).status).toBe(200);
    const pending = await patch(manager, path, edit);
    expectRefused(pending, [409, 422]);
    expect(pending.status).not.toBe(200);

    expect((await approveViaInbox(entity.id, draft.version)).status).toBe(
      "approved",
    );
    const approved = await patch(manager, path, edit);
    expectRefused(approved, [409, 422]);

    const after = shareAllocationVersionSchema.parse(
      (await get(manager, path)).body.data,
    );
    expect(after.effectiveFrom).toBe("2025-01-01");
    expect(after.allocations.map((row) => row.shareholderId).sort()).toEqual(
      allocations.map((row) => row.shareholderId).sort(),
    );
  });

  it("requires a new version to start after the latest approved one (SHARE_VERSION_EFFECTIVE_DATE_ORDER)", async () => {
    const entity = await newEntity(manager);
    const allocations = await split6040(manager);
    const v1 = await draftVersion(
      manager,
      entity.id,
      allocations,
      "2025-03-01",
    );
    expect((await submit(manager, entity.id, v1.version)).status).toBe(200);
    expect((await approveViaInbox(entity.id, v1.version)).status).toBe(
      "approved",
    );

    for (const date of ["2025-03-01", "2025-02-28", "2024-01-01"]) {
      const refused = await createVersion(
        manager,
        entity.id,
        allocations,
        date,
      );
      expect(refused.status, date).toBe(422);
      expect(refused.body.error.code).toBe(
        "SHARE_VERSION_EFFECTIVE_DATE_ORDER",
      );
    }
    const next = await createVersion(
      manager,
      entity.id,
      allocations,
      "2025-03-02",
    );
    expect(next.status).toBe(201);
    expect(next.body.data.version).toBe(2);
    // Refused attempts stored nothing: still exactly v1 and v2.
    const listed = await get(manager, versionsPath(entity.id));
    expect(listed.body.data).toHaveLength(2);
  });

  it("re-checks the effective-date order when a version is approved", async () => {
    const entity = await newEntity(manager);
    const allocations = await split6040(manager);
    const v1 = await draftVersion(
      manager,
      entity.id,
      allocations,
      "2025-01-01",
    );
    expect((await submit(manager, entity.id, v1.version)).status).toBe(200);
    expect((await approveViaInbox(entity.id, v1.version)).status).toBe(
      "approved",
    );
    // Both are valid against the approved v1 when created ...
    const later = await draftVersion(
      manager,
      entity.id,
      allocations,
      "2025-06-01",
    );
    const earlier = await draftVersion(
      manager,
      entity.id,
      allocations,
      "2025-03-01",
    );
    expect(later.version).toBe(2);
    expect(earlier.version).toBe(3);
    expect((await submit(manager, entity.id, later.version)).status).toBe(200);
    expect((await submit(manager, entity.id, earlier.version)).status).toBe(
      200,
    );
    expect((await approveViaInbox(entity.id, later.version)).status).toBe(
      "approved",
    );
    // ... but once v2 (June) is approved, v3 (March) no longer advances: the
    // chain approved it, the settle refuses it and records why.
    const refused = await approveViaInbox(entity.id, earlier.version);
    expect(refused.status).toBe("rejected");
    expect(refused.decidedBy).toBe(approver.userId);
    expect(refused.decisionNote).toContain(
      "SHARE_VERSION_EFFECTIVE_DATE_ORDER",
    );
    // v2 stays the effective list (the list is newest version first).
    const listed = await get(manager, versionsPath(entity.id));
    expect(
      listed.body.data
        .filter((row: { status: string }) => row.status === "approved")
        .map((row: { version: number }) => row.version),
    ).toEqual([2, 1]);
  });

  it("keeps using v1 until a pending v2 is approved", async () => {
    const entity = await newEntity(manager);
    const v1Alloc = await split6040(manager);
    const v2Alloc = await split6040(manager);
    const v1 = await draftVersion(manager, entity.id, v1Alloc, "2025-01-01");
    expect((await submit(manager, entity.id, v1.version)).status).toBe(200);
    expect((await approveViaInbox(entity.id, v1.version)).status).toBe(
      "approved",
    );
    const v2 = await draftVersion(manager, entity.id, v2Alloc, "2025-04-01");
    expect((await submit(manager, entity.id, v2.version)).status).toBe(200);

    const resolve = async (asOf: string) => {
      const listed = listShareAllocationVersions.response.parse(
        (await get(manager, versionsPath(entity.id))).body,
      ).data;
      return effectiveShareAllocationVersion(listed, entity.id, asOf as never)
        ?.version;
    };
    // v2 is pending: a period ending after its effective date still uses v1.
    expect(await resolve("2025-06-30")).toBe(1);
    // Filtering by status shows only what is usable.
    const approvedOnly = await get(
      manager,
      `${versionsPath(entity.id)}?status=approved`,
    );
    expect(approvedOnly.status).toBe(200);
    expect(
      approvedOnly.body.data.map((row: { version: number }) => row.version),
    ).toEqual([1]);
    const pendingOnly = await get(
      manager,
      `${versionsPath(entity.id)}?status=pending_approval`,
    );
    expect(
      pendingOnly.body.data.map((row: { version: number }) => row.version),
    ).toEqual([2]);

    expect((await approveViaInbox(entity.id, v2.version)).status).toBe(
      "approved",
    );
    expect(await resolve("2025-03-31")).toBe(1);
    expect(await resolve("2025-06-30")).toBe(2);
  });

  it("answers 404 for an unknown entity or version, 422 for a bad status filter", async () => {
    const entity = await newEntity(manager);
    expect((await get(manager, versionPath(entity.id, 7))).status).toBe(404);
    expect((await get(manager, versionsPath(randomUUID()))).status).toBe(404);
    expect(
      (await get(manager, `${versionsPath(entity.id)}?status=bogus`)).status,
    ).toBe(422);
    expect((await get(manager, versionPath(entity.id, 0))).status).toBe(422);
  });
});

describe("SH-03 idempotency", () => {
  it("replays a version create with the same key and body, conflicts on another body", async () => {
    const entity = await newEntity(manager);
    const allocations = await split6040(manager);
    const idem = key("create");
    const first = await createVersion(
      manager,
      entity.id,
      allocations,
      "2025-01-01",
      idem,
    );
    expect(first.status).toBe(201);
    const replay = await createVersion(
      manager,
      entity.id,
      allocations,
      "2025-01-01",
      idem,
    );
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.data.version).toBe(first.body.data.version);
    expect(replay.body.data.requestedAt).toBe(first.body.data.requestedAt);

    const conflict = await createVersion(
      manager,
      entity.id,
      allocations,
      "2025-02-01",
      idem,
    );
    expect(conflict.status).toBe(409);

    const listed = await get(manager, versionsPath(entity.id));
    expect(listed.body.data).toHaveLength(1);
  });

  it("replays submit and decision with the same key without a second transition", async () => {
    const entity = await newEntity(manager);
    const draft = await draftVersion(
      manager,
      entity.id,
      await split6040(manager),
    );
    const submitKey = key("submit");
    const first = await submit(manager, entity.id, draft.version, submitKey);
    expect(first.status).toBe(200);
    const replay = await submit(manager, entity.id, draft.version, submitKey);
    expect(replay.status).toBe(200);
    expect(replay.body.data.status).toBe("pending_approval");

    // The chain approves in the inbox; the decide route then settles it.
    await inboxDecide(
      tenantA,
      await chainOfVersion(tenantA, entity.id, draft.version),
      "approved",
    );
    const decideKey = key("decide");
    const decided = await approve(
      approver,
      entity.id,
      draft.version,
      decideKey,
    );
    expect(decided.status).toBe(200);
    const decidedReplay = await approve(
      approver,
      entity.id,
      draft.version,
      decideKey,
    );
    expect(decidedReplay.status).toBe(200);
    expect(decidedReplay.body.data.status).toBe("approved");
    expect(decidedReplay.body.data.decidedAt).toBe(decided.body.data.decidedAt);

    // A new key on an approved version is a real second transition: refused.
    const second = await approve(
      approver,
      entity.id,
      draft.version,
      key("decide"),
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("INVALID_TRANSITION");
  });
});

describe("legend-2ljb registry: tenant isolation (TEN-01)", () => {
  it("tenant B cannot list, read, update, submit or decide tenant A's registry", async () => {
    const entity = await newEntity(lead);
    const allocations = await split6040(lead);
    const draft = await draftVersion(lead, entity.id, allocations);
    expect((await submit(lead, entity.id, draft.version)).status).toBe(200);
    const shareholderId = allocations[0]?.shareholderId ?? "";

    // Lists never contain tenant A rows.
    const entities = listProfitEntities.response.parse(
      (await get(managerB, listProfitEntities.path)).body,
    ).data;
    expect(entities.map((row) => row.id)).not.toContain(entity.id);
    const holders = listShareholders.response.parse(
      (await get(managerB, listShareholders.path)).body,
    ).data;
    expect(holders.map((row) => row.id)).not.toContain(shareholderId);

    // Direct access by id is a 404, as if the row did not exist.
    expect((await get(managerB, versionsPath(entity.id))).status).toBe(404);
    expect(
      (await get(managerB, versionPath(entity.id, draft.version))).status,
    ).toBe(404);
    expect(
      (
        await patch(
          managerB,
          fill(updateProfitEntity.path, { profitEntityId: entity.id }),
          {
            name: "Dibajak",
          },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await patch(managerB, fill(updateShareholder.path, { shareholderId }), {
          name: "Dibajak",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await patch(managerB, versionPath(entity.id, draft.version), {
          effectiveFrom: "2025-05-01",
        })
      ).status,
    ).toBe(404);
    expect((await createVersion(managerB, entity.id, allocations)).status).toBe(
      404,
    );
    expect((await submit(managerB, entity.id, draft.version)).status).toBe(404);
    expect((await approve(approverB, entity.id, draft.version)).status).toBe(
      404,
    );
    expect((await approve(managerB, entity.id, draft.version)).status).toBe(
      404,
    );

    // Nothing changed for tenant A.
    const stillPending = await get(lead, versionPath(entity.id, draft.version));
    expect(stillPending.body.data.status).toBe("pending_approval");
    expect(
      listProfitEntities.response
        .parse((await get(lead, listProfitEntities.path)).body)
        .data.find((row) => row.id === entity.id)?.name,
    ).toBe(entity.name);
  });

  it("tenant B works its own registry independently", async () => {
    const entity = await newEntity(managerB, tenantB.tenantId);
    const a = await newShareholder(managerB);
    const b = await newShareholder(managerB);
    const draft = await draftVersion(managerB, entity.id, [
      { shareholderId: a, shareBp: 7000 },
      { shareholderId: b, shareBp: 3000 },
    ]);
    expect((await submit(managerB, entity.id, draft.version)).status).toBe(200);
    expect(
      (await approveViaInbox(entity.id, draft.version, tenantB.tenantId))
        .status,
    ).toBe("approved");
    // Tenant A cannot see it either.
    expect((await get(manager, versionsPath(entity.id))).status).toBe(404);
  });

  it("row level security hides tenant A rows from tenant B and the reverse", async () => {
    const entity = await newEntity(manager);
    const draft = await draftVersion(
      manager,
      entity.id,
      await split6040(manager),
    );
    const tables: [string, string][] = [
      ["profit_entities", "id"],
      ["share_allocation_versions", "profit_entity_id"],
      ["share_allocations", "profit_entity_id"],
    ];
    for (const [table, column] of tables) {
      const asA = await asTenant(appPool, tenantA, (client) =>
        client.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [
          entity.id,
        ]),
      );
      expect(asA.rowCount, `${table} as tenant A`).toBeGreaterThan(0);
      const asB = await asTenant(appPool, tenantB.tenantId, (client) =>
        client.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [
          entity.id,
        ]),
      );
      expect(asB.rowCount, `${table} as tenant B`).toBe(0);
    }
    expect(draft.version).toBe(1);
  });
});

// ---- raw SQL DB guards (SH-03), as the restricted app role ----------------

/** One committed transaction as `legend_app` scoped to a tenant. */
async function committed(
  tenantId: string,
  run: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await run(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const setStatus = (
  client: PoolClient,
  entityId: string,
  version: number,
  status: string,
  decided = false,
) =>
  client.query(
    `UPDATE share_allocation_versions
        SET status = $4,
            decided_by = CASE WHEN $5::boolean THEN 'guard-test-approver' ELSE decided_by END,
            decided_at = CASE WHEN $5::boolean THEN now() ELSE decided_at END,
            updated_at = now()
      WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = $3`,
    [tenantA, entityId, version, status, decided],
  );

async function versionStatus(entityId: string, version: number) {
  const row = await owner.query<{ status: string }>(
    "SELECT status FROM share_allocation_versions WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = $3",
    [tenantA, entityId, version],
  );
  return row.rows[0]?.status;
}

async function approvedVersion(allocations?: Alloc[]) {
  const entity = await newEntity(manager);
  const list = allocations ?? (await split6040(manager));
  const draft = await draftVersion(manager, entity.id, list);
  expect((await submit(manager, entity.id, draft.version)).status).toBe(200);
  expect((await approveViaInbox(entity.id, draft.version)).status).toBe(
    "approved",
  );
  return { entityId: entity.id, version: draft.version, allocations: list };
}

describe("SH-03 database guards (raw SQL as the app role)", () => {
  it("changes to share_allocations are allowed on a draft and refused once approved", async () => {
    // Positive control: the same statements work while the version is a draft.
    const entity = await newEntity(manager);
    const draft = await draftVersion(
      manager,
      entity.id,
      await split6040(manager),
    );
    await asTenant(appPool, tenantA, async (client) => {
      const update = await client.query(
        "UPDATE share_allocations SET share_bp = share_bp WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = $3",
        [tenantA, entity.id, draft.version],
      );
      expect(update.rowCount).toBe(2);
    });

    const frozen = await approvedVersion();
    const extra = await newShareholder(manager);
    await asTenant(appPool, tenantA, async (client) => {
      await expect(
        client.query(
          "UPDATE share_allocations SET share_bp = 5000 WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = $3",
          [tenantA, frozen.entityId, frozen.version],
        ),
      ).rejects.toThrow();
    });
    await asTenant(appPool, tenantA, async (client) => {
      await expect(
        client.query(
          "DELETE FROM share_allocations WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = $3",
          [tenantA, frozen.entityId, frozen.version],
        ),
      ).rejects.toThrow();
    });
    await asTenant(appPool, tenantA, async (client) => {
      await expect(
        client.query(
          `INSERT INTO share_allocations (tenant_id, profit_entity_id, version, shareholder_id, share_bp, position)
           VALUES ($1, $2, $3, $4, 100, 9)`,
          [tenantA, frozen.entityId, frozen.version, extra],
        ),
      ).rejects.toThrow();
    });
    // Ground truth: the approved list is unchanged.
    const rows = await owner.query<{ share_bp: number }>(
      "SELECT share_bp FROM share_allocations WHERE tenant_id = $1 AND profit_entity_id = $2 AND version = $3 ORDER BY share_bp",
      [tenantA, frozen.entityId, frozen.version],
    );
    expect(rows.rows.map((row) => row.share_bp)).toEqual([4000, 6000]);
  });

  it("refuses pending_approval for shares that do not sum to 10,000 bp at commit", async () => {
    // Positive control: the identical UPDATE commits for a 10,000 bp draft.
    const good = await newEntity(manager);
    const goodDraft = await draftVersion(
      manager,
      good.id,
      await split6040(manager),
    );
    await committed(tenantA, async (client) => {
      await setStatus(client, good.id, goodDraft.version, "pending_approval");
    });
    expect(await versionStatus(good.id, goodDraft.version)).toBe(
      "pending_approval",
    );

    const short = await newEntity(manager);
    const a = await newShareholder(manager);
    const b = await newShareholder(manager);
    const shortDraft = await draftVersion(manager, short.id, [
      { shareholderId: a, shareBp: 5000 },
      { shareholderId: b, shareBp: 4000 },
    ]);
    await expect(
      committed(tenantA, async (client) => {
        await setStatus(
          client,
          short.id,
          shortDraft.version,
          "pending_approval",
        );
      }),
    ).rejects.toThrow();
    expect(await versionStatus(short.id, shortDraft.version)).toBe("draft");
  });

  it("refuses an illegal status jump (draft to approved) and moves out of final states", async () => {
    const entity = await newEntity(manager);
    const draft = await draftVersion(
      manager,
      entity.id,
      await split6040(manager),
    );
    await expect(
      committed(tenantA, async (client) => {
        await setStatus(client, entity.id, draft.version, "approved", true);
      }),
    ).rejects.toThrow();
    expect(await versionStatus(entity.id, draft.version)).toBe("draft");

    // Approved is final: no way back to draft or pending_approval, no cancel.
    const frozen = await approvedVersion();
    for (const status of ["draft", "pending_approval", "cancelled"]) {
      await expect(
        committed(tenantA, async (client) => {
          await setStatus(client, frozen.entityId, frozen.version, status);
        }),
        status,
      ).rejects.toThrow();
    }
    expect(await versionStatus(frozen.entityId, frozen.version)).toBe(
      "approved",
    );
  });

  it("never deletes a profit entity or a shareholder", async () => {
    const entity = await newEntity(manager);
    const holder = await newShareholder(manager);
    await expect(
      committed(tenantA, async (client) => {
        await client.query(
          "DELETE FROM profit_entities WHERE tenant_id = $1 AND id = $2",
          [tenantA, entity.id],
        );
      }),
    ).rejects.toThrow();
    await expect(
      committed(tenantA, async (client) => {
        await client.query(
          "DELETE FROM shareholders WHERE tenant_id = $1 AND id = $2",
          [tenantA, holder],
        );
      }),
    ).rejects.toThrow();
    const left = await owner.query(
      "SELECT (SELECT count(*) FROM profit_entities WHERE tenant_id = $1 AND id = $2)::int AS e, (SELECT count(*) FROM shareholders WHERE tenant_id = $1 AND id = $3)::int AS s",
      [tenantA, entity.id, holder],
    );
    expect(left.rows[0]).toEqual({ e: 1, s: 1 });
  });
});

describe("share percentage changes need profit_share.share_allocation.change", () => {
  it("registry.manage alone is refused on create, update and submit", async () => {
    const entity = await newEntity(manager);
    const allocations = await split6040(manager);

    const created = await createVersion(managerOnly, entity.id, allocations);
    expect(created.status, JSON.stringify(created.body)).toBe(403);

    const draft = await draftVersion(manager, entity.id, allocations);
    const path = versionPath(entity.id, draft.version);
    const edited = await patch(managerOnly, path, {
      effectiveFrom: "2025-02-01",
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(403);
    const submitted = await submit(managerOnly, entity.id, draft.version);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(403);

    // Nothing moved, and the manager may still read the draft.
    const read = await get(managerOnly, path);
    expect(read.status).toBe(200);
    expect(read.body.data.status).toBe("draft");
    expect(read.body.data.effectiveFrom).toBe("2025-01-01");
  });

  it("the new permission alone passes create, update and submit", async () => {
    const entity = await newEntity(manager);
    const allocations = await split6040(manager);
    const draft = await draftVersion(changerOnly, entity.id, allocations);
    const edited = await patch(
      changerOnly,
      versionPath(entity.id, draft.version),
      { effectiveFrom: "2025-02-01" },
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const submitted = await submit(changerOnly, entity.id, draft.version);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  });

  it("the new permission does not open entities, shareholders or reads", async () => {
    const entity = await newEntity(manager);
    expect(
      (
        await post(changerOnly, createShareholder.path, {
          name: "Tanpa izin kelola",
          type: "person",
          userId: null,
          npwp: null,
          payoutAccount: null,
        })
      ).status,
    ).toBe(403);
    expect((await get(changerOnly, versionsPath(entity.id))).status).toBe(403);
    expect((await get(changerOnly, listProfitEntities.path)).status).toBe(403);
  });

  it("deciding stays on distribution.approve, not on the new permission", async () => {
    const entity = await newEntity(manager);
    const draft = await draftVersion(
      manager,
      entity.id,
      await split6040(manager),
    );
    expect((await submit(manager, entity.id, draft.version)).status).toBe(200);
    expect((await approve(changerOnly, entity.id, draft.version)).status).toBe(
      403,
    );
    // The approver passes the permission check; only the open chain holds the
    // approval back.
    const held = await approve(approver, entity.id, draft.version);
    expect(held.status, JSON.stringify(held.body)).toBe(409);
    expect(held.body.error.code).toBe("APPROVAL_PENDING");
  });
});
