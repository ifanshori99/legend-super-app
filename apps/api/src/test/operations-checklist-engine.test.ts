// Checklist engine acceptance (bead legend-5v69; PRD v1.7 §3 F45 "Operasional
// Harian", OPS-01). Covers the gaps around the existing checklist API:
//   1. template versioning + run snapshot,
//   2. recording an item that is not in the run's snapshot,
//   3. manual run assignment rules (role, shift),
//   4. the scheduler (`generateScheduledChecklistRuns`),
//   5. the 15-minute missed alert and the exactly-once failed alert,
//   6. tenant / outlet isolation of generation and the sweep.
// HTTP sections (1-3, failed alert) use the real Express app against the
// seeded Cafe Legend tenant. Scheduler sections (4-6) call the services with
// a fixed clock inside the restricted app role (RLS enforced), in two private
// tenants so counts are exact. No real waits anywhere.
//
// Assumptions (the PRD does not pin these down):
//   - A scheduled run is born `pending` with `scheduled = true`.
//   - Assignee order (outlet-scoped holder, then oldest assignment, then
//     lowest user id) is taken from the sub-brief, section B rule 3.
//   - Expired / not-yet-valid role assignments never count as "holding" a role.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  checklistAlertDeadline,
  getChecklistRun,
  updateChecklistTemplate,
} from "@starter/shared/operations";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { opsChecklistRuns } from "../db/schema/operations.ts";
import { generateScheduledChecklistRuns } from "../services/operations-checklist-scheduler.service.ts";
import { sweepMissedChecklistRuns } from "../services/operations-escalation.service.ts";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const seededTenant = cafeLegendPlatformFixtures.tenant;
const seededOutletA = cafeLegendPlatformFixtures.outlets[0];

const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

/**
 * 2026-11-02 18:00Z. That is 2026-11-03 01:00 in Jakarta (WIB, +7) and
 * 02:00 in Makassar (WITA, +8): the outlet-local date differs from the UTC
 * date, so a UTC-date bug cannot pass.
 */
const NOW = new Date("2026-11-02T18:00:00.000Z");
const SHIFT_DATE = "2026-11-03";
const JAKARTA_DUE_0800 = "2026-11-03T01:00:00.000Z";
const MAKASSAR_DUE_0800 = "2026-11-03T00:00:00.000Z";
const minutesAfter = (date: Date, minutes: number) =>
  new Date(date.getTime() + minutes * 60_000);
const daysBefore = (date: Date, days: number) =>
  new Date(date.getTime() - days * 86_400_000);

// ------------------------------------------------------------ owner helpers

/** Owner connection with the tenant settings FORCE RLS requires. */
async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

const createdUserIds: string[] = [];

/** A bare user row (no session): enough to hold a role assignment. */
async function seedUser(): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Engine test user', $2)`,
    [id, `${id}@example.test`],
  );
  createdUserIds.push(id);
  return id;
}

async function seedRole(tenant: string, label: string): Promise<string> {
  const id = randomUUID();
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, '["outlet","tenant"]')`,
      [
        id,
        tenant,
        `Engine test role ${label} ${id.slice(0, 8)}`,
        JSON.stringify(["ops.checklist.complete"]),
      ],
    ),
  );
  return id;
}

async function assignRole(
  tenant: string,
  options: {
    userId: string;
    roleId: string;
    outletId?: string;
    validFrom: Date;
    validUntil?: Date | null;
  },
) {
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $2)`,
      [
        tenant,
        options.userId,
        options.roleId,
        options.outletId ? "outlet" : "tenant",
        options.outletId ?? null,
        options.validFrom.toISOString(),
        options.validUntil?.toISOString() ?? null,
      ],
    ),
  );
}

