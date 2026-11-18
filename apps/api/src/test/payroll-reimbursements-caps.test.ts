// Reimbursement monthly cap + receipt ownership + receipt URL (bead legend-8399r).
// Contract:
//  - Month usage per (employee, category, calendar month of expenseDate) = sum of
//    amountIdr of `submitted` claims + approvedAmountIdr of `approved`/`paid`
//    claims. `rejected` and `cancelled` never count. A claim that would push
//    usage over perMonthLimitIdr is refused with 422
//    PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED (also under concurrency).
//  - receiptUploadRef must be the UUID of a fresh (<= 24h) `receipt`
//    core_storage_objects row of the same tenant and the employee's home
//    outlet, not used by another claim; otherwise 422 VALIDATION_ERROR.
//  - Services take an injectable HrisFileSigner (last parameter) and fill
//    `receiptUrl`; the ref itself is never exposed.
// Claim window (founder decision 9 Nov): POST /me/reimbursements accepts an
// expenseDate from today-30 to today (inclusive, business date); older or
// future dates are 422 VALIDATION_ERROR. Checked at submission only.
// Assumptions: a claim dated the 15th of the previous month is seeded by SQL
// (it may fall outside the 30-day window, so it cannot be POSTed); a signer that throws or returns null yields receiptUrl null without failing
// the call; service results may be the DTO itself or `{ data }` (handled by
// `unwrap`).
// Tenant A is the seeded Cafe Legend tenant; tenant B is a throwaway tenant.
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
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
import type { HrisFileSigner } from "../services/hris-contract.service.ts";
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
const otherOutletId = cafeLegendPlatformFixtures.outlets[1].id;
const CATEGORIES = "/api/hris/payroll/reimbursement-categories";
const CLAIMS = "/api/hris/payroll/reimbursements";
const ME = "/api/hris/me/reimbursements";
const owner: Pool = createOwnerPool();
const createdUsers: string[] = [];
const createdRoles: { tenantId: string; id: string }[] = [];
const createdStorage: { tenantId: string; id: string }[] = [];

const today = businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK);
const previousMonthDate = (() => {
  const [year, month] = today.split("-").map(Number);
  const previous = month === 1 ? [year - 1, 12] : [year, month - 1];
  return `${previous[0]}-${String(previous[1]).padStart(2, "0")}-15` as BusinessDate;
})();
const plusDays = (date: BusinessDate, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10) as BusinessDate;
const key = () => `reimb-caps-${randomUUID()}`;
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
        `Reimb caps ${roleId.slice(0, 8)}`,
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
const createdPositions: { tenantId: string; id: string }[] = [];

async function seedPosition(tenantId: string) {
  const id = randomUUID();
  createdPositions.push({ tenantId, id });
  await asTenant(tenantId, (db) =>
    db.query(
      "INSERT INTO positions (id, tenant_id, name) VALUES ($1, $2, $3)",
      [id, tenantId, `Jabatan caps ${label} ${id.slice(0, 6)}`],
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
       VALUES ($1, $2, $3, $4, 'Karyawan Caps', $5, $6, 'pkwtt', '2025-03-01', 'active', $7)`,
      [
        id,
        tenantId,
        userId,
        `RC${id.slice(0, 8).toUpperCase()}`,
        home,
        positionId,
        tenantId === tenant.id ? fixtureEntityId : null,
      ],
    ),
  );
  return id;
}

/** A core_storage_objects row; ageHours back-dates created_at. */
async function storageObject(
  tenantId: string,
  outlet: string,
  purpose: "receipt" | "document" = "receipt",
  ageHours = 0,
) {
  const id = randomUUID();
  createdStorage.push({ tenantId, id });
  await asTenant(tenantId, (db) =>
    db.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, created_at)
       VALUES ($1, $2, $3, $4, $5, 'image/jpeg', 2048, now() - make_interval(hours => $6::int))`,
      [
        tenantId,
        outlet,
        id,
        purpose,
        `caps/${label}/${id}.jpg`,
        Math.round(ageHours),
      ],
    ),
  );
  return id;
}

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
type Self = { client: Client; userId: string; employeeId: string };

async function newEmployee(name: string, positionId: string | null) {
  const self = await signedInClient(name);
  await grantRole(tenant.id, self.userId, ["self.reimbursement.request"]);
  const employeeId = await seedEmployee(
    tenant.id,
    outletId,
    self.userId,
    positionId,
  );
  return { ...self, employeeId } satisfies Self;
}

