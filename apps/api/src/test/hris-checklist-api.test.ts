// Onboarding checklists over HTTP (PRD v1.7 F24; brief 299 slice A; bead
// legend-ovxw; HR-01; TEN-01/02/03): templates per position, onboarding start,
// task list, task actions and the action trail. Runs the real Express app,
// Better Auth, the RBAC resolver and PostgreSQL against the seeded Cafe Legend
// tenant plus a throwaway second tenant. Expected behaviour comes from the
// brief and DECISIONS 2026-11-10 "WS-10 lifecycle", not from the service code.
//
// Assumptions (the brief leaves these open):
//  - A body or query with an unknown key or a client-sent tenantId is answered
//    422, as for every other HRIS route.
//  - A manager outside the employee's home outlet gets 404 for the employee's
//    tasks (HR-01); a user holding no HR code at all gets 403 from the gate.
//  - A manager whose reach is limited to outlets may not write templates
//    (tenant-wide reach is required): 403.
//  - Completing a done task, or waiving a waived one, answers 409.
//  - A replay with the same idempotency key and action answers the task as it
//    is now and appends no second action row.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  asTenant as asRlsTenant,
  createAppPool,
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = createAppPool();

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];
const createdPositions: string[] = [];
const createdObjects: string[] = [];
let tenantB: SecondTenant | null = null;

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Client = ReturnType<typeof agent>;

async function signedInClient(name: string, options: { mfa?: boolean } = {}) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  if (options.mfa) await verifySessionMfa(email);
  return { client, userId };
}

async function grantRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; outletIds: string[] },
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Checklist API ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    const scopeIds = scope.type === "tenant" ? [null] : scope.outletIds;
    for (const scopeId of scopeIds)
      await client.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
        [tenant.id, userId, roleId, scope.type, scopeId],
      );
  });
}

async function seedOutlet(label: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Checklist', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `CK-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet checklist ${label}`,
      ],
    ),
  );
  return id;
}

async function seedPosition(name: string) {
  const id = randomUUID();
  createdPositions.push(id);
  await asTenant((client) =>
    client.query(
      "INSERT INTO positions (id, tenant_id, name) VALUES ($1, $2, $3)",
      [id, tenant.id, name],
    ),
  );
  return id;
}

async function seedEmployee(input: {
  userId: string | null;
  outletId: string;
  positionId?: string | null;
  status?: string;
}) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id, position_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Checklist API', $5, $6, 'pkwtt', '2025-03-01', $7)`,
      [
        id,
        tenant.id,
        input.userId,
        `CK-${id.slice(0, 8).toUpperCase()}`,
        input.outletId,
        input.positionId ?? null,
        input.status ?? "onboarding",
      ],
    ),
  );
  return id;
}

