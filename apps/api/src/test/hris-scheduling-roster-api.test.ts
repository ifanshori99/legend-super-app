// Shift templates, the weekly roster, compliance warnings and roster
// publication over HTTP (PRD v1.7 §3 Kelompok D 28 "Penjadwalan Shift", F26,
// HR-01, HR-05; TEN-01/02/03; bead legend-jstx). Runs the real Express app,
// Better Auth, the RBAC resolver and PostgreSQL against the seeded Cafe Legend
// tenant plus a throwaway second tenant. Expected behaviour comes from the
// PRD, the shared contract (packages/shared/src/hris/scheduling.ts) and the
// work brief, not from the service code.
//
// Assumptions (the spec leaves these open):
//  - A body or query with an unknown key or a client-sent tenantId is answered
//    422, as for every other HRIS route.
//  - A manager outside an outlet's scope gets 404 for that outlet (brief:
//    "outlet di luar jangkauan -> 404"); a user without the permission gets 403.
//  - Reading the roster (GET /rosters) needs hr.schedule.manage; an employee
//    with only self.schedule.view reads published own shifts via GET /shifts.
//  - Scheduling an inactive employee, an employee whose home outlet is another
//    outlet, an inactive template or a template of another outlet is refused
//    with 404, 409 or 422 (the spec does not name the code).
//  - Replays of a create, cancel, copy or publish with the same idempotency
//    key answer the first result with a 2xx status and change nothing.
//  - Cancelling an already cancelled shift with a new key is a 409 conflict
//    (transitionShiftAssignment); updating a published shift is a 409.
//  - Creating a shift inside an already published week gives a draft, and a
//    second publication (new key) publishes only the new drafts.
//  - Publishing a week with nothing to publish is refused with 409 or 422.
//  - A tenant default compliance policy row is not written here (it would
//    change other suites); an outlet with no policy shows source "default"
//    with the limits 600/720/2700/660/6.
//  - `shift.published` rows go to the `cloud-sync` destination, one per
//    assignment, sequence 1 for the first publication. The notification is read
//    through the real notification consumer over the `notification`
//    destination rows (or over every `shift.published` row when the service
//    routes notifications from the same row), then from the notifications table.
//  - Dates are in March to May 2034 (Monday 2034-03-06 is week 0) so the rows
//    cannot collide with seeded data or other suites.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createNotificationConsumer } from "../services/notification-consumer.ts";
import { createNotificationRecipientResolver } from "../worker/notification-adapters.ts";
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
let tenantB: SecondTenant | null = null;
let tenantBEmployee = "";

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

async function grantOutletRole(
  userId: string,
  permissions: string[],
  outletIds: string[],
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
        `Roster API ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["outlet"]),
      ],
    );
    for (const outletId of outletIds)
      await client.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
        [tenant.id, userId, roleId, outletId],
      );
  });
}

async function seedOutlet(label: string, timezone: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Jadwal', $7, '{}', 'active')`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `RS-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet jadwal ${label}`,
        timezone,
      ],
    ),
  );
  return id;
}

async function seedEmployee(input: {
  userId: string | null;
  outletId: string;
  status?: string;
}) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Jadwal API', $5, 'pkwtt', '2025-03-01', $6)`,
      [
        id,
        tenant.id,
        input.userId,
        `RS-${id.slice(0, 8).toUpperCase()}`,
        input.outletId,
        input.status ?? "active",
      ],
    ),
  );
  return id;
}

const key = () => `rs-api-${randomUUID()}`;
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
const put = (client: Client, path: string, body: unknown) =>
  client
    .put(path)
    .set(originHeader)
    .send(body as object);

// ---- dates ------------------------------------------------------------------

const MONDAY_0 = "2034-03-06";
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
const week = (n: number) => addDays(MONDAY_0, 7 * n);
const day = (weekIndex: number, offset: number) =>
  addDays(week(weekIndex), offset);
if (new Date(`${MONDAY_0}T00:00:00Z`).getUTCDay() !== 1)
  throw new Error("MONDAY_0 must be a Monday");
/** Instant (ms) of a local wall-clock time in a fixed UTC offset. */
const at = (date: string, time: string, offsetHours: number) =>
  Date.parse(`${date}T${time}:00Z`) - offsetHours * 3_600_000;
const WIB = 7;
const WITA = 8;

type Segment = { startsAt: string; endsAt: string };
type Assignment = {
  id: string;
  outletId: string;
  employeeId: string;
  shiftTemplateId: string | null;
  businessDate: string;
  segments: Segment[];
  breakMinutes: number;
  status: string;
  source: string;
  publishedBy: string | null;
  publishedAt: string | null;
};
type Issue = {
  code: string;
  employeeId: string;
  assignmentId: string;
  limit: number;
  actual: number;
};
const spans = (assignment: Assignment) =>
  assignment.segments.map(
    (segment) =>
      [Date.parse(segment.startsAt), Date.parse(segment.endsAt)] as const,
  );
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

// ---- fixtures ---------------------------------------------------------------

let jkt: string;
let wita: string;
let emptyOutlet: string;
let policyOutlet: string;

let mgr: Client;
let mgrUserId: string;
let mgrWita: Client;
let staffA: Client;
let staffAUserId: string;
let staffB: Client;
let staffBUserId: string;
let nobody: Client;
let nobodyUserId: string;

let empA: string;
let empB: string;
let empC: string;
let empWita: string;
let empPolicy: string;
let empInactive: string;

let tplPagi: string;
let tplMalam: string;
let tplSplit: string;
let tplPanjang: string;
let tplWitaMalam: string;
let tplPolicyPagi: string;
let tplSiang: string;

