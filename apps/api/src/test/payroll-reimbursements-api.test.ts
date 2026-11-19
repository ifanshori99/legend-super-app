// Reimbursement categories and claims HTTP API (bead legend-gfcr; contract
// `@starter/shared/hris/payroll` endpoints.ts). Runs the real Express app with
// the three routers mounted by routes/index.ts:
//   /api/hris/payroll/reimbursement-categories
//   /api/hris/payroll/reimbursements
//   /api/hris/me/reimbursements
// Tenant A is the seeded Cafe Legend tenant; tenant B is a throwaway tenant
// (tenant-isolation-harness.ts).
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
  encodeCursor,
  tenantIdSchema,
  userIdSchema,
  type BusinessDate,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import * as service from "../services/payroll-reimbursements.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createOwnerPool,
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const outletId = cafeLegendPlatformFixtures.outlets[0].id;
const CATEGORIES = "/api/hris/payroll/reimbursement-categories";
const CLAIMS = "/api/hris/payroll/reimbursements";
const ME = "/api/hris/me/reimbursements";
const owner: Pool = createOwnerPool();
const createdUsers: string[] = [];
const createdRoles: { tenantId: string; id: string }[] = [];

const today = businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK);
const plusDays = (date: BusinessDate, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10) as BusinessDate;
const key = () => `reimb-api-${randomUUID()}`;
const label = randomUUID().slice(0, 8);

async function asTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function signedInClient(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

async function grantRole(
  tenantId: string,
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string } = {
    type: "tenant",
  },
) {
  const roleId = randomUUID();
  createdRoles.push({ tenantId, id: roleId });
  await asTenant(tenantId, async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `Reimb api ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenantId,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.id : null,
      ],
    );
  });
}

const createdEmployees: { tenantId: string; id: string }[] = [];
const createdReceiptObjects: string[] = [];
const createdPositions: { tenantId: string; id: string }[] = [];

async function seedPosition(tenantId: string) {
  const id = randomUUID();
  createdPositions.push({ tenantId, id });
  await asTenant(tenantId, (db) =>
    db.query(
      "INSERT INTO positions (id, tenant_id, name) VALUES ($1, $2, $3)",
      [id, tenantId, `Jabatan ${label} ${id.slice(0, 6)}`],
    ),
  );
  return id;
}

// Cash reimbursement needs a legal entity on the employee (legend-cv00j).
const fixtureEntityId = randomUUID();

async function seedEmployee(
  tenantId: string,
  home: string,
  userId: string | null,
  positionId: string | null,
) {
  const id = randomUUID();
  createdEmployees.push({ tenantId, id });
  await asTenant(tenantId, (db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              position_id, employment_type, join_date, status, legal_entity_id)
       VALUES ($1, $2, $3, $4, 'Karyawan Reimb', $5, $6, 'pkwtt', '2025-03-01', 'active', $7)`,
      [
        id,
        tenantId,
        userId,
        `RB${id.slice(0, 8).toUpperCase()}`,
        home,
        positionId,
        tenantId === tenant.id ? fixtureEntityId : null,
      ],
    ),
  );
  return id;
}

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let adminClient: Client;
let viewerClient: Client;
let approverClient: Client;
let strangerClient: Client;
let selfClient: Client;
let outletSelfClient: Client;
let selfApproverClient: Client;
let selfApproverUserId: string;
let approverUserId: string;
let selfEmployeeId: string;
let selfApproverEmployeeId: string;
let positionA: string;
let tenantB: SecondTenant;
let ctxB: ScopedTenantContext;
let approverBUserId: string;
let categoryBId: string;
let claimBId: string;
let positionBId: string;

const categoryBody = (overrides: Record<string, unknown> = {}) => ({
  name: `Transport ${label} ${randomUUID().slice(0, 6)}`,
  receiptRequired: false,
  limits: [
    { positionId: null, perClaimLimitIdr: 500_000, perMonthLimitIdr: null },
    {
      positionId: positionA,
      perClaimLimitIdr: 100_000,
      // High on purpose: these tests pile up claims for one employee; the
      // monthly cap itself is covered in payroll-reimbursements-caps.test.ts.
      perMonthLimitIdr: 100_000_000,
    },
  ],
  idempotencyKey: key(),
  ...overrides,
});

