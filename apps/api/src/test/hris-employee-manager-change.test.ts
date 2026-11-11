// legend-f4uvg (tier K: access + personal data): PATCH /api/hris/employees/:employeeId/manager
// lets HR (hr.employee.manage) or a GM scoped to a BRAND (hr.attendance.manage at brand
// scope, Q41 derivation) set or clear employees.manager_id. Written from the brief's
// Contract and "Who may call" sections, not from the implementation. Everything runs
// over HTTP against the real app; the DB is only read to assert persisted state.
//
// Assumptions where the contract is silent:
// - Check order: employee visible (404) -> actor allowed (403) -> body checks. So a
//   forbidden actor gets 403 even when the new manager would be valid.
// - Outlet-scope actors (supervisor / outlet_manager style) can SEE a direct report, so
//   the 403 targets are direct reports of the actor's own employee. Plain staff reach
//   only the own row; a route-level 403 is accepted (only the status is asserted).
// - Same idempotency key with a different payload answers 409 (as the other HRIS writes).
// - The GM also holds hr.employee.view (never hr.employee.manage); out-of-reach brand
//   employees are 404 NOT_FOUND, not 403.
// - Error body is { error: { code } } like the other HRIS endpoints.
// - Audit event shape matches the backfill's: event.reason, event.maskedChanges.before/after.
// - The backfill dry-run (`run`) lists an active, same-tenant employee without manager as
//   a finding, and stops listing him once he has an active same-outlet manager.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { ObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { run as runBackfill } from "../db/backfill-employee-managers.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const storageRuntime: StorageRuntime = {
  storage: {} as ObjectStorage,
  scanner: new NoopMalwareScanner(),
  fileSigner: async (_context, objectId) =>
    `https://signed.example.test/file/${objectId}`,
  hrisDocumentSigner: async () => null,
};
const app = createApp({ storageRuntime });

type Client = ReturnType<typeof agent>;
type JsonRow = Record<string, unknown>;
type Res = Awaited<ReturnType<Client["get"]>>;

const ACTION = "hris.employee_manager_change";
const KEY_PREFIX = "mgr-chg-";
const brandA = cafeLegendPlatformFixtures.brand.id;
const brandB = randomUUID();

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];
const createdCorrections: string[] = [];
const createdTenants: string[] = [];
let outletA1: string;
let outletA2: string;
let outletB1: string;

// ---------------------------------------------------------------------------
// DB helpers (state setup + read-back only)
// ---------------------------------------------------------------------------
async function inTenant<T>(
  tenantId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
const asTenant = <T>(work: (client: PoolClient) => Promise<T>) =>
  inTenant(tenant.id, work);

async function signedInClient(name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await verifySessionMfa(email);
  return { client, userId };
}

async function newUserId(name: string): Promise<string> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return userId;
}

type Scope =
  | { type: "tenant" }
  | { type: "brand"; brandId: string }
  | { type: "outlet"; outletId: string };

async function grantRole(
  userId: string,
  permissions: string[],
  scope: Scope,
): Promise<void> {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Manager change ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    const scopeId =
      scope.type === "brand"
        ? scope.brandId
        : scope.type === "outlet"
          ? scope.outletId
          : null;
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [tenant.id, userId, roleId, scope.type, scopeId],
    );
  });
}

// Template roles (cashier = junior, supervisor = senior) decide the role rule. Reuse the
// tenant's own template when present, else create one (and remove it afterwards).
const templateRoleIds = new Map<string, string>();
async function templateRole(key: string): Promise<string> {
  const cached = templateRoleIds.get(key);
  if (cached) return cached;
  const id = await asTenant(async (client) => {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2 LIMIT 1",
      [tenant.id, key],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const created = randomUUID();
    createdRoles.push(created);
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, true, $4, '[]'::jsonb, false, '["outlet"]'::jsonb)`,
      [created, tenant.id, key, key],
    );
    return created;
  });
  templateRoleIds.set(key, id);
  return id;
}

async function assignRoleById(
  userId: string,
  roleId: string,
  outletId: string,
  validity: { until?: string } = {},
) {
  await asTenant((client) =>
    client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 day', ${
         validity.until ? "$5::timestamptz" : "NULL"
       }, $2)`,
      [
        tenant.id,
        userId,
        roleId,
        outletId,
        ...(validity.until ? [validity.until] : []),
      ],
    ),
  );
}

