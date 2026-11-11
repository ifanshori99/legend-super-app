// Self-scoped lists over HTTP (bead legend-5nv1; PRD v1.7 TEN-01..03, HR-01,
// F25/F26): GET /api/hris/attendance/logs, /attendance/corrections, /shifts.
// A user holding ONLY self.* permissions must never see another employee's
// row, whether or not the client sends ?employeeId=<other>; a manager still
// sees every row in reach. Expected behaviour comes from the brief and the
// shared permission contract, not from the service code.
//
// Assumptions (the spec leaves these open; each is a hypothesis the engineer's
// first run confirms or refutes, a mismatch is a finding, not a flaky test):
// - A self-only user may read own logs (self.attendance.clock), own
//   corrections (same permission) and own PUBLISHED shifts (self.schedule.view);
//   draft shifts are hidden from employees (also stated in
//   hris-scheduling-roster-api.test.ts). A "swapped" shift is also visible to
//   its employee, but a swap needs the full swap flow, so it is not seeded here.
// - Scoping happens in SQL ("filter by user, not by client-supplied
//   employeeId", brief legend-5nv1): a foreign ?employeeId (or a foreign
//   ?outletId on shifts) answers 200 with an EMPTY page, never 403/404, never
//   data of the other employee. An own ?employeeId returns own rows.
// - A manager at outlet scope asking for an outlet outside reach also gets
//   200 with an empty page (RLS hides the rows). If the service answers 403 or
//   404 instead, this test fails: report it.
// - Pagination (docs/plan/contracts.md D-CORE-5): response
//   { data, meta: { limit, nextCursor } }, nextCursor null on the last page.
//   Scoping must be applied before LIMIT: a self-only user gets exactly their
//   own rows, no page is empty, and a page that exactly fills the limit with
//   no more rows already carries nextCursor null (no trailing empty page).
// - The sort key of the lists is not specified. Foreign rows are therefore
//   seeded on BOTH sides of the own rows (earlier and later timestamps/dates,
//   and in insertion order), so with any monotone sort key at least 5 foreign
//   rows come before the own rows.
// - Corrections gate (characterization): a user with ONLY
//   hr.attendance_correction.approve at an outlet with no corrections and no
//   employee row of their own gets 200 with an empty page (approvers list in
//   their reach). A user with ONLY hr.employee.manage gets the same: the
//   correction service counts hr.employee.manage as a manage code, so it lists
//   its reach (200, empty page here), never a row outside it.
// - Dates are far in the future (logs 2041, shifts 2035) so rows cannot
//   collide with seeded data or other suites.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createOwnerPool,
  requireDisposableDatabase,
  tenantAId,
} from "./tenant-isolation-harness.ts";

requireDisposableDatabase();

const app = createApp();
const owner: Pool = createOwnerPool();
const outletBaseId = cafeLegendPlatformFixtures.outlets[0].id;
const unique = () => randomBytes(4).toString("hex");

type Client = ReturnType<typeof agent>;
interface Actor {
  client: Client;
  userId: string;
}

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdOutlets: string[] = [];
const createdEmployees: string[] = [];

// ---- fixtures plumbing --------------------------------------------------------

