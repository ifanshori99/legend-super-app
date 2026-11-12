// Fail-first tests for finding 501-3 (P2, docs/briefs/hris-leave-guard.md
// section 502 item D): every leave path must take the locks in ONE order,
// "employee lock first, then the leave request row". Two paths that take them
// in opposite orders deadlock under concurrency. Expected behaviour comes from
// that brief and the leave decision contract, never from service code.
//
// Two techniques (no sleeps, only condition-based waits):
//
//  1. Deterministic ordering probe. A plain pg client (tx A) takes the
//     per-employee advisory lock named in docs/briefs/452-plan.md (F1):
//     `hris:leave-attendance:<tenantId>:<lower(employeeId)>`, the same key the
//     clock-in race test (hris-leave-attendance-race.test.ts) uses. The path
//     under test (tx B) starts while A holds it. The test polls pg_locks until
//     B is an UNGRANTED waiter on that key (it fails if B finishes without
//     waiting: the path does not take the employee lock at all). While B
//     waits, A tries `SELECT ... FOR UPDATE NOWAIT` on the leave row. If B
//     already holds the leave row lock, that fails with 55P03: B took the row
//     before the employee lock, the inverted order that deadlocks. Then A
//     commits and B must finish normally.
//
//  2. Concurrent rounds. Many rounds of two competing paths fired together
//     with Promise.all (the API serves them on separate pg connections). No
//     response may be a 5xx or mention a deadlock, and the end state must be
//     consistent: balances moved exactly once.
//
// Assumptions (spec is silent, stated here and in the report):
//  - "The employee lock" is the F1 advisory lock above (the brief says
//    "employee advisory/row lock"). All of approve, requester cancel, HR
//    cancel_leave and the inbox settle (approval.resolved consumer) must wait
//    on it. If one path does not wait on it, the ordering probe fails on that
//    path ("finished while tx A held the employee lock").
//  - A deadlock surfaces as a 5xx answer (Postgres 40P01 through the error
//    handler) or a rejected consumer call whose message mentions "deadlock".
//  - Requester cancel and approve are both the endpoint POST
//    /api/hris/leave/requests/:id/decision (action cancel / approve). HR
//    cancel is POST /api/hris/attendance/logs/:id/review with action
//    cancel_leave on a flagged log. Inbox settle is POST
//    /api/approvals/:id/decisions followed by the real approval.resolved event
//    delivered to handleHrisApprovalResolved (as in
//    hris-leave-payroll-closed-inbox.test.ts).
//  - Racing approve vs cancel may end either way: cancel after approve gives
//    "cancelled", approve after cancel is refused. Consistency rule used:
//    cancel answered 200 => leave cancelled; otherwise leave approved; in both
//    cases used_days equals the days of approved leaves and pending_days the
//    days of pending leaves (nothing moved twice or not at all).
//  - A second cancel of an already cancelled leave answers a 4xx, never 5xx.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createApp } from "../app.ts";
import { handleHrisApprovalResolved } from "../services/hris-approval-consumers.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
// Pool size: tx A, the pg_locks poller, fixture and reader helpers.
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 8,
});

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];
const createdEntities: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];

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

async function assign(
  db: PoolClient,
  userId: string,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  await db.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenant.id,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

async function grantRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Leave lock order ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await assign(db, userId, roleId, scope);
  });
}

async function templateRoleId(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenant.id, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

const CENTER = { latitude: -6.2, longitude: 106.8 };
const key = () => `llo-${randomUUID()}`;
const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);
const put = (client: Client, path: string, body: unknown) =>
  client
    .put(path)
    .set(originHeader)
    .send(body as object);

async function seedLegalEntity(label: string) {
  const id = randomUUID();
  createdEntities.push(id);
  await asTenant((db) =>
    db.query(
      "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
      [id, tenant.id, `PT Uji Kunci Cuti ${label} ${id.slice(0, 8)}`],
    ),
  );
  return id;
}