/** One checklist template written directly by the owner role. */
async function seedTemplate(
  tenant: string,
  outletId: string,
  options: {
    name: string;
    roleId: string | null;
    dueTime: string;
    version?: number;
    shiftTemplateId?: string | null;
    /** Fixed id, so a test can control the order templates are stored in. */
    id?: string;
  },
) {
  const id = options.id ?? randomUUID();
  const items = [
    {
      id: randomUUID(),
      label: "Kasir dibuka dan dihitung",
      instruction: null,
      requiredEvidence: [],
    },
    {
      id: randomUUID(),
      label: "Lantai dipel",
      instruction: null,
      requiredEvidence: [],
    },
  ];
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO ops_checklist_templates
         (id, tenant_id, outlet_id, name, type, items, schedule, role_id, version)
       VALUES ($1, $2, $3, $4, 'opening', $5, $6, $7, $8)`,
      [
        id,
        tenant,
        outletId,
        options.name,
        JSON.stringify(items),
        JSON.stringify({
          shiftTemplateId: options.shiftTemplateId ?? null,
          stationId: null,
          zoneId: null,
          dueTime: options.dueTime,
        }),
        options.roleId,
        options.version ?? 1,
      ],
    ),
  );
  return { id, items };
}

type RunRow = {
  id: string;
  outlet_id: string;
  template_id: string;
  template_version: number;
  shift_date: string;
  shift_template_id: string | null;
  assigned_to: string;
  due_at: Date;
  status: string;
  scheduled: boolean;
  results: unknown[];
  items: { id: string; label: string }[];
  missed_at: Date | null;
  alerted_at: Date | null;
};

/** Every run of one tenant, read through the owner role. */
async function readRuns(tenant: string): Promise<RunRow[]> {
  const { rows } = await asOwner(tenant, (client) =>
    client.query<RunRow>(
      `SELECT id, outlet_id, template_id, template_version, shift_date::text AS shift_date,
              shift_template_id, assigned_to, due_at, status, scheduled, results, items,
              missed_at, alerted_at
         FROM ops_checklist_runs WHERE tenant_id = $1 ORDER BY id`,
      [tenant],
    ),
  );
  return rows;
}

type OutboxRow = {
  destination: string;
  event: { name: string; payload: Record<string, unknown> };
};

async function readOutbox(tenant: string, runId: string): Promise<OutboxRow[]> {
  const { rows } = await asOwner(tenant, (client) =>
    client.query<OutboxRow>(
      `SELECT destination, event
         FROM domain_event_outbox
        WHERE tenant_id = $1 AND aggregate_type = 'checklist' AND aggregate_id = $2
        ORDER BY sequence`,
      [tenant, runId],
    ),
  );
  return rows;
}

// ----------------------------------------------------- engine tenants (4-6)

const base = (tenant: string) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const tenantScope = (tenant: string) =>
  establishScopedTenantContext(base(tenant), { kind: "tenant" });
const outletScope = (tenant: string, outletId: string) =>
  establishScopedTenantContext(base(tenant), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

type EngineTenant = {
  id: string;
  jakarta: string;
  makassar: string | null;
};

const engineTenants: EngineTenant[] = [];

/** A private tenant with its own outlet(s); copies plan data from the seed. */
async function createEngineTenant(
  label: string,
  outletZones: string[],
): Promise<EngineTenant> {
  const id = randomUUID();
  const brandId = randomUUID();
  const entityId = randomUUID();
  await ownerPool.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, $3, plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $4`,
    [
      id,
      `engine-${label}-${id.slice(0, 8)}`,
      `Engine ${label}`,
      seededTenant.id,
    ],
  );
  const outletIds = outletZones.map(() => randomUUID());
  await asOwner(id, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand')`,
      [brandId, id],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Engine', false)`,
      [entityId, id],
    );
    for (const [index, zone] of outletZones.entries())
      await client.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Engine', $7,
                 '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
        [
          outletIds[index],
          id,
          brandId,
          entityId,
          `E-0${index + 1}`,
          `Outlet ${index + 1}`,
          zone,
        ],
      );
  });
  const tenant = {
    id,
    jakarta: outletIds[0],
    makassar: outletIds[1] ?? null,
  };
  engineTenants.push(tenant);
  return tenant;
}

/** Drops checklist data of the engine tenants so every test counts from zero. */
async function resetEngineData() {
  for (const tenant of engineTenants)
    await asOwner(tenant.id, async (client) => {
      await client.query(
        "DELETE FROM domain_event_outbox WHERE tenant_id = $1",
        [tenant.id],
      );
      await client.query(
        "DELETE FROM ops_checklist_runs WHERE tenant_id = $1",
        [tenant.id],
      );
      await client.query(
        "DELETE FROM ops_checklist_templates WHERE tenant_id = $1",
        [tenant.id],
      );
      await client.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
        tenant.id,
      ]);
      await client.query("DELETE FROM roles WHERE tenant_id = $1", [tenant.id]);
    });
}

let tenantA: EngineTenant;
let tenantB: EngineTenant;

// -------------------------------------------------------------- HTTP helpers

type Session = { client: ReturnType<typeof agent>; userId: string };

const httpUserIds: string[] = [];
const httpTemplateIds: string[] = [];
const httpRunIds: string[] = [];
const httpRoleIds: string[] = [];
const httpMediaIds: string[] = [];

/** A fresh idempotency key: the tenant-wide key space is shared. */
const key = () => `legend-5v69-${randomUUID()}`;

async function signedIn(name: string): Promise<Session> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  httpUserIds.push(userId);
  return { client, userId };
}

let staff: Session;

function templateInput(overrides: Record<string, unknown> = {}) {
  return {
    outletId: seededOutletA.id,
    name: "Checklist engine legend-5v69",
    type: "opening",
    items: [
      { label: "Suhu chiller", requiredEvidence: [] },
      { label: "Lantai dipel", requiredEvidence: [] },
    ],
    schedule: {
      shiftTemplateId: null,
      stationId: null,
      zoneId: null,
      dueTime: "08:00",
    },
    roleId: null,
    ...overrides,
  };
}

async function postTemplate(overrides: Record<string, unknown> = {}) {
  const response = await staff.client
    .post("/api/operations/checklist-templates")
    .set(originHeader)
    .send({ ...templateInput(overrides), idempotencyKey: key() });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  httpTemplateIds.push(response.body.data.id as string);
  return response.body.data;
}

/** Raw run request: the caller checks the status (errors are under test). */
function requestRun(templateId: string, body: Record<string, unknown>) {
  return staff.client
    .post("/api/operations/checklist-runs")
    .set(originHeader)
    .send({
      outletId: seededOutletA.id,
      templateId,
      shiftDate: "2030-01-15",
      idempotencyKey: key(),
      ...body,
    });
}

async function postRun(templateId: string, body: Record<string, unknown>) {
  const response = await requestRun(templateId, body);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  httpRunIds.push(response.body.data.id as string);
  return response.body.data;
}

function patchTemplateItems(
  template: { id: string; updatedAt: string },
  items: Record<string, unknown>[],
) {
  return staff.client
    .patch(`/api/operations/checklist-templates/${template.id}`)
    .set(originHeader)
    .send({
      items,
      expectedUpdatedAt: template.updatedAt,
      idempotencyKey: key(),
    });
}

function transition(runId: string, action: string, idempotencyKey = key()) {
  return staff.client
    .post(`/api/operations/checklist-runs/${runId}/transition`)
    .set(originHeader)
    .send({ action, idempotencyKey });
}