async function ownerTx<T>(
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
      [tenantAId],
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

async function signedIn(
  name: string,
  options: { mfa?: boolean } = {},
): Promise<Actor> {
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
  outletScope?: string,
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await ownerTx(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenantAId,
        `Daftar mandiri ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant", "outlet"]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        tenantAId,
        userId,
        roleId,
        outletScope ? "outlet" : "tenant",
        outletScope ?? null,
      ],
    );
  });
}

async function seedOutlet(): Promise<string> {
  const id = randomUUID();
  createdOutlets.push(id);
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $3, 'Outlet daftar mandiri', address, 'Asia/Jakarta', opening_hours
       FROM outlets WHERE id = $2`,
    [id, outletBaseId, `SSL-${unique()}`.toUpperCase()],
  );
  return id;
}

/**
 * An outlet-scoped supervisor sees only direct reports, so every employee of
 * outletMain reports to the manager once the manager's own employee exists.
 */
async function seedEmployee(
  outletId: string,
  userId: string | null,
  managerId: string | null = outletId === outletMain
    ? (empManager ?? null)
    : null,
): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await ownerTx((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status, manager_id)
       VALUES ($1, $2, $3, $4, 'Karyawan Daftar Mandiri', $5, 'pkwtt', '2025-03-01', 'active', $6)`,
      [
        id,
        tenantAId,
        userId,
        `0000SSL${unique().toUpperCase()}`,
        outletId,
        managerId,
      ],
    ),
  );
  return id;
}

/** One log (ULID, upper-case in responses) for an employee. */
async function seedLog(
  outletId: string,
  employeeId: string,
  businessDate: string | null = null,
): Promise<string> {
  const ulid = createUlid();
  await ownerTx((client) =>
    client.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          geo_distance_m, validity, flag_reasons, business_date, client_event_id, review_status)
       VALUES ($1, $2, $3, $4, 'in', 'selfie_geo',
               COALESCE($6::date + time '12:00', now()), now(), 15, 'valid', '[]',
               COALESCE($6::date, '2041-06-10'::date), $5, 'none')`,
      [
        ulidToUuid(ulid),
        tenantAId,
        outletId,
        employeeId,
        createUlid(),
        businessDate,
      ],
    ),
  );
  return ulid;
}