async function seedOutlet(label: string, legalEntityId: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Absensi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $7)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        legalEntityId,
        `LO-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet urutan kunci cuti ${label}`,
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(userId: string, homeOutletId: string) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Kunci Cuti', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        userId,
        `LO-${id.slice(0, 8).toUpperCase()}`,
        homeOutletId,
      ],
    ),
  );
  return id;
}

const basePolicy = {
  geofenceRadiusM: 100,
  outsideGeofenceAction: "reject",
  unboundDeviceAction: "reject",
  requireSelfie: false,
  requireDeviceBinding: false,
  allowRotatingQr: true,
  selfieRetentionDays: 90,
};
const alwaysSampling = {
  rate: 0,
  flaggedAlways: true,
  minPerSupervisorPerWeek: 0,
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WIB_OFFSET = 7 * 60 * MINUTE;
const wibDate = (ms: number) =>
  new Date(ms + WIB_OFFSET).toISOString().slice(0, 10);
const dateAt = (offsetDays: number) => wibDate(Date.now() + offsetDays * DAY);

/** Never straddle outlet midnight: the business date is the local calendar day. */
async function avoidOutletMidnight() {
  const sinceMidnight = (Date.now() + WIB_OFFSET) % DAY;
  const untilMidnight = DAY - sinceMidnight;
  if (sinceMidnight < MINUTE || untilMidnight < 2 * MINUTE)
    await new Promise((resolve) =>
      setTimeout(resolve, untilMidnight + 2 * MINUTE),
    );
}

// ---- fixtures ---------------------------------------------------------------

let hr: Client;
let leaveTypeId: string;

beforeAll(async () => {
  // Leave requests go to the outlet manager, one level (PRD matrix).
  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'",
      [tenant.id],
    )
  ).rows;
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'",
    [tenant.id],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'leave', NULL, $2, 1)`,
    [tenant.id, await templateRoleId("outlet_manager")],
  );

  const admin = await signedInClient("HR Kunci Cuti", { mfa: true });
  await grantRole(
    admin.userId,
    [
      "hr.attendance.manage",
      "hr.leave.approve",
      "hr.employee.manage",
      "hr.employee.view",
    ],
    { type: "tenant" },
  );
  hr = admin.client;

  const type = await post(hr, "/api/hris/leave/types", {
    code: `LLO_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`,
    name: "Cuti tahunan uji urutan kunci",
    paid: true,
    requiresAttachment: false,
    policy: {
      annualDays: "60.0000",
      carryOverMaxDays: "0.0000",
      carryOverExpiryMonths: 0,
      tracksBalance: true,
      accrual: "upfront",
      negativeAllowanceDays: "0.0000",
    },
    idempotencyKey: key(),
  });
  expect(type.status, JSON.stringify(type.body)).toBe(201);
  leaveTypeId = type.body.data.id;
}, 60_000);

afterAll(async () => {
  await asTenant(async (db) => {
    await db.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await db.query(
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await db.query(
      "DELETE FROM leave_requests WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await db.query(
      "DELETE FROM leave_balances WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await db.query("DELETE FROM leave_types WHERE tenant_id = $1 AND id = $2", [
      tenant.id,
      leaveTypeId,
    ]);
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'llo-%'",
      [tenant.id],
    );
    await db.query(
      "DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await db.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await db.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'",
      [tenant.id],
    );
    for (const row of savedPolicies)
      await db.query(
        `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.id,
          row.tenant_id,
          row.action_type,
          row.threshold_idr,
          row.approver_role_id,
          row.levels,
          row.requires_distinct_actor,
        ],
      );
    await db.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await db.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
    // Outlets and legal entities stay: audit_logs is append-only and
    // references the outlets (disposable DB).
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
}, 60_000);

interface Scenario {
  outletId: string;
  employeeId: string;
  staff: Client;
  manager: Client;
}