async function createCategory(overrides: Record<string, unknown> = {}) {
  const response = await adminClient
    .post(CATEGORIES)
    .set(originHeader)
    .send(categoryBody(overrides));
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string };
}

const claimBody = (categoryId: string, overrides = {}) => ({
  categoryId,
  expenseDate: today,
  amountIdr: 80_000,
  description: "Bensin kunjungan supplier",
  receiptUploadRef: null,
  payout: "cash",
  idempotencyKey: key(),
  ...overrides,
});

async function submit(
  client: Client,
  categoryId: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await client
    .post(ME)
    .set(originHeader)
    .send(claimBody(categoryId, overrides));
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string; amountIdr: number };
}

const decide = (
  client: Client,
  id: string,
  overrides: Record<string, unknown> = {},
) =>
  client
    .post(`${CLAIMS}/${id}/decision`)
    .set(originHeader)
    .send({
      action: "approve",
      approvedAmountIdr: null,
      idempotencyKey: key(),
      ...overrides,
    });

const payCash = (client: Client, id: string) =>
  client
    .post(`${CLAIMS}/${id}/pay`)
    .set(originHeader)
    .send({ idempotencyKey: key() });

let defaultCategoryId: string;

beforeAll(async () => {
  tenantB = await createSecondTenant(owner, "reimb");
  ctxB = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantB.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
  await asTenant(tenant.id, (db) =>
    db.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Fixture Reimb', false)`,
      [fixtureEntityId, tenant.id],
    ),
  );
  positionA = await seedPosition(tenant.id);
  positionBId = await seedPosition(tenantB.tenantId);

  const admin = await signedInClient("Reimb admin API");
  await grantRole(tenant.id, admin.userId, ["payroll.view", "payroll.run"]);
  adminClient = admin.client;
  const viewer = await signedInClient("Reimb viewer API");
  await grantRole(tenant.id, viewer.userId, ["payroll.view"]);
  viewerClient = viewer.client;
  const approver = await signedInClient("Reimb approver API");
  await grantRole(tenant.id, approver.userId, ["hr.reimbursement.approve"]);
  approverClient = approver.client;
  approverUserId = approver.userId;
  const stranger = await signedInClient("Reimb stranger API");
  await grantRole(tenant.id, stranger.userId, ["hr.employee.view"]);
  strangerClient = stranger.client;

  const self = await signedInClient("Reimb self API");
  await grantRole(tenant.id, self.userId, ["self.reimbursement.request"]);
  selfClient = self.client;
  selfEmployeeId = await seedEmployee(
    tenant.id,
    outletId,
    self.userId,
    positionA,
  );

  const outletSelf = await signedInClient("Reimb outlet self API");
  await grantRole(
    tenant.id,
    outletSelf.userId,
    ["self.reimbursement.request"],
    { type: "outlet", id: outletId },
  );
  outletSelfClient = outletSelf.client;
  await seedEmployee(tenant.id, outletId, outletSelf.userId, null);

  const selfApprover = await signedInClient("Reimb self approver API");
  await grantRole(tenant.id, selfApprover.userId, [
    "self.reimbursement.request",
    "hr.reimbursement.approve",
  ]);
  selfApproverClient = selfApprover.client;
  selfApproverUserId = selfApprover.userId;
  selfApproverEmployeeId = await seedEmployee(
    tenant.id,
    outletId,
    selfApprover.userId,
    null,
  );

  defaultCategoryId = (await createCategory()).id;

  // Tenant B: a category, an employee and a submitted claim.
  const approverB = await signedInClient("Reimb approver B API");
  approverBUserId = approverB.userId;
  await grantRole(tenantB.tenantId, approverB.userId, [
    "hr.reimbursement.approve",
  ]);
  const employeeB = await seedEmployee(
    tenantB.tenantId,
    tenantB.outletId,
    null,
    null,
  );
  categoryBId = randomUUID();
  claimBId = randomUUID();
  await asTenant(tenantB.tenantId, async (db) => {
    await db.query(
      `INSERT INTO reimbursement_categories (id, tenant_id, name, receipt_required, limits)
       VALUES ($1, $2, 'Kategori B', false, $3)`,
      [
        categoryBId,
        tenantB.tenantId,
        JSON.stringify([
          {
            positionId: null,
            perClaimLimitIdr: 500000,
            perMonthLimitIdr: null,
          },
        ]),
      ],
    );
    await db.query(
      `INSERT INTO reimbursements (id, tenant_id, employee_id, category_id, expense_date,
                                   amount_idr, description, payout, status)
       VALUES ($1, $2, $3, $4, '2026-01-05', 50000, 'Klaim tenant B', 'cash', 'submitted')`,
      [claimBId, tenantB.tenantId, employeeB, categoryBId],
    );
  });
});

