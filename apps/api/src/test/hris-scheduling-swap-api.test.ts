// Shift swap and cover over HTTP (PRD v1.7 §3 Kelompok D 28 "Tukar & Ganti
// Shift", "Kepatuhan", F26, HR-05, TEN-01/02/03; WS-10 brief). Runs the real
// Express app, Better Auth, RBAC and PostgreSQL against the seeded Cafe Legend
// tenant. Expected behaviour comes from the PRD, the shared contract
// (packages/shared/src/hris/scheduling.ts, endpoints.ts) and the WS-10 brief,
// not from the service code. Roster arithmetic and the compliance maths have
// their own shared unit tests; this file checks what a client sees.
//
// Assumptions (the spec leaves these open):
//  - Create answers 201, decide and cancel answer 200, publish answers 200 or
//    201. Replays of a create or decision answer a 2xx with the same row.
//  - A refused HR-05 approval ("approve" with violations) is 409; an override
//    without a (non-blank) reason is 409 or 422.
//  - A decision by the requester or the target (even with the approve
//    permission) is 403 or 409; a cancel by anyone but the requester is 403 or
//    404; a request for somebody else's assignment is 403 or 404.
//  - An outlet outside the caller's scope answers 404 (brief: `notFound()`);
//    another tenant's swap answers 403 or 404 and is never modified.
//  - A request from a draft assignment, to a target of another outlet, or to
//    oneself is 409 or 422.
//  - A cancelled request frees its assignment for a new request (the "one open
//    request" rule counts pending requests only).
//  - A draft assignment may still be added to an already published week
//    (used to make the roster violating after a request was filed).
//  - The shift.published outbox row is found by payload.shiftAssignmentId.
//  - Dates are Mondays-based weeks from 2036-01-07, one week per scenario, so
//    publishing a week never touches rows of other suites. Outlet time zone is
//    the fixture's; templates use 07:00-15:00 (pagi) and 22:00-06:00 (malam),
//    so malam on day N followed by pagi on day N+1 leaves 60 minutes of rest,
//    below the 660 default (HR-05 violation `insufficient_rest`).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeCursor } from "@starter/shared/core";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { addBusinessDays } from "@starter/shared/hris";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import { validPdfBytes } from "./helpers/pdf-fixtures.ts";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

const app = createApp({
  storageRuntime: {
    storage: new FakeObjectStorage(),
    scanner: new NoopMalwareScanner(),
    fileSigner: async () => null,
    hrisDocumentSigner: async () => null,
  },
});
const tenant = cafeLegendPlatformFixtures.tenant;
const [outlet, secondOutlet] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const createdUsers: string[] = [];
const createdRoles: { tenantId: string; id: string }[] = [];
const createdEmployees: string[] = [];
const BASE_WEEK = "2036-01-07";
const KEY_PREFIX = "swap-api-";