/** A fresh legal entity + outlet, staff with 60 leave days, an outlet manager. */
async function newScenario(label: string): Promise<Scenario> {
  await avoidOutletMidnight();
  const legalEntityId = await seedLegalEntity(label);
  const outletId = await seedOutlet(label, legalEntityId);
  const policy = await put(hr, "/api/hris/attendance/policy", {
    outletId,
    policy: basePolicy,
    sampling: alwaysSampling,
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);

  const staffSession = await signedInClient(`Staf Kunci Cuti ${label}`);
  await grantRole(
    staffSession.userId,
    ["self.profile.view", "self.attendance.clock", "self.leave.request"],
    { type: "outlet", id: outletId },
  );
  const employeeId = await seedEmployee(staffSession.userId, outletId);

  const managerSession = await signedInClient(`Manajer Kunci Cuti ${label}`, {
    mfa: true,
  });
  const managerRoleId = await templateRoleId("outlet_manager");
  await asTenant((db) =>
    assign(db, managerSession.userId, managerRoleId, {
      type: "outlet",
      id: outletId,
    }),
  );

  // A balance row for every calendar year the scenario's dates can reach.
  const years = new Set(
    [-1, 0, 45].map((offset) => Number(dateAt(offset).slice(0, 4))),
  );
  for (const year of years)
    await asTenant((db) =>
      db.query(
        `INSERT INTO leave_balances
           (tenant_id, employee_id, leave_type_id, period_year, entitled_days)
         VALUES ($1, $2, $3, $4, '60')`,
        [tenant.id, employeeId, leaveTypeId, year],
      ),
    );

  return {
    outletId,
    employeeId,
    staff: staffSession.client,
    manager: managerSession.client,
  };
}

// ---- API helpers ------------------------------------------------------------

interface Answer {
  status: number;
  body: unknown;
}

const requestLeaveRaw = (s: Scenario, dayOffset: number) =>
  post(s.staff, "/api/hris/leave/requests", {
    leaveTypeId,
    startDate: dateAt(dayOffset),
    endDate: dateAt(dayOffset),
    reason: "Cuti uji urutan kunci",
    attachmentUploadRef: null,
    idempotencyKey: key(),
  });

/** Files a one-day leave on `dayOffset`; answers the pending leave id. */
async function requestLeave(s: Scenario, dayOffset: number) {
  const response = await requestLeaveRaw(s, dayOffset);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(response.body.data.status).toBe("pending");
  return response.body.data.id as string;
}

const decideAs = (
  client: Client,
  leaveId: string,
  action: "approve" | "reject" | "cancel",
) =>
  post(client, `/api/hris/leave/requests/${leaveId}/decision`, {
    action,
    ...(action === "reject" ? { rejectionReason: "Jadwal penuh" } : {}),
    idempotencyKey: key(),
  });

async function approveLeave(s: Scenario, leaveId: string) {
  const response = await decideAs(s.manager, leaveId, "approve");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.data.status).toBe("approved");
}

/** The open inbox level of the leave's approval chain. */
async function pendingInboxRequest(leaveId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT a.id FROM approval_requests a
       JOIN leave_requests l ON l.approval_chain_id = a.chain_id
      WHERE a.tenant_id = $1 AND l.id = $2 AND a.status = 'pending'
      ORDER BY a.level LIMIT 1`,
    [tenant.id, leaveId],
  );
  if (!rows[0]) throw new Error("No pending inbox request for the leave");
  return rows[0].id;
}

/** The inbox decision only appends approval.resolved to the outbox. */
async function inboxApprove(s: Scenario, leaveId: string) {
  const response = await post(
    s.manager,
    `/api/approvals/${await pendingInboxRequest(leaveId)}/decisions`,
    { decision: "approved", reason: "Disetujui lewat inbox" },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

/**
 * Delivers the leave chain's real approval.resolved event to the HRIS consumer
 * (the worker's job; tests have no worker). The consumer settles the leave.
 */
async function deliverResolved(leaveId: string): Promise<void> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT o.event FROM domain_event_outbox o
       JOIN leave_requests l
         ON o.event->'payload'->>'chainId' = l.approval_chain_id::text
      WHERE o.tenant_id = $1 AND l.id = $2
        AND o.destination = 'cloud-sync'
        AND o.event->>'name' = 'approval.resolved'`,
    [tenant.id, leaveId],
  );
  expect(rows).toHaveLength(1);
  const workerContext = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "job",
    } as Parameters<typeof establishTenantContext>[0]),
    { kind: "tenant" },
  );
  await handleHrisApprovalResolved(
    workerContext,
    eventEnvelopeSchema.parse(rows[0]?.event),
  );
}