afterAll(async () => {
  const errors: unknown[] = [];
  const step = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    for (const tenantId of [tenant.id, tenantB?.tenantId]) {
      if (!tenantId) continue;
      await step(() =>
        asTenant(tenantId, async (db) => {
          await db.query(
            "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'reimb-api-%'",
            [tenantId],
          );
          await db.query(
            "DELETE FROM reimbursements WHERE tenant_id = $1 AND employee_id = ANY($2)",
            [tenantId, createdEmployees.map((row) => row.id)],
          );
          await db.query(
            "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2)",
            [tenantId, createdReceiptObjects],
          );
          await db.query(
            "DELETE FROM reimbursement_categories WHERE tenant_id = $1 AND (name LIKE $2 OR name = 'Kategori B')",
            [tenantId, `%${label}%`],
          );
          await db.query(
            "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2)",
            [tenantId, createdEmployees.map((row) => row.id)],
          );
          await db.query(
            "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = $2",
            [tenantId, fixtureEntityId],
          );
          await db.query(
            "DELETE FROM positions WHERE tenant_id = $1 AND id = ANY($2)",
            [tenantId, createdPositions.map((row) => row.id)],
          );
          await db.query(
            "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
            [tenantId, createdUsers],
          );
          await db.query(
            "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
            [tenantId, createdRoles.map((row) => row.id)],
          );
        }),
      );
    }
    if (tenantB) await step(() => removeSecondTenant(owner, tenantB));
    await step(() =>
      owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]),
    );
  } finally {
    await step(() => owner.end());
  }
  if (errors.length > 0) throw errors[0];
}, 60_000);