async function createTemplate(
  client: Client,
  outletId: string,
  name: string,
  segments: { startTime: string; endTime: string }[],
  breakMinutes: number,
) {
  const created = await post(client, "/api/hris/shift-templates", {
    outletId,
    name,
    segments,
    breakMinutes,
    stationId: null,
    positionId: null,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data as { id: string };
}

const shiftBody = (
  outletId: string,
  employeeId: string,
  businessDate: string,
  shiftTemplateId: string,
  idempotencyKey = key(),
) => ({
  outletId,
  employeeId,
  businessDate,
  shiftTemplateId,
  stationId: null,
  idempotencyKey,
});

async function makeShift(
  outletId: string,
  employeeId: string,
  businessDate: string,
  templateId: string,
) {
  const created = await post(
    mgr,
    "/api/hris/shifts",
    shiftBody(outletId, employeeId, businessDate, templateId),
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data as Assignment;
}

async function roster(outletId: string, weekStart: string, client = mgr) {
  const response = await client.get(
    `/api/hris/rosters?outletId=${outletId}&weekStart=${weekStart}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as {
    outletId: string;
    weekStart: string;
    published: boolean;
    assignments: Assignment[];
    complianceIssues: Issue[];
  };
}

const activeOf = (rows: Assignment[]) =>
  rows.filter((row) => row.status !== "cancelled");

async function shiftEvents(assignmentId: string, destination = "cloud-sync") {
  return asTenant(async (client) => {
    const { rows } = await client.query<{
      destination: string;
      sequence: number;
      event: Record<string, unknown> & { payload: Record<string, unknown> };
    }>(
      `SELECT destination, sequence::int AS sequence, event
         FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'shift.published'
          AND event->'payload'->>'shiftAssignmentId' = $2
          AND destination = $3
        ORDER BY sequence`,
      [tenant.id, assignmentId, destination],
    );
    return rows;
  });
}

beforeAll(async () => {
  jkt = await seedOutlet("WIB", "Asia/Jakarta");
  wita = await seedOutlet("WITA", "Asia/Makassar");
  emptyOutlet = await seedOutlet("kosong", "Asia/Jakarta");
  policyOutlet = await seedOutlet("kebijakan", "Asia/Jakarta");

  const manager = await signedInClient("Manajer Jadwal API", { mfa: true });
  await grantOutletRole(
    manager.userId,
    ["hr.schedule.manage", "hr.shift_swap.approve"],
    [jkt, wita, emptyOutlet, policyOutlet],
  );
  mgr = manager.client;
  mgrUserId = manager.userId;

  const managerWita = await signedInClient("Manajer WITA API", { mfa: true });
  await grantOutletRole(managerWita.userId, ["hr.schedule.manage"], [wita]);
  mgrWita = managerWita.client;

  const a = await signedInClient("Staf A Jadwal API");
  await grantOutletRole(
    a.userId,
    ["self.profile.view", "self.schedule.view"],
    [jkt],
  );
  staffA = a.client;
  staffAUserId = a.userId;

  const b = await signedInClient("Staf B Jadwal API");
  await grantOutletRole(
    b.userId,
    ["self.profile.view", "self.schedule.view"],
    [jkt],
  );
  staffB = b.client;
  staffBUserId = b.userId;

  const none = await signedInClient("Tanpa Izin Jadwal API");
  await grantOutletRole(none.userId, ["self.profile.view"], [jkt]);
  nobody = none.client;
  nobodyUserId = none.userId;

  empA = await seedEmployee({ userId: a.userId, outletId: jkt });
  empB = await seedEmployee({ userId: b.userId, outletId: jkt });
  empC = await seedEmployee({ userId: null, outletId: jkt });
  empWita = await seedEmployee({ userId: null, outletId: wita });
  empPolicy = await seedEmployee({ userId: null, outletId: policyOutlet });
  empInactive = await seedEmployee({
    userId: null,
    outletId: jkt,
    status: "terminated",
  });

  tplPagi = (
    await createTemplate(
      mgr,
      jkt,
      "Pagi",
      [{ startTime: "08:00", endTime: "16:00" }],
      60,
    )
  ).id;
  tplMalam = (
    await createTemplate(
      mgr,
      jkt,
      "Malam",
      [{ startTime: "22:00", endTime: "06:00" }],
      30,
    )
  ).id;
  tplSplit = (
    await createTemplate(
      mgr,
      jkt,
      "Split",
      [
        { startTime: "08:00", endTime: "12:00" },
        { startTime: "16:00", endTime: "20:00" },
      ],
      60,
    )
  ).id;
  tplPanjang = (
    await createTemplate(
      mgr,
      jkt,
      "Panjang",
      [{ startTime: "06:00", endTime: "20:00" }],
      0,
    )
  ).id;
  tplWitaMalam = (
    await createTemplate(
      mgr,
      wita,
      "Malam WITA",
      [{ startTime: "22:00", endTime: "06:00" }],
      30,
    )
  ).id;
  tplSiang = (
    await createTemplate(
      mgr,
      jkt,
      "Siang tumpang tindih",
      [{ startTime: "12:00", endTime: "20:00" }],
      60,
    )
  ).id;
  tplPolicyPagi = (
    await createTemplate(
      mgr,
      policyOutlet,
      "Pagi kebijakan",
      [{ startTime: "08:00", endTime: "16:00" }],
      60,
    )
  ).id;
}, 120_000);

afterAll(async () => {
  await asTenant(async (client) => {
    for (const table of [
      "shift_swap_requests",
      "roster_publications",
      "shift_assignments",
      "shift_templates",
      "shift_compliance_policies",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])`,
        [tenant.id, createdOutlets],
      );
    await client.query(
      `DELETE FROM delivery_attempts WHERE tenant_id = $1 AND notification_id IN
         (SELECT id FROM notifications WHERE tenant_id = $1 AND user_id::text = ANY($2::text[]))`,
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM notifications WHERE tenant_id = $1 AND user_id::text = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'rs-api-%'",
      [tenant.id],
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
    // Outlets stay: audit_logs is append-only and references them (disposable DB).
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  if (tenantB) {
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
  it("[TEN-01] anonymous requests to every scheduling route answer 401", async () => {
    const anonymous = agent(app);
    for (const path of [
      "/api/hris/shift-templates",
      "/api/hris/shift-compliance-policy",
      "/api/hris/shifts",
      `/api/hris/rosters?outletId=${jkt}&weekStart=${week(0)}`,
    ])
      expect((await anonymous.get(path)).status, path).toBe(401);
    for (const path of [
      "/api/hris/shift-templates",
      "/api/hris/shifts",
      "/api/hris/rosters/copy",
      "/api/hris/rosters/publish",
    ])
      expect(
        (await anonymous.post(path).set(originHeader).send({})).status,
        path,
      ).toBe(401);
  });

  it("[§28 Template Shift] an employee cannot create or change a template, a shift, a policy or publish (403)", async () => {
    expect(
      (
        await post(staffA, "/api/hris/shift-templates", {
          outletId: jkt,
          name: "Tidak boleh",
          segments: [{ startTime: "08:00", endTime: "16:00" }],
          breakMinutes: 0,
          stationId: null,
          positionId: null,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await patch(staffA, `/api/hris/shift-templates/${tplPagi}`, {
          name: "Diretas",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          staffA,
          "/api/hris/shifts",
          shiftBody(jkt, empA, day(0, 0), tplPagi),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await put(staffA, "/api/hris/shift-compliance-policy", {
          outletId: jkt,
          maxShiftMinutes: 600,
          maxDailyMinutes: 720,
          maxWeeklyMinutes: 2700,
          minRestMinutesBetweenShifts: 660,
          maxConsecutiveWorkDays: 6,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(staffA, "/api/hris/rosters/publish", {
          outletId: jkt,
          weekStart: week(0),
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(staffA, "/api/hris/rosters/copy", {
          outletId: jkt,
          fromWeekStart: week(0),
          toWeekStart: week(1),
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await staffA.get(
          `/api/hris/rosters?outletId=${jkt}&weekStart=${week(0)}`,
        )
      ).status,
    ).toBe(403);
  });

  it("[HR-01] a user without the schedule permission cannot list shifts (403)", async () => {
    expect((await nobody.get("/api/hris/shifts")).status).toBe(403);
    expect(nobodyUserId).toBeTruthy();
  });
});

// ---- templates ---------------------------------------------------------------

describe("§28 Template Shift", () => {
  it("[§28 Template Shift] HR creates a single-segment template (201) and it is listed for the outlet", async () => {
    const created = await post(mgr, "/api/hris/shift-templates", {
      outletId: jkt,
      name: "Siang",
      segments: [{ startTime: "12:00", endTime: "20:00" }],
      breakMinutes: 45,
      stationId: null,
      positionId: null,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      tenantId: tenant.id,
      outletId: jkt,
      name: "Siang",
      segments: [{ startTime: "12:00", endTime: "20:00" }],
      breakMinutes: 45,
      stationId: null,
      positionId: null,
      isActive: true,
    });
    const list = await mgr.get(`/api/hris/shift-templates?outletId=${jkt}`);
    expect(list.status).toBe(200);
    expect(ids(list.body.data)).toContain(created.body.data.id);
    expect(ids(list.body.data)).toContain(tplPagi);
  });

  it("[§28 Template Shift] a split shift keeps its two segments and a night shift may cross midnight", async () => {
    const list = await mgr.get(`/api/hris/shift-templates?outletId=${jkt}`);
    const split = list.body.data.find(
      (row: { id: string }) => row.id === tplSplit,
    );
    expect(split.segments).toEqual([
      { startTime: "08:00", endTime: "12:00" },
      { startTime: "16:00", endTime: "20:00" },
    ]);
    const night = list.body.data.find(
      (row: { id: string }) => row.id === tplMalam,
    );
    expect(night.segments).toEqual([{ startTime: "22:00", endTime: "06:00" }]);
  });

  it("[§28 Template Shift] HR renames, retimes and deactivates a template; inactive templates are hidden unless asked for", async () => {
    const tpl = await createTemplate(
      mgr,
      jkt,
      "Sementara",
      [{ startTime: "09:00", endTime: "17:00" }],
      30,
    );
    const changed = await patch(mgr, `/api/hris/shift-templates/${tpl.id}`, {
      name: "Sementara baru",
      segments: [{ startTime: "10:00", endTime: "18:00" }],
      breakMinutes: 60,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.data).toMatchObject({
      id: tpl.id,
      name: "Sementara baru",
      segments: [{ startTime: "10:00", endTime: "18:00" }],
      breakMinutes: 60,
      isActive: true,
    });
    const off = await patch(mgr, `/api/hris/shift-templates/${tpl.id}`, {
      isActive: false,
    });
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);

    const active = await mgr.get(`/api/hris/shift-templates?outletId=${jkt}`);
    expect(ids(active.body.data)).not.toContain(tpl.id);
    const all = await mgr.get(
      `/api/hris/shift-templates?outletId=${jkt}&includeInactive=true`,
    );
    expect(ids(all.body.data)).toContain(tpl.id);

    // An inactive template can no longer be assigned.
    const refused = await post(
      mgr,
      "/api/hris/shifts",
      shiftBody(jkt, empA, day(0, 5), tpl.id),
    );
    expect([404, 409, 422]).toContain(refused.status);
  });

  it("[§28 Template Shift] an outlet without templates lists an empty page", async () => {
    const empty = await mgr.get(
      `/api/hris/shift-templates?outletId=${emptyOutlet}`,
    );
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);
  });

  it("[TEN-02] invalid template bodies are refused (422)", async () => {
    const valid = {
      outletId: jkt,
      name: "Uji",
      segments: [{ startTime: "08:00", endTime: "16:00" }],
      breakMinutes: 30,
      stationId: null,
      positionId: null,
    };
    for (const bad of [
      { ...valid, extra: 1 },
      { ...valid, tenantId: tenant.id },
      { ...valid, name: "" },
      { ...valid, segments: [] },
      { ...valid, segments: [{ startTime: "08:00", endTime: "08:00" }] },
      {
        ...valid,
        segments: [
          { startTime: "06:00", endTime: "09:00" },
          { startTime: "10:00", endTime: "12:00" },
          { startTime: "14:00", endTime: "18:00" },
        ],
      },
      {
        ...valid,
        segments: [
          { startTime: "08:00", endTime: "12:00" },
          { startTime: "11:00", endTime: "15:00" },
        ],
      },
      {
        ...valid,
        segments: [
          { startTime: "08:00", endTime: "12:00" },
          { startTime: "20:00", endTime: "02:00" },
        ],
      },
      { ...valid, breakMinutes: 241 },
      { ...valid, breakMinutes: -1 },
      { ...valid, outletId: "not-a-uuid" },
    ])
      expect(
        (await post(mgr, "/api/hris/shift-templates", bad)).status,
        JSON.stringify(bad),
      ).toBe(422);
    const noOrigin = await mgr.post("/api/hris/shift-templates").send(valid);
    expect(noOrigin.status).toBe(403);
    expect(
      (await patch(mgr, `/api/hris/shift-templates/${tplPagi}`, {})).status,
    ).toBe(422);
    expect(
      (
        await patch(mgr, `/api/hris/shift-templates/${tplPagi}`, {
          tenantId: tenant.id,
        })
      ).status,
    ).toBe(422);
    expect((await mgr.get("/api/hris/shift-templates?tenantId=x")).status).toBe(
      422,
    );
  });

  it("[TEN-03] a manager of another outlet cannot create, change or see this outlet's templates (404)", async () => {
    expect(
      (
        await post(mgrWita, "/api/hris/shift-templates", {
          outletId: jkt,
          name: "Lintas outlet",
          segments: [{ startTime: "08:00", endTime: "16:00" }],
          breakMinutes: 0,
          stationId: null,
          positionId: null,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await patch(mgrWita, `/api/hris/shift-templates/${tplPagi}`, {
          name: "Diretas",
        })
      ).status,
    ).toBe(404);
    expect(
      (await mgrWita.get(`/api/hris/shift-templates?outletId=${jkt}`)).status,
    ).toBe(404);
    const own = await mgrWita.get("/api/hris/shift-templates");
    expect(own.status).toBe(200);
    expect(ids(own.body.data)).toContain(tplWitaMalam);
    expect(ids(own.body.data)).not.toContain(tplPagi);
    const unchanged = await mgr.get(
      `/api/hris/shift-templates?outletId=${jkt}`,
    );
    expect(
      unchanged.body.data.find((row: { id: string }) => row.id === tplPagi)
        .name,
    ).toBe("Pagi");
  });
});

// ---- draft shifts ------------------------------------------------------------

describe("§28 Roster Mingguan: draft shifts", () => {
  it("[§28 Roster Mingguan] HR creates a draft shift (201): status draft, source user, segments copied from the template in the outlet time zone, no personal data", async () => {
    const date = day(0, 0);
    const created = await post(
      mgr,
      "/api/hris/shifts",
      shiftBody(jkt, empA, date, tplPagi),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const shift = created.body.data as Assignment;
    expect(shift).toMatchObject({
      tenantId: tenant.id,
      outletId: jkt,
      employeeId: empA,
      shiftTemplateId: tplPagi,
      businessDate: date,
      breakMinutes: 60,
      status: "draft",
      source: "user",
      publishedBy: null,
      publishedAt: null,
    });
    expect(spans(shift)).toEqual([
      [at(date, "08:00", WIB), at(date, "16:00", WIB)],
    ]);
    const serialized = JSON.stringify(created.body);
    expect(serialized).not.toContain("Karyawan Jadwal API");
    expect(serialized).not.toMatch(/nik|salary|gaji|fullName/i);
  });

  it("[§28 Roster Mingguan] a replay with the same idempotency key returns the same draft and adds nothing", async () => {
    const body = shiftBody(jkt, empB, day(0, 1), tplPagi);
    const first = await post(mgr, "/api/hris/shifts", body);
    const replay = await post(mgr, "/api/hris/shifts", body);
    expect(first.status).toBe(201);
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const view = await roster(jkt, week(0));
    expect(
      view.assignments.filter((row) => row.id === first.body.data.id),
    ).toHaveLength(1);
    expect(view.published).toBe(false);
  });

  it("[§28 Roster Mingguan] a night shift crosses midnight and belongs to the day it starts; the same template in WITA gives other instants", async () => {
    const date = day(1, 0);
    const jakarta = await makeShift(jkt, empA, date, tplMalam);
    expect(jakarta.businessDate).toBe(date);
    expect(spans(jakarta)).toEqual([
      [at(date, "22:00", WIB), at(addDays(date, 1), "06:00", WIB)],
    ]);
    expect(jakarta.breakMinutes).toBe(30);

    const makassar = await makeShift(wita, empWita, date, tplWitaMalam);
    expect(makassar.businessDate).toBe(date);
    expect(spans(makassar)).toEqual([
      [at(date, "22:00", WITA), at(addDays(date, 1), "06:00", WITA)],
    ]);
    expect(spans(makassar)[0]![0]).toBe(spans(jakarta)[0]![0] - 3_600_000);
  });

  it("[§28 Roster Mingguan] a split shift gives two concrete segments", async () => {
    const date = day(1, 2);
    const shift = await makeShift(jkt, empB, date, tplSplit);
    expect(spans(shift)).toEqual([
      [at(date, "08:00", WIB), at(date, "12:00", WIB)],
      [at(date, "16:00", WIB), at(date, "20:00", WIB)],
    ]);
    expect(shift.breakMinutes).toBe(60);
  });

  it("[§28 Roster Mingguan] editing a template later does not change a shift already assigned", async () => {
    const tpl = await createTemplate(
      mgr,
      jkt,
      "Snapshot",
      [{ startTime: "08:00", endTime: "16:00" }],
      60,
    );
    const date = day(2, 0);
    const before = await makeShift(jkt, empA, date, tpl.id);
    const changed = await patch(mgr, `/api/hris/shift-templates/${tpl.id}`, {
      segments: [{ startTime: "09:00", endTime: "17:00" }],
      breakMinutes: 30,
    });
    expect(changed.status).toBe(200);
    const after = await makeShift(jkt, empB, date, tpl.id);
    expect(spans(after)).toEqual([
      [at(date, "09:00", WIB), at(date, "17:00", WIB)],
    ]);
    expect(after.breakMinutes).toBe(30);
    const view = await roster(jkt, week(2));
    const kept = view.assignments.find((row) => row.id === before.id)!;
    expect(spans(kept)).toEqual([
      [at(date, "08:00", WIB), at(date, "16:00", WIB)],
    ]);
    expect(kept.breakMinutes).toBe(60);
  });

  it("[§28 Roster Mingguan] only an active employee of the outlet can be scheduled, with a template of that outlet", async () => {
    const date = day(0, 2);
    for (const body of [
      shiftBody(jkt, empInactive, date, tplPagi),
      shiftBody(jkt, empWita, date, tplPagi),
      shiftBody(jkt, empA, date, tplWitaMalam),
      shiftBody(jkt, randomUUID(), date, tplPagi),
      shiftBody(jkt, empA, date, randomUUID()),
    ]) {
      const refused = await post(mgr, "/api/hris/shifts", body);
      expect([404, 409, 422], JSON.stringify(refused.body)).toContain(
        refused.status,
      );
    }
    const view = await roster(jkt, week(0));
    expect(view.assignments.filter((row) => row.businessDate === date)).toEqual(
      [],
    );
  });

  it("[TEN-02] invalid shift bodies are refused (422)", async () => {
    const valid = shiftBody(jkt, empA, day(0, 3), tplPagi);
    for (const bad of [
      { ...valid, extra: 1 },
      { ...valid, tenantId: tenant.id },
      { ...valid, idempotencyKey: undefined },
      { ...valid, idempotencyKey: "short" },
      { ...valid, businessDate: "2034-02-31" },
      { ...valid, businessDate: "06-03-2034" },
      { ...valid, employeeId: "not-a-uuid" },
    ])
      expect(
        (await post(mgr, "/api/hris/shifts", bad)).status,
        JSON.stringify(bad),
      ).toBe(422);
    expect(
      (
        await mgr
          .post("/api/hris/shifts")
          .send(shiftBody(jkt, empA, day(0, 3), tplPagi))
      ).status,
    ).toBe(403);
  });

  it("[§28 Roster Mingguan] HR changes a draft: another employee, template and date; segments follow", async () => {
    const draft = await makeShift(jkt, empA, day(3, 0), tplPagi);
    const moved = await patch(mgr, `/api/hris/shifts/${draft.id}`, {
      employeeId: empC,
      shiftTemplateId: tplMalam,
      businessDate: day(3, 1),
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const date = day(3, 1);
    expect(moved.body.data).toMatchObject({
      id: draft.id,
      employeeId: empC,
      shiftTemplateId: tplMalam,
      businessDate: date,
      status: "draft",
      breakMinutes: 30,
    });
    expect(spans(moved.body.data)).toEqual([
      [at(date, "22:00", WIB), at(addDays(date, 1), "06:00", WIB)],
    ]);
    expect((await patch(mgr, `/api/hris/shifts/${draft.id}`, {})).status).toBe(
      422,
    );
    expect(
      (
        await patch(mgr, `/api/hris/shifts/${draft.id}`, {
          employeeId: empInactive,
        })
      ).status,
    ).not.toBeLessThan(400);
  });

  it("[§28 Roster Mingguan] HR cancels a draft (200); a replay answers the same, a different key is a conflict, and a cancelled draft cannot be edited", async () => {
    const draft = await makeShift(jkt, empB, day(3, 3), tplPagi);
    const cancelKey = key();
    const cancelled = await post(mgr, `/api/hris/shifts/${draft.id}/cancel`, {
      idempotencyKey: cancelKey,
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data).toMatchObject({
      id: draft.id,
      status: "cancelled",
    });
    const replay = await post(mgr, `/api/hris/shifts/${draft.id}/cancel`, {
      idempotencyKey: cancelKey,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data.status).toBe("cancelled");
    const again = await post(mgr, `/api/hris/shifts/${draft.id}/cancel`, {
      idempotencyKey: key(),
    });
    expect([200, 409]).toContain(again.status);
    if (again.status === 200) expect(again.body.data.status).toBe("cancelled");
    expect(
      (await patch(mgr, `/api/hris/shifts/${draft.id}`, { employeeId: empA }))
        .status,
    ).toBe(409);
    const view = await roster(jkt, week(3));
    expect(
      view.assignments.filter(
        (row) => row.id === draft.id && row.status !== "cancelled",
      ),
    ).toEqual([]);
  });

  it("[§28 Roster Mingguan] an unknown shift answers 404", async () => {
    expect(
      (
        await patch(mgr, `/api/hris/shifts/${randomUUID()}`, {
          employeeId: empA,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(mgr, `/api/hris/shifts/${randomUUID()}/cancel`, {
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(404);
  });

  it("[§28 Roster Mingguan] an outlet-week without shifts is an empty, unpublished roster", async () => {
    const view = await roster(emptyOutlet, week(20));
    expect(view).toMatchObject({
      outletId: emptyOutlet,
      weekStart: week(20),
      published: false,
      assignments: [],
      complianceIssues: [],
    });
    const list = await mgr.get(`/api/hris/shifts?outletId=${emptyOutlet}`);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
    const refused = await post(mgr, "/api/hris/rosters/publish", {
      outletId: emptyOutlet,
      weekStart: week(20),
      idempotencyKey: key(),
    });
    expect([409, 422]).toContain(refused.status);
  });
});

// ---- copy week ---------------------------------------------------------------

describe("§28 Roster Mingguan: copy previous week", () => {
  let source: Assignment[] = [];
  let copyKey = "";
  let copied: Assignment[] = [];

  it("[§28 Roster Mingguan] copying a week creates drafts in the target week, shifted by 7 days, and skips cancelled shifts", async () => {
    const a = await makeShift(jkt, empA, day(4, 0), tplPagi);
    const b = await makeShift(jkt, empB, day(4, 2), tplMalam);
    const c = await makeShift(jkt, empC, day(4, 4), tplSplit);
    const dropped = await makeShift(jkt, empA, day(4, 5), tplPagi);
    expect(
      (
        await post(mgr, `/api/hris/shifts/${dropped.id}/cancel`, {
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(200);
    source = [a, b, c];

    copyKey = key();
    const response = await post(mgr, "/api/hris/rosters/copy", {
      outletId: jkt,
      fromWeekStart: week(4),
      toWeekStart: week(5),
      idempotencyKey: copyKey,
    });
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    expect(response.body.data).toMatchObject({
      outletId: jkt,
      weekStart: week(5),
      published: false,
    });
    copied = activeOf(response.body.data.assignments as Assignment[]);
    expect(copied).toHaveLength(3);
    for (const original of source) {
      const copy = copied.find(
        (row) => row.employeeId === original.employeeId,
      )!;
      expect(copy, original.id).toBeTruthy();
      expect(copy.id).not.toBe(original.id);
      expect(copy.status).toBe("draft");
      expect(copy.publishedAt).toBeNull();
      expect(copy.businessDate).toBe(addDays(original.businessDate, 7));
      expect(copy.shiftTemplateId).toBe(original.shiftTemplateId);
      expect(copy.breakMinutes).toBe(original.breakMinutes);
      expect(spans(copy)).toEqual(
        spans(original).map(
          ([start, end]) =>
            [start + 7 * 86_400_000, end + 7 * 86_400_000] as const,
        ),
      );
    }
    const view = await roster(jkt, week(5));
    expect(ids(activeOf(view.assignments)).sort()).toEqual(ids(copied).sort());
    // The source week is untouched.
    const sourceView = await roster(jkt, week(4));
    expect(activeOf(sourceView.assignments)).toHaveLength(3);
  });

  it("[§28 Roster Mingguan] a replay with the same key returns the same drafts and creates no more", async () => {
    const replay = await post(mgr, "/api/hris/rosters/copy", {
      outletId: jkt,
      fromWeekStart: week(4),
      toWeekStart: week(5),
      idempotencyKey: copyKey,
    });
    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(ids(activeOf(replay.body.data.assignments)).sort()).toEqual(
      ids(copied).sort(),
    );
    const view = await roster(jkt, week(5));
    expect(activeOf(view.assignments)).toHaveLength(3);
  });

  it("[§28 Roster Mingguan] copying onto a week that already has different shifts is refused (409) and changes nothing", async () => {
    await makeShift(jkt, empB, day(7, 1), tplPagi);
    const refused = await post(mgr, "/api/hris/rosters/copy", {
      outletId: jkt,
      fromWeekStart: week(4),
      toWeekStart: week(7),
      idempotencyKey: key(),
    });
    expect(refused.status).toBe(409);
    const view = await roster(jkt, week(7));
    expect(activeOf(view.assignments)).toHaveLength(1);
  });

  it("[TEN-02] invalid copy bodies are refused (422)", async () => {
    const valid = {
      outletId: jkt,
      fromWeekStart: week(4),
      toWeekStart: week(6),
      idempotencyKey: key(),
    };
    for (const bad of [
      { ...valid, extra: 1 },
      { ...valid, tenantId: tenant.id },
      { ...valid, toWeekStart: "2034-13-01" },
      { ...valid, idempotencyKey: undefined },
    ])
      expect(
        (await post(mgr, "/api/hris/rosters/copy", bad)).status,
        JSON.stringify(bad),
      ).toBe(422);
  });

  it("[TEN-03] a manager of another outlet cannot copy this outlet's roster (404)", async () => {
    const refused = await post(mgrWita, "/api/hris/rosters/copy", {
      outletId: jkt,
      fromWeekStart: week(4),
      toWeekStart: week(6),
      idempotencyKey: key(),
    });
    expect(refused.status).toBe(404);
    const view = await roster(jkt, week(6));
    expect(view.assignments).toEqual([]);
  });
});

// ---- compliance ---------------------------------------------------------------

describe("§28 Kepatuhan", () => {
  it("[§28 Kepatuhan] an outlet with no policy shows the default limits", async () => {
    const response = await mgr.get(
      `/api/hris/shift-compliance-policy?outletId=${emptyOutlet}`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      source: "default",
      maxShiftMinutes: 600,
      maxDailyMinutes: 720,
      maxWeeklyMinutes: 2700,
      minRestMinutesBetweenShifts: 660,
      maxConsecutiveWorkDays: 6,
    });
  });

  it("[§28 Kepatuhan] the draft roster warns about a too long shift, too little rest and overlapping shifts, without blocking the drafts", async () => {
    const mon = day(7, 0);
    const tue = day(7, 1);
    const nightB = await makeShift(jkt, empB, mon, tplMalam);
    const morningB = await makeShift(jkt, empB, tue, tplPagi);
    const longC = await makeShift(jkt, empC, day(7, 2), tplPanjang);
    const firstA = await makeShift(jkt, empA, day(7, 3), tplPagi);
    const secondA = await makeShift(jkt, empA, day(7, 3), tplSiang);
    expect(secondA.id).not.toBe(firstA.id);

    const view = await roster(jkt, week(7));
    expect(view.published).toBe(false);
    const issues = view.complianceIssues;
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "insufficient_rest",
        employeeId: empB,
        assignmentId: morningB.id,
        limit: 660,
        actual: 120,
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "shift_too_long",
        employeeId: empC,
        assignmentId: longC.id,
        limit: 600,
        actual: 840,
      }),
    );
    expect(
      issues.filter(
        (issue) =>
          issue.code === "overlapping_shift" && issue.employeeId === empA,
      ),
    ).toHaveLength(1);
    expect(issues.filter((issue) => issue.assignmentId === nightB.id)).toEqual(
      [],
    );
    expect(ids(view.assignments)).toEqual(
      expect.arrayContaining([
        nightB.id,
        morningB.id,
        longC.id,
        firstA.id,
        secondA.id,
      ]),
    );
  });

  it("[§28 Kepatuhan] a clean roster has no warnings", async () => {
    await makeShift(jkt, empA, day(8, 0), tplPagi);
    await makeShift(jkt, empB, day(8, 0), tplPagi);
    const view = await roster(jkt, week(8));
    expect(view.complianceIssues).toEqual([]);
  });

  it("[§28 Kepatuhan] HR sets an outlet policy: the limits are configurable and warnings follow them; other outlets keep the default", async () => {
    const date = day(9, 0);
    await makeShift(policyOutlet, empPolicy, date, tplPolicyPagi);
    expect((await roster(policyOutlet, week(9))).complianceIssues).toEqual([]);

    const updated = await put(mgr, "/api/hris/shift-compliance-policy", {
      outletId: policyOutlet,
      maxShiftMinutes: 360,
      maxDailyMinutes: 720,
      maxWeeklyMinutes: 2700,
      minRestMinutesBetweenShifts: 660,
      maxConsecutiveWorkDays: 6,
    });
    expect(updated.status, JSON.stringify(updated.body)).toBeLessThan(300);
    expect(updated.body.data).toMatchObject({
      outletId: policyOutlet,
      maxShiftMinutes: 360,
    });
    const read = await mgr.get(
      `/api/hris/shift-compliance-policy?outletId=${policyOutlet}`,
    );
    expect(read.body.data).toMatchObject({
      source: "outlet",
      maxShiftMinutes: 360,
    });
    const view = await roster(policyOutlet, week(9));
    expect(view.complianceIssues).toContainEqual(
      expect.objectContaining({
        code: "shift_too_long",
        employeeId: empPolicy,
        limit: 360,
        actual: 420,
      }),
    );
    const other = await mgr.get(
      `/api/hris/shift-compliance-policy?outletId=${emptyOutlet}`,
    );
    expect(other.body.data).toMatchObject({
      source: "default",
      maxShiftMinutes: 600,
    });
  });

  it("[§28 Kepatuhan] an inconsistent policy is refused (422); a manager outside the outlet gets 404", async () => {
    const valid = {
      outletId: policyOutlet,
      maxShiftMinutes: 600,
      maxDailyMinutes: 720,
      maxWeeklyMinutes: 2700,
      minRestMinutesBetweenShifts: 660,
      maxConsecutiveWorkDays: 6,
    };
    for (const bad of [
      { ...valid, maxDailyMinutes: 500 },
      { ...valid, maxWeeklyMinutes: 700 },
      { ...valid, maxShiftMinutes: 30 },
      { ...valid, maxConsecutiveWorkDays: 0 },
      { ...valid, extra: 1 },
      { ...valid, tenantId: tenant.id },
    ])
      expect(
        (await put(mgr, "/api/hris/shift-compliance-policy", bad)).status,
        JSON.stringify(bad),
      ).toBe(422);
    expect(
      (await put(mgrWita, "/api/hris/shift-compliance-policy", valid)).status,
    ).toBe(404);
    // A manager scoped to outlets only cannot change the tenant-wide policy.
    expect([403, 404]).toContain(
      (
        await put(mgr, "/api/hris/shift-compliance-policy", {
          ...valid,
          outletId: null,
        })
      ).status,
    );
  });
});

// ---- publication --------------------------------------------------------------

describe("§28 Roster Mingguan: publication, events and notifications", () => {
  let a: Assignment;
  let b: Assignment;
  let c: Assignment;
  let cancelledBefore: Assignment;
  let publishKey = "";
  let publishedAt = "";

  it("[HR-01] before publication an employee sees none of the draft shifts, while the manager sees them", async () => {
    a = await makeShift(jkt, empA, day(10, 0), tplPagi);
    b = await makeShift(jkt, empB, day(10, 1), tplPagi);
    c = await makeShift(jkt, empC, day(10, 2), tplPagi);
    cancelledBefore = await makeShift(jkt, empA, day(10, 3), tplPagi);
    expect(
      (
        await post(mgr, `/api/hris/shifts/${cancelledBefore.id}/cancel`, {
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(200);

    const range = `from=${week(10)}&to=${day(10, 6)}`;
    const own = await staffA.get(`/api/hris/shifts?${range}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data).toEqual([]);
    const manager = await mgr.get(`/api/hris/shifts?outletId=${jkt}&${range}`);
    expect(manager.status).toBe(200);
    expect(ids(manager.body.data)).toEqual(
      expect.arrayContaining([a.id, b.id, c.id]),
    );
  });

  it("[TEN-03] a manager of another outlet cannot publish this outlet's week (404) and nothing changes", async () => {
    const refused = await post(mgrWita, "/api/hris/rosters/publish", {
      outletId: jkt,
      weekStart: week(10),
      idempotencyKey: key(),
    });
    expect(refused.status).toBe(404);
    expect((await roster(jkt, week(10))).published).toBe(false);
    expect(await shiftEvents(a.id)).toEqual([]);
  });

  it("[§28 Roster Mingguan] HR publishes the week (200): drafts become published with actor and time, cancelled shifts stay out", async () => {
    publishKey = key();
    const response = await post(mgr, "/api/hris/rosters/publish", {
      outletId: jkt,
      weekStart: week(10),
      idempotencyKey: publishKey,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const data = response.body.data;
    expect(data).toMatchObject({
      outletId: jkt,
      weekStart: week(10),
      publishedBy: mgrUserId,
    });
    expect(data.publishedAt).toBeTruthy();
    publishedAt = data.publishedAt;
    const published = data.assignments as Assignment[];
    expect(ids(published).sort()).toEqual([a.id, b.id, c.id].sort());
    for (const row of published) {
      expect(row.status).toBe("published");
      expect(row.publishedBy).toBe(mgrUserId);
      expect(row.publishedAt).not.toBeNull();
    }
    expect(data.complianceIssues).toEqual([]);

    const view = await roster(jkt, week(10));
    expect(view.published).toBe(true);
    const cancelled = view.assignments.find(
      (row) => row.id === cancelledBefore.id,
    );
    if (cancelled) expect(cancelled.status).toBe("cancelled");
  });

  it("[§28 Roster Mingguan] a replay with the same key returns the first result and emits no second event", async () => {
    const replay = await post(mgr, "/api/hris/rosters/publish", {
      outletId: jkt,
      weekStart: week(10),
      idempotencyKey: publishKey,
    });
    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(300);
    expect(replay.body.data.publishedAt).toBe(publishedAt);
    expect(ids(replay.body.data.assignments).sort()).toEqual(
      [a.id, b.id, c.id].sort(),
    );
    for (const row of [a, b, c])
      expect(await shiftEvents(row.id), row.id).toHaveLength(1);
    expect(await shiftEvents(cancelledBefore.id)).toEqual([]);
  });

  it("[§28 Notifikasi Jadwal] each published shift emits one shift.published event to cloud-sync without personal data", async () => {
    const rows = await shiftEvents(a.id);
    expect(rows).toHaveLength(1);
    // One more row feeds the notification consumer (destination notification).
    expect(await shiftEvents(a.id, "notification")).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      destination: "cloud-sync",
      sequence: 1,
    });
    const envelope = eventEnvelopeSchema.parse(rows[0]!.event);
    expect(envelope.name).toBe("shift.published");
    expect(rows[0]!.event.payload).toMatchObject({
      shiftAssignmentId: a.id,
      employeeId: empA,
      outletId: jkt,
      shiftTemplateId: tplPagi,
      stationId: null,
      businessDate: day(10, 0),
      publishedBy: mgrUserId,
    });
    const payload = rows[0]!.event.payload as { segments: Segment[] };
    expect(
      payload.segments.map(
        (segment) =>
          [Date.parse(segment.startsAt), Date.parse(segment.endsAt)] as const,
      ),
    ).toEqual([[at(day(10, 0), "08:00", WIB), at(day(10, 0), "16:00", WIB)]]);
    const serialized = JSON.stringify(rows[0]!.event);
    expect(serialized).not.toContain("Karyawan Jadwal API");
    expect(serialized).not.toMatch(/nik|salary|gaji|fullName/i);
  });

  it("[§28 Notifikasi Jadwal] the shift owners get an in-app notification; an employee with no shift gets none; a replay adds none", async () => {
    const countFor = async (userId: string) =>
      asTenant(async (client) => {
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM notifications
            WHERE tenant_id = $1 AND user_id::text = $2`,
          [tenant.id, userId],
        );
        return rows[0]!.n;
      });

    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenant.id,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    const deliver = createNotificationConsumer(
      context,
      createNotificationRecipientResolver({ email: false, push: true }),
    );
    const deliverAll = async () => {
      const load = (onlyNotification: boolean) =>
        asTenant(async (client) => {
          const { rows } = await client.query<{
            event: Record<string, unknown>;
          }>(
            `SELECT event FROM domain_event_outbox
              WHERE tenant_id = $1 AND event->>'name' = 'shift.published'
                AND event->'payload'->>'outletId' = $2
                AND ($3::boolean IS FALSE OR destination = 'notification')
              ORDER BY created_at`,
            [tenant.id, jkt, onlyNotification],
          );
          return rows.map((row) => row.event);
        });
      let events = await load(true);
      if (events.length === 0) events = await load(false);
      expect(events.length, "shift.published rows to deliver").toBeGreaterThan(
        0,
      );
      for (const event of events)
        await withTenant(db, context, (tx) =>
          deliver(event as never, String(event.idempotencyKey), tx as never),
        );
    };

    expect(await countFor(staffAUserId)).toBe(0);
    await deliverAll();
    const afterA = await countFor(staffAUserId);
    const afterB = await countFor(staffBUserId);
    expect(afterA).toBeGreaterThanOrEqual(1);
    expect(afterB).toBeGreaterThanOrEqual(1);
    expect(await countFor(nobodyUserId)).toBe(0);

    await deliverAll();
    expect(await countFor(staffAUserId)).toBe(afterA);
    expect(await countFor(staffBUserId)).toBe(afterB);
  });

  it("[HR-01] after publication each employee sees only their own published shifts, never a colleague's", async () => {
    const range = `from=${week(10)}&to=${day(10, 6)}`;
    const own = await staffA.get(`/api/hris/shifts?${range}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(ids(own.body.data)).toEqual([a.id]);
    expect(own.body.data[0]).toMatchObject({
      employeeId: empA,
      status: "published",
    });
    const other = await staffB.get(`/api/hris/shifts?${range}`);
    expect(ids(other.body.data)).toEqual([b.id]);

    // Asking for a colleague's shifts through the filter gives nothing of theirs.
    const peek = await staffA.get(
      `/api/hris/shifts?${range}&employeeId=${empB}`,
    );
    if (peek.status === 200)
      expect(
        peek.body.data.every(
          (row: { employeeId: string }) => row.employeeId === empA,
        ),
      ).toBe(true);
    else expect([403, 404]).toContain(peek.status);
    // Other outlets are out of the employee's reach.
    const outside = await staffA.get(`/api/hris/shifts?outletId=${wita}`);
    if (outside.status === 200) expect(outside.body.data).toEqual([]);
    else expect([403, 404]).toContain(outside.status);

    const manager = await mgr.get(`/api/hris/shifts?outletId=${jkt}&${range}`);
    expect(ids(manager.body.data)).toEqual(
      expect.arrayContaining([a.id, b.id, c.id]),
    );
  });

  it("[§28 Roster Mingguan] a published shift cannot be edited (409); HR can cancel it", async () => {
    expect(
      (
        await patch(mgr, `/api/hris/shifts/${b.id}`, {
          shiftTemplateId: tplMalam,
        })
      ).status,
    ).toBe(409);
    const cancelled = await post(mgr, `/api/hris/shifts/${c.id}/cancel`, {
      idempotencyKey: key(),
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.status).toBe("cancelled");
    const view = await roster(jkt, week(10));
    expect(view.assignments.find((row) => row.id === b.id)?.status).toBe(
      "published",
    );
  });

  it("[§28 Roster Mingguan] a shift added to a published week is a draft; a second publication publishes only it and does not re-emit the others", async () => {
    const extra = await makeShift(jkt, empA, day(10, 4), tplPagi);
    expect(extra.status).toBe("draft");
    expect(
      (await staffA.get(`/api/hris/shifts?from=${day(10, 4)}&to=${day(10, 4)}`))
        .body.data,
    ).toEqual([]);

    const second = await post(mgr, "/api/hris/rosters/publish", {
      outletId: jkt,
      weekStart: week(10),
      idempotencyKey: key(),
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(
      activeOf(second.body.data.assignments).every(
        (row: Assignment) => row.status === "published",
      ),
    ).toBe(true);
    expect(await shiftEvents(extra.id)).toHaveLength(1);
    expect(await shiftEvents(a.id)).toHaveLength(1);
    expect(await shiftEvents(b.id)).toHaveLength(1);
  });

  it("[§28 Kepatuhan] compliance warnings do not block publication: they are returned with the publication and shown on the roster", async () => {
    const response = await post(mgr, "/api/hris/rosters/publish", {
      outletId: jkt,
      weekStart: week(7),
      idempotencyKey: key(),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const codes = (response.body.data.complianceIssues as Issue[]).map(
      (issue) => issue.code,
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        "insufficient_rest",
        "shift_too_long",
        "overlapping_shift",
      ]),
    );
    expect(
      (response.body.data.assignments as Assignment[]).every(
        (row) => row.status === "published",
      ),
    ).toBe(true);
    const view = await roster(jkt, week(7));
    expect(view.published).toBe(true);
    expect(view.complianceIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["insufficient_rest", "shift_too_long"]),
    );
  });

  it("[§28 Roster Mingguan] copying a published week gives drafts that the employees cannot see yet", async () => {
    const response = await post(mgr, "/api/hris/rosters/copy", {
      outletId: jkt,
      fromWeekStart: week(10),
      toWeekStart: week(11),
      idempotencyKey: key(),
    });
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    expect(response.body.data.published).toBe(false);
    const copies = activeOf(response.body.data.assignments as Assignment[]);
    expect(copies.length).toBeGreaterThanOrEqual(2);
    for (const copy of copies) {
      expect(copy.status).toBe("draft");
      expect(copy.publishedAt).toBeNull();
    }
    const own = await staffA.get(
      `/api/hris/shifts?from=${week(11)}&to=${day(11, 6)}`,
    );
    expect(own.body.data).toEqual([]);
  });

  it("[TEN-02] invalid publication bodies are refused (422)", async () => {
    const valid = { outletId: jkt, weekStart: week(12), idempotencyKey: key() };
    for (const bad of [
      { ...valid, extra: 1 },
      { ...valid, tenantId: tenant.id },
      { ...valid, weekStart: "not-a-date" },
      { ...valid, idempotencyKey: undefined },
    ])
      expect(
        (await post(mgr, "/api/hris/rosters/publish", bad)).status,
        JSON.stringify(bad),
      ).toBe(422);
    expect((await mgr.get(`/api/hris/rosters?outletId=${jkt}`)).status).toBe(
      422,
    );
  });
});

// ---- outlet scope and tenant isolation ---------------------------------------

describe("outlet scope and tenant isolation", () => {
  it("[TEN-03] a manager of another outlet cannot create, change, cancel, list or read this outlet's roster (404)", async () => {
    const draft = await makeShift(jkt, empA, day(13, 0), tplPagi);
    expect(
      (
        await post(
          mgrWita,
          "/api/hris/shifts",
          shiftBody(jkt, empA, day(13, 1), tplPagi),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await patch(mgrWita, `/api/hris/shifts/${draft.id}`, {
          employeeId: empB,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(mgrWita, `/api/hris/shifts/${draft.id}/cancel`, {
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await mgrWita.get(
          `/api/hris/rosters?outletId=${jkt}&weekStart=${week(13)}`,
        )
      ).status,
    ).toBe(404);
    const foreign = await mgrWita.get(`/api/hris/shifts?outletId=${jkt}`);
    if (foreign.status === 200) expect(foreign.body.data).toEqual([]);
    else expect(foreign.status).toBe(404);
    const own = await mgrWita.get("/api/hris/shifts?limit=100");
    expect(own.status).toBe(200);
    expect(ids(own.body.data)).not.toContain(draft.id);
    const view = await roster(jkt, week(13));
    expect(view.assignments).toHaveLength(1);
    expect(view.assignments[0]).toMatchObject({
      id: draft.id,
      employeeId: empA,
      status: "draft",
    });
  });

  it("[TEN-01] another tenant's outlet, employee and shifts are not reachable and RLS hides this tenant's rows from it", async () => {
    tenantB = await createSecondTenant(owner, "sched");
    tenantBEmployee = randomUUID();
    await owner.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, NULL, $3, 'Karyawan Tenant B', $4, 'pkwtt', '2025-03-01', 'active')`,
      [
        tenantBEmployee,
        tenantB.tenantId,
        `TB-${tenantBEmployee.slice(0, 8).toUpperCase()}`,
        tenantB.outletId,
      ],
    );

    // Controls: tenant A rows exist.
    const own = await makeShift(jkt, empB, day(14, 0), tplPagi);
    expect((await roster(jkt, week(14))).assignments).toHaveLength(1);

    // Tenant B's outlet is out of reach for a tenant A manager.
    expect(
      (
        await mgr.get(
          `/api/hris/rosters?outletId=${tenantB.outletId}&weekStart=${week(14)}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await mgr.get(`/api/hris/shift-templates?outletId=${tenantB.outletId}`))
        .status,
    ).toBe(404);
    expect(
      (
        await post(mgr, "/api/hris/shift-templates", {
          outletId: tenantB.outletId,
          name: "Lintas tenant",
          segments: [{ startTime: "08:00", endTime: "16:00" }],
          breakMinutes: 0,
          stationId: null,
          positionId: null,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(mgr, "/api/hris/shifts", {
          ...shiftBody(tenantB.outletId, tenantBEmployee, day(14, 1), tplPagi),
        })
      ).status,
    ).toBe(404);
    // Tenant B's employee cannot be scheduled in a tenant A outlet.
    const crossEmployee = await post(
      mgr,
      "/api/hris/shifts",
      shiftBody(jkt, tenantBEmployee, day(14, 1), tplPagi),
    );
    expect([404, 409, 422]).toContain(crossEmployee.status);
    expect(
      (
        await post(mgr, "/api/hris/rosters/publish", {
          outletId: tenantB.outletId,
          weekStart: week(14),
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(404);

    // Row level security: tenant B sees and changes none of tenant A's rows.
    for (const [table, rowId] of [
      ["shift_assignments", own.id],
      ["shift_templates", tplPagi],
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
  });
});