async function seedCorrection(
  outletId: string,
  employeeId: string,
  requestedDate: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await ownerTx((client) =>
    client.query(
      `INSERT INTO attendance_corrections
         (id, tenant_id, outlet_id, employee_id, requested_type, requested_occurred_at, reason,
          requested_by, idempotency_key)
       VALUES ($1, $2, $3, $4, 'out', COALESCE($7::date + time '12:00', now()),
               'Lupa absen pulang', $5, $6)`,
      [
        id,
        tenantAId,
        outletId,
        employeeId,
        randomUUID(),
        `ssl-${randomUUID()}`,
        requestedDate,
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

/** Ids of every page row; follows cursors so a late foreign row cannot hide. */
async function listAll(
  client: Client,
  path: string,
  pick: (row: Record<string, unknown>) => string,
): Promise<{ status: number; ids: string[] }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response: Awaited<ReturnType<Client["get"]>> = await client.get(
      `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (response.status !== 200) return { status: response.status, ids };
    ids.push(...(response.body.data as Record<string, unknown>[]).map(pick));
    cursor = (response.body.meta?.nextCursor as string | null) ?? null;
    if (!cursor) break;
  }
  return { status: 200, ids };
}

interface Chain {
  /** Per page: status, ids, and the pagination meta the server returned. */
  pages: {
    status: number;
    ids: string[];
    limit: unknown;
    nextCursor: string | null;
  }[];
  ids: string[];
}

/** Walks the cursor chain with an explicit page size; stops on the first non-200. */
async function walk(
  client: Client,
  path: string,
  limit: number,
  pick: (row: Record<string, unknown>) => string,
): Promise<Chain> {
  const chain: Chain = { pages: [], ids: [] };
  let cursor: string | null = null;
  for (let page = 0; page < 30; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response: Awaited<ReturnType<Client["get"]>> = await client.get(
      `${path}${separator}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    const ids =
      response.status === 200
        ? (response.body.data as Record<string, unknown>[]).map(pick)
        : [];
    cursor = (response.body?.meta?.nextCursor as string | null) ?? null;
    chain.pages.push({
      status: response.status,
      ids,
      limit: response.body?.meta?.limit,
      nextCursor: cursor,
    });
    chain.ids.push(...ids);
    if (response.status !== 200 || !cursor) break;
  }
  return chain;
}

/**
 * The chain returns exactly the own rows: every page is 200, non-empty and at
 * most `limit` long, the chain ends with nextCursor null after the expected
 * number of pages, and no foreign row ever shows up.
 */
function expectOwnRowsOnly(
  chain: Chain,
  own: string[],
  foreign: string[],
  limit: number,
) {
  const label = JSON.stringify(chain.pages);
  for (const page of chain.pages) {
    expect(page.status, label).toBe(200);
    expect(page.limit, label).toBe(limit);
    expect(
      page.ids.length,
      `empty or oversized page: ${label}`,
    ).toBeGreaterThan(0);
    expect(page.ids.length, label).toBeLessThanOrEqual(limit);
  }
  for (const hidden of foreign) expect(chain.ids, label).not.toContain(hidden);
  expect([...chain.ids].sort(), label).toEqual([...own].sort());
  expect(chain.pages.length, label).toBe(Math.ceil(own.length / limit));
  expect(chain.pages[chain.pages.length - 1].nextCursor, label).toBeNull();
}

const logId = (row: Record<string, unknown>) => String(row.id).toUpperCase();
const plainId = (row: Record<string, unknown>) => String(row.id);

// ---- dates (2035-03-05 is a Monday) --------------------------------------------

const WEEK_PUBLISHED = "2035-03-05";
const WEEK_DRAFT = "2035-03-12";
if (new Date(`${WEEK_PUBLISHED}T00:00:00Z`).getUTCDay() !== 1)
  throw new Error("WEEK_PUBLISHED must be a Monday");

// ---- fixtures -------------------------------------------------------------------

let outletMain: string; // self users, colleague and manager reach
let outletOther: string; // foreign outlet
let outletEmpty: string; // outlet without any row

let selfA: Actor;
let selfB: Actor;
let manager: Actor; // outlet scope: outletMain
let empManager: string | undefined; // the manager's own employee row
let managerOther: Actor; // outlet scope: outletOther (creates the foreign shift)
let approverOnly: Actor; // hr.attendance_correction.approve at outletEmpty
let employeeManager: Actor; // hr.employee.manage at outletEmpty

let empA: string;
let empB: string;
let empColleague: string;
let empForeign: string;

let logA: string;
let logB: string;
let logColleague: string;
let logForeign: string;

let corrA: string;
let corrB: string;
let corrColleague: string;
let corrForeign: string;

let shiftA: string; // published
let shiftB: string;
let shiftColleague: string;
let shiftADraft: string; // draft, selfA
let shiftForeign: string; // published, other outlet

interface PagingFixture {
  actor: Actor;
  ownLogs: string[];
  foreignLogs: string[];
  ownCorrections: string[];
  foreignCorrections: string[];
  ownShifts: string[];
  foreignShifts: string[];
}
let paging: PagingFixture;

async function createShift(
  actor: Actor,
  outletId: string,
  employeeId: string,
  templateId: string,
  businessDate: string,
): Promise<string> {
  const created = await post(actor.client, "/api/hris/shifts", {
    outletId,
    employeeId,
    businessDate,
    shiftTemplateId: templateId,
    stationId: null,
    idempotencyKey: `ssl-${randomUUID()}`,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return (created.body.data as { id: string }).id;
}

async function createTemplate(actor: Actor, outletId: string): Promise<string> {
  const created = await post(actor.client, "/api/hris/shift-templates", {
    outletId,
    name: `Pagi ${unique()}`,
    segments: [{ startTime: "08:00", endTime: "16:00" }],
    breakMinutes: 60,
    stationId: null,
    positionId: null,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return (created.body.data as { id: string }).id;
}

async function publish(actor: Actor, outletId: string, weekStart: string) {
  const response = await post(actor.client, "/api/hris/rosters/publish", {
    outletId,
    weekStart,
    idempotencyKey: `ssl-${randomUUID()}`,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

beforeAll(async () => {
  outletMain = await seedOutlet();
  outletOther = await seedOutlet();
  outletEmpty = await seedOutlet();

  selfA = await signedIn("Mandiri A");
  selfB = await signedIn("Mandiri B");
  manager = await signedIn("Manajer Mandiri", { mfa: true });
  managerOther = await signedIn("Manajer Lain Mandiri", { mfa: true });
  approverOnly = await signedIn("Penyetuju Saja");
  employeeManager = await signedIn("Pengelola Karyawan Saja");

  empManager = await seedEmployee(outletMain, manager.userId, null);
  empA = await seedEmployee(outletMain, selfA.userId);
  empB = await seedEmployee(outletMain, selfB.userId);
  empColleague = await seedEmployee(outletMain, null);
  empForeign = await seedEmployee(outletOther, null);

  // Self-only users: tenant scope on purpose (widest scope; still only self.*).
  const selfPermissions = [
    "self.profile.view",
    "self.attendance.clock",
    "self.schedule.view",
  ];
  await grantRole(selfA.userId, selfPermissions);
  await grantRole(selfB.userId, selfPermissions);
  await grantRole(
    manager.userId,
    [
      "hr.attendance.manage",
      "hr.attendance_correction.approve",
      "hr.schedule.manage",
    ],
    outletMain,
  );
  await grantRole(managerOther.userId, ["hr.schedule.manage"], outletOther);
  await grantRole(
    approverOnly.userId,
    ["hr.attendance_correction.approve"],
    outletEmpty,
  );
  await grantRole(employeeManager.userId, ["hr.employee.manage"], outletEmpty);

  logA = await seedLog(outletMain, empA);
  logB = await seedLog(outletMain, empB);
  logColleague = await seedLog(outletMain, empColleague);
  logForeign = await seedLog(outletOther, empForeign);

  corrA = await seedCorrection(outletMain, empA);
  corrB = await seedCorrection(outletMain, empB);
  corrColleague = await seedCorrection(outletMain, empColleague);
  corrForeign = await seedCorrection(outletOther, empForeign);

  const templateMain = await createTemplate(manager, outletMain);
  const templateOther = await createTemplate(managerOther, outletOther);
  shiftA = await createShift(
    manager,
    outletMain,
    empA,
    templateMain,
    WEEK_PUBLISHED,
  );
  shiftB = await createShift(
    manager,
    outletMain,
    empB,
    templateMain,
    "2035-03-06",
  );
  shiftColleague = await createShift(
    manager,
    outletMain,
    empColleague,
    templateMain,
    "2035-03-07",
  );
  shiftForeign = await createShift(
    managerOther,
    outletOther,
    empForeign,
    templateOther,
    WEEK_PUBLISHED,
  );
  await publish(manager, outletMain, WEEK_PUBLISHED);
  await publish(managerOther, outletOther, WEEK_PUBLISHED);
  // Created after publication of another week: stays a draft.
  shiftADraft = await createShift(
    manager,
    outletMain,
    empA,
    templateMain,
    WEEK_DRAFT,
  );
  paging = await seedPaging(manager, templateMain, selfPermissions);
}, 300_000);

/**
 * Pagination fixture: a self-only user with TWO own rows per list, in the middle
 * of 5 earlier and 5 later foreign rows (mixed employees and outlets). With
 * limit=1 or 2, unscoped SQL would fill the first pages with foreign rows.
 */
async function seedPaging(
  managerActor: Actor,
  templateMain: string,
  selfPermissions: string[],
): Promise<PagingFixture> {
  const actor = await signedIn("Mandiri Halaman");
  await grantRole(actor.userId, selfPermissions);
  const empOwn = await seedEmployee(outletMain, actor.userId);

  const earlier = [
    "2041-07-01",
    "2041-07-02",
    "2041-07-03",
    "2041-07-04",
    "2041-07-05",
  ];
  const ownDays = ["2041-07-10", "2041-07-11"];
  const later = [
    "2041-07-20",
    "2041-07-21",
    "2041-07-22",
    "2041-07-23",
    "2041-07-24",
  ];
  const foreignPool = [
    { outlet: outletMain, employee: empB },
    { outlet: outletMain, employee: empColleague },
    { outlet: outletOther, employee: empForeign },
  ];
  const foreignAt = (index: number) => foreignPool[index % foreignPool.length];

  const result: PagingFixture = {
    actor,
    ownLogs: [],
    foreignLogs: [],
    ownCorrections: [],
    foreignCorrections: [],
    ownShifts: [],
    foreignShifts: [],
  };

  // Logs and corrections: insertion order and date both put own rows in the middle.
  let index = 0;
  for (const date of earlier) {
    const { outlet, employee } = foreignAt(index++);
    result.foreignLogs.push(await seedLog(outlet, employee, date));
    result.foreignCorrections.push(
      await seedCorrection(outlet, employee, date),
    );
  }
  for (const date of ownDays) {
    result.ownLogs.push(await seedLog(outletMain, empOwn, date));
    result.ownCorrections.push(await seedCorrection(outletMain, empOwn, date));
  }
  for (const date of later) {
    const { outlet, employee } = foreignAt(index++);
    result.foreignLogs.push(await seedLog(outlet, employee, date));
    result.foreignCorrections.push(
      await seedCorrection(outlet, employee, date),
    );
  }

  // Shifts: one foreign employee per shift (no compliance clash), all published.
  const shiftDays = [
    { date: "2035-04-03", own: false },
    { date: "2035-04-03", own: false },
    { date: "2035-04-03", own: false },
    { date: "2035-04-03", own: false },
    { date: "2035-04-03", own: false },
    { date: "2035-04-10", own: true },
    { date: "2035-04-11", own: true },
    { date: "2035-04-17", own: false },
    { date: "2035-04-17", own: false },
    { date: "2035-04-17", own: false },
    { date: "2035-04-17", own: false },
    { date: "2035-04-17", own: false },
  ];
  for (const { date, own } of shiftDays) {
    const employee = own ? empOwn : await seedEmployee(outletMain, null);
    const id = await createShift(
      managerActor,
      outletMain,
      employee,
      templateMain,
      date,
    );
    (own ? result.ownShifts : result.foreignShifts).push(id);
  }
  for (const weekStart of ["2035-04-02", "2035-04-09", "2035-04-16"])
    await publish(managerActor, outletMain, weekStart);
  return result;
}

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
      ownerTx(
        async (client) => {
          for (const table of [
            "shift_swap_requests",
            "roster_publications",
            "roster_copies",
            "shift_assignments",
            "shift_templates",
            "shift_compliance_policies",
            "attendance_logs",
            "attendance_corrections",
          ])
            await client.query(
              `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])`,
              [tenantAId, createdOutlets],
            );
          await client.query(
            `DELETE FROM audit_logs
              WHERE tenant_id = $1 AND (outlet_id = ANY($2::uuid[])
                 OR EXISTS (SELECT 1 FROM unnest($3::text[]) AS e(id)
                             WHERE audit_logs.event::text LIKE '%' || e.id || '%'))`,
            [tenantAId, createdOutlets, createdEmployees],
          );
          await client.query(
            "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'ssl-%'",
            [tenantAId],
          );
          await client.query(
            "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
            [tenantAId, createdEmployees],
          );
          await client.query(
            "DELETE FROM role_assignments WHERE tenant_id = $1 AND role_id = ANY($2::uuid[])",
            [tenantAId, createdRoles],
          );
          await client.query(
            "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
            [tenantAId, createdRoles],
          );
        },
        { replica: true },
      ),
    );
    // Outlets stay: append-only audit rows may reference them (disposable DB).
    await step(() =>
      owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
        createdUsers,
      ]),
    );
  } finally {
    await step(() => owner.end());
  }
  if (errors.length > 0) throw errors[0];
}, 90_000);

// ---- legend-5nv1: attendance logs ----------------------------------------------

describe("legend-5nv1 GET /api/hris/attendance/logs: self-only user", () => {
  it("with no filter sees own logs and no colleague, foreign-outlet or other self user's log", async () => {
    const own = await listAll(selfA.client, "/api/hris/attendance/logs", logId);
    expect(own.status).toBe(200);
    expect(own.ids).toContain(logA);
    expect(own.ids).not.toContain(logB);
    expect(own.ids).not.toContain(logColleague);
    expect(own.ids).not.toContain(logForeign);
  });

  it("?employeeId=<other> never returns that employee's logs", async () => {
    for (const other of [
      { employeeId: empB, hidden: logB },
      { employeeId: empColleague, hidden: logColleague },
      { employeeId: empForeign, hidden: logForeign },
    ]) {
      const result = await listAll(
        selfA.client,
        `/api/hris/attendance/logs?employeeId=${other.employeeId}`,
        logId,
      );
      expect(result.status, other.employeeId).toBe(200);
      expect(result.ids).not.toContain(other.hidden);
      expect(result.ids).toEqual([]);
    }
  });

  it("?employeeId=<own> still returns own logs", async () => {
    const result = await listAll(
      selfA.client,
      `/api/hris/attendance/logs?employeeId=${empA}`,
      logId,
    );
    expect(result.status).toBe(200);
    expect(result.ids).toContain(logA);
    expect(result.ids).not.toContain(logB);
  });

  it("the other self user sees their own log and not the first user's", async () => {
    const own = await listAll(selfB.client, "/api/hris/attendance/logs", logId);
    expect(own.status).toBe(200);
    expect(own.ids).toContain(logB);
    expect(own.ids).not.toContain(logA);
  });
});

describe("legend-5nv1 GET /api/hris/attendance/logs: manager", () => {
  it("still sees every log in reach and none outside it", async () => {
    const all = await listAll(
      manager.client,
      "/api/hris/attendance/logs",
      logId,
    );
    expect(all.status).toBe(200);
    expect(all.ids).toEqual(expect.arrayContaining([logA, logB, logColleague]));
    expect(all.ids).not.toContain(logForeign);

    const byEmployee = await listAll(
      manager.client,
      `/api/hris/attendance/logs?employeeId=${empColleague}`,
      logId,
    );
    expect(byEmployee.status).toBe(200);
    expect(byEmployee.ids).toContain(logColleague);
    expect(byEmployee.ids).not.toContain(logA);
  });
});

// ---- legend-5nv1: corrections ----------------------------------------------------

describe("legend-5nv1 GET /api/hris/attendance/corrections: self-only user", () => {
  it("with no filter sees own corrections and nobody else's", async () => {
    const own = await listAll(
      selfA.client,
      "/api/hris/attendance/corrections",
      plainId,
    );
    expect(own.status).toBe(200);
    expect(own.ids).toContain(corrA);
    expect(own.ids).not.toContain(corrB);
    expect(own.ids).not.toContain(corrColleague);
    expect(own.ids).not.toContain(corrForeign);
  });

  it("?employeeId=<other> never returns that employee's corrections", async () => {
    for (const other of [
      { employeeId: empB, hidden: corrB },
      { employeeId: empColleague, hidden: corrColleague },
      { employeeId: empForeign, hidden: corrForeign },
    ]) {
      const result = await listAll(
        selfA.client,
        `/api/hris/attendance/corrections?employeeId=${other.employeeId}`,
        plainId,
      );
      expect(result.status, other.employeeId).toBe(200);
      expect(result.ids).not.toContain(other.hidden);
      expect(result.ids).toEqual([]);
    }
  });

  it("?employeeId=<own> still returns own corrections", async () => {
    const result = await listAll(
      selfA.client,
      `/api/hris/attendance/corrections?employeeId=${empA}`,
      plainId,
    );
    expect(result.status).toBe(200);
    expect(result.ids).toContain(corrA);
    expect(result.ids).not.toContain(corrB);
  });
});

describe("legend-5nv1 GET /api/hris/attendance/corrections: manager", () => {
  it("still sees every correction in reach and none outside it", async () => {
    const all = await listAll(
      manager.client,
      "/api/hris/attendance/corrections",
      plainId,
    );
    expect(all.status).toBe(200);
    expect(all.ids).toEqual(
      expect.arrayContaining([corrA, corrB, corrColleague]),
    );
    expect(all.ids).not.toContain(corrForeign);
  });
});

describe("legend-5nv1 corrections gate: approve-only / employee.manage-only user with no own row", () => {
  // CHARACTERIZATION with exact expectations (see header assumptions): the
  // approver and the employee.manage holder both list their reach only
  // (MANAGE_CODES in the correction service include hr.employee.manage; empty
  // outlet: 200, no rows). Neither ever sees a row of the seeded outlets.
  const hidden = () => [corrA, corrB, corrColleague, corrForeign];

  it("hr.attendance_correction.approve only, outlet without corrections: 200 and an empty page", async () => {
    const result = await listAll(
      approverOnly.client,
      "/api/hris/attendance/corrections",
      plainId,
    );
    expect(result.status).toBe(200);
    expect(result.ids).toEqual([]);
    for (const row of hidden()) expect(result.ids).not.toContain(row);
  });

  it("hr.employee.manage only, outlet without corrections: 200 and an empty page", async () => {
    const result = await listAll(
      employeeManager.client,
      "/api/hris/attendance/corrections",
      plainId,
    );
    expect(result.status).toBe(200);
    expect(result.ids).toEqual([]);
    for (const row of hidden()) expect(result.ids).not.toContain(row);
  });
});

// ---- legend-5nv1: shifts -----------------------------------------------------------

describe("legend-5nv1 GET /api/hris/shifts: self-only user", () => {
  const range = `from=${WEEK_PUBLISHED}&to=2035-03-18`;

  it("with no filter sees own published shift, not the draft and nobody else's", async () => {
    const own = await listAll(selfA.client, "/api/hris/shifts", plainId);
    expect(own.status).toBe(200);
    expect(own.ids).toContain(shiftA);
    expect(own.ids).not.toContain(shiftADraft);
    expect(own.ids).not.toContain(shiftB);
    expect(own.ids).not.toContain(shiftColleague);
    expect(own.ids).not.toContain(shiftForeign);
  });

  it("a date range around the shifts gives the same result", async () => {
    const own = await listAll(
      selfA.client,
      `/api/hris/shifts?${range}`,
      plainId,
    );
    expect(own.status).toBe(200);
    expect(own.ids).toEqual([shiftA]);
    const other = await listAll(
      selfB.client,
      `/api/hris/shifts?${range}`,
      plainId,
    );
    expect(other.ids).toEqual([shiftB]);
  });

  it("?employeeId=<other> never returns that employee's shifts", async () => {
    for (const other of [
      { employeeId: empB, hidden: shiftB },
      { employeeId: empColleague, hidden: shiftColleague },
      { employeeId: empForeign, hidden: shiftForeign },
    ]) {
      const result = await listAll(
        selfA.client,
        `/api/hris/shifts?${range}&employeeId=${other.employeeId}`,
        plainId,
      );
      expect(result.status, other.employeeId).toBe(200);
      expect(result.ids).not.toContain(other.hidden);
      expect(result.ids).toEqual([]);
    }
  });

  it("?outletId=<other outlet> shows nothing of that outlet", async () => {
    const result = await listAll(
      selfA.client,
      `/api/hris/shifts?outletId=${outletOther}`,
      plainId,
    );
    expect(result.status).toBe(200);
    expect(result.ids).not.toContain(shiftForeign);
    expect(result.ids).toEqual([]);
  });

  it("?employeeId=<own> still returns the own published shift only", async () => {
    const result = await listAll(
      selfA.client,
      `/api/hris/shifts?${range}&employeeId=${empA}`,
      plainId,
    );
    expect(result.status).toBe(200);
    expect(result.ids).toEqual([shiftA]);
  });
});

describe("legend-5nv1 GET /api/hris/shifts: manager", () => {
  it("still sees every shift (draft included) of the outlet in reach and none of another outlet", async () => {
    const all = await listAll(
      manager.client,
      `/api/hris/shifts?outletId=${outletMain}`,
      plainId,
    );
    expect(all.status).toBe(200);
    expect(all.ids).toEqual(
      expect.arrayContaining([shiftA, shiftB, shiftColleague, shiftADraft]),
    );
    expect(all.ids).not.toContain(shiftForeign);

    const outside = await listAll(
      manager.client,
      `/api/hris/shifts?outletId=${outletOther}`,
      plainId,
    );
    expect(outside.status).toBe(200);
    expect(outside.ids).toEqual([]);
  });
});

// ---- legend-5nv1: SQL scoping survives pagination ---------------------------------
//
// The self-only user has 2 own rows per list among 10 foreign rows seeded on both
// sides. Scoping applied after LIMIT would return foreign-only or empty pages for
// limit 1 and 2; correct scoping gives exactly the 2 own rows.

describe("legend-5nv1 pagination: self-only user gets only own rows at any page size", () => {
  for (const limit of [1, 2]) {
    it(`logs, limit=${limit}: own rows only, no foreign row, no empty page`, async () => {
      const chain = await walk(
        paging.actor.client,
        "/api/hris/attendance/logs",
        limit,
        logId,
      );
      expectOwnRowsOnly(chain, paging.ownLogs, paging.foreignLogs, limit);
    });

    it(`corrections, limit=${limit}: own rows only, no foreign row, no empty page`, async () => {
      const chain = await walk(
        paging.actor.client,
        "/api/hris/attendance/corrections",
        limit,
        plainId,
      );
      expectOwnRowsOnly(
        chain,
        paging.ownCorrections,
        paging.foreignCorrections,
        limit,
      );
    });

    it(`shifts, limit=${limit}: own published shifts only, with and without a date range`, async () => {
      for (const path of [
        "/api/hris/shifts",
        "/api/hris/shifts?from=2035-04-01&to=2035-04-30",
      ]) {
        const chain = await walk(paging.actor.client, path, limit, plainId);
        expectOwnRowsOnly(chain, paging.ownShifts, paging.foreignShifts, limit);
      }
    });
  }

  it("a foreign ?employeeId with limit=1 is an empty page with no cursor, not foreign rows", async () => {
    for (const path of [
      `/api/hris/attendance/logs?employeeId=${empColleague}`,
      `/api/hris/attendance/corrections?employeeId=${empColleague}`,
      `/api/hris/shifts?employeeId=${empColleague}`,
    ]) {
      const chain = await walk(paging.actor.client, path, 1, plainId);
      expect(chain.pages, path).toHaveLength(1);
      expect(chain.pages[0].status, path).toBe(200);
      expect(chain.ids, path).toEqual([]);
      expect(chain.pages[0].nextCursor, path).toBeNull();
    }
  });

  it("a manager's cursor chain at limit=2 reaches every own-outlet row exactly once", async () => {
    // Guards against a scoping fix that breaks keyset paging for managers.
    const chain = await walk(
      manager.client,
      "/api/hris/attendance/logs",
      2,
      logId,
    );
    expect(chain.pages.every((page) => page.status === 200)).toBe(true);
    expect(new Set(chain.ids).size).toBe(chain.ids.length);
    expect(chain.ids).toEqual(
      expect.arrayContaining([...paging.ownLogs, logA, logB, logColleague]),
    );
    expect(chain.ids).not.toContain(logForeign);
  });
});