describe("reimbursement categories API", () => {
  it("creates, lists (payroll.view or approver) and pages categories", async () => {
    const created = await adminClient
      .post(CATEGORIES)
      .set(originHeader)
      .send(categoryBody({ name: `Parkir ${label}`, receiptRequired: true }));
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      tenantId: tenant.id,
      name: `Parkir ${label}`,
      receiptRequired: true,
      isActive: true,
    });
    expect(created.body.data.limits).toHaveLength(2);

    for (const client of [viewerClient, approverClient, adminClient]) {
      const list = await client.get(`${CATEGORIES}?limit=100`);
      expect(list.status).toBe(200);
      expect(
        list.body.data.some(
          (row: { id: string }) => row.id === created.body.data.id,
        ),
      ).toBe(true);
    }
    const first = await viewerClient.get(`${CATEGORIES}?limit=1`);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.meta.nextCursor).toEqual(expect.any(String));
    const second = await viewerClient.get(
      `${CATEGORIES}?limit=1&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
  });

  it("[AUTH] answers 401 anonymous, 403 without the right, 403 write with payroll.view only", async () => {
    expect((await agent(app).get(CATEGORIES)).status).toBe(401);
    expect((await strangerClient.get(CATEGORIES)).status).toBe(403);
    expect(
      (
        await viewerClient
          .post(CATEGORIES)
          .set(originHeader)
          .send(categoryBody())
      ).status,
    ).toBe(403);
    expect(
      (
        await approverClient
          .post(CATEGORIES)
          .set(originHeader)
          .send(categoryBody())
      ).status,
    ).toBe(403);
    expect(
      (await adminClient.post(CATEGORIES).send(categoryBody())).status,
    ).toBe(403);
  });

  it("[TEN-02] rejects tenantId, unknown keys and bad limits with 422", async () => {
    const post = (body: object) =>
      adminClient.post(CATEGORIES).set(originHeader).send(body);
    expect(
      (await post({ ...categoryBody(), tenantId: tenant.id })).status,
    ).toBe(422);
    expect((await post({ ...categoryBody(), isActive: false })).status).toBe(
      422,
    );
    expect((await post(categoryBody({ limits: [] }))).status).toBe(422);
    expect(
      (
        await post(
          categoryBody({
            limits: [
              {
                positionId: null,
                perClaimLimitIdr: 1000,
                perMonthLimitIdr: null,
              },
              {
                positionId: null,
                perClaimLimitIdr: 2000,
                perMonthLimitIdr: null,
              },
            ],
          }),
        )
      ).status,
    ).toBe(422);
    expect(
      (await adminClient.get(`${CATEGORIES}?tenantId=${tenant.id}`)).status,
    ).toBe(422);
  });

  it("answers 422 for an unknown position and for a position of another tenant", async () => {
    for (const positionId of [randomUUID(), positionBId]) {
      const response = await adminClient
        .post(CATEGORIES)
        .set(originHeader)
        .send(
          categoryBody({
            limits: [
              { positionId, perClaimLimitIdr: 1000, perMonthLimitIdr: null },
            ],
          }),
        );
      expect(response.status).toBe(422);
    }
  });

  it("answers 409 for a duplicate name and replays the same key", async () => {
    const name = `Makan ${label}`;
    const idempotencyKey = key();
    const first = await adminClient
      .post(CATEGORIES)
      .set(originHeader)
      .send(categoryBody({ name, idempotencyKey }));
    expect(first.status).toBe(201);
    const replay = await adminClient
      .post(CATEGORIES)
      .set(originHeader)
      .send(categoryBody({ name, idempotencyKey }));
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    const duplicate = await adminClient
      .post(CATEGORIES)
      .set(originHeader)
      .send(categoryBody({ name }));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("CONFLICT");
  });

  it("[isolation] never lists a category of another tenant", async () => {
    const list = await viewerClient.get(`${CATEGORIES}?limit=100`);
    expect(
      list.body.data.some((row: { id: string }) => row.id === categoryBId),
    ).toBe(false);
    const asB = await service.listReimbursementCategories(
      ctxB,
      approverBUserId,
      {
        limit: 100,
      },
    );
    expect(asB.data.map((row) => row.id)).toEqual([categoryBId]);
  });
});

describe("my reimbursements API: submit and list", () => {
  it("submits a claim for the signed-in employee and lists only own claims", async () => {
    const claim = await submit(selfClient, defaultCategoryId);
    const stored = await selfClient.get(ME);
    expect(stored.status).toBe(200);
    const mine = stored.body.data.find(
      (row: { id: string }) => row.id === claim.id,
    );
    expect(mine).toMatchObject({
      tenantId: tenant.id,
      employeeId: selfEmployeeId,
      categoryId: defaultCategoryId,
      amountIdr: 80_000,
      approvedAmountIdr: null,
      status: "submitted",
      payout: "cash",
      receiptUrl: null,
      decidedBy: null,
      paidAt: null,
    });
    // Another employee's list never shows it (HR-01).
    const other = await selfApproverClient.get(ME);
    expect(
      other.body.data.some((row: { id: string }) => row.id === claim.id),
    ).toBe(false);
  });

  it("lets an employee with an outlet-scoped self right submit", async () => {
    const claim = await submit(outletSelfClient, defaultCategoryId);
    expect(claim.id).toEqual(expect.any(String));
    const list = await outletSelfClient.get(ME);
    expect(list.status).toBe(200);
    expect(list.body.data.map((row: { id: string }) => row.id)).toContain(
      claim.id,
    );
  });

  it("[AUTH] answers 401 anonymous and 403 without self.reimbursement.request", async () => {
    expect((await agent(app).get(ME)).status).toBe(401);
    expect((await adminClient.get(ME)).status).toBe(403);
    expect(
      (
        await adminClient
          .post(ME)
          .set(originHeader)
          .send(claimBody(defaultCategoryId))
      ).status,
    ).toBe(403);
    expect(
      (await selfClient.post(ME).send(claimBody(defaultCategoryId))).status,
    ).toBe(403);
  });

  it("answers 404 for a signed-in user without an employee row", async () => {
    const lonely = await signedInClient("Reimb no employee API");
    await grantRole(tenant.id, lonely.userId, ["self.reimbursement.request"]);
    expect((await lonely.client.get(ME)).status).toBe(404);
  });

  it("[TEN-02] rejects tenantId, employeeId and bad values with 422", async () => {
    const post = (body: object) =>
      selfClient.post(ME).set(originHeader).send(body);
    const base = claimBody(defaultCategoryId);
    expect((await post({ ...base, tenantId: tenant.id })).status).toBe(422);
    expect(
      (await post({ ...base, employeeId: selfApproverEmployeeId })).status,
    ).toBe(422);
    expect((await post({ ...base, amountIdr: 0 })).status).toBe(422);
    expect((await post({ ...base, amountIdr: 10.5 })).status).toBe(422);
    expect((await post({ ...base, payout: "bank" })).status).toBe(422);
    expect((await post({ ...base, description: "  " })).status).toBe(422);
  });

  it("answers 422 for a future expense date, a missing required receipt, an inactive category", async () => {
    const future = await selfClient
      .post(ME)
      .set(originHeader)
      .send(claimBody(defaultCategoryId, { expenseDate: plusDays(today, 2) }));
    expect(future.status).toBe(422);

    const receipt = await createCategory({
      name: `Struk ${label}`,
      receiptRequired: true,
    });
    const without = await selfClient
      .post(ME)
      .set(originHeader)
      .send(claimBody(receipt.id));
    expect(without.status).toBe(422);
    // The receipt must be a fresh `receipt` object of the home outlet.
    const receiptObjectId = randomUUID();
    createdReceiptObjects.push(receiptObjectId);
    await asTenant(tenant.id, (db) =>
      db.query(
        `INSERT INTO core_storage_objects
           (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes)
         VALUES ($1, $2, $3, 'receipt', $4, 'image/jpeg', 1024)`,
        [
          tenant.id,
          outletId,
          receiptObjectId,
          `${receiptObjectId}/original.jpg`,
        ],
      ),
    );
    const withRef = await selfClient
      .post(ME)
      .set(originHeader)
      .send(claimBody(receipt.id, { receiptUploadRef: receiptObjectId }));
    expect(withRef.status).toBe(201);
    // The upload reference is never returned (no signer is wired: URL is null).
    expect(JSON.stringify(withRef.body)).not.toContain(receiptObjectId);

    const inactive = await createCategory({ name: `Nonaktif ${label}` });
    await asTenant(tenant.id, (db) =>
      db.query(
        "UPDATE reimbursement_categories SET is_active = false WHERE id = $1",
        [inactive.id],
      ),
    );
    const off = await selfClient
      .post(ME)
      .set(originHeader)
      .send(claimBody(inactive.id));
    expect(off.status).toBe(422);
  });

  it("answers 404 for an unknown category and for a category of another tenant", async () => {
    for (const categoryId of [randomUUID(), categoryBId]) {
      const response = await selfClient
        .post(ME)
        .set(originHeader)
        .send(claimBody(categoryId));
      expect(response.status).toBe(404);
    }
  });

  it("applies the per-claim limit of the position, else the default", async () => {
    // selfClient is on positionA (100000 per claim), selfApprover has no
    // position and falls back to the default row (500000).
    const over = await selfClient
      .post(ME)
      .set(originHeader)
      .send(claimBody(defaultCategoryId, { amountIdr: 100_001 }));
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED");
    expect(
      (await submit(selfClient, defaultCategoryId, { amountIdr: 100_000 })).id,
    ).toEqual(expect.any(String));
    expect(
      (
        await submit(selfApproverClient, defaultCategoryId, {
          amountIdr: 500_000,
        })
      ).id,
    ).toEqual(expect.any(String));
    const overDefault = await selfApproverClient
      .post(ME)
      .set(originHeader)
      .send(claimBody(defaultCategoryId, { amountIdr: 500_001 }));
    expect(overDefault.status).toBe(422);
  });

  it("replays the first 201 for the same key and refuses the key with another body", async () => {
    const idempotencyKey = key();
    const first = await submit(selfClient, defaultCategoryId, {
      idempotencyKey,
    });
    const replay = await selfClient
      .post(ME)
      .set(originHeader)
      .send(claimBody(defaultCategoryId, { idempotencyKey }));
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.id);
    const other = await selfClient
      .post(ME)
      .set(originHeader)
      .send(claimBody(defaultCategoryId, { idempotencyKey, amountIdr: 1000 }));
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("reimbursements API: list and decide", () => {
  it("lists claims for approvers with status and employee filters", async () => {
    const claim = await submit(selfClient, defaultCategoryId, {
      amountIdr: 20_000,
    });
    const list = await approverClient.get(
      `${CLAIMS}?status=submitted&employeeId=${selfEmployeeId}&limit=100`,
    );
    expect(list.status).toBe(200);
    const ids = list.body.data.map((row: { id: string }) => row.id);
    expect(ids).toContain(claim.id);
    expect(
      list.body.data.every(
        (row: { employeeId: string; status: string }) =>
          row.employeeId === selfEmployeeId && row.status === "submitted",
      ),
    ).toBe(true);
    const page = await approverClient.get(`${CLAIMS}?limit=1`);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta.nextCursor).toEqual(expect.any(String));
    expect(
      (
        await approverClient.get(
          `${CLAIMS}?limit=1&cursor=${encodeURIComponent(page.body.meta.nextCursor)}`,
        )
      ).status,
    ).toBe(200);
  });

  it("[AUTH] answers 401 anonymous and 403 without hr.reimbursement.approve", async () => {
    expect((await agent(app).get(CLAIMS)).status).toBe(401);
    for (const client of [
      adminClient,
      viewerClient,
      strangerClient,
      selfClient,
    ]) {
      expect((await client.get(CLAIMS)).status).toBe(403);
    }
    const claim = await submit(selfClient, defaultCategoryId, {
      amountIdr: 11_000,
    });
    expect((await decide(adminClient, claim.id)).status).toBe(403);
    expect((await payCash(adminClient, claim.id)).status).toBe(403);
    expect(
      (
        await approverClient.post(`${CLAIMS}/${claim.id}/decision`).send({
          action: "approve",
          approvedAmountIdr: null,
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(403);
  });

  it("[TEN-02] rejects unknown keys, bad ids and bad actions with 422", async () => {
    const claim = await submit(selfClient, defaultCategoryId, {
      amountIdr: 12_000,
    });
    expect(
      (await decide(approverClient, claim.id, { tenantId: tenant.id })).status,
    ).toBe(422);
    expect(
      (await decide(approverClient, claim.id, { action: "pay" })).status,
    ).toBe(422);
    expect((await decide(approverClient, "not-a-uuid")).status).toBe(422);
    expect(
      (await decide(approverClient, claim.id, { approvedAmountIdr: 0 })).status,
    ).toBe(422);
    expect((await approverClient.get(`${CLAIMS}?status=nope`)).status).toBe(
      422,
    );
  });

  it("approves with null as the full amount and records the decider", async () => {
    const claim = await submit(selfClient, defaultCategoryId, {
      amountIdr: 60_000,
    });
    const response = await decide(approverClient, claim.id);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: claim.id,
      status: "approved",
      amountIdr: 60_000,
      approvedAmountIdr: 60_000,
      decidedBy: approverUserId,
    });
    expect(response.body.data.decidedAt).toEqual(expect.any(String));
  });

  it("lets the approver lower the amount but never raise it", async () => {
    const claim = await submit(selfClient, defaultCategoryId, {
      amountIdr: 70_000,
    });
    const raised = await decide(approverClient, claim.id, {
      approvedAmountIdr: 70_001,
    });
    expect(raised.status).toBe(422);
    const still = await approverClient.get(
      `${CLAIMS}?status=submitted&limit=100`,
    );
    expect(
      still.body.data.some((row: { id: string }) => row.id === claim.id),
    ).toBe(true);
    const lowered = await decide(approverClient, claim.id, {
      approvedAmountIdr: 45_000,
    });
    expect(lowered.status).toBe(200);
    expect(lowered.body.data).toMatchObject({
      status: "approved",
      amountIdr: 70_000,
      approvedAmountIdr: 45_000,
    });
  });

  it("rejects a claim, refuses an amount on reject, and refuses a second decision", async () => {
    const claim = await submit(selfClient, defaultCategoryId, {
      amountIdr: 30_000,
    });
    const withAmount = await decide(approverClient, claim.id, {
      action: "reject",
      approvedAmountIdr: 10_000,
    });
    expect(withAmount.status).toBe(422);
    const rejected = await decide(approverClient, claim.id, {
      action: "reject",
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data).toMatchObject({
      status: "rejected",
      approvedAmountIdr: null,
      decidedBy: approverUserId,
    });
    const again = await decide(approverClient, claim.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("PAYROLL_INVALID_TRANSITION");
  });

  it("[SoD] refuses a decider who is the claimant", async () => {
    const claim = await submit(selfApproverClient, defaultCategoryId, {
      amountIdr: 25_000,
    });
    const own = await decide(selfApproverClient, claim.id);
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe("PAYROLL_APPROVER_NOT_DISTINCT");
    expect((await decide(approverClient, claim.id)).status).toBe(200);
    expect(selfApproverUserId).not.toBe(approverUserId);
  });

  it("answers 404 for an unknown claim", async () => {
    expect((await decide(approverClient, randomUUID())).status).toBe(404);
    expect((await payCash(approverClient, randomUUID())).status).toBe(404);
  });

  it("replays a decision with the same key", async () => {
    const claim = await submit(selfClient, defaultCategoryId, {
      amountIdr: 15_000,
    });
    const idempotencyKey = key();
    const first = await decide(approverClient, claim.id, { idempotencyKey });
    const replay = await decide(approverClient, claim.id, { idempotencyKey });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
  });
});

describe("reimbursements API: pay cash", () => {
  it("pays an approved cash claim once", async () => {
    const claim = await submit(selfClient, defaultCategoryId, {
      amountIdr: 40_000,
    });
    const early = await payCash(approverClient, claim.id);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("PAYROLL_INVALID_TRANSITION");
    await decide(approverClient, claim.id, { approvedAmountIdr: 35_000 });
    const paid = await payCash(approverClient, claim.id);
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({
      status: "paid",
      approvedAmountIdr: 35_000,
      payrollRunId: null,
    });
    expect(paid.body.data.paidAt).toEqual(expect.any(String));
    const twice = await payCash(approverClient, claim.id);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("PAYROLL_INVALID_TRANSITION");
  });

  it("refuses to pay a payroll payout by hand and a rejected claim", async () => {
    const viaPayroll = await submit(selfClient, defaultCategoryId, {
      amountIdr: 22_000,
      payout: "payroll",
    });
    await decide(approverClient, viaPayroll.id);
    const refused = await payCash(approverClient, viaPayroll.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("PAYROLL_INVALID_TRANSITION");

    const rejected = await submit(selfClient, defaultCategoryId, {
      amountIdr: 21_000,
    });
    await decide(approverClient, rejected.id, { action: "reject" });
    expect((await payCash(approverClient, rejected.id)).status).toBe(409);
  });

  it("[TEN-02] rejects an unknown key in the pay body with 422", async () => {
    const response = await approverClient
      .post(`${CLAIMS}/${randomUUID()}/pay`)
      .set(originHeader)
      .send({ idempotencyKey: key(), tenantId: tenant.id });
    expect(response.status).toBe(422);
  });
});

describe("reimbursements API: tenant isolation", () => {
  it("never lists, decides or pays a claim of another tenant (404)", async () => {
    const list = await approverClient.get(`${CLAIMS}?limit=100`);
    expect(
      list.body.data.some((row: { id: string }) => row.id === claimBId),
    ).toBe(false);
    expect((await decide(approverClient, claimBId)).status).toBe(404);
    expect((await payCash(approverClient, claimBId)).status).toBe(404);
    const stored = await asTenant(tenantB.tenantId, (db) =>
      db.query("SELECT status FROM reimbursements WHERE id = $1", [claimBId]),
    );
    expect(stored.rows[0].status).toBe("submitted");
  });

  it("tenant B cannot see or decide a tenant A claim (404)", async () => {
    const claim = await submit(selfClient, defaultCategoryId, {
      amountIdr: 18_000,
    });
    const asB = await service.listReimbursements(ctxB, approverBUserId, {
      limit: 100,
    });
    expect(asB.data.map((row) => row.id)).toEqual([claimBId]);
    await expect(
      service.decideReimbursement(ctxB, approverBUserId, claim.id as never, {
        action: "approve",
        approvedAmountIdr: null,
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.payReimbursementCash(
        ctxB,
        userIdSchema.parse(approverBUserId),
        claim.id as never,
        key(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const stored = await asTenant(tenant.id, (db) =>
      db.query("SELECT status FROM reimbursements WHERE id = $1", [claim.id]),
    );
    expect(stored.rows[0].status).toBe("submitted");
  });
});

describe("reimbursements API: review fixes", () => {
  it("[SoD] refuses a payer who is the claimant", async () => {
    const claim = await submit(selfApproverClient, defaultCategoryId, {
      amountIdr: 26_000,
    });
    expect((await decide(approverClient, claim.id)).status).toBe(200);
    const own = await payCash(selfApproverClient, claim.id);
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe("PAYROLL_APPROVER_NOT_DISTINCT");
    expect((await payCash(approverClient, claim.id)).status).toBe(200);
  });

  it("refuses a resigned or terminated employee a new claim with 422", async () => {
    for (const status of ["resigned", "terminated"]) {
      const leaver = await signedInClient(`Reimb ${status} API`);
      await grantRole(tenant.id, leaver.userId, ["self.reimbursement.request"]);
      const employeeId = await seedEmployee(
        tenant.id,
        outletId,
        leaver.userId,
        null,
      );
      await asTenant(tenant.id, (db) =>
        db.query("UPDATE employees SET status = $2 WHERE id = $1", [
          employeeId,
          status,
        ]),
      );
      const response = await leaver.client
        .post(ME)
        .set(originHeader)
        .send(claimBody(defaultCategoryId));
      expect(response.status, status).toBe(422);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("answers 422, not 500, to a crafted cursor", async () => {
    for (const keys of [
      ["not-a-date", "x"],
      [today, "x"],
      ["2025-02-30", randomUUID()],
    ]) {
      const cursor = encodeURIComponent(encodeCursor(keys));
      expect(
        (await approverClient.get(`${CLAIMS}?cursor=${cursor}`)).status,
      ).toBe(422);
      expect((await selfClient.get(`${ME}?cursor=${cursor}`)).status).toBe(422);
    }
  });
});