async function ownerTx<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
  options: { replica?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (options.replica)
      await client.query("SET LOCAL session_replication_role = replica");
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
const asTenant = <T>(run: (client: PoolClient) => Promise<T>) =>
  ownerTx(tenant.id, run);

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

async function grantCustomRole(
  tenantId: string,
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const roleId = randomUUID();
  createdRoles.push({ tenantId, id: roleId });
  await ownerTx(tenantId, async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantId,
        `Swap API ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
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

async function seedEmployee(
  userId: string | null,
  outletId: string,
  name = "Karyawan Tukar API",
) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, $6, $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        userId,
        `SW-${id.slice(0, 8).toUpperCase()}`,
        outletId,
        name,
      ],
    ),
  );
  return id;
}

const key = () => `${KEY_PREFIX}${randomUUID()}`;
const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);

const STAFF_PERMISSIONS = [
  "self.profile.view",
  "self.schedule.view",
  "self.shift_swap.request",
  "self.leave.request",
];
const MANAGER_PERMISSIONS = [
  "hr.schedule.manage",
  "hr.shift_swap.approve",
  "hr.employee.view",
];

let hr: { client: Client; userId: string };
let hrNoApprove: { client: Client; userId: string };
let managerB: { client: Client; userId: string };
let supervisor: { client: Client; userId: string };
let requester: { client: Client; userId: string };
let target: { client: Client; userId: string };
let target2: { client: Client; userId: string };
let bystander: { client: Client; userId: string };
let dual: { client: Client; userId: string };
let dualTarget: { client: Client; userId: string };
let employeeR: string;
let employeeT: string;
let employeeT2: string;
let employeeDual: string;
let employeeDualTarget: string;
let employeeOtherOutlet: string;
let pagiId: string;
let malamId: string;
let tenantB: SecondTenant;
let actorB: { client: Client; userId: string };

beforeAll(async () => {
  hr = await signedInClient("HR Tukar API", { mfa: true });
  await grantCustomRole(tenant.id, hr.userId, MANAGER_PERMISSIONS, {
    type: "tenant",
  });
  hrNoApprove = await signedInClient("HR Tanpa Approve API", { mfa: true });
  await grantCustomRole(
    tenant.id,
    hrNoApprove.userId,
    ["hr.schedule.manage", "hr.employee.view"],
    { type: "tenant" },
  );
  managerB = await signedInClient("Manajer B Tukar API", { mfa: true });
  await grantCustomRole(tenant.id, managerB.userId, MANAGER_PERMISSIONS, {
    type: "outlet",
    id: secondOutlet.id,
  });
  supervisor = await signedInClient("Supervisor rincian tukar", { mfa: true });
  await grantCustomRole(
    tenant.id,
    supervisor.userId,
    ["hr.shift_swap.approve"],
    { type: "outlet", id: outlet.id },
  );

  const staffScope = { type: "outlet", id: outlet.id } as const;
  requester = await signedInClient("Peminta Tukar API");
  target = await signedInClient("Target Tukar API");
  target2 = await signedInClient("Target Dua Tukar API");
  bystander = await signedInClient("Pengamat Tukar API");
  for (const staff of [requester, target, target2, bystander])
    await grantCustomRole(
      tenant.id,
      staff.userId,
      STAFF_PERMISSIONS,
      staffScope,
    );
  dual = await signedInClient("Peminta Penyetuju API", { mfa: true });
  dualTarget = await signedInClient("Target Penyetuju API", { mfa: true });
  for (const staff of [dual, dualTarget])
    await grantCustomRole(
      tenant.id,
      staff.userId,
      [...STAFF_PERMISSIONS, "hr.shift_swap.approve", "hr.employee.view"],
      staffScope,
    );

  employeeR = await seedEmployee(requester.userId, outlet.id, "Pemohon U4");
  employeeT = await seedEmployee(target.userId, outlet.id, "Rekan U4");
  employeeT2 = await seedEmployee(target2.userId, outlet.id);
  await seedEmployee(bystander.userId, outlet.id);
  employeeDual = await seedEmployee(dual.userId, outlet.id);
  employeeDualTarget = await seedEmployee(dualTarget.userId, outlet.id);
  employeeOtherOutlet = await seedEmployee(null, secondOutlet.id);

  const pagi = await post(hr.client, "/api/hris/shift-templates", {
    outletId: outlet.id,
    name: "SWAPAPI Pagi",
    segments: [{ startTime: "07:00", endTime: "15:00" }],
    breakMinutes: 60,
    stationId: null,
    positionId: null,
  });
  expect(pagi.status, JSON.stringify(pagi.body)).toBe(201);
  pagiId = pagi.body.data.id;
  const malam = await post(hr.client, "/api/hris/shift-templates", {
    outletId: outlet.id,
    name: "SWAPAPI Malam",
    segments: [{ startTime: "22:00", endTime: "06:00" }],
    breakMinutes: 30,
    stationId: null,
    positionId: null,
  });
  expect(malam.status, JSON.stringify(malam.body)).toBe(201);
  malamId = malam.body.data.id;

  tenantB = await createSecondTenant(owner, "swapapi");
  actorB = await signedInClient("Tenant B Tukar API", { mfa: true });
  await grantCustomRole(
    tenantB.tenantId,
    actorB.userId,
    [...MANAGER_PERMISSIONS, "self.schedule.view"],
    { type: "tenant" },
  );
}, 90_000);

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
    await step(() =>
      ownerTx(tenant.id, async (db) => {
        await db.query(
          "DELETE FROM shift_swap_requests WHERE tenant_id = $1 AND requested_by = ANY($2::uuid[])",
          [tenant.id, createdEmployees],
        );
        await db.query(
          "DELETE FROM shift_assignments WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
          [tenant.id, createdEmployees],
        );
        await db.query(
          "DELETE FROM roster_publications WHERE tenant_id = $1 AND outlet_id = $2 AND week_start >= $3",
          [tenant.id, outlet.id, BASE_WEEK],
        );
        await db.query(
          "DELETE FROM shift_templates WHERE tenant_id = $1 AND name LIKE 'SWAPAPI %'",
          [tenant.id],
        );
        await db.query(
          "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE $2",
          [tenant.id, `${KEY_PREFIX}%`],
        );
      }),
    );
    await step(() =>
      // Audit and outbox rows are append-only; replica mode lets the owner
      // remove the ones that name our fixtures.
      ownerTx(
        tenant.id,
        async (db) => {
          await db.query(
            `DELETE FROM domain_event_outbox
              WHERE tenant_id = $1 AND event->'payload'->>'employeeId' = ANY($2::text[])`,
            [tenant.id, createdEmployees],
          );
          await db.query(
            `DELETE FROM audit_logs
              WHERE tenant_id = $1 AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS e(id)
                                                WHERE audit_logs.event::text LIKE '%' || e.id || '%')`,
            [tenant.id, createdEmployees],
          );
        },
        { replica: true },
      ),
    );
    await step(() =>
      ownerTx(tenant.id, (db) =>
        db.query(
          "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
          [tenant.id, createdEmployees],
        ),
      ),
    );
    for (const role of createdRoles)
      await step(() =>
        ownerTx(role.tenantId, async (db) => {
          await db.query(
            "DELETE FROM role_assignments WHERE tenant_id = $1 AND role_id = $2",
            [role.tenantId, role.id],
          );
          await db.query("DELETE FROM roles WHERE tenant_id = $1 AND id = $2", [
            role.tenantId,
            role.id,
          ]);
        }),
      );
    if (tenantB)
      await step(() =>
        ownerTx(
          tenantB.tenantId,
          (db) =>
            db.query("DELETE FROM audit_logs WHERE tenant_id = $1", [
              tenantB.tenantId,
            ]),
          { replica: true },
        ),
      );
    if (tenantB) await step(() => removeSecondTenant(owner, tenantB));
    await step(() =>
      owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
        createdUsers,
      ]),
    );
  } finally {
    await step(() => owner.end());
  }
  if (errors.length > 0) throw errors[0];
}, 60_000);

// ---- scenario helpers ----------------------------------------------------

const weekOf = (week: number) => addBusinessDays(BASE_WEEK, 7 * week);
const dayOf = (week: number, day: number) =>
  addBusinessDays(BASE_WEEK, 7 * week + day);

async function createShift(
  employeeId: string,
  businessDate: string,
  templateId: string,
): Promise<string> {
  const created = await post(hr.client, "/api/hris/shifts", {
    outletId: outlet.id,
    employeeId,
    businessDate,
    shiftTemplateId: templateId,
    stationId: null,
    idempotencyKey: key(),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.status).toBe("draft");
  return created.body.data.id as string;
}

async function publishWeek(week: number) {
  const published = await post(hr.client, "/api/hris/rosters/publish", {
    outletId: outlet.id,
    weekStart: weekOf(week),
    idempotencyKey: key(),
  });
  expect([200, 201], JSON.stringify(published.body)).toContain(
    published.status,
  );
}

type Entry = { employeeId: string; day: number; templateId: string };

/** Creates the entries as drafts of one week and publishes the whole week. */
async function publishedWeek(week: number, entries: Entry[]) {
  const ids: string[] = [];
  for (const entry of entries)
    ids.push(
      await createShift(
        entry.employeeId,
        dayOf(week, entry.day),
        entry.templateId,
      ),
    );
  await publishWeek(week);
  return ids;
}

type ShiftView = { id: string; employeeId: string; status: string };
async function shiftAs(
  client: Client,
  week: number,
  assignmentId: string,
): Promise<ShiftView | undefined> {
  const list = await client.get(
    `/api/hris/shifts?outletId=${outlet.id}&from=${weekOf(week)}&to=${dayOf(week, 6)}&limit=100`,
  );
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  return (list.body.data as ShiftView[]).find((row) => row.id === assignmentId);
}
const shiftNow = (week: number, assignmentId: string) =>
  shiftAs(hr.client, week, assignmentId);

type SwapBody = {
  fromAssignmentId: string;
  toEmployeeId: string;
  toAssignmentId?: string | null;
  idempotencyKey?: string;
};
const requestSwap = (client: Client, body: SwapBody) =>
  post(client, "/api/hris/shift-swaps", {
    outletId: outlet.id,
    toAssignmentId: null,
    idempotencyKey: key(),
    ...body,
  });

async function openCover(assignmentId: string, toEmployeeId: string) {
  const created = await requestSwap(requester.client, {
    fromAssignmentId: assignmentId,
    toEmployeeId,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data as {
    id: string;
    status: string;
    complianceIssues: { code: string; employeeId: string }[];
  };
}

/** Seeds a published copy of `likeAssignmentId` for the employee at another outlet. */
async function publishedShiftElsewhere(
  employeeId: string,
  outletId: string,
  likeAssignmentId: string,
) {
  await asTenant((db) =>
    db.query(
      `INSERT INTO shift_assignments
         (tenant_id, outlet_id, employee_id, business_date, segments, break_minutes,
          status, source, published_by, published_at, created_by)
       SELECT tenant_id, $2, $3, business_date, segments, break_minutes,
              'published', 'user', created_by, now(), created_by
         FROM shift_assignments WHERE tenant_id = $1 AND id = $4`,
      [tenant.id, outletId, employeeId, likeAssignmentId],
    ),
  );
}

const decide = async (
  client: Client,
  swapId: string,
  action: "approve" | "approve_with_override" | "reject",
  overrideReason: string | null = null,
  idempotencyKey = key(),
) => {
  // Existing manager-decision scenarios begin after the colleague accepts.
  // The peer-acceptance cases below exercise the decision endpoint directly.
  if (client === hr.client) {
    const { rows } = await asTenant((db) =>
      db.query<{ to_employee_id: string }>(
        "SELECT to_employee_id FROM shift_swap_requests WHERE tenant_id = $1 AND id = $2",
        [tenant.id, swapId],
      ),
    );
    const peer = [
      [employeeT, target.client],
      [employeeT2, target2.client],
      [employeeDualTarget, dualTarget.client],
      [employeeR, requester.client],
      [employeeDual, dual.client],
    ].find(([id]) => id === rows[0]?.to_employee_id)?.[1];
    if (peer && typeof peer !== "string") {
      await post(peer, `/api/hris/shift-swaps/${swapId}/peer-response`, {
        action: "accept",
        idempotencyKey: key(),
      });
    }
  }
  return post(client, `/api/hris/shift-swaps/${swapId}/decision`, {
    action,
    overrideReason,
    ...(action === "reject" ? { rejectionReason: "Jadwal penuh" } : {}),
    idempotencyKey,
  });
};

const cancelSwap = (client: Client, swapId: string, idempotencyKey = key()) =>
  post(client, `/api/hris/shift-swaps/${swapId}/cancel`, { idempotencyKey });

async function swapStatus(swapId: string): Promise<string | undefined> {
  const list = await hr.client.get(
    `/api/hris/shift-swaps?outletId=${outlet.id}&limit=100`,
  );
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  return (list.body.data as { id: string; status: string }[]).find(
    (row) => row.id === swapId,
  )?.status;
}

type OutboxEvent = {
  sequence: number;
  idempotencyKey: string;
  payload: { employeeId: string; shiftAssignmentId: string };
};
async function publishedEvents(assignmentId: string): Promise<OutboxEvent[]> {
  const { rows } = await asTenant((db) =>
    db.query<{ event: OutboxEvent }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND destination = 'cloud-sync'
          AND event->>'name' = 'shift.published'
          AND event->'payload'->>'shiftAssignmentId' = $2
        ORDER BY (event->>'sequence')::int`,
      [tenant.id, assignmentId],
    ),
  );
  return rows.map((row) => row.event);
}