let adminClient: Client;
let approverClient: Client;
let approverUserId: string;
let positionA: string;
let tenantB: SecondTenant;
let ctxA: ScopedTenantContext;
let mainEmployee: Self;
let otherEmployee: Self;
let signerEmployee: Self;

const categoryBody = (overrides: Record<string, unknown> = {}) => ({
  name: `Caps ${label} ${randomUUID().slice(0, 6)}`,
  receiptRequired: false,
  limits: [
    { positionId: null, perClaimLimitIdr: 500_000, perMonthLimitIdr: null },
    {
      positionId: positionA,
      perClaimLimitIdr: 100_000,
      perMonthLimitIdr: 300_000,
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

/** Seeds a pending claim by SQL, bypassing the 30-day submission window. */
async function seedClaim(
  employeeId: string,
  categoryId: string,
  expenseDate: string,
  amountIdr: number,
) {
  const id = randomUUID();
  await asTenant(tenant.id, (db) =>
    db.query(
      `INSERT INTO reimbursements (id, tenant_id, employee_id, category_id, expense_date,
                                   amount_idr, description, payout, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Klaim lama', 'cash', 'submitted')`,
      [id, tenant.id, employeeId, categoryId, expenseDate, amountIdr],
    ),
  );
  return id;
}

async function countClaims(employeeId: string, categoryId: string) {
  return asTenant(tenant.id, async (db) => {
    const result = await db.query(
      "SELECT count(*)::int AS n FROM reimbursements WHERE tenant_id = $1 AND employee_id = $2 AND category_id = $3",
      [tenant.id, employeeId, categoryId],
    );
    return result.rows[0].n as number;
  });
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

/** Raw POST: callers assert the status themselves. */
const post = (
  client: Client,
  categoryId: string,
  overrides: Record<string, unknown> = {},
) => client.post(ME).set(originHeader).send(claimBody(categoryId, overrides));

async function submit(
  client: Client,
  categoryId: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await post(client, categoryId, overrides);
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

function expectLimitExceeded(response: {
  status: number;
  body: { error?: { code?: string } };
}) {
  expect(response.status, JSON.stringify(response.body)).toBe(422);
  expect(response.body.error?.code).toBe(
    "PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED",
  );
}

function expectValidationError(response: {
  status: number;
  body: { error?: { code?: string } };
}) {
  expect(response.status, JSON.stringify(response.body)).toBe(422);
  expect(response.body.error?.code).toBe("VALIDATION_ERROR");
}

/** Services may return the DTO or an envelope; accept both. */
const unwrap = (result: unknown) => {
  const envelope = result as { data?: unknown };
  return (envelope.data ?? result) as {
    id: string;
    receiptUrl: string | null;
  };
};

beforeAll(async () => {
  tenantB = await createSecondTenant(owner, "reimbcaps");
  ctxA = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.id),
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

  const admin = await signedInClient("Reimb caps admin");
  await grantRole(tenant.id, admin.userId, ["payroll.view", "payroll.run"]);
  adminClient = admin.client;
  const approver = await signedInClient("Reimb caps approver");
  await grantRole(tenant.id, approver.userId, ["hr.reimbursement.approve"]);
  approverClient = approver.client;
  approverUserId = approver.userId;

  mainEmployee = await newEmployee("Reimb caps main", positionA);
  otherEmployee = await newEmployee("Reimb caps other", positionA);
  signerEmployee = await newEmployee("Reimb caps signer", positionA);
}, 60_000);

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
            "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'reimb-caps-%'",
            [tenantId],
          );
          await db.query(
            "DELETE FROM reimbursements WHERE tenant_id = $1 AND employee_id = ANY($2)",
            [tenantId, createdEmployees.map((row) => row.id)],
          );
          await db.query(
            "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
            [
              tenantId,
              createdStorage
                .filter((row) => row.tenantId === tenantId)
                .map((row) => row.id),
            ],
          );
          await db.query(
            "DELETE FROM reimbursement_categories WHERE tenant_id = $1 AND name LIKE $2",
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

describe("reimbursement monthly cap", () => {
  it("refuses a claim over the monthly cap with 422 and shares no usage across category, employee or month", async () => {
    const category = await createCategory(); // perClaim 100k, perMonth 300k
    for (let i = 0; i < 3; i += 1) {
      await submit(mainEmployee.client, category.id, { amountIdr: 100_000 });
    }
    // 300k used: even 1_000 more is over the cap.
    expectLimitExceeded(
      await post(mainEmployee.client, category.id, { amountIdr: 1_000 }),
    );
    expectLimitExceeded(
      await post(mainEmployee.client, category.id, { amountIdr: 100_000 }),
    );

    // Another category of the same employee has its own usage.
    const another = await createCategory();
    await submit(mainEmployee.client, another.id, { amountIdr: 100_000 });
    // Another employee has their own usage on the same category.
    await submit(otherEmployee.client, category.id, { amountIdr: 100_000 });
    // A claim dated the previous month counts against that month only. It is
    // seeded by SQL: the 15th of last month can be older than the 30-day window.
    await seedClaim(
      mainEmployee.employeeId,
      category.id,
      previousMonthDate,
      100_000,
    );
    // ... and this month is still full.
    expectLimitExceeded(
      await post(mainEmployee.client, category.id, { amountIdr: 1_000 }),
    );
  });

  it("accepts a claim exactly at the monthly cap", async () => {
    const category = await createCategory();
    await submit(mainEmployee.client, category.id, { amountIdr: 100_000 });
    await submit(mainEmployee.client, category.id, { amountIdr: 100_000 });
    await submit(mainEmployee.client, category.id, { amountIdr: 99_000 });
    await submit(mainEmployee.client, category.id, { amountIdr: 1_000 });
    expectLimitExceeded(
      await post(mainEmployee.client, category.id, { amountIdr: 1_000 }),
    );
  });

  it("frees the amount of a rejected claim", async () => {
    const category = await createCategory();
    const first = await submit(mainEmployee.client, category.id, {
      amountIdr: 100_000,
    });
    await submit(mainEmployee.client, category.id, { amountIdr: 100_000 });
    await submit(mainEmployee.client, category.id, { amountIdr: 100_000 });
    expectLimitExceeded(
      await post(mainEmployee.client, category.id, { amountIdr: 100_000 }),
    );
    const rejected = await decide(approverClient, first.id, {
      action: "reject",
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    await submit(mainEmployee.client, category.id, { amountIdr: 100_000 });
    expectLimitExceeded(
      await post(mainEmployee.client, category.id, { amountIdr: 1_000 }),
    );
  });

  it("counts an approved claim at its approved amount", async () => {
    const category = await createCategory();
    const first = await submit(mainEmployee.client, category.id, {
      amountIdr: 100_000,
    });
    await submit(mainEmployee.client, category.id, { amountIdr: 100_000 });
    await submit(mainEmployee.client, category.id, { amountIdr: 100_000 });
    const approved = await decide(approverClient, first.id, {
      approvedAmountIdr: 40_000,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    // Usage is now 40k + 100k + 100k = 240k, so 60k fits exactly.
    await submit(mainEmployee.client, category.id, { amountIdr: 60_000 });
    expectLimitExceeded(
      await post(mainEmployee.client, category.id, { amountIdr: 1_000 }),
    );
  });

  it("re-checks the month at approval when the category cap was lowered after the claims were submitted", async () => {
    const category = await createCategory({
      limits: [
        {
          positionId: positionA,
          perClaimLimitIdr: 100_000,
          perMonthLimitIdr: 1_000_000,
        },
      ],
    });
    const first = await submit(mainEmployee.client, category.id, {
      amountIdr: 90_000,
    });
    const second = await submit(mainEmployee.client, category.id, {
      amountIdr: 90_000,
    });
    await asTenant(tenant.id, (db) =>
      db.query(
        `UPDATE reimbursement_categories
            SET limits = jsonb_set(limits, '{0,perMonthLimitIdr}', '100000')
          WHERE id = $1`,
        [category.id],
      ),
    );
    const ok = await decide(approverClient, first.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // 90k already approved + 90k > 100k: refused, and the claim stays open.
    expectLimitExceeded(await decide(approverClient, second.id));
    // A lower approved amount that fits is accepted.
    const lowered = await decide(approverClient, second.id, {
      approvedAmountIdr: 10_000,
    });
    expect(lowered.status, JSON.stringify(lowered.body)).toBe(200);
  });

  it("lets exactly one of three parallel claims through when only one fits", async () => {
    const category = await createCategory({
      limits: [
        {
          positionId: positionA,
          perClaimLimitIdr: 100_000,
          perMonthLimitIdr: 150_000,
        },
      ],
    });
    const responses = await Promise.all(
      [0, 1, 2].map(() =>
        post(mainEmployee.client, category.id, { amountIdr: 80_000 }),
      ),
    );
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses, JSON.stringify(responses.map((r) => r.body))).toEqual([
      201, 422, 422,
    ]);
    for (const response of responses.filter((r) => r.status === 422)) {
      expectLimitExceeded(response);
    }
  });
});

describe("reimbursement claim window", () => {
  it("[reimb-window-boundary] accepts today-30 and today, refuses today-31 with 422 and stores nothing", async () => {
    const category = await createCategory();
    const edge = await post(mainEmployee.client, category.id, {
      expenseDate: plusDays(today, -30),
      amountIdr: 10_000,
    });
    expect(edge.status, JSON.stringify(edge.body)).toBe(201);
    const now = await post(mainEmployee.client, category.id, {
      expenseDate: today,
      amountIdr: 10_000,
    });
    expect(now.status, JSON.stringify(now.body)).toBe(201);
    expect(await countClaims(mainEmployee.employeeId, category.id)).toBe(2);

    const tooOld = await post(mainEmployee.client, category.id, {
      expenseDate: plusDays(today, -31),
      amountIdr: 10_000,
    });
    expectValidationError(tooOld);
    expect(await countClaims(mainEmployee.employeeId, category.id)).toBe(2);
  });

  it("[reimb-window-future] still refuses a future expense date with 422", async () => {
    const category = await createCategory();
    expectValidationError(
      await post(mainEmployee.client, category.id, {
        expenseDate: plusDays(today, 1),
        amountIdr: 10_000,
      }),
    );
    expect(await countClaims(mainEmployee.employeeId, category.id)).toBe(0);
  });

  it("[reimb-window-receipt] a too-old claim does not consume its receipt", async () => {
    const category = await createCategory();
    const ref = await storageObject(tenant.id, outletId);
    expectValidationError(
      await post(mainEmployee.client, category.id, {
        expenseDate: plusDays(today, -31),
        receiptUploadRef: ref,
        amountIdr: 10_000,
      }),
    );
    // The same receipt is still free for a claim inside the window.
    const retry = await post(mainEmployee.client, category.id, {
      expenseDate: today,
      receiptUploadRef: ref,
      amountIdr: 10_000,
    });
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
  });

  it("[reimb-window-old-claim] approval and cash payment of an old claim are not re-checked", async () => {
    const category = await createCategory();
    const id = await seedClaim(
      mainEmployee.employeeId,
      category.id,
      plusDays(today, -60),
      50_000,
    );
    const approved = await decide(approverClient, id);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe("approved");
    const paid = await approverClient
      .post(`${CLAIMS}/${id}/pay`)
      .set(originHeader)
      .send({ idempotencyKey: key() });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.data.status).toBe("paid");
  });

  it("[reimb-window-replay] replaying the same idempotency key returns the original claim", async () => {
    const category = await createCategory();
    const idempotencyKey = key();
    const body = {
      expenseDate: plusDays(today, -30),
      amountIdr: 10_000,
      idempotencyKey,
    };
    const first = await post(mainEmployee.client, category.id, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await post(mainEmployee.client, category.id, body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await countClaims(mainEmployee.employeeId, category.id)).toBe(1);
  });

  it("[reimb-window-parallel] four parallel submissions, two too old: exactly two 201 and two 422", async () => {
    const category = await createCategory();
    const dates = [
      plusDays(today, -31),
      plusDays(today, -40),
      plusDays(today, -30),
      today,
    ];
    const refs = await Promise.all(
      dates.map(() => storageObject(tenant.id, outletId)),
    );
    const responses = await Promise.all(
      dates.map((expenseDate, index) =>
        post(mainEmployee.client, category.id, {
          expenseDate,
          receiptUploadRef: refs[index],
          amountIdr: 10_000,
        }),
      ),
    );
    const detail = JSON.stringify(responses.map((r) => r.body));
    expect(
      responses.map((r) => r.status),
      detail,
    ).toEqual([422, 422, 201, 201]);
    for (const response of responses.slice(0, 2)) {
      expectValidationError(response);
    }
    expect(await countClaims(mainEmployee.employeeId, category.id)).toBe(2);
  });
});

describe("reimbursement receipt ownership", () => {
  const withReceipt = (receiptRequired = false) =>
    createCategory({ receiptRequired });

  it("accepts a fresh receipt object of the employee's own outlet", async () => {
    const category = await withReceipt(true);
    const ref = await storageObject(tenant.id, outletId);
    const response = await post(mainEmployee.client, category.id, {
      receiptUploadRef: ref,
      amountIdr: 10_000,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it("answers 422 VALIDATION_ERROR for refs that are not a valid receipt", async () => {
    const category = await withReceipt();
    const foreignTenant = await storageObject(
      tenantB.tenantId,
      tenantB.outletId,
    );
    const document = await storageObject(tenant.id, outletId, "document");
    const old = await storageObject(tenant.id, outletId, "receipt", 48);
    const otherOutlet = await storageObject(tenant.id, otherOutletId);
    const cases: [string, string][] = [
      ["non-UUID", "uploads/struk-1"],
      ["unknown UUID", randomUUID()],
      ["object of another tenant", foreignTenant],
      ["purpose document", document],
      ["object older than 24h", old],
      ["object of another outlet", otherOutlet],
    ];
    for (const [name, ref] of cases) {
      const response = await post(mainEmployee.client, category.id, {
        receiptUploadRef: ref,
        amountIdr: 10_000,
      });
      expect(response.status, `${name}: ${JSON.stringify(response.body)}`).toBe(
        422,
      );
      expectValidationError(response);
    }
  });

  it("refuses a receipt already used by another claim", async () => {
    const category = await withReceipt();
    const ref = await storageObject(tenant.id, outletId);
    await submit(mainEmployee.client, category.id, {
      receiptUploadRef: ref,
      amountIdr: 10_000,
    });
    expectValidationError(
      await post(otherEmployee.client, category.id, {
        receiptUploadRef: ref,
        amountIdr: 10_000,
      }),
    );
    expectValidationError(
      await post(mainEmployee.client, category.id, {
        receiptUploadRef: ref,
        amountIdr: 10_000,
      }),
    );
  });

  it("lets exactly one of two parallel claims use the same fresh receipt", async () => {
    const category = await withReceipt();
    const ref = await storageObject(tenant.id, outletId);
    const responses = await Promise.all(
      [0, 1].map(() =>
        post(mainEmployee.client, category.id, {
          receiptUploadRef: ref,
          amountIdr: 10_000,
        }),
      ),
    );
    expect(
      responses.map((response) => response.status).sort(),
      JSON.stringify(responses.map((r) => r.body)),
    ).toEqual([201, 422]);
  });

  it("keeps a null receipt valid unless the category requires one", async () => {
    const optional = await withReceipt(false);
    const none = await post(mainEmployee.client, optional.id, {
      receiptUploadRef: null,
      amountIdr: 10_000,
    });
    expect(none.status, JSON.stringify(none.body)).toBe(201);

    const required = await withReceipt(true);
    const missing = await post(mainEmployee.client, required.id, {
      receiptUploadRef: null,
      amountIdr: 10_000,
    });
    expect(missing.status, JSON.stringify(missing.body)).toBe(422);
  });
});

describe("reimbursement receipt URL", () => {
  const signedUrl = (id: string) => `https://files.test/receipts/${id}?sig=abc`;

  it("fills receiptUrl from the signer on list-mine, list-all and create, and leaves claims without a receipt null", async () => {
    const category = await createCategory();
    const ref = await storageObject(tenant.id, outletId);
    const withRef = await submit(signerEmployee.client, category.id, {
      receiptUploadRef: ref,
      amountIdr: 10_000,
    });
    const without = await submit(signerEmployee.client, category.id, {
      amountIdr: 11_000,
    });
    const signer = vi.fn<HrisFileSigner>(async (_ctx, id) => signedUrl(id));

    const mine = await service.listMyReimbursements(
      ctxA,
      userIdSchema.parse(signerEmployee.userId),
      { limit: 100 },
      signer,
    );
    const rows = mine.data as { id: string; receiptUrl: string | null }[];
    expect(rows.find((row) => row.id === withRef.id)?.receiptUrl).toBe(
      signedUrl(ref),
    );
    expect(rows.find((row) => row.id === without.id)?.receiptUrl).toBeNull();
    expect(signer).toHaveBeenCalledWith(expect.anything(), ref);
    // Only the claim with a receipt is signed.
    expect(signer).toHaveBeenCalledTimes(1);

    const all = await service.listReimbursements(
      ctxA,
      userIdSchema.parse(approverUserId),
      { limit: 100 },
      signer,
    );
    const allRows = all.data as { id: string; receiptUrl: string | null }[];
    expect(allRows.find((row) => row.id === withRef.id)?.receiptUrl).toBe(
      signedUrl(ref),
    );
    expect(allRows.find((row) => row.id === without.id)?.receiptUrl).toBeNull();

    const freshRef = await storageObject(tenant.id, outletId);
    const createSigner = vi.fn<HrisFileSigner>(async (_ctx, id) =>
      signedUrl(id),
    );
    const created = unwrap(
      await service.createMyReimbursement(
        ctxA,
        userIdSchema.parse(signerEmployee.userId),
        claimBody(category.id, {
          receiptUploadRef: freshRef,
          amountIdr: 12_000,
        }) as never,
        new Date(),
        createSigner,
      ),
    );
    expect(created.receiptUrl).toBe(signedUrl(freshRef));
    expect(createSigner).toHaveBeenCalledWith(expect.anything(), freshRef);
  });

  it("fills receiptUrl on decide", async () => {
    const category = await createCategory();
    const ref = await storageObject(tenant.id, outletId);
    const claim = await submit(signerEmployee.client, category.id, {
      receiptUploadRef: ref,
      amountIdr: 13_000,
    });
    const signer = vi.fn<HrisFileSigner>(async (_ctx, id) => signedUrl(id));
    const decided = unwrap(
      await service.decideReimbursement(
        ctxA,
        userIdSchema.parse(approverUserId),
        claim.id as never,
        { action: "approve", approvedAmountIdr: null, idempotencyKey: key() },
        new Date(),
        signer,
      ),
    );
    expect(decided.receiptUrl).toBe(signedUrl(ref));
    expect(signer).toHaveBeenCalledWith(expect.anything(), ref);
  });

  it("yields receiptUrl null when the signer returns null or throws, and by default", async () => {
    const category = await createCategory();
    const ref = await storageObject(tenant.id, outletId);
    const claim = await submit(signerEmployee.client, category.id, {
      receiptUploadRef: ref,
      amountIdr: 14_000,
    });
    const userId = userIdSchema.parse(signerEmployee.userId);
    const find = (result: { data: unknown }) =>
      (result.data as { id: string; receiptUrl: string | null }[]).find(
        (row) => row.id === claim.id,
      );

    const nullSigner: HrisFileSigner = async () => null;
    const throwing: HrisFileSigner = async () => {
      throw new Error("storage down");
    };
    expect(
      find(
        await service.listMyReimbursements(
          ctxA,
          userId,
          { limit: 100 },
          nullSigner,
        ),
      )?.receiptUrl,
    ).toBeNull();
    expect(
      find(
        await service.listMyReimbursements(
          ctxA,
          userId,
          { limit: 100 },
          throwing,
        ),
      )?.receiptUrl,
    ).toBeNull();
    expect(
      find(await service.listMyReimbursements(ctxA, userId, { limit: 100 }))
        ?.receiptUrl,
    ).toBeNull();

    const freshRef = await storageObject(tenant.id, outletId);
    const created = unwrap(
      await service.createMyReimbursement(
        ctxA,
        userId,
        claimBody(category.id, {
          receiptUploadRef: freshRef,
          amountIdr: 15_000,
        }) as never,
        new Date(),
        throwing,
      ),
    );
    expect(created.receiptUrl).toBeNull();
  });

  it("never returns the upload ref in an HTTP response", async () => {
    const category = await createCategory();
    const ref = await storageObject(tenant.id, outletId);
    const created = await post(signerEmployee.client, category.id, {
      receiptUploadRef: ref,
      amountIdr: 16_000,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const claimId = created.body.data.id as string;
    const mine = await signerEmployee.client.get(`${ME}?limit=100`);
    const all = await approverClient.get(`${CLAIMS}?limit=100`);
    const decided = await decide(approverClient, claimId);
    for (const response of [created, mine, all, decided]) {
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
      expect(JSON.stringify(response.body)).not.toContain(ref);
    }
  });
});