async function seedOutlet(brandId: string): Promise<string> {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet ubah atasan', 'Jl. Atasan', 'Asia/Jakarta',
               '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        tenant.id,
        brandId,
        cafeLegendPlatformFixtures.legalEntity.id,
        `MC-${id.slice(0, 8)}`.toUpperCase(),
      ],
    ),
  );
  return id;
}

async function seedEmployee(
  options: {
    homeOutletId?: string;
    userId?: string | null;
    managerId?: string | null;
    status?: string;
    name?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status, manager_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', $7, $8, now() - interval '1 day')`,
      [
        id,
        tenant.id,
        options.userId ?? null,
        `MC-${id.slice(0, 8).toUpperCase()}`,
        options.name ?? `Karyawan Atasan ${id.slice(0, 8)}`,
        options.homeOutletId ?? outletA1,
        options.status ?? "active",
        options.managerId ?? null,
      ],
    ),
  );
  return id;
}

/** Employee with a login whose only role is the given template (or a custom role). */
async function seedEmployeeWithRole(
  role: "cashier" | "supervisor" | "custom",
  options: { managerId?: string | null; homeOutletId?: string } = {},
): Promise<string> {
  const outletId = options.homeOutletId ?? outletA1;
  const userId = await newUserId(`Peran ${role}`);
  if (role === "custom")
    await grantRole(userId, ["self.profile.view"], {
      type: "outlet",
      outletId,
    });
  else await assignRoleById(userId, await templateRole(role), outletId);
  return seedEmployee({
    userId,
    homeOutletId: outletId,
    managerId: options.managerId ?? null,
  });
}

async function managerOf(employeeId: string): Promise<string | null> {
  const rows = await asTenant(async (client) => {
    const result = await client.query<{ manager_id: string | null }>(
      "SELECT manager_id FROM employees WHERE tenant_id = $1 AND id = $2",
      [tenant.id, employeeId],
    );
    return result.rows;
  });
  return rows[0]!.manager_id;
}

async function updatedAtOf(employeeId: string): Promise<number> {
  const rows = await asTenant(async (client) => {
    const result = await client.query<{ at: Date }>(
      "SELECT updated_at AS at FROM employees WHERE tenant_id = $1 AND id = $2",
      [tenant.id, employeeId],
    );
    return result.rows;
  });
  return rows[0]!.at.getTime();
}

type AuditRow = {
  outlet_id: string | null;
  event: {
    action: string;
    objectType: string;
    objectId: string;
    reason?: string;
    maskedChanges: {
      before: { managerId: string | null };
      after: { managerId: string | null };
    };
  };
};
async function auditRows(employeeId: string): Promise<AuditRow[]> {
  return asTenant(async (client) => {
    const result = await client.query<AuditRow>(
      `SELECT outlet_id, event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
      [tenant.id, ACTION, employeeId],
    );
    return result.rows;
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
const newKey = () => `${KEY_PREFIX}${randomUUID()}`;
const patchManager = (
  client: Client,
  employeeId: string,
  managerId: string | null,
  extra: Record<string, unknown> = {},
) =>
  client
    .patch(`/api/hris/employees/${employeeId}/manager`)
    .set(originHeader)
    .send({ managerId, idempotencyKey: newKey(), ...extra });

function expectError(res: Res, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body?.error?.code, JSON.stringify(res.body)).toBe(code);
}

/** A rejected call neither moves manager_id nor writes an audit row. */
async function expectNoChange(
  employeeId: string,
  managerBefore: string | null,
) {
  expect(await managerOf(employeeId)).toBe(managerBefore);
  expect(await auditRows(employeeId)).toHaveLength(0);
}

let hr: Awaited<ReturnType<typeof signedInClient>>;
let gm: Awaited<ReturnType<typeof signedInClient>>;
let sup: Awaited<ReturnType<typeof signedInClient>>;
let om: Awaited<ReturnType<typeof signedInClient>>;
let staff: Awaited<ReturnType<typeof signedInClient>>;
let supEmployee: string;
let omEmployee: string;
let staffEmployee: string;

beforeAll(async () => {
  await asTenant((client) =>
    client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand B ubah atasan')`,
      [brandB, tenant.id, `mc-${brandB.slice(0, 8)}`],
    ),
  );
  outletA1 = await seedOutlet(brandA);
  outletA2 = await seedOutlet(brandA);
  outletB1 = await seedOutlet(brandB);

  hr = await signedInClient("HR Ubah Atasan");
  gm = await signedInClient("GM Ubah Atasan");
  sup = await signedInClient("Supervisor Ubah Atasan");
  om = await signedInClient("Outlet Manager Ubah Atasan");
  staff = await signedInClient("Kasir Ubah Atasan");

  await grantRole(hr.userId, ["hr.employee.manage", "hr.employee.view"], {
    type: "tenant",
  });
  // GM: hr.attendance.manage at BRAND scope, never hr.employee.manage.
  await grantRole(
    gm.userId,
    [
      "hr.employee.view",
      "hr.attendance.manage",
      "hr.attendance_correction.approve",
    ],
    { type: "brand", brandId: brandA },
  );
  await grantRole(sup.userId, ["hr.employee.view", "hr.attendance.manage"], {
    type: "outlet",
    outletId: outletA1,
  });
  await grantRole(
    om.userId,
    [
      "hr.employee.view",
      "hr.attendance.manage",
      "hr.attendance_correction.approve",
    ],
    { type: "outlet", outletId: outletA1 },
  );
  await grantRole(staff.userId, ["self.profile.view"], {
    type: "outlet",
    outletId: outletA1,
  });

  supEmployee = await seedEmployee({ userId: sup.userId });
  omEmployee = await seedEmployee({ userId: om.userId });
  staffEmployee = await seedEmployee({ userId: staff.userId });
});