/** Inserts a flagged `in` log on the day (what an approved leave leaves behind). */
async function seedFlaggedLog(s: Scenario, dayOffset: number): Promise<string> {
  const id = ulidToUuid(createUlid());
  await asTenant((db) =>
    db.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          validity, flag_reasons, business_date, client_event_id, review_status)
       VALUES ($1, $2, $3, $4, 'in', 'selfie_geo', $5, now(), 'flagged',
               '["leave_approved"]'::jsonb, $6, $7, 'pending')`,
      [
        id,
        tenant.id,
        s.outletId,
        s.employeeId,
        new Date(Date.now() + dayOffset * DAY),
        dateAt(dayOffset),
        `llo-${randomUUID()}`,
      ],
    ),
  );
  return id;
}

const looksLikeUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id);
const toUuid = (id: string) => (looksLikeUuid(id) ? id : ulidToUuid(id));

/** The id the HTTP API uses for a log whose database uuid we know. */
async function apiIdOf(s: Scenario, uuid: string) {
  const response = await hr.get(
    `/api/hris/attendance/logs?employeeId=${s.employeeId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const found = (response.body.data as { id: string }[]).find(
    (item) => toUuid(item.id) === uuid,
  );
  expect(found, "seeded log listed by the API").toBeDefined();
  return found!.id;
}

const hrCancelLeave = (apiLogId: string) =>
  post(hr, `/api/hris/attendance/logs/${apiLogId}/review`, {
    idempotencyKey: key(),
    action: "cancel_leave",
  });

// ---- readers and consistency checks ----------------------------------------

async function leaveRow(leaveId: string) {
  const { rows } = await asTenant((db) =>
    db.query<{ status: string; days: string }>(
      "SELECT status, days::text FROM leave_requests WHERE tenant_id = $1 AND id = $2",
      [tenant.id, leaveId],
    ),
  );
  expect(rows[0], `leave ${leaveId} exists`).toBeDefined();
  return rows[0]!;
}

/**
 * Balances moved exactly once: used_days is the sum of the days of the
 * employee's approved leaves, pending_days the sum of the days of the pending
 * ones (cancelled leaves hold nothing). A leave that was approved and then
 * cancelled, or approved twice, breaks this.
 */
async function expectBalancesMatchLeaves(s: Scenario) {
  const { rows } = await asTenant(async (db) => {
    const leaves = await db.query<{ status: string; days: string }>(
      "SELECT status, days::text FROM leave_requests WHERE tenant_id = $1 AND employee_id = $2",
      [tenant.id, s.employeeId],
    );
    const balances = await db.query<{ used: string; pending: string }>(
      `SELECT coalesce(sum(used_days), 0)::text AS used,
              coalesce(sum(pending_days), 0)::text AS pending
         FROM leave_balances
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3`,
      [tenant.id, s.employeeId, leaveTypeId],
    );
    return { rows: { leaves: leaves.rows, balance: balances.rows[0]! } };
  });
  const sumDays = (status: string) =>
    rows.leaves
      .filter((leave) => leave.status === status)
      .reduce((sum, leave) => sum + Number(leave.days), 0);
  expect(Number(rows.balance.used), "used_days = approved leave days").toBe(
    sumDays("approved"),
  );
  expect(
    Number(rows.balance.pending),
    "pending_days = pending leave days",
  ).toBe(sumDays("pending"));
}

/** No answer may be a server error or name a deadlock. */
function expectNoDeadlock(label: string, answers: Answer[]) {
  for (const answer of answers) {
    const text = JSON.stringify(answer.body ?? "");
    expect(text, `${label}: deadlock in ${text}`).not.toMatch(/deadlock/i);
    expect(
      answer.status,
      `${label}: server error ${answer.status} ${text}`,
    ).toBeLessThan(500);
  }
}

// ---- tx A: the employee lock holder ----------------------------------------

const lockName = (employeeId: string) =>
  `hris:leave-attendance:${tenant.id}:${employeeId.toLowerCase()}`;

/** How many transactions wait (ungranted) on the employee's shared lock. */
async function waitersOn(employeeId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [lockName(employeeId)],
  );
  return rows[0]!.n;
}