function recordResult(
  runId: string,
  itemId: string,
  body: Record<string, unknown> = {},
) {
  return staff.client
    .post(`/api/operations/checklist-runs/${runId}/items/${itemId}/result`)
    .set(originHeader)
    .send({
      status: "done",
      numberValue: null,
      note: null,
      photoMediaIds: [],
      signatureMediaId: null,
      ...body,
      idempotencyKey: key(),
    });
}

// ----------------------------------------------------------------- lifecycle

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // Tenant-scoped owner on the seeded tenant: holds every `ops.*` permission.
  staff = await signedIn("Engine Owner");
  await ownerPool.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 day', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [seededTenant.id, staff.userId],
  );
  tenantA = await createEngineTenant("a", ["Asia/Jakarta", "Asia/Makassar"]);
  tenantB = await createEngineTenant("b", ["Asia/Jakarta"]);
});

afterEach(resetEngineData);

afterAll(async () => {
  await resetEngineData();
  await asOwner(seededTenant.id, async (client) => {
    if (httpRunIds.length > 0) {
      await client.query(
        `DELETE FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->'payload'->>'runId' = ANY($2)`,
        [seededTenant.id, httpRunIds],
      );
      await client.query("DELETE FROM ops_checklist_runs WHERE id = ANY($1)", [
        httpRunIds,
      ]);
    }
    if (httpTemplateIds.length > 0)
      await client.query(
        "DELETE FROM ops_checklist_templates WHERE id = ANY($1)",
        [httpTemplateIds],
      );
    await client.query(
      "DELETE FROM operations_idempotency WHERE tenant_id = $1 AND key LIKE 'legend-5v69-%'",
      [seededTenant.id],
    );
    if (httpMediaIds.length > 0)
      await client.query(
        "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2)",
        [seededTenant.id, httpMediaIds],
      );
    if (httpRoleIds.length > 0) {
      await client.query(
        "DELETE FROM role_assignments WHERE role_id = ANY($1)",
        [httpRoleIds],
      );
      await client.query("DELETE FROM roles WHERE id = ANY($1)", [httpRoleIds]);
    }
  });
  const allUsers = [...httpUserIds, ...createdUserIds];
  if (allUsers.length > 0) {
    await ownerPool.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1)",
      [allUsers],
    );
    await ownerPool.query('DELETE FROM "user" WHERE id = ANY($1)', [allUsers]);
  }
  for (const tenant of engineTenants)
    await asOwner(tenant.id, async (client) => {
      await client.query("DELETE FROM outlets WHERE tenant_id = $1", [
        tenant.id,
      ]);
      await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
        tenant.id,
      ]);
      await client.query("DELETE FROM brands WHERE tenant_id = $1", [
        tenant.id,
      ]);
    });
  for (const tenant of engineTenants)
    await ownerPool.query("DELETE FROM tenants WHERE id = $1", [tenant.id]);
  await ownerPool.end();
});

// ===================================================== 1. template versioning

describe("Checklist template versioning (legend-5v69)", () => {
  it("[legend-5v69][OPS-01] an item edit bumps the template version, and a run made earlier keeps version 1 and its old items", async () => {
    const template = await postTemplate();
    expect(template.version).toBe(1);
    const oldLabels = template.items.map(
      (item: { label: string }) => item.label,
    );

    const run = await postRun(template.id, { assignedTo: staff.userId });
    expect(run.templateVersion).toBe(1);

    const edited = await patchTemplateItems(template, [
      { label: "Item pengganti", requiredEvidence: [] },
    ]);
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    updateChecklistTemplate.response.parse(edited.body);
    expect(edited.body.data.version).toBe(2);

    // GET re-read: the run is a frozen snapshot of version 1.
    const reread = await staff.client.get(
      `/api/operations/checklist-runs/${run.id}`,
    );
    expect(reread.status, JSON.stringify(reread.body)).toBe(200);
    getChecklistRun.response.parse(reread.body);
    expect(reread.body.data.templateVersion).toBe(1);
    expect(
      reread.body.data.items.map((item: { label: string }) => item.label),
    ).toEqual(oldLabels);
    expect(reread.body.data.items).toEqual(run.items);

    // A run created after the edit snapshots version 2.
    const later = await postRun(template.id, {
      assignedTo: staff.userId,
      shiftDate: "2030-01-16",
    });
    expect(later.templateVersion).toBe(2);
    expect(later.items.map((item: { label: string }) => item.label)).toEqual([
      "Item pengganti",
    ]);
  });

  it("[legend-5v69][OPS-01] a name-only edit keeps the version (no new snapshot is warranted)", async () => {
    const template = await postTemplate();
    const renamed = await staff.client
      .patch(`/api/operations/checklist-templates/${template.id}`)
      .set(originHeader)
      .send({
        name: "Nama baru legend-5v69",
        expectedUpdatedAt: template.updatedAt,
        idempotencyKey: key(),
      });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.data.version).toBe(1);
  });
});

// ================================================ 2. item not in the run

describe("Recording an item outside the run snapshot (legend-5v69)", () => {
  it("[legend-5v69][OPS-01] an item added to the template after the run was made is refused with 404 CHECKLIST_ITEM_NOT_IN_RUN", async () => {
    const template = await postTemplate({
      items: [{ label: "Satu butir", requiredEvidence: [] }],
    });
    const run = await postRun(template.id, { assignedTo: staff.userId });
    const started = await transition(run.id, "start");
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    const edited = await patchTemplateItems(template, [
      { id: template.items[0].id, label: "Satu butir", requiredEvidence: [] },
      { label: "Butir baru", requiredEvidence: [] },
    ]);
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const addedItem = edited.body.data.items.find(
      (item: { label: string }) => item.label === "Butir baru",
    );
    expect(addedItem?.id).toBeTruthy();

    const refused = await recordResult(run.id, addedItem.id as string);
    expect(refused.status, JSON.stringify(refused.body)).toBe(404);
    expect(refused.body.error.code).toBe("CHECKLIST_ITEM_NOT_IN_RUN");

    // A random id is refused the same way, and nothing was written.
    const unknown = await recordResult(run.id, randomUUID());
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("CHECKLIST_ITEM_NOT_IN_RUN");
    const reread = await staff.client.get(
      `/api/operations/checklist-runs/${run.id}`,
    );
    expect(reread.body.data.results).toEqual([]);

    // The item the run does hold is accepted.
    const accepted = await recordResult(run.id, run.items[0].id as string);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  });
});