type CancelledEvent = {
  sequence: number;
  payload: {
    employeeId: string;
    shiftAssignmentId: string;
    reason: string;
    cancelledBy: string;
  };
};
async function cancelledEvents(
  assignmentId: string,
  destination: "cloud-sync" | "notification" = "cloud-sync",
): Promise<CancelledEvent[]> {
  const { rows } = await asTenant((db) =>
    db.query<{ event: CancelledEvent }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND destination = $3
          AND event->>'name' = 'shift.cancelled'
          AND event->'payload'->>'shiftAssignmentId' = $2
        ORDER BY (event->>'sequence')::int`,
      [tenant.id, assignmentId, destination],
    ),
  );
  return rows.map((row) => row.event);
}

// ---- authentication and input -------------------------------------------

const withoutIdempotencyKey = (body: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(body).filter(([name]) => name !== "idempotencyKey"),
  );

describe("authentication and input", () => {
  it("[TEN-01] anonymous requests to every swap route answer 401", async () => {
    const anonymous = agent(app);
    const id = randomUUID();
    expect((await anonymous.get("/api/hris/shift-swaps")).status).toBe(401);
    for (const path of [
      "/api/hris/shift-swaps",
      `/api/hris/shift-swaps/${id}/decision`,
      `/api/hris/shift-swaps/${id}/cancel`,
    ])
      expect(
        (await anonymous.post(path).set(originHeader).send({})).status,
        path,
      ).toBe(401);
  });

  it("[TEN-02] swap bodies with a tenantId, an unknown field, a missing idempotency key or no Origin are refused", async () => {
    const [shift] = await publishedWeek(20, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const valid = {
      outletId: outlet.id,
      fromAssignmentId: shift,
      toEmployeeId: employeeT,
      toAssignmentId: null,
      idempotencyKey: key(),
    };
    const send = (body: object) =>
      post(requester.client, "/api/hris/shift-swaps", body);
    expect((await send({ ...valid, tenantId: tenant.id })).status).toBe(422);
    expect((await send({ ...valid, extra: 1 })).status).toBe(422);
    const withoutKey = withoutIdempotencyKey(valid);
    expect((await send(withoutKey)).status).toBe(422);
    expect(
      (await send({ ...valid, fromAssignmentId: "not-a-uuid" })).status,
    ).toBe(422);
    const noOrigin = await requester.client
      .post("/api/hris/shift-swaps")
      .send(valid);
    expect(noOrigin.status).toBe(403);
    expect((await shiftNow(20, shift))?.status).toBe("published");

    const swap = await openCover(shift, employeeT);
    const decision = (body: object) =>
      post(hr.client, `/api/hris/shift-swaps/${swap.id}/decision`, body);
    const base = {
      action: "approve",
      overrideReason: null,
      idempotencyKey: key(),
    };
    expect((await decision({ ...base, tenantId: tenant.id })).status).toBe(422);
    expect((await decision({ ...base, action: "approve_all" })).status).toBe(
      422,
    );
    const noKey = withoutIdempotencyKey(base);
    expect((await decision(noKey)).status).toBe(422);
    expect(await swapStatus(swap.id)).toBe("pending");
  });
});

// ---- clean swap and cover ------------------------------------------------

describe("Tukar & Ganti Shift: approval without violations", () => {
  it("[F26 cover] a clean cover is requested (pending, no issues) and approved: the shift moves to the colleague as swapped", async () => {
    const [shift] = await publishedWeek(0, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);
    expect(swap).toMatchObject({
      status: "pending",
      complianceIssues: [],
      overrideReason: null,
      approvedBy: null,
      decidedAt: null,
      requestedBy: employeeR,
      toEmployeeId: employeeT,
      toAssignmentId: null,
      fromAssignmentId: shift,
      outletId: outlet.id,
    });
    // Nothing moves before a decision.
    expect(await shiftNow(0, shift)).toMatchObject({
      employeeId: employeeR,
      status: "published",
    });

    const approved = await decide(hr.client, swap.id, "approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({
      id: swap.id,
      status: "approved",
      approvedBy: hr.userId,
      overrideReason: null,
    });
    expect(approved.body.data.decidedAt).toEqual(expect.any(String));
    expect(await shiftNow(0, shift)).toMatchObject({
      employeeId: employeeT,
      status: "swapped",
    });

    // The colleague now sees the shift, the original owner no longer does.
    expect((await shiftAs(target.client, 0, shift))?.status).toBe("swapped");
    expect(await shiftAs(requester.client, 0, shift)).toBeUndefined();
  });

  it("[F26 swap] a clean swap exchanges the two assignments; both become swapped", async () => {
    const [mine, theirs] = await publishedWeek(1, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
      { employeeId: employeeT, day: 2, templateId: pagiId },
    ]);
    const created = await requestSwap(requester.client, {
      fromAssignmentId: mine,
      toEmployeeId: employeeT,
      toAssignmentId: theirs,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      status: "pending",
      complianceIssues: [],
      fromAssignmentId: mine,
      toAssignmentId: theirs,
    });

    const approved = await decide(hr.client, created.body.data.id, "approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe("approved");
    expect(await shiftNow(1, mine)).toMatchObject({
      employeeId: employeeT,
      status: "swapped",
    });
    expect(await shiftNow(1, theirs)).toMatchObject({
      employeeId: employeeR,
      status: "swapped",
    });
  });

  it("[F26 notifikasi] an approved cover re-emits shift.published for the changed shift with a higher sequence and a new idempotency key", async () => {
    const [shift] = await publishedWeek(2, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const first = await publishedEvents(shift);
    expect(first).toHaveLength(1);
    expect(first[0].payload.employeeId).toBe(employeeR);

    const swap = await openCover(shift, employeeT);
    expect(await publishedEvents(shift)).toHaveLength(1);
    const approved = await decide(hr.client, swap.id, "approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const events = await publishedEvents(shift);
    expect(events).toHaveLength(2);
    expect(events[1].sequence).toBeGreaterThan(events[0].sequence);
    expect(events[1].idempotencyKey).not.toBe(events[0].idempotencyKey);
    expect(events[1].payload.employeeId).toBe(employeeT);
  });

  it("[F26 notifikasi] an approved swap re-emits shift.published for both changed shifts; a rejection emits nothing", async () => {
    const [mine, theirs, other] = await publishedWeek(3, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
      { employeeId: employeeT, day: 2, templateId: pagiId },
      { employeeId: employeeR, day: 4, templateId: pagiId },
    ]);
    const swap = await requestSwap(requester.client, {
      fromAssignmentId: mine,
      toEmployeeId: employeeT,
      toAssignmentId: theirs,
    });
    expect(swap.status).toBe(201);
    expect((await decide(hr.client, swap.body.data.id, "approve")).status).toBe(
      200,
    );
    expect(await publishedEvents(mine)).toHaveLength(2);
    expect(await publishedEvents(theirs)).toHaveLength(2);
    expect((await publishedEvents(mine))[1].payload.employeeId).toBe(employeeT);
    expect((await publishedEvents(theirs))[1].payload.employeeId).toBe(
      employeeR,
    );

    const rejectedCover = await openCover(other, employeeT);
    const rejected = await decide(hr.client, rejectedCover.id, "reject");
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.data).toMatchObject({
      status: "rejected",
      approvedBy: hr.userId,
    });
    expect(await publishedEvents(other)).toHaveLength(1);
    expect(await shiftNow(3, other)).toMatchObject({
      employeeId: employeeR,
      status: "published",
    });
  });
});

describe("Tukar & Ganti Shift: shift.cancelled untuk pemilik lama", () => {
  it("[F26 notifikasi] an approved cover emits shift.cancelled (swapped_away) for the requester on both destinations, before the new owner's shift.published", async () => {
    const [shift] = await publishedWeek(40, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);
    expect(await cancelledEvents(shift)).toHaveLength(0);
    expect((await decide(hr.client, swap.id, "approve")).status).toBe(200);

    for (const destination of ["cloud-sync", "notification"] as const) {
      const cancelled = await cancelledEvents(shift, destination);
      expect(cancelled, destination).toHaveLength(1);
      expect(cancelled[0].payload).toMatchObject({
        shiftAssignmentId: shift,
        employeeId: employeeR,
        cause: "swapped_away",
        cancelledBy: hr.userId,
      });
    }
    // One per-assignment sequence: v1 published, v2 cancelled, v3 published.
    const published = await publishedEvents(shift);
    const cancelled = await cancelledEvents(shift);
    expect(published).toHaveLength(2);
    expect(cancelled[0].sequence).toBeGreaterThan(published[0].sequence);
    expect(published[1].sequence).toBeGreaterThan(cancelled[0].sequence);
    expect(published[1].payload.employeeId).toBe(employeeT);
  });

  it("[F26 notifikasi] an approved swap emits shift.cancelled for both parties and shift.published for both new owners; a rejection emits no cancel", async () => {
    const [mine, theirs, other] = await publishedWeek(41, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
      { employeeId: employeeT, day: 2, templateId: pagiId },
      { employeeId: employeeR, day: 4, templateId: pagiId },
    ]);
    const swap = await requestSwap(requester.client, {
      fromAssignmentId: mine,
      toEmployeeId: employeeT,
      toAssignmentId: theirs,
    });
    expect(swap.status, JSON.stringify(swap.body)).toBe(201);
    expect((await decide(hr.client, swap.body.data.id, "approve")).status).toBe(
      200,
    );
    for (const destination of ["cloud-sync", "notification"] as const) {
      const fromMine = await cancelledEvents(mine, destination);
      const fromTheirs = await cancelledEvents(theirs, destination);
      expect(fromMine, destination).toHaveLength(1);
      expect(fromTheirs, destination).toHaveLength(1);
      expect(fromMine[0].payload).toMatchObject({
        employeeId: employeeR,
        cause: "swapped_away",
      });
      expect(fromTheirs[0].payload).toMatchObject({
        employeeId: employeeT,
        cause: "swapped_away",
      });
    }
    expect((await publishedEvents(mine))[1].payload.employeeId).toBe(employeeT);
    expect((await publishedEvents(theirs))[1].payload.employeeId).toBe(
      employeeR,
    );

    const rejectedCover = await openCover(other, employeeT);
    expect((await decide(hr.client, rejectedCover.id, "reject")).status).toBe(
      200,
    );
    expect(await cancelledEvents(other)).toHaveLength(0);
  });

  it("[F26 swap] a swapped shift cannot be swapped or covered again: 409 with a clear message, as source or as target", async () => {
    const [shift, mineAgain] = await publishedWeek(42, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
      { employeeId: employeeR, day: 2, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);
    expect((await decide(hr.client, swap.id, "approve")).status).toBe(200);
    expect(await shiftNow(42, shift)).toMatchObject({
      employeeId: employeeT,
      status: "swapped",
    });

    const again = await requestSwap(target.client, {
      fromAssignmentId: shift,
      toEmployeeId: employeeR,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(JSON.stringify(again.body)).toContain("tidak dapat ditukar lagi");

    const asTarget = await requestSwap(requester.client, {
      fromAssignmentId: mineAgain,
      toEmployeeId: employeeT,
      toAssignmentId: shift,
    });
    expect(asTarget.status, JSON.stringify(asTarget.body)).toBe(409);
    expect(JSON.stringify(asTarget.body)).toContain("tidak dapat ditukar lagi");
    expect(await swapStatusOfAssignment(shift)).toBe("approved");
  });
});

// ---- HR-05 ---------------------------------------------------------------

describe("HR-05 tukar shift tidak boleh melanggar jam kerja tanpa approval eksplisit", () => {
  it("[HR-05] a violating cover is requested with its issues frozen; plain approval is refused (409) and nothing moves", async () => {
    // T works malam on day 1 (until 06:00 day 2); R's pagi on day 2 starts at
    // 07:00, so the cover leaves T 60 minutes of rest (limit 660).
    const [, shift] = await publishedWeek(4, [
      { employeeId: employeeT, day: 1, templateId: malamId },
      { employeeId: employeeR, day: 2, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);
    expect(swap.complianceIssues.length).toBeGreaterThan(0);
    expect(swap.complianceIssues).toContainEqual(
      expect.objectContaining({
        code: "insufficient_rest",
        employeeId: employeeT,
      }),
    );

    const refused = await decide(hr.client, swap.id, "approve");
    expect(refused.status).toBe(409);
    expect(await swapStatus(swap.id)).toBe("pending");
    expect(await shiftNow(4, shift)).toMatchObject({
      employeeId: employeeR,
      status: "published",
    });
    expect(await publishedEvents(shift)).toHaveLength(1);
  });

  it("[HR-05] approve_with_override without a reason (missing or blank) is refused; with a reason it passes and the reason is stored", async () => {
    const [, shift] = await publishedWeek(5, [
      { employeeId: employeeT, day: 1, templateId: malamId },
      { employeeId: employeeR, day: 2, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);

    for (const reason of [null, "   "]) {
      const refused = await decide(
        hr.client,
        swap.id,
        "approve_with_override",
        reason,
      );
      expect([409, 422], `reason ${JSON.stringify(reason)}`).toContain(
        refused.status,
      );
    }
    expect(await swapStatus(swap.id)).toBe("pending");
    expect(await shiftNow(5, shift)).toMatchObject({ employeeId: employeeR });

    const reason = "Kekurangan staf pagi, istirahat disepakati karyawan";
    const approved = await decide(
      hr.client,
      swap.id,
      "approve_with_override",
      reason,
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({
      id: swap.id,
      status: "approved",
      overrideReason: reason,
      approvedBy: hr.userId,
    });
    expect(approved.body.data.complianceIssues.length).toBeGreaterThan(0);
    expect(await shiftNow(5, shift)).toMatchObject({
      employeeId: employeeT,
      status: "swapped",
    });
    const stored = await hr.client.get(
      `/api/hris/shift-swaps?outletId=${outlet.id}&status=approved&limit=100`,
    );
    expect(stored.body.data).toContainEqual(
      expect.objectContaining({ id: swap.id, overrideReason: reason }),
    );
  });

  it("[HR-05] a clean cover cannot be 'overridden': there is nothing to override (409)", async () => {
    const [shift] = await publishedWeek(6, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);
    const refused = await decide(
      hr.client,
      swap.id,
      "approve_with_override",
      "Tidak perlu",
    );
    expect(refused.status).toBe(409);
    expect(await swapStatus(swap.id)).toBe("pending");
  });

  it("[HR-05] compliance is recomputed at decision time: a conflict that appeared after the request blocks plain approval", async () => {
    const [shift] = await publishedWeek(7, [
      { employeeId: employeeR, day: 2, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);
    expect(swap.complianceIssues).toEqual([]);

    // After the request, T is rostered malam the night before and the week is
    // published again (drafts do not count towards compliance).
    await createShift(employeeT, dayOf(7, 1), malamId);
    await publishWeek(7);
    const refused = await decide(hr.client, swap.id, "approve");
    expect(refused.status).toBe(409);
    expect(await shiftNow(7, shift)).toMatchObject({ employeeId: employeeR });

    const override = await decide(
      hr.client,
      swap.id,
      "approve_with_override",
      "Disetujui dengan istirahat singkat",
    );
    expect(override.status, JSON.stringify(override.body)).toBe(200);
    expect(override.body.data.overrideReason).toBe(
      "Disetujui dengan istirahat singkat",
    );
  });

  it("[HR-05] an outlet-only approver still sees the target's published shifts at another outlet: plain approve is 409, an override passes", async () => {
    const [shift] = await publishedWeek(30, [
      { employeeId: employeeR, day: 2, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);
    expect(swap.complianceIssues).toEqual([]);

    // T also works the same hours at the other outlet, published.
    await publishedShiftElsewhere(employeeT, secondOutlet.id, shift);
    const approverA = await signedInClient("Penyetuju Outlet A Tukar API", {
      mfa: true,
    });
    await grantCustomRole(tenant.id, approverA.userId, MANAGER_PERMISSIONS, {
      type: "outlet",
      id: outlet.id,
    });

    const accepted = await post(
      target.client,
      `/api/hris/shift-swaps/${swap.id}/peer-response`,
      { action: "accept", idempotencyKey: key() },
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    const refused = await decide(approverA.client, swap.id, "approve");
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await shiftNow(30, shift)).toMatchObject({ employeeId: employeeR });

    const override = await decide(
      approverA.client,
      swap.id,
      "approve_with_override",
      "Disetujui, tahu bentrok outlet lain",
    );
    expect(override.status, JSON.stringify(override.body)).toBe(200);
    expect(override.body.data.complianceIssues.length).toBeGreaterThan(0);
    expect(await shiftNow(30, shift)).toMatchObject({ employeeId: employeeT });
  }, 60_000);

  it("[HR-05] a request sees the target's published shifts at another outlet when filed (frozen issues)", async () => {
    const [shift] = await publishedWeek(31, [
      { employeeId: employeeR, day: 2, templateId: pagiId },
    ]);
    await publishedShiftElsewhere(employeeT, secondOutlet.id, shift);
    const swap = await openCover(shift, employeeT);
    expect(swap.complianceIssues.length).toBeGreaterThan(0);
    expect(
      swap.complianceIssues.every((issue) => issue.employeeId === employeeT),
    ).toBe(true);
  });

  it("[HR-05] compliance ignores draft shifts: a colleague's unpublished draft neither blocks nor shows in the issues", async () => {
    const [shift] = await publishedWeek(32, [
      { employeeId: employeeR, day: 2, templateId: pagiId },
    ]);
    await createShift(employeeT, dayOf(32, 1), malamId);
    const swap = await openCover(shift, employeeT);
    expect(swap.complianceIssues).toEqual([]);
    const approved = await decide(hr.client, swap.id, "approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  });

  it("[HR-05] compliance is recomputed at decision time: a conflict that disappeared after the request no longer needs an override", async () => {
    const [blocker, shift] = await publishedWeek(8, [
      { employeeId: employeeT, day: 1, templateId: malamId },
      { employeeId: employeeR, day: 2, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);
    expect(swap.complianceIssues.length).toBeGreaterThan(0);

    const cancelled = await post(
      hr.client,
      `/api/hris/shifts/${blocker}/cancel`,
      {
        idempotencyKey: key(),
      },
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const approved = await decide(hr.client, swap.id, "approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: "approved",
      overrideReason: null,
    });
    expect(await shiftNow(8, shift)).toMatchObject({ employeeId: employeeT });
  });
});

// ---- request rules -------------------------------------------------------

describe("pengajuan tukar/ganti", () => {
  it("[F26 swap] only one open request per assignment (409); after it is cancelled a new one is accepted", async () => {
    const [shift] = await publishedWeek(9, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const first = await openCover(shift, employeeT);
    const second = await requestSwap(requester.client, {
      fromAssignmentId: shift,
      toEmployeeId: employeeT2,
    });
    expect(second.status).toBe(409);

    expect((await cancelSwap(requester.client, first.id)).status).toBe(200);
    const again = await requestSwap(requester.client, {
      fromAssignmentId: shift,
      toEmployeeId: employeeT2,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it("[F26 swap] replaying a create with the same idempotency key returns the same request, not a second one", async () => {
    const [shift] = await publishedWeek(10, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const idempotencyKey = key();
    const body = {
      fromAssignmentId: shift,
      toEmployeeId: employeeT,
      idempotencyKey,
    };
    const first = await requestSwap(requester.client, body);
    const replay = await requestSwap(requester.client, body);
    expect(first.status).toBe(201);
    expect(replay.status).toBeGreaterThanOrEqual(200);
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const mine = await requester.client.get(
      "/api/hris/shift-swaps?mine=true&limit=100",
    );
    expect(
      (mine.body.data as { id: string }[]).filter(
        (row) => row.id === first.body.data.id,
      ),
    ).toHaveLength(1);
  });

  it("[F26 swap] concurrent creates with the same idempotency key return one request, not a 409", async () => {
    const [shift] = await publishedWeek(33, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const body = {
      fromAssignmentId: shift,
      toEmployeeId: employeeT,
      idempotencyKey: key(),
    };
    const results = await Promise.all([
      requestSwap(requester.client, body),
      requestSwap(requester.client, body),
      requestSwap(requester.client, body),
    ]);
    for (const result of results)
      expect([200, 201], JSON.stringify(result.body)).toContain(result.status);
    expect(new Set(results.map((result) => result.body.data.id)).size).toBe(1);
  });

  it("[F26 swap] a malformed list cursor is 422, not 500; mine=true without an employee record is an empty page", async () => {
    const cursor = (parts: string[]) => encodeCursor(parts);
    for (const bad of [
      cursor(["2036-01-01T00:00:00.000Z", "not-a-uuid"]),
      cursor(["not-a-date", randomUUID()]),
    ]) {
      const response = await hr.client.get(
        `/api/hris/shift-swaps?limit=10&cursor=${bad}`,
      );
      expect(response.status, bad).toBe(422);
    }
    const mine = await hr.client.get(
      "/api/hris/shift-swaps?mine=true&limit=10",
    );
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.data).toEqual([]);
    expect(mine.body.meta.nextCursor).toBeNull();
  });

  it("[F26 swap] a colleague cannot request a swap for someone else's shift", async () => {
    const [shift] = await publishedWeek(11, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const stolen = await requestSwap(bystander.client, {
      fromAssignmentId: shift,
      toEmployeeId: employeeT,
    });
    expect([403, 404]).toContain(stolen.status);
  });

  it("[F26 swap] a draft shift, a target of another outlet and a swap with oneself are refused", async () => {
    const draft = await createShift(employeeR, dayOf(12, 1), pagiId);
    const fromDraft = await requestSwap(requester.client, {
      fromAssignmentId: draft,
      toEmployeeId: employeeT,
    });
    expect([409, 422]).toContain(fromDraft.status);

    const [shift] = await publishedWeek(13, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const elsewhere = await requestSwap(requester.client, {
      fromAssignmentId: shift,
      toEmployeeId: employeeOtherOutlet,
    });
    expect([409, 422]).toContain(elsewhere.status);
    const toSelf = await requestSwap(requester.client, {
      fromAssignmentId: shift,
      toEmployeeId: employeeR,
    });
    expect([409, 422]).toContain(toSelf.status);
    expect(await swapStatusOfAssignment(shift)).toBeUndefined();
  });

  it("[F26 swap] swapping two shifts of the same day and template is refused when filed (422), not left to fail on approval", async () => {
    const [mine, theirs] = await publishedWeek(50, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
      { employeeId: employeeT, day: 1, templateId: pagiId },
    ]);
    const refused = await requestSwap(requester.client, {
      fromAssignmentId: mine,
      toEmployeeId: employeeT,
      toAssignmentId: theirs,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error.code).toBe("VALIDATION_ERROR");
    expect(await swapStatusOfAssignment(mine)).toBeUndefined();
  });

  it("[F26 swap] a cover approved with override to a colleague who already holds that day and template is 409 SHIFT_DUPLICATE; the swap stays pending and nothing moves", async () => {
    const [mine, held] = await publishedWeek(51, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
      { employeeId: employeeT, day: 1, templateId: pagiId },
    ]);
    const swap = await openCover(mine, employeeT);

    const refused = await decide(
      hr.client,
      swap.id,
      "approve_with_override",
      "Dua shift pagi di hari yang sama disetujui manajer",
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("SHIFT_DUPLICATE");
    expect(await swapStatus(swap.id)).toBe("pending");
    expect(await shiftNow(51, mine)).toMatchObject({
      employeeId: employeeR,
      status: "published",
    });
    expect(await shiftNow(51, held)).toMatchObject({
      employeeId: employeeT,
      status: "published",
    });
    expect(await publishedEvents(mine)).toHaveLength(1);
    expect(await cancelledEvents(mine)).toHaveLength(0);
  });

  it("[F26 swap] the list shows a requester only their own requests; an employee with no request sees an empty list", async () => {
    const [shift] = await publishedWeek(14, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);

    const mine = await requester.client.get(
      "/api/hris/shift-swaps?mine=true&limit=100",
    );
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.data).toContainEqual(
      expect.objectContaining({ id: swap.id, status: "pending" }),
    );

    const empty = await bystander.client.get(
      "/api/hris/shift-swaps?mine=true&limit=100",
    );
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual([]);

    const pending = await hr.client.get(
      `/api/hris/shift-swaps?outletId=${outlet.id}&status=pending&limit=100`,
    );
    expect(pending.status).toBe(200);
    expect(pending.body.data).toContainEqual(
      expect.objectContaining({ id: swap.id }),
    );
  });
});

async function swapStatusOfAssignment(
  assignmentId: string,
): Promise<string | undefined> {
  const list = await hr.client.get(
    `/api/hris/shift-swaps?outletId=${outlet.id}&limit=100`,
  );
  return (
    list.body.data as { fromAssignmentId: string; status: string }[]
  ).find((row) => row.fromAssignmentId === assignmentId)?.status;
}

// ---- decision rules ------------------------------------------------------

describe("keputusan: penyetuju, idempotensi, pembatalan", () => {
  it("[F26 approval] the requester and the target cannot decide their own swap even with the approve permission; an independent approver can", async () => {
    const [shift] = await publishedWeek(15, [
      { employeeId: employeeDual, day: 1, templateId: pagiId },
    ]);
    const created = await requestSwap(dual.client, {
      fromAssignmentId: shift,
      toEmployeeId: employeeDualTarget,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;

    for (const [who, client] of [
      ["requester", dual.client],
      ["target", dualTarget.client],
    ] as const) {
      const attempt = await decide(client, id, "approve");
      expect([403, 409], who).toContain(attempt.status);
    }
    expect(await swapStatus(id)).toBe("pending");
    expect(await shiftNow(15, shift)).toMatchObject({
      employeeId: employeeDual,
    });

    const approved = await decide(hr.client, id, "approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.approvedBy).toBe(hr.userId);
  });

  it("[F26 approval] repeating the same decision returns the existing result without a second event; a different decision is 409", async () => {
    const [shift] = await publishedWeek(16, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);
    const idempotencyKey = key();
    const first = await decide(
      hr.client,
      swap.id,
      "approve",
      null,
      idempotencyKey,
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const replay = await decide(
      hr.client,
      swap.id,
      "approve",
      null,
      idempotencyKey,
    );
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({
      id: swap.id,
      status: "approved",
      decidedAt: first.body.data.decidedAt,
      approvedBy: first.body.data.approvedBy,
    });
    const again = await decide(hr.client, swap.id, "approve");
    expect(again.status).toBe(200);
    expect(again.body.data.decidedAt).toBe(first.body.data.decidedAt);
    expect(await publishedEvents(shift)).toHaveLength(2);

    const opposite = await decide(hr.client, swap.id, "reject");
    expect(opposite.status).toBe(409);
    expect(await shiftNow(16, shift)).toMatchObject({
      employeeId: employeeT,
      status: "swapped",
    });
  });

  it("[F26 approval] a rejected request cannot be approved afterwards (409) and leaves the roster untouched", async () => {
    const [shift] = await publishedWeek(17, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);
    expect((await decide(hr.client, swap.id, "reject")).status).toBe(200);
    expect((await decide(hr.client, swap.id, "approve")).status).toBe(409);
    expect(await swapStatus(swap.id)).toBe("rejected");
    expect(await shiftNow(17, shift)).toMatchObject({
      employeeId: employeeR,
      status: "published",
    });
  });

  it("[F26 swap] only the requester cancels, only while pending; the shift stays with them", async () => {
    const [shift] = await publishedWeek(18, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);

    for (const client of [target.client, bystander.client, hr.client]) {
      const refused = await cancelSwap(client, swap.id);
      expect([403, 404]).toContain(refused.status);
    }
    expect(await swapStatus(swap.id)).toBe("pending");

    const idempotencyKey = key();
    const cancelled = await cancelSwap(
      requester.client,
      swap.id,
      idempotencyKey,
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data).toMatchObject({
      id: swap.id,
      status: "cancelled",
    });
    const replay = await cancelSwap(requester.client, swap.id, idempotencyKey);
    expect(replay.status).toBe(200);
    expect(replay.body.data.status).toBe("cancelled");
    expect(await shiftNow(18, shift)).toMatchObject({
      employeeId: employeeR,
      status: "published",
    });
    expect((await decide(hr.client, swap.id, "approve")).status).toBe(409);
  });

  it("[F26 swap] an approved request can no longer be cancelled (409)", async () => {
    const [shift] = await publishedWeek(19, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);
    expect((await decide(hr.client, swap.id, "approve")).status).toBe(200);
    expect((await cancelSwap(requester.client, swap.id)).status).toBe(409);
    expect(await swapStatus(swap.id)).toBe("approved");
  });
});

// ---- permissions and outlet scope ---------------------------------------

describe("izin dan jangkauan outlet", () => {
  it("[F26 approval] employees and managers without hr.shift_swap.approve cannot decide (403)", async () => {
    const [shift] = await publishedWeek(21, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);
    for (const client of [
      requester.client,
      bystander.client,
      hrNoApprove.client,
    ])
      expect((await decide(client, swap.id, "approve")).status).toBe(403);
    expect(await swapStatus(swap.id)).toBe("pending");
  });

  it("[TEN-03] an approver of another outlet gets 404 and cannot change the swap", async () => {
    const [shift] = await publishedWeek(22, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);
    const foreign = await decide(managerB.client, swap.id, "approve");
    expect(foreign.status).toBe(404);
    expect(await swapStatus(swap.id)).toBe("pending");
    expect(await shiftNow(22, shift)).toMatchObject({ employeeId: employeeR });

    const list = await managerB.client.get(
      `/api/hris/shift-swaps?outletId=${outlet.id}&limit=100`,
    );
    expect(list.status).toBe(404);
  });

  it("[F26 approval] an unknown swap id is 404", async () => {
    expect((await decide(hr.client, randomUUID(), "approve")).status).toBe(404);
    expect((await cancelSwap(requester.client, randomUUID())).status).toBe(404);
  });
});

// ---- tenant isolation ----------------------------------------------------

describe("isolasi tenant", () => {
  it("[TEN-01] a manager of another tenant cannot see, decide or cancel this tenant's swap", async () => {
    const [shift] = await publishedWeek(23, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);

    const attempt = await decide(actorB.client, swap.id, "approve");
    expect([403, 404]).toContain(attempt.status);
    const cancel = await cancelSwap(actorB.client, swap.id);
    expect([403, 404]).toContain(cancel.status);

    // A foreign-tenant account is refused outright; if a route ever answers
    // 200 it must not carry this tenant's rows.
    const list = await actorB.client.get("/api/hris/shift-swaps?limit=100");
    expect([200, 403, 404]).toContain(list.status);
    expect(JSON.stringify(list.body)).not.toContain(swap.id);
    const shifts = await actorB.client.get("/api/hris/shifts?limit=100");
    expect([200, 403, 404]).toContain(shifts.status);
    expect(JSON.stringify(shifts.body)).not.toContain(shift);

    expect(await swapStatus(swap.id)).toBe("pending");
    expect(await shiftNow(23, shift)).toMatchObject({
      employeeId: employeeR,
      status: "published",
    });
  });
});

describe("legend-mu78t colleague acceptance and candidates", () => {
  it("lists only same-outlet active colleagues and no personal fields", async () => {
    const [fromAssignmentId] = await publishedWeek(82, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const sourceQuery = `&fromAssignmentId=${fromAssignmentId}`;
    const response = await requester.client.get(
      `/api/hris/shift-swaps/candidates?outletId=${outlet.id}${sourceQuery}`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: employeeT })]),
    );
    expect(
      response.body.data.map((row: { id: string }) => row.id),
    ).not.toContain(employeeOtherOutlet);
    for (const row of response.body.data) {
      expect(Object.keys(row).sort()).toEqual(["assignments", "id", "name"]);
      expect(typeof row.name).toBe("string");
    }
    expect(
      (
        await requester.client.get(
          `/api/hris/shift-swaps/candidates?outletId=${secondOutlet.id}${sourceQuery}`,
        )
      ).status,
    ).not.toBe(200);
    expect(
      (
        await actorB.client.get(
          `/api/hris/shift-swaps/candidates?outletId=${outlet.id}${sourceQuery}`,
        )
      ).status,
    ).not.toBe(200);
    expect(
      (
        await agent(app).get(
          `/api/hris/shift-swaps/candidates?outletId=${outlet.id}${sourceQuery}`,
        )
      ).status,
    ).toBe(401);
  });

  it("requires the addressed colleague to accept before a manager can approve", async () => {
    const [shift] = await publishedWeek(80, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);
    const path = `/api/hris/shift-swaps/${swap.id}/peer-response`;
    expect(
      (
        await post(hr.client, `/api/hris/shift-swaps/${swap.id}/decision`, {
          action: "approve",
          overrideReason: null,
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(409);
    for (const client of [requester.client, target2.client, actorB.client]) {
      expect(
        (await post(client, path, { action: "accept", idempotencyKey: key() }))
          .status,
      ).not.toBe(200);
    }
    const accepted = await post(target.client, path, {
      action: "accept",
      idempotencyKey: key(),
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.data.peerAcceptedAt).toEqual(expect.any(String));
    const approved = await decide(hr.client, swap.id, "approve");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await shiftNow(80, shift))?.employeeId).toBe(employeeT);
  });

  it("rejects a request only with the colleague's reason and leaves the assignment untouched", async () => {
    const [shift] = await publishedWeek(81, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
    ]);
    const swap = await openCover(shift, employeeT);
    const path = `/api/hris/shift-swaps/${swap.id}/peer-response`;
    expect(
      (
        await post(target.client, path, {
          action: "reject",
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(422);
    const rejected = await post(target.client, path, {
      action: "reject",
      rejectionReason: "Tidak tersedia",
      idempotencyKey: key(),
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.data).toMatchObject({
      status: "rejected",
      rejectionReason: "Tidak tersedia",
    });
    expect((await shiftNow(81, shift))?.employeeId).toBe(employeeR);
    expect((await decide(hr.client, swap.id, "approve")).status).toBe(409);
  });
});

describe("legend-hvh9x scoped shift context without roster access", () => {
  it("returns only minimal published peer assignments within seven days of the caller's own source", async () => {
    const [beforeWindow, previousBoundary] = await publishedWeek(82, [
      { employeeId: employeeT, day: 0, templateId: pagiId },
      { employeeId: employeeT, day: 1, templateId: pagiId },
    ]);
    const [source, peer, edge] = await publishedWeek(83, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
      { employeeId: employeeT, day: 2, templateId: pagiId },
      { employeeId: employeeT, day: 0, templateId: pagiId },
    ]);
    const [boundary, outside] = await publishedWeek(84, [
      { employeeId: employeeT, day: 1, templateId: pagiId },
      { employeeId: employeeT, day: 2, templateId: pagiId },
    ]);
    const draft = await createShift(employeeT, dayOf(83, 3), pagiId);
    await publishedShiftElsewhere(employeeT, secondOutlet.id, source);

    const response = await requester.client.get(
      `/api/hris/shift-swaps/candidates?outletId=${outlet.id}&fromAssignmentId=${source}`,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const colleague = response.body.data.find(
      (row: { id: string }) => row.id === employeeT,
    );
    expect(colleague).toMatchObject({ id: employeeT, name: "Rekan U4" });
    expect(colleague.assignments).toEqual([
      {
        id: previousBoundary,
        businessDate: dayOf(82, 1),
        segments: [
          {
            startsAt: `${dayOf(82, 1)}T00:00:00.000Z`,
            endsAt: `${dayOf(82, 1)}T08:00:00.000Z`,
          },
        ],
        breakMinutes: 60,
      },
      {
        id: edge,
        businessDate: dayOf(83, 0),
        segments: [
          {
            startsAt: `${dayOf(83, 0)}T00:00:00.000Z`,
            endsAt: `${dayOf(83, 0)}T08:00:00.000Z`,
          },
        ],
        breakMinutes: 60,
      },
      {
        id: peer,
        businessDate: dayOf(83, 2),
        segments: [
          {
            startsAt: `${dayOf(83, 2)}T00:00:00.000Z`,
            endsAt: `${dayOf(83, 2)}T08:00:00.000Z`,
          },
        ],
        breakMinutes: 60,
      },
      {
        id: boundary,
        businessDate: dayOf(84, 1),
        segments: [
          {
            startsAt: `${dayOf(84, 1)}T00:00:00.000Z`,
            endsAt: `${dayOf(84, 1)}T08:00:00.000Z`,
          },
        ],
        breakMinutes: 60,
      },
    ]);
    expect(JSON.stringify(response.body)).not.toContain(draft);
    expect(JSON.stringify(response.body)).not.toContain(beforeWindow);
    expect(JSON.stringify(response.body)).not.toContain(outside);
    expect(JSON.stringify(response.body)).not.toContain(employeeOtherOutlet);
    expect(
      response.body.data.map((row: { id: string }) => row.id),
    ).not.toContain(employeeR);
    for (const row of response.body.data) {
      expect(Object.keys(row).sort()).toEqual(["assignments", "id", "name"]);
      for (const assignment of row.assignments)
        expect(Object.keys(assignment).sort()).toEqual([
          "breakMinutes",
          "businessDate",
          "id",
          "segments",
        ]);
    }

    // The returned assignment id is sufficient for a real swap request.
    const created = await requestSwap(requester.client, {
      fromAssignmentId: source,
      toEmployeeId: colleague.id,
      toAssignmentId: colleague.assignments[2].id,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.toAssignmentId).toBe(peer);

    // A valid minimal candidate read does not grant directory or roster reads.
    expect((await requester.client.get("/api/hris/employees")).status).toBe(
      403,
    );
    const roster = await requester.client.get(
      `/api/hris/shifts?outletId=${outlet.id}&from=${weekOf(83)}&to=${dayOf(84, 6)}&limit=100`,
    );
    expect(roster.status, JSON.stringify(roster.body)).toBe(200);
    expect(JSON.stringify(roster.body)).not.toContain(peer);
  });

  it("requires a source owned by the caller and refuses foreign outlet and tenant reads", async () => {
    const [source, peer] = await publishedWeek(85, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
      { employeeId: employeeT, day: 2, templateId: pagiId },
    ]);
    expect(
      (
        await requester.client.get(
          `/api/hris/shift-swaps/candidates?outletId=${outlet.id}`,
        )
      ).status,
    ).toBe(422);
    for (const [client, outletId, fromAssignmentId] of [
      [target.client, outlet.id, source],
      [requester.client, outlet.id, peer],
      [requester.client, secondOutlet.id, source],
      [managerB.client, outlet.id, source],
      [actorB.client, outlet.id, source],
    ] as const) {
      const response = await client.get(
        `/api/hris/shift-swaps/candidates?outletId=${outletId}&fromAssignmentId=${fromAssignmentId}`,
      );
      expect([403, 404], JSON.stringify(response.body)).toContain(
        response.status,
      );
      expect(JSON.stringify(response.body)).not.toContain("Pemohon U4");
      expect(JSON.stringify(response.body)).not.toContain("Rekan U4");
    }
    const draft = await createShift(employeeR, dayOf(85, 3), pagiId);
    const invalidSource = await requester.client.get(
      `/api/hris/shift-swaps/candidates?outletId=${outlet.id}&fromAssignmentId=${draft}`,
    );
    expect([404, 409, 422], JSON.stringify(invalidSource.body)).toContain(
      invalidSource.status,
    );
  });

  it("gives only the recipient and in-scope approver the requester's name and both shift details", async () => {
    const [source, peer] = await publishedWeek(86, [
      { employeeId: employeeR, day: 1, templateId: pagiId },
      { employeeId: employeeT, day: 2, templateId: pagiId },
    ]);
    const created = await requestSwap(requester.client, {
      fromAssignmentId: source,
      toEmployeeId: employeeT,
      toAssignmentId: peer,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const requestId = created.body.data.id as string;
    for (const [client, query] of [
      [target.client, "mine=true"],
      [supervisor.client, `outletId=${outlet.id}`],
    ] as const) {
      const response = await client.get(
        `/api/hris/shift-swaps?${query}&limit=100`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const row = response.body.data.find(
        (candidate: { id: string }) => candidate.id === requestId,
      );
      expect(row).toMatchObject({
        requestedByName: "Pemohon U4",
        toEmployeeName: "Rekan U4",
        fromAssignment: {
          id: source,
          businessDate: dayOf(86, 1),
          segments: [
            {
              startsAt: `${dayOf(86, 1)}T00:00:00.000Z`,
              endsAt: `${dayOf(86, 1)}T08:00:00.000Z`,
            },
          ],
          breakMinutes: 60,
        },
        toAssignment: {
          id: peer,
          businessDate: dayOf(86, 2),
          segments: [
            {
              startsAt: `${dayOf(86, 2)}T00:00:00.000Z`,
              endsAt: `${dayOf(86, 2)}T08:00:00.000Z`,
            },
          ],
          breakMinutes: 60,
        },
      });
      expect(Object.keys(row.fromAssignment).sort()).toEqual([
        "breakMinutes",
        "businessDate",
        "id",
        "segments",
      ]);
      expect(Object.keys(row.toAssignment).sort()).toEqual([
        "breakMinutes",
        "businessDate",
        "id",
        "segments",
      ]);
    }
    for (const client of [bystander.client, managerB.client, actorB.client]) {
      const response = await client.get("/api/hris/shift-swaps?limit=100");
      expect([200, 403, 404], JSON.stringify(response.body)).toContain(
        response.status,
      );
      expect(JSON.stringify(response.body)).not.toContain(requestId);
      expect(JSON.stringify(response.body)).not.toContain(source);
      expect(JSON.stringify(response.body)).not.toContain(peer);
    }
    expect((await supervisor.client.get("/api/hris/employees")).status).toBe(
      403,
    );
    expect((await supervisor.client.get("/api/hris/shifts")).status).toBe(403);
  });
});

describe("legend-0ldcp private leave attachment uploads", () => {
  const url = "/api/hris/leave/attachments";
  // A real PDF: storage parses document uploads (legend-851ef).
  let pdf: Buffer;
  beforeAll(async () => {
    pdf = Buffer.from(await validPdfBytes());
  });
  const upload = (client: Client, bytes: Buffer, filename: string) =>
    client.post(url).set(originHeader).attach("file", bytes, filename);

  it("uploads a valid private document for an employee", async () => {
    const response = await upload(requester.client, pdf, "certificate.pdf");
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.attachmentUploadRef).toEqual(expect.any(String));
    expect(Object.keys(response.body.data)).toEqual(["attachmentUploadRef"]);
  });

  it("refuses anonymous users, unrelated accounts, spoofed files and oversized files", async () => {
    expect((await upload(agent(app), pdf, "certificate.pdf")).status).toBe(401);
    expect(
      (await upload(actorB.client, pdf, "certificate.pdf")).status,
    ).not.toBe(201);
    expect(
      (
        await upload(
          requester.client,
          Buffer.from("not a PDF"),
          "certificate.pdf",
        )
      ).status,
    ).not.toBe(201);
    expect(
      (
        await upload(
          requester.client,
          Buffer.alloc(10 * 1024 * 1024 + 1),
          "oversize.pdf",
        )
      ).status,
    ).not.toBe(201);
    expect(
      (await upload(requester.client, Buffer.from("text"), "document.txt"))
        .status,
    ).not.toBe(201);
  });
});