/**
 * Tx A holds the employee lock. Tx B (`startB`) starts and must queue on it
 * while holding NO lock on the leave row: A then locks the row with NOWAIT,
 * which fails the moment B already holds it (leave row first = inverted
 * order). After A commits, B's result is returned.
 */
async function employeeLockBeforeLeaveRow<T>(
  s: Scenario,
  leaveId: string,
  startB: () => Promise<T>,
): Promise<T> {
  const a = await owner.connect();
  let finished = false;
  let outcome = "";
  let committed = false;
  let b: Promise<T> | null = null;
  try {
    await a.query("BEGIN");
    await a.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    await a.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      lockName(s.employeeId),
    ]);

    b = (async () => await startB())()
      .then((value) => {
        const answer = value as Partial<Answer> | undefined;
        outcome = `${answer?.status ?? "ok"} ${JSON.stringify(
          answer?.body ?? "",
        ).slice(0, 300)}`;
        return value;
      })
      .finally(() => {
        finished = true;
      });
    b.catch(() => undefined);

    // Condition-based wait: poll until B queues on the lock; give up the
    // moment B has finished (it never waited) or after a generous bound.
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (finished)
        throw new Error(
          `tx B finished while tx A held the employee lock: the path does not take the employee lock before its work (B answered: ${outcome})`,
        );
      if ((await waitersOn(s.employeeId)) > 0) break;
      if (Date.now() > deadline)
        throw new Error("tx B never queued on the lock and never finished");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    try {
      await a.query(
        "SELECT id FROM leave_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE NOWAIT",
        [tenant.id, leaveId],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "55P03")
        throw new Error(
          "tx B holds the leave request row while it waits for the employee lock: lock order is leave row first, employee lock second (deadlock-prone)",
        );
      throw error;
    }

    await a.query("COMMIT");
    committed = true;
    return await b;
  } finally {
    if (!committed) await a.query("ROLLBACK").catch(() => undefined);
    a.release();
    if (b) await b.catch(() => undefined);
  }
}

// ---- deterministic ordering probe ------------------------------------------

