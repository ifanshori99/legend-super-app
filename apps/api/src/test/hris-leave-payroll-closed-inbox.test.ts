// Fail-first tests for architect finding H1 of branch hris-leave-guard (money:
// payroll), written from docs/briefs/hris-leave-guard.md, the card contract and
// the sibling attendance-correction rule, never from service code. Patterns:
// hris-leave-payroll-closed.test.ts, hris-leave-review-followups.test.ts (F3,
// inbox decision + delivery of the real approval.resolved event).
//
// Scenario: a leave is PENDING for dates inside a payroll run; the run is then
// locked / paid / reversed; the approver approves through the general approval
// inbox (POST /api/approvals/:id/decisions). That endpoint skips the leave
// decision endpoint's payroll guard. The approval.resolved consumer then
// settles the leave.
//
// Contract (the same as an attendance correction decided through the inbox on a
// closed period): the leave must not get stuck pending and must never be
// approved. It ends status "rejected" without decided_by (system settle), the
// reserved pending days go back (balances as before the request), the cause
// payroll_locked is recorded, no days are deducted (used_days unchanged, no
// leave.approved event) and no attendance log is flagged. Settling again (the
// event is delivered twice) changes nothing more. With the period open the
// inbox approval still approves. The employee cancel and the manager reject of
// such a pending leave still work (they hold no pay: no 409 loop).
//
// Assumptions (the brief is silent, stated here and in the report):
//  - The inbox decision answers 200 (the approval service knows nothing about
//    payroll); the leave outcome is observed after delivering the real
//    approval.resolved envelope of the leave's chain (tests have no worker).
//  - "Closed" = payroll_runs.status in locked, paid, reversed; a leave that only
//    partly overlaps a closed run counts as inside (doubt = restrict).
//  - The cause "payroll_locked" is checked loosely: it must appear in an audit
//    log event naming the leave, an outbox event naming the leave, or the leave
//    row itself.
//  - "HR reject" is the leave decision endpoint action reject by the outlet
//    manager (the approver of the leave policy in these fixtures).
//  - Only leave rows are touched, never payroll amounts: "no deduction" is
//    observed as unchanged used_days and no leave.approved outbox event.
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
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const RUN_MARKER = "lpci-test";
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
        `Leave payroll closed inbox ${roleId.slice(0, 8)}`,
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
const key = () => `lpci-${randomUUID()}`;
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
      [id, tenant.id, `PT Uji Cuti Payroll ${label} ${id.slice(0, 8)}`],
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
        `LP-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet cuti-payroll ${label}`,
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
       VALUES ($1, $2, $3, $4, 'Karyawan Cuti Payroll', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        userId,
        `LP-${id.slice(0, 8).toUpperCase()}`,
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

  const admin = await signedInClient("HR Cuti Payroll Tutup Inbox", {
    mfa: true,
  });
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
    code: `LPCI_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`,
    name: "Cuti tahunan uji payroll tutup inbox",
    paid: true,
    requiresAttachment: false,
    policy: {
      annualDays: "12.0000",
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
});