/** An employee document (needs a private-bucket object row first). */
async function seedDocument(employeeId: string, outletId: string) {
  const objectId = randomUUID();
  const documentId = randomUUID();
  createdObjects.push(objectId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO core_storage_objects (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes)
       VALUES ($1, $2, $3, 'document', $4, 'image/webp', 1024)`,
      [tenant.id, outletId, objectId, `legend-ovxw/${objectId}.webp`],
    );
    await client.query(
      `INSERT INTO employee_documents (id, tenant_id, employee_id, type, storage_object_id)
       VALUES ($1, $2, $3, 'ktp', $4)`,
      [documentId, tenant.id, employeeId, objectId],
    );
  });
  return documentId;
}

/** A task row written directly, for cases the template cannot express. */
async function seedTask(input: {
  employeeId: string;
  code: string;
  category: string;
  requiresDocument?: boolean;
  systemManaged?: boolean;
}) {
  const id = randomUUID();
  await asTenant((client) =>
    client.query(
      `INSERT INTO hris_checklist_tasks
         (id, tenant_id, employee_id, kind, code, title, category, requires_document, system_managed, sort_order)
       VALUES ($1, $2, $3, 'onboarding', $4, $5, $6, $7, $8, 0)`,
      [
        id,
        tenant.id,
        input.employeeId,
        input.code,
        `Tugas ${input.code}`,
        input.category,
        input.requiresDocument ?? false,
        input.systemManaged ?? false,
      ],
    ),
  );
  return id;
}

const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);
const patch = (client: Client, path: string, body: unknown) =>
  client
    .patch(path)
    .set(originHeader)
    .send(body as object);
const key = () => `ck-api-${randomUUID()}`;

type Task = {
  id: string;
  employeeId: string;
  code: string;
  category: string;
  status: string;
  doneBy: string | null;
  doneAt: string | null;
  documentId: string | null;
  blockReason: string | null;
  waiveReason: string | null;
  systemManaged: boolean;
  requiresDocument: boolean;
  templateId: string | null;
  sortOrder: number;
};
type ActionRow = {
  action: string;
  fromStatus: string;
  toStatus: string;
  reason: string | null;
  actorUserId: string;
  documentId: string | null;
};

const item = (
  code: string,
  category: string,
  sortOrder: number,
  requiresDocument = false,
) => ({
  code,
  title: `Item ${code}`,
  category,
  requiresDocument,
  sortOrder,
});

async function createTemplate(
  client: Client,
  positionId: string | null,
  items: ReturnType<typeof item>[],
  title = "Template onboarding",
) {
  const created = await post(client, "/api/hris/checklist-templates", {
    kind: "onboarding",
    positionId,
    title,
    items,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data as { id: string; version: number };
}

async function act(
  client: Client,
  taskId: string,
  body: Record<string, unknown>,
) {
  return post(client, `/api/hris/checklist-tasks/${taskId}/actions`, body);
}

async function tasksOf(client: Client, employeeId: string) {
  const response = await client.get(
    `/api/hris/employees/${employeeId}/checklist-tasks?limit=100`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as Task[];
}

async function actionRows(client: Client, taskId: string) {
  const response = await client.get(
    `/api/hris/checklist-tasks/${taskId}/actions`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as ActionRow[];
}

async function auditCount(action: string, objectId: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
      [tenant.id, action, objectId],
    );
    return rows[0]!.n;
  });
}

// ---- fixtures ---------------------------------------------------------------

let jkt: string;
let other: string;
let positionKasir: string;
let positionDefault: string;

let hr: Client;
let hrUserId: string;
let hrOutletOnly: Client;
let hrOther: Client;
let viewer: Client;
let staff: Client;
let staff2: Client;
let nobody: Client;

let empStaff: string;
let empStaff2: string;
let empNoPosition: string;
let tenantBEmployee = "";

beforeAll(async () => {
  // A leftover default template of a failed run would block the unique index.
  await owner.query(
    "DELETE FROM hris_checklist_tasks WHERE tenant_id = $1 AND code LIKE 'ck_%'",
    [tenant.id],
  );
  jkt = await seedOutlet("A");
  other = await seedOutlet("B");
  positionKasir = await seedPosition("Kasir Checklist API");
  positionDefault = await seedPosition("Tanpa template Checklist API");

  const manager = await signedInClient("HR Checklist API", { mfa: true });
  await grantRole(manager.userId, ["hr.employee.manage"], { type: "tenant" });
  hr = manager.client;
  hrUserId = manager.userId;

  const scoped = await signedInClient("HR Outlet Checklist API", { mfa: true });
  await grantRole(scoped.userId, ["hr.employee.manage"], {
    type: "outlet",
    outletIds: [jkt],
  });
  hrOutletOnly = scoped.client;

  const otherHr = await signedInClient("HR Lain Checklist API", { mfa: true });
  await grantRole(otherHr.userId, ["hr.employee.manage"], {
    type: "outlet",
    outletIds: [other],
  });
  hrOther = otherHr.client;

  const view = await signedInClient("Penilik Checklist API", { mfa: true });
  await grantRole(view.userId, ["hr.employee.view"], {
    type: "outlet",
    outletIds: [jkt],
  });
  viewer = view.client;

  const a = await signedInClient("Staf A Checklist API");
  await grantRole(a.userId, ["self.profile.view"], {
    type: "outlet",
    outletIds: [jkt],
  });
  staff = a.client;

  const b = await signedInClient("Staf B Checklist API");
  await grantRole(b.userId, ["self.profile.view"], {
    type: "outlet",
    outletIds: [jkt],
  });
  staff2 = b.client;

  const none = await signedInClient("Tanpa Izin Checklist API");
  nobody = none.client;

  empStaff = await seedEmployee({
    userId: a.userId,
    outletId: jkt,
    positionId: positionKasir,
  });
  empStaff2 = await seedEmployee({ userId: b.userId, outletId: jkt });
  empNoPosition = await seedEmployee({
    userId: null,
    outletId: jkt,
    positionId: positionDefault,
  });
}, 120_000);

afterAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      `DELETE FROM hris_checklist_task_actions WHERE tenant_id = $1 AND task_id IN
         (SELECT id FROM hris_checklist_tasks WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[]))`,
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM hris_checklist_tasks WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM hris_checklist_templates WHERE tenant_id = $1 AND (created_by = ANY($2::text[]) OR position_id = ANY($3::uuid[]))",
      [tenant.id, createdUsers, createdPositions],
    );
    await client.query(
      "DELETE FROM employee_documents WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdObjects],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM positions WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdPositions],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
    // Outlets stay: audit_logs is append-only and references them (disposable DB).
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  if (tenantB) {
    await owner.query("DELETE FROM hris_checklist_tasks WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]);
    await owner.query("DELETE FROM employees WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]);
    await removeSecondTenant(owner, tenantB);
  }
  await appPool.end();
  await owner.end();
});

// ---- authentication and permissions -----------------------------------------

describe("authentication and permissions", () => {
  it("[TEN-01] anonymous requests to every checklist route answer 401", async () => {
    const anonymous = agent(app);
    const taskId = randomUUID();
    for (const path of [
      "/api/hris/checklist-templates",
      `/api/hris/employees/${empStaff}/checklist-tasks`,
      `/api/hris/checklist-tasks/${taskId}/actions`,
    ])
      expect((await anonymous.get(path)).status, path).toBe(401);
    for (const path of [
      "/api/hris/checklist-templates",
      `/api/hris/employees/${empStaff}/onboarding`,
      `/api/hris/checklist-tasks/${taskId}/actions`,
    ])
      expect(
        (await anonymous.post(path).set(originHeader).send({})).status,
        path,
      ).toBe(401);
    expect(
      (
        await anonymous
          .patch(`/api/hris/checklist-templates/${taskId}`)
          .set(originHeader)
          .send({})
      ).status,
    ).toBe(401);
  });

  it("answers 403 to a role without the key", async () => {
    expect((await nobody.get("/api/hris/checklist-templates")).status).toBe(
      403,
    );
    expect(
      (await post(nobody, `/api/hris/employees/${empStaff}/onboarding`, {}))
        .status,
    ).toBe(403);
    expect(
      (await act(nobody, randomUUID(), { action: "complete" })).status,
    ).toBe(403);
    // View-only and self roles cannot read templates or start onboarding.
    expect((await viewer.get("/api/hris/checklist-templates")).status).toBe(
      403,
    );
    expect((await staff.get("/api/hris/checklist-templates")).status).toBe(403);
    expect(
      (await post(viewer, `/api/hris/employees/${empStaff}/onboarding`, {}))
        .status,
    ).toBe(403);
  });

  it("[TEN-02] rejects a client-sent tenant id and unknown keys with 422", async () => {
    const response = await post(hr, "/api/hris/checklist-templates", {
      tenantId: randomUUID(),
      kind: "onboarding",
      positionId: null,
      title: "Lintas tenant",
      items: [item("ck_tenant", "documents", 0)],
    });
    expect(response.status).toBe(422);
    expect(
      (
        await post(hr, "/api/hris/checklist-templates", {
          kind: "onboarding",
          positionId: null,
          title: "Kunci asing",
          items: [item("ck_extra", "documents", 0)],
          extra: true,
        })
      ).status,
    ).toBe(422);
  });
});

// ---- templates ---------------------------------------------------------------

describe("templates", () => {
  it("writes need tenant-wide reach; an outlet-only manager gets 403", async () => {
    const response = await post(hrOutletOnly, "/api/hris/checklist-templates", {
      kind: "onboarding",
      positionId: null,
      title: "Outlet saja",
      items: [item("ck_scope", "documents", 0)],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });

  it("creates, lists, refuses a second active template and bumps the version on an item edit", async () => {
    const created = await createTemplate(hr, positionKasir, [
      item("ck_ktp", "documents", 0, true),
      item("ck_seragam", "uniform", 1),
    ]);
    expect(created.version).toBe(1);

    const duplicate = await post(hr, "/api/hris/checklist-templates", {
      kind: "onboarding",
      positionId: positionKasir,
      title: "Kembar",
      items: [item("ck_dup", "documents", 0)],
    });
    expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(409);

    const listed = await hr.get(
      `/api/hris/checklist-templates?kind=onboarding&positionId=${positionKasir}&isActive=true`,
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data.map((row: { id: string }) => row.id)).toEqual([
      created.id,
    ]);

    const renamed = await patch(
      hr,
      `/api/hris/checklist-templates/${created.id}`,
      { title: "Template kasir" },
    );
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.data.version).toBe(1);

    const edited = await patch(
      hr,
      `/api/hris/checklist-templates/${created.id}`,
      {
        items: [
          item("ck_ktp", "documents", 0, true),
          item("ck_seragam", "uniform", 1),
          item("ck_pelatihan", "training", 2),
        ],
      },
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data.version).toBe(2);
    expect(edited.body.data.items).toHaveLength(3);
    expect(
      await auditCount("hris.checklist_template.updated", created.id),
    ).toBe(2);
  });

  it("rejects an offboarding category on an onboarding template and a duplicate item code with 422", async () => {
    for (const items of [
      [item("ck_aset", "asset", 0)],
      [item("ck_same", "documents", 0), item("ck_same", "uniform", 1)],
    ])
      expect(
        (
          await post(hr, "/api/hris/checklist-templates", {
            kind: "onboarding",
            positionId: null,
            title: "Tidak sah",
            items,
          })
        ).status,
      ).toBe(422);
  });

  it("answers 404 for an unknown position and an unknown template", async () => {
    expect(
      (
        await post(hr, "/api/hris/checklist-templates", {
          kind: "onboarding",
          positionId: randomUUID(),
          title: "Jabatan hilang",
          items: [item("ck_gone", "documents", 0)],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await patch(hr, `/api/hris/checklist-templates/${randomUUID()}`, {
          title: "Hilang",
        })
      ).status,
    ).toBe(404);
  });
});

// ---- onboarding ---------------------------------------------------------------

describe("onboarding start", () => {
  it("answers 409 when no template matches the position and there is no default", async () => {
    const response = await post(
      hr,
      `/api/hris/employees/${empNoPosition}/onboarding`,
      {},
    );
    expect(response.status, JSON.stringify(response.body)).toBe(409);
  });

  it("copies the position template, and a repeat returns the same tasks without writing", async () => {
    const first = await post(
      hr,
      `/api/hris/employees/${empStaff}/onboarding`,
      {},
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const tasks = first.body.data as Task[];
    expect(tasks.map((task) => task.code)).toEqual([
      "ck_ktp",
      "ck_seragam",
      "ck_pelatihan",
    ]);
    expect(tasks.every((task) => task.status === "open")).toBe(true);
    expect(tasks[0]!.requiresDocument).toBe(true);
    expect(await auditCount("hris.onboarding.started", empStaff)).toBe(1);

    const again = await post(
      hr,
      `/api/hris/employees/${empStaff}/onboarding`,
      {},
    );
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((again.body.data as Task[]).map((task) => task.id)).toEqual(
      tasks.map((task) => task.id),
    );
    expect(await tasksOf(hr, empStaff)).toHaveLength(3);
    expect(await auditCount("hris.onboarding.started", empStaff)).toBe(1);
  });

  it("falls back to the default template when the position has none", async () => {
    const template = await createTemplate(
      hr,
      null,
      [item("ck_umum", "account", 0)],
      "Template default",
    );
    const response = await post(
      hr,
      `/api/hris/employees/${empNoPosition}/onboarding`,
      {},
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const tasks = response.body.data as Task[];
    expect(tasks.map((task) => task.code)).toEqual(["ck_umum"]);
    expect(tasks[0]!.templateId).toBe(template.id);
  });

  it("lists tasks page by page with a cursor", async () => {
    const first = await hr.get(
      `/api/hris/employees/${empStaff}/checklist-tasks?limit=2`,
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.nextCursor).toEqual(expect.any(String));
    const second = await hr.get(
      `/api/hris/employees/${empStaff}/checklist-tasks?limit=2&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`,
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.meta.nextCursor).toBeNull();
  });
});

// ---- task actions -------------------------------------------------------------

describe("task actions", () => {
  it("block needs a reason; block, unblock and complete record reason and actor", async () => {
    const employeeId = await seedEmployee({ userId: null, outletId: jkt });
    const taskId = await seedTask({
      employeeId,
      code: "ck_blokir",
      category: "other",
    });

    const noReason = await act(hr, taskId, { action: "block" });
    expect(noReason.status, JSON.stringify(noReason.body)).toBe(422);

    const blocked = await act(hr, taskId, {
      action: "block",
      reason: "Menunggu berkas dari cabang",
    });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
    expect(blocked.body.data.status).toBe("blocked");
    expect(blocked.body.data.blockReason).toBe("Menunggu berkas dari cabang");

    const unblocked = await act(hr, taskId, { action: "unblock" });
    expect(unblocked.status, JSON.stringify(unblocked.body)).toBe(200);
    expect(unblocked.body.data.status).toBe("open");
    expect(unblocked.body.data.blockReason).toBeNull();

    const done = await act(hr, taskId, { action: "complete" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.status).toBe("done");
    expect(done.body.data.doneBy).toBe(hrUserId);
    expect(done.body.data.doneAt).toEqual(expect.any(String));

    const trail = await actionRows(hr, taskId);
    expect(
      trail.map((row) => [row.action, row.fromStatus, row.toStatus]),
    ).toEqual([
      ["block", "open", "blocked"],
      ["unblock", "blocked", "open"],
      ["complete", "open", "done"],
    ]);
    expect(trail[0]!.reason).toBe("Menunggu berkas dari cabang");
    expect(trail.every((row) => row.actorUserId === hrUserId)).toBe(true);
    expect(await auditCount("hris.checklist_task.complete", taskId)).toBe(1);
  });

  it("waive needs a reason; the action row keeps reason and actor; waived is terminal", async () => {
    const employeeId = await seedEmployee({ userId: null, outletId: jkt });
    const taskId = await seedTask({
      employeeId,
      code: "ck_bebas",
      category: "uniform",
    });

    const noReason = await act(hr, taskId, { action: "waive" });
    expect(noReason.status, JSON.stringify(noReason.body)).toBe(422);
    const blank = await act(hr, taskId, { action: "waive", reason: "   " });
    expect(blank.status, JSON.stringify(blank.body)).toBe(422);
    expect((await tasksOf(hr, employeeId))[0]!.status).toBe("open");

    const waived = await act(hr, taskId, {
      action: "waive",
      reason: "Karyawan memakai seragam sendiri",
    });
    expect(waived.status, JSON.stringify(waived.body)).toBe(200);
    expect(waived.body.data.status).toBe("waived");
    expect(waived.body.data.waiveReason).toBe(
      "Karyawan memakai seragam sendiri",
    );
    const trail = await actionRows(hr, taskId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: "waive",
      fromStatus: "open",
      toStatus: "waived",
      reason: "Karyawan memakai seragam sendiri",
      actorUserId: hrUserId,
    });

    for (const action of ["complete", "block", "waive", "unblock"])
      expect(
        (await act(hr, taskId, { action, reason: "Lagi" })).status,
        action,
      ).toBe(409);
    expect(await actionRows(hr, taskId)).toHaveLength(1);
  });

  it("done is terminal: every further action answers 409", async () => {
    const employeeId = await seedEmployee({ userId: null, outletId: jkt });
    const taskId = await seedTask({
      employeeId,
      code: "ck_selesai",
      category: "other",
    });
    expect((await act(hr, taskId, { action: "complete" })).status).toBe(200);
    for (const action of ["complete", "block", "waive", "unblock"])
      expect(
        (await act(hr, taskId, { action, reason: "Lagi" })).status,
        action,
      ).toBe(409);
  });

  it("a task that requires a document refuses complete without one (422), with another employee's document (422), and accepts the employee's own", async () => {
    const employeeId = await seedEmployee({ userId: null, outletId: jkt });
    const taskId = await seedTask({
      employeeId,
      code: "ck_ktp_wajib",
      category: "documents",
      requiresDocument: true,
    });
    const none = await act(hr, taskId, { action: "complete" });
    expect(none.status, JSON.stringify(none.body)).toBe(422);

    const foreignDocument = await seedDocument(empStaff2, jkt);
    const foreign = await act(hr, taskId, {
      action: "complete",
      documentId: foreignDocument,
    });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(422);
    expect((await tasksOf(hr, employeeId))[0]!.status).toBe("open");

    const ownDocument = await seedDocument(employeeId, jkt);
    const done = await act(hr, taskId, {
      action: "complete",
      documentId: ownDocument,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.documentId).toBe(ownDocument);
    expect((await actionRows(hr, taskId))[0]!.documentId).toBe(ownDocument);
  });

  it("refuses a manual complete of a system managed task with 409 TASK_SYSTEM_MANAGED", async () => {
    const employeeId = await seedEmployee({ userId: null, outletId: jkt });
    const taskId = await seedTask({
      employeeId,
      code: "ck_sistem",
      category: "account",
      systemManaged: true,
    });
    const response = await act(hr, taskId, { action: "complete" });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("TASK_SYSTEM_MANAGED");
    expect((await tasksOf(hr, employeeId))[0]!.status).toBe("open");
    expect(await actionRows(hr, taskId)).toHaveLength(0);
  });

  it("replays an action with the same idempotency key without a second row, and refuses the key for another action", async () => {
    const employeeId = await seedEmployee({ userId: null, outletId: jkt });
    const taskId = await seedTask({
      employeeId,
      code: "ck_kunci",
      category: "other",
    });
    const idempotencyKey = key();
    const first = await act(hr, taskId, { action: "complete", idempotencyKey });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const replay = await act(hr, taskId, {
      action: "complete",
      idempotencyKey,
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data.doneAt).toBe(first.body.data.doneAt);
    expect(await actionRows(hr, taskId)).toHaveLength(1);
    const reused = await act(hr, taskId, {
      action: "waive",
      reason: "Lain",
      idempotencyKey,
    });
    expect(reused.status, JSON.stringify(reused.body)).toBe(409);
  });
});

// ---- self service ---------------------------------------------------------------

describe("self service", () => {
  it("the employee completes their own documents and training tasks only", async () => {
    const documents = await seedTask({
      employeeId: empStaff2,
      code: "ck_self_doc",
      category: "documents",
    });
    const training = await seedTask({
      employeeId: empStaff2,
      code: "ck_self_training",
      category: "training",
    });
    const uniform = await seedTask({
      employeeId: empStaff2,
      code: "ck_self_uniform",
      category: "uniform",
    });

    // staff (employee A) cannot touch employee B's tasks: looks like a missing row.
    expect((await act(staff, documents, { action: "complete" })).status).toBe(
      404,
    );

    const done = await act(staff2, documents, { action: "complete" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.status).toBe("done");
    expect((await act(staff2, training, { action: "complete" })).status).toBe(
      200,
    );

    // Not documents or training, and never block, unblock or waive.
    expect((await act(staff2, uniform, { action: "complete" })).status).toBe(
      403,
    );
    expect(
      (await act(staff2, uniform, { action: "waive", reason: "Tidak perlu" }))
        .status,
    ).toBe(403);
    expect(
      (await act(staff2, uniform, { action: "block", reason: "Tunda" })).status,
    ).toBe(403);
    expect(
      (await tasksOf(hr, empStaff2)).find((t) => t.id === uniform)!.status,
    ).toBe("open");
  });

  it("the employee reads their own tasks but not the action trail or the templates", async () => {
    const own = await staff2.get(
      `/api/hris/employees/${empStaff2}/checklist-tasks`,
    );
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data.length).toBeGreaterThan(0);
    expect(
      (await staff.get(`/api/hris/employees/${empStaff2}/checklist-tasks`))
        .status,
    ).toBe(404);
    const taskId = (own.body.data as Task[])[0]!.id;
    expect(
      (await staff2.get(`/api/hris/checklist-tasks/${taskId}/actions`)).status,
    ).toBe(403);
  });
});

// ---- scope and isolation ------------------------------------------------------

describe("outlet scope and tenant isolation", () => {
  it("[HR-01] a manager of another outlet gets 404 for the employee's tasks and actions; a view-only role cannot act", async () => {
    const tasks = await tasksOf(hr, empStaff);
    const taskId = tasks[0]!.id;
    expect(
      (await hrOther.get(`/api/hris/employees/${empStaff}/checklist-tasks`))
        .status,
    ).toBe(404);
    expect((await act(hrOther, taskId, { action: "complete" })).status).toBe(
      404,
    );
    expect(
      (await hrOther.get(`/api/hris/checklist-tasks/${taskId}/actions`)).status,
    ).toBe(404);
    expect(
      (await post(hrOther, `/api/hris/employees/${empStaff}/onboarding`, {}))
        .status,
    ).toBe(404);

    // The view-only role of the right outlet reads, but may not act.
    expect((await tasksOf(viewer, empStaff)).length).toBe(3);
    expect((await act(viewer, taskId, { action: "complete" })).status).toBe(
      403,
    );
    expect((await actionRows(viewer, tasks[0]!.id)).length).toBe(0);

    // The outlet-only manager of the right outlet may act on tasks.
    expect(
      (await act(hrOutletOnly, tasks[1]!.id, { action: "complete" })).status,
    ).toBe(200);
  });

  it("[TEN-01] another tenant's employee and task are not reachable and RLS hides this tenant's rows from it", async () => {
    tenantB = await createSecondTenant(owner, "checklist");
    tenantBEmployee = randomUUID();
    const tenantBTask = randomUUID();
    await owner.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, NULL, $3, 'Karyawan Tenant B', $4, 'pkwtt', '2025-03-01', 'onboarding')`,
      [
        tenantBEmployee,
        tenantB.tenantId,
        `TB-${tenantBEmployee.slice(0, 8).toUpperCase()}`,
        tenantB.outletId,
      ],
    );
    await owner.query(
      `INSERT INTO hris_checklist_tasks (id, tenant_id, employee_id, kind, code, title, category, sort_order)
       VALUES ($1, $2, $3, 'onboarding', 'ck_tenant_b', 'Tugas tenant B', 'other', 0)`,
      [tenantBTask, tenantB.tenantId, tenantBEmployee],
    );

    expect(
      (await hr.get(`/api/hris/employees/${tenantBEmployee}/checklist-tasks`))
        .status,
    ).toBe(404);
    expect(
      (await post(hr, `/api/hris/employees/${tenantBEmployee}/onboarding`, {}))
        .status,
    ).toBe(404);
    expect((await act(hr, tenantBTask, { action: "complete" })).status).toBe(
      404,
    );
    expect(
      (await hr.get(`/api/hris/checklist-tasks/${tenantBTask}/actions`)).status,
    ).toBe(404);
    const tenantBStatus = await owner.query(
      "SELECT status FROM hris_checklist_tasks WHERE id = $1",
      [tenantBTask],
    );
    expect(tenantBStatus.rows[0].status).toBe("open");

    // Row level security: tenant B sees and changes none of tenant A's rows.
    const [tenantATask] = await tasksOf(hr, empStaff);
    for (const [table, rowId] of [
      ["hris_checklist_tasks", tenantATask!.id],
    ] as const) {
      const asA = await asRlsTenant(appPool, tenant.id, (client) =>
        client.query(`SELECT id FROM ${table} WHERE id = $1`, [rowId]),
      );
      expect(asA.rowCount, `${table} visible to its tenant`).toBe(1);
      const asB = await asRlsTenant(
        appPool,
        tenantB!.tenantId,
        async (client) => {
          const seen = await client.query(
            `SELECT id FROM ${table} WHERE id = $1`,
            [rowId],
          );
          const updated = await client.query(
            `UPDATE ${table} SET tenant_id = tenant_id WHERE id = $1`,
            [rowId],
          );
          const deleted = await client.query(
            `DELETE FROM ${table} WHERE id = $1`,
            [rowId],
          );
          return [seen.rowCount, updated.rowCount, deleted.rowCount];
        },
      );
      expect(asB, `${table} hidden from another tenant`).toEqual([0, 0, 0]);
    }
    const templates = await asRlsTenant(appPool, tenantB!.tenantId, (client) =>
      client.query("SELECT id FROM hris_checklist_templates"),
    );
    expect(templates.rowCount).toBe(0);
  });
});