describe("[501-3] every leave path takes the employee lock before the leave row", () => {
  it("[501-3] approving a pending leave waits for the employee lock holding no leave row lock", async () => {
    const s = await newScenario("order-approve");
    const leaveId = await requestLeave(s, 2);
    const response = await employeeLockBeforeLeaveRow(s, leaveId, () =>
      decideAs(s.manager, leaveId, "approve"),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe("approved");
    await expectBalancesMatchLeaves(s);
  });

  it("[501-3] the requester cancelling a pending leave waits for the employee lock holding no leave row lock", async () => {
    const s = await newScenario("order-cancel-pending");
    const leaveId = await requestLeave(s, 2);
    const response = await employeeLockBeforeLeaveRow(s, leaveId, () =>
      decideAs(s.staff, leaveId, "cancel"),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe("cancelled");
    await expectBalancesMatchLeaves(s);
  });

  it("[501-3] the requester cancelling an approved leave waits for the employee lock holding no leave row lock", async () => {
    const s = await newScenario("order-cancel-approved");
    const leaveId = await requestLeave(s, 2);
    await approveLeave(s, leaveId);
    const response = await employeeLockBeforeLeaveRow(s, leaveId, () =>
      decideAs(s.staff, leaveId, "cancel"),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe("cancelled");
    await expectBalancesMatchLeaves(s);
  });

  it("[501-3] HR cancel_leave waits for the employee lock holding no leave row lock", async () => {
    const s = await newScenario("order-hr-cancel");
    const leaveId = await requestLeave(s, 0);
    await approveLeave(s, leaveId);
    const apiId = await apiIdOf(s, await seedFlaggedLog(s, 0));
    const response = await employeeLockBeforeLeaveRow(s, leaveId, () =>
      hrCancelLeave(apiId),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await leaveRow(leaveId)).status).toBe("cancelled");
    await expectBalancesMatchLeaves(s);
  });

  it("[501-3] the inbox settle (approval.resolved consumer) waits for the employee lock holding no leave row lock", async () => {
    const s = await newScenario("order-inbox-settle");
    const leaveId = await requestLeave(s, 2);
    await inboxApprove(s, leaveId);
    await employeeLockBeforeLeaveRow(s, leaveId, () =>
      deliverResolved(leaveId),
    );
    expect((await leaveRow(leaveId)).status).toBe("approved");
    await expectBalancesMatchLeaves(s);
  });
});

// ---- concurrent rounds ------------------------------------------------------

const ROUNDS = 10;

describe("[501-3] concurrent leave decisions never deadlock and end consistent", () => {
  it(`[501-3] approve vs requester cancel on the same pending leave, ${ROUNDS} rounds: no deadlock, balances moved once`, async () => {
    const s = await newScenario("race-approve-cancel");
    for (let round = 0; round < ROUNDS; round++) {
      const leaveId = await requestLeave(s, 2 + round);
      const [approve, cancel] = await Promise.all([
        decideAs(s.manager, leaveId, "approve"),
        decideAs(s.staff, leaveId, "cancel"),
      ]);
      const label = `round ${round}`;
      expectNoDeadlock(label, [approve, cancel]);
      expect(
        [approve.status, cancel.status].includes(200),
        `${label}: one side must win (${approve.status}/${cancel.status})`,
      ).toBe(true);
      const row = await leaveRow(leaveId);
      expect(row.status, `${label}: cancel ${cancel.status}`).toBe(
        cancel.status === 200 ? "cancelled" : "approved",
      );
      await expectBalancesMatchLeaves(s);
    }
  }, 120_000);

  it(`[501-3] HR cancel_leave vs requester cancel on the same approved leave, ${ROUNDS / 2} rounds: no deadlock, days handed back once`, async () => {
    for (let round = 0; round < ROUNDS / 2; round++) {
      const s = await newScenario(`race-hr-cancel-${round}`);
      const leaveId = await requestLeave(s, 0);
      await approveLeave(s, leaveId);
      const apiId = await apiIdOf(s, await seedFlaggedLog(s, 0));
      const [hrAnswer, staffAnswer] = await Promise.all([
        hrCancelLeave(apiId),
        decideAs(s.staff, leaveId, "cancel"),
      ]);
      const label = `round ${round}`;
      expectNoDeadlock(label, [hrAnswer, staffAnswer]);
      expect(
        [hrAnswer.status, staffAnswer.status].includes(200),
        `${label}: one cancel must win (${hrAnswer.status}/${staffAnswer.status})`,
      ).toBe(true);
      expect((await leaveRow(leaveId)).status, label).toBe("cancelled");
      await expectBalancesMatchLeaves(s);
    }
  }, 180_000);

  it(`[501-3] inbox settle vs requester cancel on the same pending leave, ${ROUNDS} rounds: no deadlock, balances moved once`, async () => {
    const s = await newScenario("race-inbox-cancel");
    for (let round = 0; round < ROUNDS; round++) {
      const leaveId = await requestLeave(s, 2 + round);
      await inboxApprove(s, leaveId);
      const [cancel, settle] = await Promise.all([
        decideAs(s.staff, leaveId, "cancel"),
        deliverResolved(leaveId).then(
          () => ({ ok: true as const, message: "" }),
          (error: unknown) => ({
            ok: false as const,
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
      ]);
      const label = `round ${round}`;
      expectNoDeadlock(label, [cancel]);
      // A settle that finds the leave already cancelled may answer or skip;
      // it must never fail with a deadlock.
      expect(settle.message, `${label}: settle error`).not.toMatch(/deadlock/i);
      const row = await leaveRow(leaveId);
      expect(row.status, `${label}: cancel ${cancel.status}`).toBe(
        cancel.status === 200 ? "cancelled" : "approved",
      );
      await expectBalancesMatchLeaves(s);
    }
  }, 120_000);
});