afterAll(async () => {
  await asTenant(async (db) => {
    // Replica mode skips the payroll lock-chain guard for the cleanup delete.
    await db.query("SET LOCAL session_replication_role = replica");
    await db.query(
      "DELETE FROM payroll_runs WHERE tenant_id = $1 AND created_by = $2",
      [tenant.id, RUN_MARKER],
    );
    await db.query("SET LOCAL session_replication_role = origin");
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'lpci-%'",
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
});

interface Scenario {
  outletId: string;
  legalEntityId: string;
  employeeId: string;
  staff: Client;
  manager: Client;
}

/** A fresh legal entity + outlet, staff, 12 leave days and an outlet manager. */
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

  const staffSession = await signedInClient(`Staf Cuti Inbox ${label}`);
  await grantRole(
    staffSession.userId,
    ["self.profile.view", "self.attendance.clock", "self.leave.request"],
    { type: "outlet", id: outletId },
  );
  const employeeId = await seedEmployee(staffSession.userId, outletId);

  const managerSession = await signedInClient(`Manajer Cuti Inbox ${label}`, {
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
    [-8, 0, 8].map((offset) => Number(dateAt(offset).slice(0, 4))),
  );
  for (const year of years)
    await asTenant((db) =>
      db.query(
        `INSERT INTO leave_balances
           (tenant_id, employee_id, leave_type_id, period_year, entitled_days)
         VALUES ($1, $2, $3, $4, '12')`,
        [tenant.id, employeeId, leaveTypeId, year],
      ),
    );

  return {
    outletId,
    legalEntityId,
    employeeId,
    staff: staffSession.client,
    manager: managerSession.client,
  };
}

// ---- payroll run helper -----------------------------------------------------

type RunStatus =
  | "draft"
  | "simulated"
  | "hr_approved"
  | "approved"
  | "locked"
  | "paid"
  | "reversed";
const CLOSED_STATUSES = ["locked", "paid", "reversed"] as const;

/**
 * Inserts a payroll run for the scenario's legal entity on the given client.
 * Replica mode skips the lock-chain guard and the free-standing policy
 * reference, so one insert makes a frozen run.
 */
async function insertRun(
  client: PoolClient,
  s: Scenario,
  status: RunStatus,
  fromOffset: number,
  toOffset: number,
): Promise<string> {
  const id = randomUUID();
  const frozen = ["locked", "paid", "reversed"].includes(status);
  await client.query("SET LOCAL session_replication_role = replica");
  await client.query(
    `INSERT INTO payroll_runs
       (id, tenant_id, legal_entity_id, payroll_policy_id, run_type, period_start, period_end,
        pay_date, status, config_snapshot, totals, approved_by_hr, approved_by_hr_at,
        approved_by_finance, approved_by_finance_at, locked_by, locked_at,
        paid_by, paid_at, reversal, created_by)
     VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, $7, '{"v":1}', '{"t":1}',
             'hr-user', now(), 'finance-user', now(),
             $8, $9, $10, $11, $12::jsonb, $13)`,
    [
      id,
      tenant.id,
      s.legalEntityId,
      randomUUID(),
      dateAt(fromOffset),
      dateAt(toOffset),
      status,
      frozen ? "lock-user" : null,
      frozen ? new Date() : null,
      status === "paid" ? "pay-user" : null,
      status === "paid" ? new Date() : null,
      status === "reversed" ? JSON.stringify({ status: "approved" }) : null,
      RUN_MARKER,
    ],
  );
  await client.query("SET LOCAL session_replication_role = origin");
  return id;
}

/** Runs `body` while a payroll run exists (committed), removes it after. */
async function withRun(
  s: Scenario,
  status: RunStatus,
  fromOffset: number,
  toOffset: number,
  body: () => Promise<void>,
): Promise<void> {
  const runId = await asTenant((db) =>
    insertRun(db, s, status, fromOffset, toOffset),
  );
  try {
    await body();
  } finally {
    await asTenant(async (db) => {
      await db.query("SET LOCAL session_replication_role = replica");
      await db.query("DELETE FROM payroll_runs WHERE id = $1", [runId]);
    });
  }
}
// ---- readers and API helpers -----------------------------------------------

async function balancesOf(s: Scenario) {
  const { rows } = await asTenant((db) =>
    db.query<{ period_year: number; used_days: string; pending_days: string }>(
      `SELECT period_year, used_days::text, pending_days::text FROM leave_balances
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        ORDER BY period_year`,
      [tenant.id, s.employeeId, leaveTypeId],
    ),
  );
  return rows;
}

const sumOf = (
  rows: { used_days: string; pending_days: string }[],
  field: "used_days" | "pending_days",
) => rows.reduce((sum, row) => sum + Number(row[field]), 0);

async function leaveRow(leaveId: string) {
  const { rows } = await asTenant((db) =>
    db.query<{
      status: string;
      decided_by: string | null;
      approval_chain_id: string | null;
    }>(
      `SELECT status, decided_by, approval_chain_id
         FROM leave_requests WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, leaveId],
    ),
  );
  expect(rows[0], `leave ${leaveId} exists`).toBeDefined();
  return rows[0]!;
}

async function requestLeave(
  s: Scenario,
  startOffset: number,
  endOffset: number,
) {
  const response = await post(s.staff, "/api/hris/leave/requests", {
    leaveTypeId,
    startDate: dateAt(startOffset),
    endDate: dateAt(endOffset),
    reason: "Cuti uji payroll tutup inbox",
    attachmentUploadRef: null,
    idempotencyKey: key(),
  });
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
    idempotencyKey: key(),
  });

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

const decideInbox = (s: Scenario, approvalId: string) =>
  post(s.manager, `/api/approvals/${approvalId}/decisions`, {
    decision: "approved",
    reason: "Disetujui lewat inbox",
  });

async function inboxApprove(s: Scenario, leaveId: string) {
  const response = await decideInbox(s, await pendingInboxRequest(leaveId));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

/**
 * The inbox decision only appends approval.resolved to the outbox; the worker
 * delivers it to the HRIS consumer, which settles the leave. Tests have no
 * worker, so deliver the real event of the leave's chain the same way. Can be
 * called again: a redelivery of the same event.
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

/** How many records name the leave together with the cause payroll_locked. */
async function payrollLockedCauseCount(leaveId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT (
       (SELECT count(*) FROM audit_logs l
         WHERE l.tenant_id = $1 AND l.event::text LIKE '%' || $2 || '%'
           AND l.event::text LIKE '%payroll_locked%')
       + (SELECT count(*) FROM domain_event_outbox o
           WHERE o.tenant_id = $1 AND o.event::text LIKE '%' || $2 || '%'
             AND o.event::text LIKE '%payroll_locked%')
       + (SELECT count(*) FROM leave_requests r
           WHERE r.tenant_id = $1 AND r.id::text = $2
             AND row_to_json(r)::text LIKE '%payroll_locked%')
     )::text AS n`,
    [tenant.id, leaveId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function leaveApprovedEvents(leaveId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'leave.approved'
        AND event->'payload'->>'leaveRequestId' = $2`,
    [tenant.id, leaveId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Inserts an attendance log straight into the table; returns its uuid. */
async function seedLog(s: Scenario, offsetDays: number): Promise<string> {
  const id = ulidToUuid(createUlid());
  await asTenant((db) =>
    db.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          validity, flag_reasons, business_date, client_event_id, review_status)
       VALUES ($1, $2, $3, $4, 'in', 'selfie_geo', $5, now(), 'valid', '[]'::jsonb,
               $6, $7, 'none')`,
      [
        id,
        tenant.id,
        s.outletId,
        s.employeeId,
        new Date(Date.now() + offsetDays * DAY),
        dateAt(offsetDays),
        `lpci-${randomUUID()}`,
      ],
    ),
  );
  return id;
}

async function dbLog(id: string) {
  const { rows } = await asTenant((db) =>
    db.query<{
      validity: string;
      review_status: string;
      flag_reasons: string[];
    }>(
      `SELECT validity, review_status, flag_reasons
         FROM attendance_logs WHERE tenant_id = $1 AND id = $2`,
      [tenant.id, id],
    ),
  );
  expect(rows[0], `log ${id} exists`).toBeDefined();
  return rows[0]!;
}

// ---- tests ------------------------------------------------------------------

describe("[legend-0c5yg H1] inbox approval of a pending leave whose period got closed", () => {
  for (const status of CLOSED_STATUSES) {
    it(`[0c5yg-H1] ${status} run: inbox approval settles the leave rejected (not stuck, not approved), pending days released, cause payroll_locked, no deduction, no flag`, async () => {
      const s = await newScenario(`h1-${status}`);
      const balancesBefore = await balancesOf(s);
      const leaveId = await requestLeave(s, 0, 1);
      const logToday = await seedLog(s, 0);
      const logBefore = await dbLog(logToday);
      const held = await balancesOf(s);
      expect(sumOf(held, "pending_days"), "request reserves days").toBe(2);

      await withRun(s, status, -2, 2, async () => {
        await inboxApprove(s, leaveId);
        await deliverResolved(leaveId);
      });

      const row = await leaveRow(leaveId);
      expect(row.status, "not stuck pending, never approved").toBe("rejected");
      expect(row.decided_by, "system settle, no approver recorded").toBeNull();
      expect(await balancesOf(s), "balances back as before").toEqual(
        balancesBefore,
      );
      expect(
        await payrollLockedCauseCount(leaveId),
        "cause payroll_locked recorded",
      ).toBeGreaterThan(0);
      expect(await leaveApprovedEvents(leaveId), "no leave.approved").toBe(0);
      expect(await dbLog(logToday), "no attendance flag").toEqual(logBefore);
    });
  }

  it("[0c5yg-H1] a run locked between the inbox decision and the settle: the leave ends rejected, days released", async () => {
    const s = await newScenario("h1-between");
    const balancesBefore = await balancesOf(s);
    const leaveId = await requestLeave(s, 0, 1);
    await inboxApprove(s, leaveId); // period still open here

    await withRun(s, "locked", -1, 1, async () => {
      await deliverResolved(leaveId);
    });

    expect((await leaveRow(leaveId)).status).toBe("rejected");
    expect(await balancesOf(s)).toEqual(balancesBefore);
    expect(await leaveApprovedEvents(leaveId)).toBe(0);
  });

  it("[0c5yg-H1] only the last leave day inside the closed run: the whole leave ends rejected", async () => {
    const s = await newScenario("h1-straddle");
    const balancesBefore = await balancesOf(s);
    const leaveId = await requestLeave(s, 0, 2);

    await withRun(s, "locked", 2, 4, async () => {
      await inboxApprove(s, leaveId);
      await deliverResolved(leaveId);
    });

    expect((await leaveRow(leaveId)).status).toBe("rejected");
    expect(await balancesOf(s)).toEqual(balancesBefore);
  });

  it("[0c5yg-H1] settling again (the event is delivered twice) is idempotent: still rejected, balances and cause records unchanged", async () => {
    const s = await newScenario("h1-idem");
    const balancesBefore = await balancesOf(s);
    const leaveId = await requestLeave(s, 0, 1);

    await withRun(s, "locked", -2, 2, async () => {
      await inboxApprove(s, leaveId);
      await deliverResolved(leaveId);
      const causeAfterFirst = await payrollLockedCauseCount(leaveId);
      const rowAfterFirst = await leaveRow(leaveId);

      await deliverResolved(leaveId);
      await deliverResolved(leaveId);

      expect(await leaveRow(leaveId)).toEqual(rowAfterFirst);
      expect(await balancesOf(s)).toEqual(balancesBefore);
      expect(await payrollLockedCauseCount(leaveId), "no duplicate cause").toBe(
        causeAfterFirst,
      );
      expect(await leaveApprovedEvents(leaveId)).toBe(0);
    });
  });

  it("[0c5yg-H1] control, open period: inbox approval still approves, days move from pending to used once, the clash log is flagged once", async () => {
    const s = await newScenario("h1-open");
    const leaveId = await requestLeave(s, 0, 1);
    const logToday = await seedLog(s, 0);

    // A closed run on other dates and an open (draft) run on these dates must
    // not interfere.
    await withRun(s, "locked", -20, -10, async () => {
      await withRun(s, "draft", -2, 2, async () => {
        await inboxApprove(s, leaveId);
        await deliverResolved(leaveId);
      });
    });

    const row = await leaveRow(leaveId);
    expect(row.status).toBe("approved");
    const balances = await balancesOf(s);
    expect(sumOf(balances, "used_days")).toBe(2);
    expect(sumOf(balances, "pending_days")).toBe(0);
    expect(await leaveApprovedEvents(leaveId)).toBe(1);

    const flagged = await dbLog(logToday);
    expect(flagged.validity).toBe("flagged");
    expect(
      flagged.flag_reasons.filter((reason) => reason === "leave_approved"),
    ).toHaveLength(1);
  });
});

describe("[legend-0c5yg H1] a pending leave in a closed period can still be closed by its people (no 409 loop)", () => {
  it("[0c5yg-H1] the employee cancels a pending leave inside a locked run: 200 cancelled, pending days released", async () => {
    const s = await newScenario("h1-cancel");
    const balancesBefore = await balancesOf(s);
    const leaveId = await requestLeave(s, 0, 1);

    await withRun(s, "locked", -2, 2, async () => {
      const response = await decideAs(s.staff, leaveId, "cancel");
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.status).toBe("cancelled");
    });

    expect((await leaveRow(leaveId)).status).toBe("cancelled");
    expect(await balancesOf(s)).toEqual(balancesBefore);
  });

  it("[0c5yg-H1] the manager rejects a pending leave inside a paid run: 200 rejected, pending days released", async () => {
    const s = await newScenario("h1-reject");
    const balancesBefore = await balancesOf(s);
    const leaveId = await requestLeave(s, 0, 1);

    await withRun(s, "paid", -2, 2, async () => {
      const response = await decideAs(s.manager, leaveId, "reject");
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.status).toBe("rejected");
    });

    expect((await leaveRow(leaveId)).status).toBe("rejected");
    expect(await balancesOf(s)).toEqual(balancesBefore);
  });

  it("[0c5yg-H1] the direct approve stays refused 409 PAYROLL_PERIOD_LOCKED, and the leave can then be rejected (not stuck)", async () => {
    const s = await newScenario("h1-direct");
    const balancesBefore = await balancesOf(s);
    const leaveId = await requestLeave(s, 0, 1);

    await withRun(s, "reversed", -2, 2, async () => {
      const approve = await decideAs(s.manager, leaveId, "approve");
      expect(approve.status, JSON.stringify(approve.body)).toBe(409);
      expect(approve.body.error?.code).toBe("PAYROLL_PERIOD_LOCKED");
      expect((await leaveRow(leaveId)).status).toBe("pending");

      const reject = await decideAs(s.manager, leaveId, "reject");
      expect(reject.status, JSON.stringify(reject.body)).toBe(200);
    });

    expect((await leaveRow(leaveId)).status).toBe("rejected");
    expect(await balancesOf(s)).toEqual(balancesBefore);
  });
});