// ======================================================= 3. manual assignment

describe("Manual run assignment rules (legend-5v69)", () => {
  async function roleHolder() {
    const roleId = await seedRole(seededTenant.id, "http");
    httpRoleIds.push(roleId);
    const holder = await signedIn("Engine Role Holder");
    await assignRole(seededTenant.id, {
      userId: holder.userId,
      roleId,
      outletId: seededOutletA.id,
      validFrom: daysBefore(new Date(), 1),
    });
    return { roleId, holder };
  }

  it("[legend-5v69][OPS-01] a template with a role accepts only an assignee who holds that role", async () => {
    const { roleId, holder } = await roleHolder();
    const template = await postTemplate({ roleId });

    // staff is an owner, not a holder of this role: 422.
    const refused = await requestRun(template.id, { assignedTo: staff.userId });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error.code).toBe("VALIDATION_ERROR");

    // A user with no role at all is refused as well.
    const nobody = await seedUser();
    const none = await requestRun(template.id, { assignedTo: nobody });
    expect(none.status, JSON.stringify(none.body)).toBe(422);

    const ok = await postRun(template.id, { assignedTo: holder.userId });
    expect(ok.assignedTo).toBe(holder.userId);

    // A holder whose assignment already ended no longer counts.
    const former = await seedUser();
    await assignRole(seededTenant.id, {
      userId: former,
      roleId,
      outletId: seededOutletA.id,
      validFrom: daysBefore(new Date(), 10),
      validUntil: daysBefore(new Date(), 1),
    });
    const expired = await requestRun(template.id, { assignedTo: former });
    expect(expired.status, JSON.stringify(expired.body)).toBe(422);
  });

  it("[legend-5v69][OPS-01] a template without a role still accepts any assignee in the outlet", async () => {
    const template = await postTemplate({ roleId: null });
    const run = await postRun(template.id, { assignedTo: staff.userId });
    expect(run.assignedTo).toBe(staff.userId);
    expect(run.shiftTemplateId).toBeNull();
  });

  it("[legend-5v69][OPS-01] the run's shift defaults from the template schedule and a different shift is refused with 422", async () => {
    const scheduledShift = randomUUID();
    const template = await postTemplate({
      schedule: {
        shiftTemplateId: scheduledShift,
        stationId: null,
        zoneId: null,
        dueTime: "08:00",
      },
    });

    // Omitted shift: taken from the template schedule.
    const defaulted = await postRun(template.id, {
      assignedTo: staff.userId,
      shiftDate: "2030-02-01",
    });
    expect(defaulted.shiftTemplateId).toBe(scheduledShift);

    // Explicit null behaves like omitted (nothing chosen by the caller).
    const nulled = await postRun(template.id, {
      assignedTo: staff.userId,
      shiftDate: "2030-02-02",
      shiftTemplateId: null,
    });
    expect(nulled.shiftTemplateId).toBe(scheduledShift);

    // The same shift is fine.
    const same = await postRun(template.id, {
      assignedTo: staff.userId,
      shiftDate: "2030-02-03",
      shiftTemplateId: scheduledShift,
    });
    expect(same.shiftTemplateId).toBe(scheduledShift);

    // A different shift contradicts the schedule.
    const mismatch = await requestRun(template.id, {
      assignedTo: staff.userId,
      shiftDate: "2030-02-04",
      shiftTemplateId: randomUUID(),
    });
    expect(mismatch.status, JSON.stringify(mismatch.body)).toBe(422);
    expect(mismatch.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ============================================================== 4. scheduler

describe("Scheduled checklist runs (legend-5v69)", () => {
  it("[legend-5v69][OPS-01] creates one pending run per role template for the outlet-local date, due in the outlet time zone, assigned to the role holder", async () => {
    const roleId = await seedRole(tenantA.id, "kasir");
    const holder = await seedUser();
    await assignRole(tenantA.id, {
      userId: holder,
      roleId,
      outletId: tenantA.jakarta,
      validFrom: daysBefore(NOW, 1),
    });
    const jakarta = await seedTemplate(tenantA.id, tenantA.jakarta, {
      name: "Buka Jakarta",
      roleId,
      dueTime: "08:00",
      version: 3,
    });
    const makassar = await seedTemplate(tenantA.id, tenantA.makassar!, {
      name: "Buka Makassar",
      roleId,
      dueTime: "08:00",
    });
    // The role is held at tenant scope too, so the Makassar outlet has a holder.
    const headOffice = await seedUser();
    await assignRole(tenantA.id, {
      userId: headOffice,
      roleId,
      validFrom: daysBefore(NOW, 1),
    });

    const context = tenantScope(tenantA.id);
    const created = await withTenant(db, context, (tx) =>
      generateScheduledChecklistRuns(tx, context, NOW),
    );
    expect(created).toBe(2);

    const runs = await readRuns(tenantA.id);
    expect(runs).toHaveLength(2);
    const jakartaRun = runs.find((run) => run.template_id === jakarta.id)!;
    const makassarRun = runs.find((run) => run.template_id === makassar.id)!;

    // The outlet-local date (not the UTC date 2026-11-02), per outlet.
    expect(jakartaRun.shift_date).toBe(SHIFT_DATE);
    expect(makassarRun.shift_date).toBe(SHIFT_DATE);
    // 08:00 on the outlet wall clock.
    expect(jakartaRun.due_at.toISOString()).toBe(JAKARTA_DUE_0800);
    expect(makassarRun.due_at.toISOString()).toBe(MAKASSAR_DUE_0800);

    expect(jakartaRun.scheduled).toBe(true);
    expect(jakartaRun.status).toBe("pending");
    expect(jakartaRun.results).toEqual([]);
    expect(jakartaRun.outlet_id).toBe(tenantA.jakarta);
    expect(jakartaRun.assigned_to).toBe(holder);
    expect(jakartaRun.template_version).toBe(3);
    expect(jakartaRun.items.map((item) => item.id)).toEqual(
      jakarta.items.map((item) => item.id),
    );
    // Makassar has no outlet-scoped holder: the tenant-scoped holder is used.
    expect(makassarRun.scheduled).toBe(true);
    expect(makassarRun.assigned_to).toBe(headOffice);
  });

  it("[legend-5v69][OPS-01] the run carries the template's shift, and a second tick creates nothing", async () => {
    const roleId = await seedRole(tenantA.id, "kasir");
    const holder = await seedUser();
    await assignRole(tenantA.id, {
      userId: holder,
      roleId,
      outletId: tenantA.jakarta,
      validFrom: daysBefore(NOW, 1),
    });
    const shiftTemplateId = randomUUID();
    await seedTemplate(tenantA.id, tenantA.jakarta, {
      name: "Buka",
      roleId,
      dueTime: "08:00",
      shiftTemplateId,
    });
    const context = tenantScope(tenantA.id);

    const first = await withTenant(db, context, (tx) =>
      generateScheduledChecklistRuns(tx, context, NOW),
    );
    expect(first).toBe(1);
    expect((await readRuns(tenantA.id))[0].shift_template_id).toBe(
      shiftTemplateId,
    );

    // Idempotent: same instant, then a later tick of the same local day.
    const second = await withTenant(db, context, (tx) =>
      generateScheduledChecklistRuns(tx, context, NOW),
    );
    expect(second).toBe(0);
    const later = await withTenant(db, context, (tx) =>
      generateScheduledChecklistRuns(tx, context, minutesAfter(NOW, 30)),
    );
    expect(later).toBe(0);
    expect(await readRuns(tenantA.id)).toHaveLength(1);
  });

  it("[legend-5v69][OPS-01] two overlapping ticks together create the run once", async () => {
    const roleId = await seedRole(tenantA.id, "kasir");
    const holder = await seedUser();
    await assignRole(tenantA.id, {
      userId: holder,
      roleId,
      outletId: tenantA.jakarta,
      validFrom: daysBefore(NOW, 1),
    });
    await seedTemplate(tenantA.id, tenantA.jakarta, {
      name: "Buka",
      roleId,
      dueTime: "08:00",
    });
    const context = tenantScope(tenantA.id);
    const results = await Promise.all([
      withTenant(db, context, (tx) =>
        generateScheduledChecklistRuns(tx, context, NOW),
      ),
      withTenant(db, context, (tx) =>
        generateScheduledChecklistRuns(tx, context, NOW),
      ),
    ]);
    expect(results[0] + results[1]).toBe(1);
    expect(await readRuns(tenantA.id)).toHaveLength(1);
  });

  it("[legend-5v69][OPS-01] a template whose due time already passed today gets no run (it would be born missed)", async () => {
    const roleId = await seedRole(tenantA.id, "kasir");
    const holder = await seedUser();
    await assignRole(tenantA.id, {
      userId: holder,
      roleId,
      outletId: tenantA.jakarta,
      validFrom: daysBefore(NOW, 1),
    });
    // Jakarta local time is 01:00 at NOW: 00:30 has passed, 01:00 is "now".
    await seedTemplate(tenantA.id, tenantA.jakarta, {
      name: "Sudah lewat",
      roleId,
      dueTime: "00:30",
    });
    await seedTemplate(tenantA.id, tenantA.jakarta, {
      name: "Tepat sekarang",
      roleId,
      dueTime: "01:00",
    });
    const upcoming = await seedTemplate(tenantA.id, tenantA.jakarta, {
      name: "Belum lewat",
      roleId,
      dueTime: "01:01",
    });
    const context = tenantScope(tenantA.id);

    const created = await withTenant(db, context, (tx) =>
      generateScheduledChecklistRuns(tx, context, NOW),
    );
    expect(created).toBe(1);
    const runs = await readRuns(tenantA.id);
    expect(runs.map((run) => run.template_id)).toEqual([upcoming.id]);
    // No run, so the sweep has nothing to alert about.
    const swept = await withTenant(db, context, (tx) =>
      sweepMissedChecklistRuns(tx, context, NOW),
    );
    expect(swept).toBe(0);
  });

  it("[legend-5v69][OPS-01] a manual run already made for a role template and today's outlet-local date is not duplicated by the scheduler", async () => {
    const roleId = await seedRole(tenantA.id, "kasir");
    const holder = await seedUser();
    await assignRole(tenantA.id, {
      userId: holder,
      roleId,
      outletId: tenantA.jakarta,
      validFrom: daysBefore(NOW, 1),
    });
    const template = await seedTemplate(tenantA.id, tenantA.jakarta, {
      name: "Buka",
      roleId,
      dueTime: "08:00",
    });
    // Assumption: a manual run is a run with scheduled = false, any assignee
    // and any due time, for the same template and the outlet-local date
    // (2026-11-03 in Jakarta, not the UTC date 2026-11-02).
    const manualRunId = randomUUID();
    await asOwner(tenantA.id, (client) =>
      client.query(
        `INSERT INTO ops_checklist_runs
           (id, tenant_id, outlet_id, template_id, template_version, shift_date,
            assigned_to, due_at, status, scheduled, results, items)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, 'pending', false, '[]', $8)`,
        [
          manualRunId,
          tenantA.id,
          tenantA.jakarta,
          template.id,
          SHIFT_DATE,
          holder,
          JAKARTA_DUE_0800,
          JSON.stringify(template.items),
        ],
      ),
    );

    const context = tenantScope(tenantA.id);
    const created = await withTenant(db, context, (tx) =>
      generateScheduledChecklistRuns(tx, context, NOW),
    );
    expect(created).toBe(0);
    const runs = await readRuns(tenantA.id);
    expect(runs.map((run) => run.id)).toEqual([manualRunId]);
    expect(runs[0].scheduled).toBe(false);
  });

  it("[legend-5v69][OPS-01] several skipped templates (past due, no role holder) do not block a later due template", async () => {
    const roleId = await seedRole(tenantA.id, "kasir");
    const holder = await seedUser();
    await assignRole(tenantA.id, {
      userId: holder,
      roleId,
      outletId: tenantA.jakarta,
      validFrom: daysBefore(NOW, 1),
    });
    // A role nobody holds: every template on it is skipped.
    const emptyRoleId = await seedRole(tenantA.id, "kosong");

    // Skipped templates get the lowest ids and are stored first; the due one
    // gets the highest id and is stored last, so any ordering puts it behind.
    const skippedIds = [1, 2, 3, 4].map(
      (n) => `00000000-0000-4000-8000-00000000000${n}`,
    );
    await seedTemplate(tenantA.id, tenantA.jakarta, {
      id: skippedIds[0],
      name: "Lewat 1",
      roleId,
      dueTime: "00:10", // Jakarta is 01:00 at NOW: already past
    });
    await seedTemplate(tenantA.id, tenantA.jakarta, {
      id: skippedIds[1],
      name: "Lewat 2",
      roleId,
      dueTime: "00:20",
    });
    await seedTemplate(tenantA.id, tenantA.jakarta, {
      id: skippedIds[2],
      name: "Tanpa pemegang 1",
      roleId: emptyRoleId,
      dueTime: "08:00",
    });
    await seedTemplate(tenantA.id, tenantA.jakarta, {
      id: skippedIds[3],
      name: "Tanpa pemegang 2",
      roleId: emptyRoleId,
      dueTime: "09:00",
    });
    const due = await seedTemplate(tenantA.id, tenantA.jakarta, {
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      name: "Masih akan datang",
      roleId,
      dueTime: "08:00",
    });

    const context = tenantScope(tenantA.id);
    const created = await withTenant(db, context, (tx) =>
      generateScheduledChecklistRuns(tx, context, NOW),
    );
    expect(created).toBe(1);
    const runs = await readRuns(tenantA.id);
    expect(runs.map((run) => run.template_id)).toEqual([due.id]);
    expect(runs[0].assigned_to).toBe(holder);
  });

  it("[legend-5v69][OPS-01] a template without a role is manual-only and never generated", async () => {
    const roleId = await seedRole(tenantA.id, "kasir");
    const holder = await seedUser();
    await assignRole(tenantA.id, {
      userId: holder,
      roleId,
      validFrom: daysBefore(NOW, 1),
    });
    await seedTemplate(tenantA.id, tenantA.jakarta, {
      name: "Manual saja",
      roleId: null,
      dueTime: "08:00",
    });
    const context = tenantScope(tenantA.id);
    const created = await withTenant(db, context, (tx) =>
      generateScheduledChecklistRuns(tx, context, NOW),
    );
    expect(created).toBe(0);
    expect(await readRuns(tenantA.id)).toHaveLength(0);
  });

  it("[legend-5v69][OPS-01] no active holder of the role means no run: ended and not-yet-started assignments do not count", async () => {
    const roleId = await seedRole(tenantA.id, "kasir");
    const ended = await seedUser();
    await assignRole(tenantA.id, {
      userId: ended,
      roleId,
      outletId: tenantA.jakarta,
      validFrom: daysBefore(NOW, 10),
      validUntil: minutesAfter(NOW, -60),
    });
    const future = await seedUser();
    await assignRole(tenantA.id, {
      userId: future,
      roleId,
      outletId: tenantA.jakarta,
      validFrom: minutesAfter(NOW, 60),
    });
    // A holder at another outlet does not cover this one.
    const elsewhere = await seedUser();
    await assignRole(tenantA.id, {
      userId: elsewhere,
      roleId,
      outletId: tenantA.makassar!,
      validFrom: daysBefore(NOW, 1),
    });
    await seedTemplate(tenantA.id, tenantA.jakarta, {
      name: "Tanpa pemegang",
      roleId,
      dueTime: "08:00",
    });
    const context = tenantScope(tenantA.id);
    const created = await withTenant(db, context, (tx) =>
      generateScheduledChecklistRuns(tx, context, NOW),
    );
    expect(created).toBe(0);
    expect(await readRuns(tenantA.id)).toHaveLength(0);
  });

  it("[legend-5v69][OPS-01] with several holders the assignee is deterministic: outlet-scoped first, then the oldest assignment", async () => {
    const roleId = await seedRole(tenantA.id, "kasir");
    const tenantWide = await seedUser();
    await assignRole(tenantA.id, {
      userId: tenantWide,
      roleId,
      validFrom: daysBefore(NOW, 30),
    });
    const outletNewer = await seedUser();
    await assignRole(tenantA.id, {
      userId: outletNewer,
      roleId,
      outletId: tenantA.jakarta,
      validFrom: daysBefore(NOW, 2),
    });
    const outletOlder = await seedUser();
    await assignRole(tenantA.id, {
      userId: outletOlder,
      roleId,
      outletId: tenantA.jakarta,
      validFrom: daysBefore(NOW, 5),
    });
    await seedTemplate(tenantA.id, tenantA.jakarta, {
      name: "Buka",
      roleId,
      dueTime: "08:00",
    });
    const context = tenantScope(tenantA.id);
    await withTenant(db, context, (tx) =>
      generateScheduledChecklistRuns(tx, context, NOW),
    );
    const runs = await readRuns(tenantA.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].assigned_to).toBe(outletOlder);
  });

  it("[legend-5v69][OPS-01][TEN-01] another tenant's templates are untouched by this tenant's generation", async () => {
    const roleA = await seedRole(tenantA.id, "kasir");
    const holderA = await seedUser();
    await assignRole(tenantA.id, {
      userId: holderA,
      roleId: roleA,
      validFrom: daysBefore(NOW, 1),
    });
    const templateA = await seedTemplate(tenantA.id, tenantA.jakarta, {
      name: "Buka A",
      roleId: roleA,
      dueTime: "08:00",
    });
    const roleB = await seedRole(tenantB.id, "kasir");
    const holderB = await seedUser();
    await assignRole(tenantB.id, {
      userId: holderB,
      roleId: roleB,
      validFrom: daysBefore(NOW, 1),
    });
    const templateB = await seedTemplate(tenantB.id, tenantB.jakarta, {
      name: "Buka B",
      roleId: roleB,
      dueTime: "08:00",
    });

    const contextA = tenantScope(tenantA.id);
    const createdA = await withTenant(db, contextA, (tx) =>
      generateScheduledChecklistRuns(tx, contextA, NOW),
    );
    expect(createdA).toBe(1);
    expect((await readRuns(tenantA.id)).map((run) => run.template_id)).toEqual([
      templateA.id,
    ]);
    // Tenant B has not been generated for yet.
    expect(await readRuns(tenantB.id)).toHaveLength(0);

    const contextB = tenantScope(tenantB.id);
    const createdB = await withTenant(db, contextB, (tx) =>
      generateScheduledChecklistRuns(tx, contextB, NOW),
    );
    expect(createdB).toBe(1);
    const runsB = await readRuns(tenantB.id);
    expect(runsB.map((run) => run.template_id)).toEqual([templateB.id]);
    expect(runsB[0].assigned_to).toBe(holderB);
    // Tenant A did not get a second run from tenant B's tick.
    expect(await readRuns(tenantA.id)).toHaveLength(1);
  });
});

// ============================================================= 5. alert <= 15 min

describe("Checklist alerts (legend-5v69)", () => {
  it("[legend-5v69][OPS-01] a generated run missed one minute after its deadline queues exactly one checklist.missed notification within 15 minutes", async () => {
    const roleId = await seedRole(tenantA.id, "kasir");
    const holder = await seedUser();
    await assignRole(tenantA.id, {
      userId: holder,
      roleId,
      outletId: tenantA.jakarta,
      validFrom: daysBefore(NOW, 1),
    });
    await seedTemplate(tenantA.id, tenantA.jakarta, {
      name: "Buka",
      roleId,
      dueTime: "08:00",
    });
    const context = tenantScope(tenantA.id);
    await withTenant(db, context, (tx) =>
      generateScheduledChecklistRuns(tx, context, NOW),
    );
    const [run] = await readRuns(tenantA.id);
    const dueAt = run.due_at;
    expect(dueAt.toISOString()).toBe(JAKARTA_DUE_0800);

    // Before the deadline nothing is missed and nothing is queued.
    const early = await withTenant(db, context, (tx) =>
      sweepMissedChecklistRuns(tx, context, minutesAfter(dueAt, -1)),
    );
    expect(early).toBe(0);
    expect(await readOutbox(tenantA.id, run.id)).toHaveLength(0);

    const detectedAt = minutesAfter(dueAt, 1);
    const marked = await withTenant(db, context, (tx) =>
      sweepMissedChecklistRuns(tx, context, detectedAt),
    );
    expect(marked).toBe(1);

    const after = (await readRuns(tenantA.id))[0];
    expect(after.status).toBe("missed");
    expect(after.missed_at?.toISOString()).toBe(detectedAt.toISOString());
    expect(after.alerted_at?.toISOString()).toBe(detectedAt.toISOString());

    const events = (await readOutbox(tenantA.id, run.id)).filter(
      (row) => row.event.name === "checklist.missed",
    );
    expect(events).toHaveLength(1);
    expect(events[0].destination).toBe("notification");
    expect(events[0].event.payload).toMatchObject({
      runId: run.id,
      assignedTo: holder,
      dueAt: dueAt.toISOString(),
    });
    const detected = events[0].event.payload.detectedAt as string;
    expect(Date.parse(detected)).toBeLessThanOrEqual(
      Date.parse(checklistAlertDeadline(dueAt.toISOString())),
    );

    // A second sweep (even later) queues nothing more.
    const again = await withTenant(db, context, (tx) =>
      sweepMissedChecklistRuns(tx, context, minutesAfter(dueAt, 5)),
    );
    expect(again).toBe(0);
    expect(
      (await readOutbox(tenantA.id, run.id)).filter(
        (row) => row.event.name === "checklist.missed",
      ),
    ).toHaveLength(1);

    // The scheduler does not resurrect or duplicate a missed run later that
    // same local day (it is also past due, so nothing new is born missed).
    const regenerated = await withTenant(db, context, (tx) =>
      generateScheduledChecklistRuns(tx, context, minutesAfter(dueAt, 6)),
    );
    expect(regenerated).toBe(0);
    expect(await readRuns(tenantA.id)).toHaveLength(1);
  });

  it("[legend-5v69][OPS-01] a failed run emits exactly one checklist.failed even when the transition request is replayed", async () => {
    const template = await postTemplate({
      items: [{ label: "Suhu chiller", requiredEvidence: [] }],
    });
    const run = await postRun(template.id, { assignedTo: staff.userId });
    const started = await transition(run.id, "start");
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const answered = await recordResult(run.id, run.items[0].id as string, {
      status: "failed",
      note: "Chiller terlalu hangat",
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);

    const replayKey = key();
    const first = await transition(run.id, "fail", replayKey);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.status).toBe("failed");
    const replay = await transition(run.id, "fail", replayKey);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data.status).toBe("failed");

    const alerts = (await readOutbox(seededTenant.id, run.id)).filter(
      (row) => row.event.name === "checklist.failed",
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].destination).toBe("notification");
    expect(alerts[0].event.payload.failedItemIds).toEqual([run.items[0].id]);

    // A new request (new key) on a run that already failed is refused and
    // still raises no second alert.
    const again = await transition(run.id, "fail");
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CHECKLIST_TRANSITION_INVALID");
    expect(
      (await readOutbox(seededTenant.id, run.id)).filter(
        (row) => row.event.name === "checklist.failed",
      ),
    ).toHaveLength(1);
  });
});

// ================================================================= 6. isolation

describe("Checklist engine isolation (legend-5v69)", () => {
  async function seedGeneratableTemplate(
    tenant: EngineTenant,
    outletId: string,
  ) {
    const roleId = await seedRole(tenant.id, "kasir");
    const holder = await seedUser();
    await assignRole(tenant.id, {
      userId: holder,
      roleId,
      validFrom: daysBefore(NOW, 1),
    });
    return seedTemplate(tenant.id, outletId, {
      name: "Buka",
      roleId,
      dueTime: "08:00",
    });
  }

  it("[legend-5v69][TEN-03] an outlet-scoped caller neither generates for nor sees another outlet's runs", async () => {
    const template = await seedGeneratableTemplate(tenantA, tenantA.jakarta);
    const otherOutlet = outletScope(tenantA.id, tenantA.makassar!);

    // The Makassar-scoped tick has no template of its own: nothing is created.
    const none = await withTenant(db, otherOutlet, (tx) =>
      generateScheduledChecklistRuns(tx, otherOutlet, NOW),
    );
    expect(none).toBe(0);
    expect(await readRuns(tenantA.id)).toHaveLength(0);

    // The Jakarta-scoped tick creates the Jakarta run.
    const ownOutlet = outletScope(tenantA.id, tenantA.jakarta);
    const created = await withTenant(db, ownOutlet, (tx) =>
      generateScheduledChecklistRuns(tx, ownOutlet, NOW),
    );
    expect(created).toBe(1);
    const [run] = await readRuns(tenantA.id);
    expect(run.template_id).toBe(template.id);

    // The Makassar scope cannot read the Jakarta run ...
    const visible = await withTenant(db, otherOutlet, (tx) =>
      tx
        .select({ id: opsChecklistRuns.id })
        .from(opsChecklistRuns)
        .where(eq(opsChecklistRuns.templateId, template.id)),
    );
    expect(visible).toHaveLength(0);
    const jakartaVisible = await withTenant(db, ownOutlet, (tx) =>
      tx
        .select({ id: opsChecklistRuns.id })
        .from(opsChecklistRuns)
        .where(
          and(
            eq(opsChecklistRuns.templateId, template.id),
            eq(
              opsChecklistRuns.outletId,
              outletIdSchema.parse(tenantA.jakarta),
            ),
          ),
        ),
    );
    expect(jakartaVisible).toHaveLength(1);

    // ... and its sweep cannot mark it missed, however late it runs.
    const swept = await withTenant(db, otherOutlet, (tx) =>
      sweepMissedChecklistRuns(tx, otherOutlet, minutesAfter(NOW, 24 * 60)),
    );
    expect(swept).toBe(0);
    expect((await readRuns(tenantA.id))[0].status).toBe("pending");
  });

  it("[legend-5v69][TEN-01] another tenant's context generates nothing for this tenant and cannot read its runs", async () => {
    const template = await seedGeneratableTemplate(tenantA, tenantA.jakarta);
    // Tenant B holds no role templates at all.
    const contextB = tenantScope(tenantB.id);
    const none = await withTenant(db, contextB, (tx) =>
      generateScheduledChecklistRuns(tx, contextB, NOW),
    );
    expect(none).toBe(0);
    expect(await readRuns(tenantA.id)).toHaveLength(0);

    const contextA = tenantScope(tenantA.id);
    expect(
      await withTenant(db, contextA, (tx) =>
        generateScheduledChecklistRuns(tx, contextA, NOW),
      ),
    ).toBe(1);

    const seenByB = await withTenant(db, contextB, (tx) =>
      tx
        .select({ id: opsChecklistRuns.id })
        .from(opsChecklistRuns)
        .where(eq(opsChecklistRuns.templateId, template.id)),
    );
    expect(seenByB).toHaveLength(0);
    // Tenant B's sweep does not touch tenant A's overdue run either.
    const swept = await withTenant(db, contextB, (tx) =>
      sweepMissedChecklistRuns(tx, contextB, minutesAfter(NOW, 24 * 60)),
    );
    expect(swept).toBe(0);
    expect((await readRuns(tenantA.id))[0].status).toBe("pending");
  });
});