// ---------------------------------------------------------------------------
// 1. HR sets a manager
// ---------------------------------------------------------------------------
describe("legend-f4uvg HR changes the manager", () => {
  it("sets the manager: 200 with the new managerId, DB updated, one audit row, updated_at advanced", async () => {
    const boss = await seedEmployee();
    const target = await seedEmployee();
    const updatedBefore = await updatedAtOf(target);

    const res = await patchManager(hr.client, target, boss, {
      reason: "  Salah input atasan  ",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ id: target, managerId: boss });
    expect(await managerOf(target)).toBe(boss);
    expect(await updatedAtOf(target)).toBeGreaterThan(updatedBefore);

    const audit = await auditRows(target);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.outlet_id).toBe(outletA1);
    expect(audit[0]!.event).toMatchObject({
      action: ACTION,
      objectType: "employee",
      objectId: target,
      reason: "Salah input atasan",
    });
    expect(audit[0]!.event.maskedChanges.before.managerId).toBeNull();
    expect(audit[0]!.event.maskedChanges.after.managerId).toBe(boss);
  });

  it("changes an existing manager and records before and after; reason is optional", async () => {
    const oldBoss = await seedEmployee();
    const newBoss = await seedEmployee();
    const target = await seedEmployee({ managerId: oldBoss });

    const res = await patchManager(hr.client, target, newBoss);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.managerId).toBe(newBoss);
    const audit = await auditRows(target);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event.maskedChanges.before.managerId).toBe(oldBoss);
    expect(audit[0]!.event.maskedChanges.after.managerId).toBe(newBoss);
  });

  it("clears the manager with null: 200, DB null, audit before=old after=null", async () => {
    const boss = await seedEmployee();
    const target = await seedEmployee({ managerId: boss });

    const res = await patchManager(hr.client, target, null, {
      reason: "Atasan keluar",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.managerId).toBeNull();
    expect(await managerOf(target)).toBeNull();
    const audit = await auditRows(target);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event.reason).toBe("Atasan keluar");
    expect(audit[0]!.event.maskedChanges.before.managerId).toBe(boss);
    expect(audit[0]!.event.maskedChanges.after.managerId).toBeNull();
  });

  it("a manager of another outlet in the same tenant is allowed (HR decides)", async () => {
    const boss = await seedEmployee({ homeOutletId: outletA2 });
    const target = await seedEmployee();
    const res = await patchManager(hr.client, target, boss);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await managerOf(target)).toBe(boss);
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotency
// ---------------------------------------------------------------------------
describe("legend-f4uvg idempotency", () => {
  it("replaying the same key and payload returns the first result and writes no second audit row", async () => {
    const boss = await seedEmployee();
    const target = await seedEmployee();
    const body = {
      managerId: boss,
      reason: "Replay",
      idempotencyKey: newKey(),
    };
    const send = () =>
      hr.client
        .patch(`/api/hris/employees/${target}/manager`)
        .set(originHeader)
        .send(body);

    const first = await send();
    const replay = await send();

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    expect(await auditRows(target)).toHaveLength(1);
    expect(await managerOf(target)).toBe(boss);
  });

  it("the same key with a different payload is refused with 409 and changes nothing more", async () => {
    const boss = await seedEmployee();
    const otherBoss = await seedEmployee();
    const target = await seedEmployee();
    const idempotencyKey = newKey();

    const first = await patchManager(hr.client, target, boss, {
      idempotencyKey,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const reused = await patchManager(hr.client, target, otherBoss, {
      idempotencyKey,
    });

    expect(reused.status, JSON.stringify(reused.body)).toBe(409);
    expect(await managerOf(target)).toBe(boss);
    expect(await auditRows(target)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. GM brand
// ---------------------------------------------------------------------------
describe("legend-f4uvg GM brand", () => {
  it("changes the manager of an employee of the own brand (any outlet of the brand)", async () => {
    for (const outletId of [outletA1, outletA2]) {
      const boss = await seedEmployee({ homeOutletId: outletId });
      const target = await seedEmployee({ homeOutletId: outletId });

      const res = await patchManager(gm.client, target, boss, {
        reason: "GM brand",
      });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.managerId).toBe(boss);
      expect(await managerOf(target)).toBe(boss);
      expect(await auditRows(target)).toHaveLength(1);
    }
  });

  it("answers 404 NOT_FOUND for an employee of another brand and changes nothing", async () => {
    const boss = await seedEmployee({ homeOutletId: outletB1 });
    const target = await seedEmployee({ homeOutletId: outletB1 });

    const res = await patchManager(gm.client, target, boss);

    expectError(res, 404, "NOT_FOUND");
    await expectNoChange(target, null);
  });
});

// ---------------------------------------------------------------------------
// 4. Not allowed callers
// ---------------------------------------------------------------------------
describe("legend-f4uvg callers that may not change managers", () => {
  it.each([
    ["outlet-scope supervisor", () => sup, () => supEmployee],
    ["outlet-scope outlet_manager", () => om, () => omEmployee],
  ])(
    "%s gets 403 FORBIDDEN for a visible direct report",
    async (_name, who, ownEmployee) => {
      const oldBoss = ownEmployee();
      const target = await seedEmployee({ managerId: oldBoss });
      const candidate = await seedEmployee();

      const res = await patchManager(who().client, target, candidate);

      expectError(res, 403, "FORBIDDEN");
      await expectNoChange(target, oldBoss);
    },
  );

  it("a plain employee/cashier cannot change even his own manager (403)", async () => {
    const candidate = await seedEmployee();
    const res = await patchManager(staff.client, staffEmployee, candidate);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    await expectNoChange(staffEmployee, null);
  });

  it("an anonymous caller is refused and nothing changes", async () => {
    const target = await seedEmployee();
    const candidate = await seedEmployee();
    const res = await agent(app)
      .patch(`/api/hris/employees/${target}/manager`)
      .set(originHeader)
      .send({ managerId: candidate, idempotencyKey: newKey() });
    expect(res.status).toBe(401);
    await expectNoChange(target, null);
  });
});

// ---------------------------------------------------------------------------
// 5. Rejections
// ---------------------------------------------------------------------------
describe("legend-f4uvg rejected changes", () => {
  it("self as manager: 422 VALIDATION_ERROR", async () => {
    const target = await seedEmployee();
    const res = await patchManager(hr.client, target, target);
    expectError(res, 422, "VALIDATION_ERROR");
    await expectNoChange(target, null);
  });

  it("unchanged value: 422 VALIDATION_ERROR (same manager, and null to null)", async () => {
    const boss = await seedEmployee();
    const withBoss = await seedEmployee({ managerId: boss });
    const without = await seedEmployee();

    expectError(
      await patchManager(hr.client, withBoss, boss),
      422,
      "VALIDATION_ERROR",
    );
    expectError(
      await patchManager(hr.client, without, null),
      422,
      "VALIDATION_ERROR",
    );
    await expectNoChange(withBoss, boss);
    await expectNoChange(without, null);
  });

  it("inactive manager: 422 MANAGER_NOT_ELIGIBLE", async () => {
    const target = await seedEmployee();
    for (const status of ["resigned", "suspended"]) {
      const boss = await seedEmployee({ status });
      expectError(
        await patchManager(hr.client, target, boss),
        422,
        "MANAGER_NOT_ELIGIBLE",
      );
    }
    await expectNoChange(target, null);
  });

  it("unknown manager id: 422 MANAGER_NOT_ELIGIBLE", async () => {
    const target = await seedEmployee();
    const res = await patchManager(hr.client, target, randomUUID());
    expectError(res, 422, "MANAGER_NOT_ELIGIBLE");
    await expectNoChange(target, null);
  });

  it("manager from another tenant: 422 MANAGER_NOT_ELIGIBLE without leaking anything", async () => {
    const foreign = await seedForeignTenantEmployee();
    const target = await seedEmployee();

    const res = await patchManager(hr.client, target, foreign.employeeId);

    expectError(res, 422, "MANAGER_NOT_ELIGIBLE");
    expect(JSON.stringify(res.body)).not.toContain(foreign.fullName);
    expect(JSON.stringify(res.body)).not.toContain(foreign.tenantId);
    await expectNoChange(target, null);
  });

  it("unknown employee, and an employee of another tenant: 404 NOT_FOUND", async () => {
    const boss = await seedEmployee();
    expectError(
      await patchManager(hr.client, randomUUID(), boss),
      404,
      "NOT_FOUND",
    );
    const foreign = await seedForeignTenantEmployee();
    expectError(
      await patchManager(hr.client, foreign.employeeId, boss),
      404,
      "NOT_FOUND",
    );
  });

  it("direct cycle (A under B, then B under A): 409 MANAGER_CYCLE", async () => {
    const b = await seedEmployee();
    const a = await seedEmployee({ managerId: b });

    const res = await patchManager(hr.client, b, a);

    expectError(res, 409, "MANAGER_CYCLE");
    await expectNoChange(b, null);
    expect(await managerOf(a)).toBe(b);
  });

  it("three-level cycle (A under B under C, then C under A): 409 MANAGER_CYCLE", async () => {
    const c = await seedEmployee();
    const b = await seedEmployee({ managerId: c });
    const a = await seedEmployee({ managerId: b });

    expectError(await patchManager(hr.client, c, a), 409, "MANAGER_CYCLE");
    await expectNoChange(c, null);
  });

  it("a cycle through a long chain is found at any depth", async () => {
    const top = await seedEmployee();
    let previous = top;
    for (let level = 0; level < 8; level += 1)
      previous = await seedEmployee({ managerId: previous });

    expectError(
      await patchManager(hr.client, top, previous),
      409,
      "MANAGER_CYCLE",
    );
    await expectNoChange(top, null);
  });

  it("moving an employee under a colleague of another branch of the tree is fine (no false cycle)", async () => {
    const root = await seedEmployee();
    const left = await seedEmployee({ managerId: root });
    const right = await seedEmployee({ managerId: root });
    const res = await patchManager(hr.client, left, right);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await managerOf(left)).toBe(right);
  });
});

// ---------------------------------------------------------------------------
// 5a. Brand reach of the new manager, and no self-service on the own row
// ---------------------------------------------------------------------------
// Assumptions (contract silent on exact wording):
// - A brand-scoped GM may only pick a manager inside the brands he can reach; a manager
//   of another brand answers exactly like an unknown / inactive id (422
//   MANAGER_NOT_ELIGIBLE, same code and message), so existence is not leaked.
// - A caller who is himself an employee (employees.user_id = his user) may not change
//   his OWN row's manager even when he holds the right: 403 FORBIDDEN, checked before
//   the body checks, so every managerId (valid, null, himself) gives 403.
const errorShape = (res: Res) => ({
  status: res.status,
  code: res.body?.error?.code,
  message: res.body?.error?.message,
});

describe("legend-f4uvg manager outside the GM's brand", () => {
  it("brand-A GM with an active brand-B manager: 422 MANAGER_NOT_ELIGIBLE, nothing changed, same answer as an unknown id", async () => {
    const brandBBoss = await seedEmployee({
      homeOutletId: outletB1,
      name: `Bos Brand B Rahasia ${randomUUID().slice(0, 8)}`,
    });
    const target = await seedEmployee({ homeOutletId: outletA1 });

    const crossBrand = await patchManager(gm.client, target, brandBBoss);
    const unknown = await patchManager(gm.client, target, randomUUID());

    expectError(crossBrand, 422, "MANAGER_NOT_ELIGIBLE");
    expectError(unknown, 422, "MANAGER_NOT_ELIGIBLE");
    expect(errorShape(crossBrand)).toEqual(errorShape(unknown));
    expect(JSON.stringify(crossBrand.body)).not.toContain("Rahasia");
    expect(JSON.stringify(crossBrand.body)).not.toContain(brandBBoss);
    await expectNoChange(target, null);
  });

  it("brand-A GM cannot swap an existing manager for a brand-B manager either", async () => {
    const oldBoss = await seedEmployee({ homeOutletId: outletA1 });
    const brandBBoss = await seedEmployee({ homeOutletId: outletB1 });
    const target = await seedEmployee({
      homeOutletId: outletA1,
      managerId: oldBoss,
    });

    const res = await patchManager(gm.client, target, brandBBoss);

    expectError(res, 422, "MANAGER_NOT_ELIGIBLE");
    await expectNoChange(target, oldBoss);
  });

  it("tenant-wide HR with the same brand-B manager succeeds", async () => {
    const brandBBoss = await seedEmployee({ homeOutletId: outletB1 });
    const target = await seedEmployee({ homeOutletId: outletA1 });

    const res = await patchManager(hr.client, target, brandBBoss);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ id: target, managerId: brandBBoss });
    expect(await managerOf(target)).toBe(brandBBoss);
    expect(await auditRows(target)).toHaveLength(1);
  });
});

describe("legend-f4uvg nobody changes the manager of his own employee row", () => {
  // Callers that hold the right AND are an employee themselves.
  const selfCallers = [
    {
      name: "tenant-wide HR",
      permissions: ["hr.employee.manage", "hr.employee.view"],
      scope: (): Scope => ({ type: "tenant" }),
    },
    {
      name: "brand GM",
      permissions: ["hr.employee.view", "hr.attendance.manage"],
      scope: (): Scope => ({ type: "brand", brandId: brandA }),
    },
  ];

  async function callerWithOwnRow(index: number) {
    const spec = selfCallers[index]!;
    const caller = await signedInClient(`${spec.name} karyawan sendiri`);
    await grantRole(caller.userId, spec.permissions, spec.scope());
    const currentBoss = await seedEmployee();
    const ownRow = await seedEmployee({
      userId: caller.userId,
      managerId: currentBoss,
    });
    return { ...caller, ownRow, currentBoss };
  }

  it.each(selfCallers.map((spec, index) => [spec.name, index] as const))(
    "%s changing his own manager gets 403 FORBIDDEN for any managerId, nothing changes, no audit row",
    async (_name, index) => {
      const { client, ownRow, currentBoss } = await callerWithOwnRow(index);
      const otherBoss = await seedEmployee();

      for (const managerId of [otherBoss, null, ownRow, randomUUID()]) {
        const res = await patchManager(client, ownRow, managerId);
        expectError(res, 403, "FORBIDDEN");
      }

      await expectNoChange(ownRow, currentBoss);
    },
  );

  it.each(selfCallers.map((spec, index) => [spec.name, index] as const))(
    "%s who is an employee can still change someone else's manager",
    async (_name, index) => {
      const { client } = await callerWithOwnRow(index);
      const boss = await seedEmployee();
      const target = await seedEmployee();

      const res = await patchManager(client, target, boss);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await managerOf(target)).toBe(boss);
      expect(await auditRows(target)).toHaveLength(1);
    },
  );

  it("a caller who is not an employee himself (HR without an employee row) is unaffected", async () => {
    const boss = await seedEmployee();
    const target = await seedEmployee();
    const res = await patchManager(hr.client, target, boss);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5b. Role rule
// ---------------------------------------------------------------------------
describe("legend-f4uvg role rule (non-junior employee needs a non-junior manager)", () => {
  it("junior-only manager for a supervisor: 422 MANAGER_ROLE_TOO_LOW", async () => {
    const senior = await seedEmployeeWithRole("supervisor");
    const juniorBoss = await seedEmployeeWithRole("cashier");

    const res = await patchManager(hr.client, senior, juniorBoss);

    expectError(res, 422, "MANAGER_ROLE_TOO_LOW");
    await expectNoChange(senior, null);
  });

  it("a manager without any role is too low for a non-junior employee", async () => {
    const senior = await seedEmployeeWithRole("supervisor");
    const noRoleBoss = await seedEmployee();
    expectError(
      await patchManager(hr.client, senior, noRoleBoss),
      422,
      "MANAGER_ROLE_TOO_LOW",
    );
    await expectNoChange(senior, null);
  });

  it("a custom role counts as non-junior", async () => {
    const custom = await seedEmployeeWithRole("custom");
    const juniorBoss = await seedEmployeeWithRole("cashier");
    expectError(
      await patchManager(hr.client, custom, juniorBoss),
      422,
      "MANAGER_ROLE_TOO_LOW",
    );
    await expectNoChange(custom, null);
  });

  it("a junior manager for a junior employee is fine", async () => {
    const junior = await seedEmployeeWithRole("cashier");
    const juniorBoss = await seedEmployeeWithRole("cashier");

    const res = await patchManager(hr.client, junior, juniorBoss);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await managerOf(junior)).toBe(juniorBoss);
  });

  it("a junior employee (and one without any role) may get a manager without roles", async () => {
    const junior = await seedEmployeeWithRole("cashier");
    const noRole = await seedEmployee();
    const noRoleBoss = await seedEmployee();
    expect((await patchManager(hr.client, junior, noRoleBoss)).status).toBe(
      200,
    );
    expect((await patchManager(hr.client, noRole, noRoleBoss)).status).toBe(
      200,
    );
  });

  it("a senior manager for a supervisor is fine", async () => {
    const senior = await seedEmployeeWithRole("supervisor");
    const seniorBoss = await seedEmployeeWithRole("supervisor");
    const res = await patchManager(hr.client, senior, seniorBoss);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await managerOf(senior)).toBe(seniorBoss);
  });

  it("clearing with null is never blocked by the role rule", async () => {
    const juniorBoss = await seedEmployeeWithRole("cashier");
    const senior = await seedEmployeeWithRole("supervisor", {
      managerId: juniorBoss,
    });

    const res = await patchManager(hr.client, senior, null);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await managerOf(senior)).toBeNull();
    const audit = await auditRows(senior);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event.maskedChanges.before.managerId).toBe(juniorBoss);
    expect(audit[0]!.event.maskedChanges.after.managerId).toBeNull();
  });

  it("an expired senior assignment no longer makes the employee non-junior", async () => {
    const userId = await newUserId("Peran kedaluwarsa");
    await assignRoleById(userId, await templateRole("cashier"), outletA1);
    await assignRoleById(userId, await templateRole("supervisor"), outletA1, {
      until: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const employee = await seedEmployee({ userId });
    const juniorBoss = await seedEmployeeWithRole("cashier");

    const res = await patchManager(hr.client, employee, juniorBoss);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 6. Concurrency
// ---------------------------------------------------------------------------
describe("legend-f4uvg concurrency", () => {
  it("A->B and B->A fired together: exactly one 200 and one 409, no cycle in the DB", async () => {
    for (let round = 0; round < 3; round += 1) {
      const a = await seedEmployee();
      const b = await seedEmployee();

      const [first, second] = await Promise.all([
        patchManager(hr.client, a, b),
        patchManager(hr.client, b, a),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses, JSON.stringify([first.body, second.body])).toEqual([
        200, 409,
      ]);
      const loser = first.status === 409 ? first : second;
      expect(loser.body?.error?.code).toBe("MANAGER_CYCLE");
      const [managerOfA, managerOfB] = [await managerOf(a), await managerOf(b)];
      expect(managerOfA === b && managerOfB === a).toBe(false);
      expect([managerOfA === b, managerOfB === a].filter(Boolean)).toHaveLength(
        1,
      );
      expect((await auditRows(a)).length + (await auditRows(b)).length).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Effect on visibility and on the backfill
// ---------------------------------------------------------------------------
type Correction = { employeeId: string; id: string };
async function seedCorrection(
  employeeId: string,
  outletId: string,
): Promise<Correction> {
  const id = randomUUID();
  createdCorrections.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO attendance_corrections
         (id, tenant_id, outlet_id, employee_id, requested_type, requested_occurred_at, reason,
          requested_by, idempotency_key)
       VALUES ($1, $2, $3, $4, 'out', now(), 'Lupa absen pulang', $5, $6)`,
      [
        id,
        tenant.id,
        outletId,
        employeeId,
        randomUUID(),
        `${KEY_PREFIX}c-${id}`,
      ],
    ),
  );
  return { employeeId, id };
}

async function correctionIds(client: Client): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 30; page += 1) {
    const response: Res = await client.get(
      `/api/hris/attendance/corrections?limit=100${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    ids.push(
      ...(response.body.data as JsonRow[]).map((row) =>
        String(row.id).toLowerCase(),
      ),
    );
    cursor = (response.body?.meta?.nextCursor as string | null) ?? null;
    if (!cursor) break;
  }
  return ids;
}

describe("legend-f4uvg after the change", () => {
  it("the new outlet manager sees the employee, and the backfill dry-run stops listing him", async () => {
    const visOutlet = await seedOutlet(brandA);
    const visOm = await signedInClient("Outlet Manager Visibilitas");
    // Attendance permissions only, so visibility comes from the manager link alone.
    await grantRole(
      visOm.userId,
      ["hr.attendance.manage", "hr.attendance_correction.approve"],
      { type: "outlet", outletId: visOutlet },
    );
    const visOmEmployee = await seedEmployee({
      userId: visOm.userId,
      homeOutletId: visOutlet,
    });
    const employee = await seedEmployee({ homeOutletId: visOutlet });
    const correction = await seedCorrection(employee, visOutlet);
    const dryRun = async () =>
      (
        await runBackfill({
          pool: owner,
          apply: false,
          now: new Date(),
          log: () => undefined,
          tenantId: tenant.id,
        })
      ).findings.map((finding) => finding.employeeId);

    expect(await correctionIds(visOm.client)).not.toContain(correction.id);
    expect(await dryRun()).toContain(employee);

    const res = await patchManager(hr.client, employee, visOmEmployee);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await correctionIds(visOm.client)).toContain(correction.id);
    expect(await dryRun()).not.toContain(employee);
  });
});

// ---------------------------------------------------------------------------
// Other tenant fixture
// ---------------------------------------------------------------------------
async function seedForeignTenantEmployee() {
  const tenantId = randomUUID();
  createdTenants.push(tenantId);
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Tenant asing ubah atasan', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `mc-foreign-${tenantId}`, randomUUID()],
  );
  const brandId = randomUUID();
  const legalEntityId = randomUUID();
  const outletId = randomUUID();
  const employeeId = randomUUID();
  const fullName = `Nama Asing Rahasia ${employeeId.slice(0, 8)}`;
  await inTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand asing')`,
      [brandId, tenantId, `mf-${brandId.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, 'PT Asing')`,
      [legalEntityId, tenantId],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet asing', 'Jl. Asing', 'Asia/Jakarta',
               '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        outletId,
        tenantId,
        brandId,
        legalEntityId,
        `MF-${outletId.slice(0, 8)}`.toUpperCase(),
      ],
    );
    await client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, NULL, $3, $4, $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenantId,
        `MF-${employeeId.slice(0, 8).toUpperCase()}`,
        fullName,
        outletId,
      ],
    );
  });
  return { tenantId, employeeId, fullName };
}

// ---------------------------------------------------------------------------
// GET /api/me/access: canChangeEmployeeManager (presentation hint for the
// "Ubah atasan" button; PATCH stays the authority and re-checks the scope)
// ---------------------------------------------------------------------------
describe("GET /api/me/access canChangeEmployeeManager", () => {
  const hintOf = async (client: Client) => {
    const res = await client.get("/api/me/access");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data.canChangeEmployeeManager as unknown;
  };

  it("is true for HR (hr.employee.manage) and for a brand-scoped GM", async () => {
    expect(await hintOf(hr.client)).toBe(true);
    expect(await hintOf(gm.client)).toBe(true);
  });

  it("is false for an outlet-scoped supervisor and outlet manager, which PATCH answers 403", async () => {
    expect(await hintOf(sup.client)).toBe(false);
    expect(await hintOf(om.client)).toBe(false);
    const target = await seedEmployee();
    expect((await patchManager(om.client, target, null)).status).toBe(403);
  });

  it("is false for plain staff", async () => {
    expect(await hintOf(staff.client)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cleanup (audit_logs is append-only: delete with triggers off, like the GM test)
// ---------------------------------------------------------------------------
afterAll(async () => {
  try {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const scope = (tenantId: string) =>
        client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
          [tenantId],
        );
      await scope(tenant.id);
      await client.query(
        "DELETE FROM audit_logs WHERE tenant_id = $1 AND event->>'objectId' = ANY($2::text[])",
        [tenant.id, createdEmployees],
      );
      await client.query(
        "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE $2",
        [tenant.id, `%${KEY_PREFIX}%`],
      );
      await client.query(
        "DELETE FROM attendance_corrections WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdCorrections],
      );
      await client.query(
        "UPDATE employees SET manager_id = NULL WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdEmployees],
      );
      await client.query(
        "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdEmployees],
      );
      await client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
        [tenant.id, createdUsers],
      );
      await client.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdRoles],
      );
      await client.query(
        "DELETE FROM outlets WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdOutlets],
      );
      await client.query(
        "DELETE FROM brands WHERE tenant_id = $1 AND id = $2",
        [tenant.id, brandB],
      );
      for (const tenantId of createdTenants) {
        await scope(tenantId);
        for (const table of [
          "audit_logs",
          "employees",
          "outlets",
          "legal_entities",
          "brands",
        ])
          await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
            tenantId,
          ]);
      }
      await client.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
        createdTenants,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUsers,
    ]);
  } finally {
    await owner.end();
  }
}, 60_000);
