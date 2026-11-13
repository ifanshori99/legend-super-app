// Fail-first tests for legend-x0avw findings 5 and 6 (docs/briefs/452-plan.md
// "F5 cloud-sync event untuk split/batal" and "F6 batas bayar"). Expected
// behaviour comes from that plan and the shared event contract
// (@starter/shared/hris), never from service code.
//
// F5: when HR cancels one day of an approved multi-day leave
// (POST /api/hris/attendance/logs/:logId/review, action cancel_leave) the leave
// row is narrowed and/or a tail row is added, or a one-day leave is cancelled.
// Every changed leave row must publish one cloud-sync `leave.changed` v1 event
// in the same transaction as the leave UPDATE/INSERT.
// F6: a clock-in on an approved leave day is flagged and its
// `attendance.logged` event carries validity "flagged" (payroll consumers must
// exclude flagged/pending logs; there is no payroll consumer of attendance yet).
//
// Assumptions:
//  - Event ids are uuids (attendance log ids are ULIDs, per the HRIS id
//    contract); both forms are normalised to uuid before comparing with rows.
//  - Narrowed rows (head, or the remaining part when the first/last day is
//    cancelled) and new tail rows use changeReason "range_split"; a leave that
//    is cancelled as a whole uses "range_cancelled" (status "cancelled").
//  - `days` is a decimal4 string ("2.0000"); compared numerically.
//  - A holiday in excludedHolidayDates stays with the part of the range that
//    contains that date.
//  - Setup mirrors hris-attendance-leave-split.test.ts (leave rows are seeded
//    directly as approved, so the only `leave.changed` events of a test are the
//    ones produced by cancel_leave).
//  - The "no leftover event on rollback" case seeds two overlapping approved
//    leaves on the same day. Whether the service answers 2xx (cancels both) or
//    refuses with ATTENDANCE_LEAVE_STILL_APPROVED is not asserted; the
//    invariant is atomicity: the events published are exactly the leave rows
//    that changed, and none when the call is refused.
//  - Not covered: "log later flagged by a leave approval keeps a single initial
//    attendance.logged" needs the approval-policy fixtures of
//    hris-leave-approve-flags-attendance.test.ts; only the clock-in-on-leave
//    path is tested here.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createUlid, ulidToUuid, uuidToUlid } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import * as hrisShared from "@starter/shared/hris";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

// `leaveChanged` does not exist yet while this test is fail-first.
const leaveChanged = (
  hrisShared as unknown as {
    leaveChanged?: {
      name: string;
      payloadSchema: {
        safeParse: (value: unknown) => { success: boolean };
        parse: (value: unknown) => unknown;
        shape?: Record<string, unknown>;
      };
    };
  }
).leaveChanged;

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];

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
        `Leave changed event ${roleId.slice(0, 8)}`,
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

const CENTER = { latitude: -6.2, longitude: 106.8 };
const key = () => `lv-chg-${randomUUID()}`;
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

async function seedOutlet(label: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Absensi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $7)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `LC-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet leave-changed ${label}`,
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(userId: string, homeOutletId: string) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Event Cuti', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenant.id,
        userId,
        `LC-${id.slice(0, 8).toUpperCase()}`,
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
const noSampling = { rate: 0, flaggedAlways: true, minPerSupervisorPerWeek: 0 };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WIB_OFFSET = 7 * 60 * MINUTE;
const wibDate = (ms: number) =>
  new Date(ms + WIB_OFFSET).toISOString().slice(0, 10);
/** Outlet-local (WIB) calendar date `offset` days from today. */
const dateAt = (offset: number) => wibDate(Date.now() + offset * DAY);

/**
 * Never straddle outlet midnight: the business date is the local calendar day.
 * Waits only until the safe window starts: before midnight until 2 minutes
 * after it, just after midnight until 1 minute after it. (It used to wait
 * `untilMidnight + 2 min` in both cases, and `untilMidnight` is almost a whole
 * day just after midnight, so tests started in the first minute of the WIB day
 * slept past their timeout.) The longest wait is under 4 minutes, so the
 * `beforeEach` below carries a hook timeout above that.
 */
async function avoidOutletMidnight() {
  const sinceMidnight = (Date.now() + WIB_OFFSET) % DAY;
  const untilMidnight = DAY - sinceMidnight;
  let waitMs = 0;
  if (untilMidnight < 2 * MINUTE) waitMs = untilMidnight + 2 * MINUTE;
  else if (sinceMidnight < MINUTE) waitMs = MINUTE - sinceMidnight + 1_000;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

// A test that starts near midnight waits here, in a hook with its own long
// timeout, instead of inside the test (default testTimeout 20 s). Later calls
// in newStaff then find the window already passed.
beforeEach(async () => {
  await avoidOutletMidnight();
}, 5 * MINUTE);

const looksLikeUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id);
const toUuid = (id: string) => (looksLikeUuid(id) ? id : ulidToUuid(id));

// ---- fixtures ---------------------------------------------------------------

let hr: Client;
let hrUserId: string;
let leaveTypeId: string;
let outletA: string;

beforeAll(async () => {
  const admin = await signedInClient("HR Event Cuti", { mfa: true });
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
  hrUserId = admin.userId;

  const type = await post(hr, "/api/hris/leave/types", {
    code: `LCHG_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`,
    name: "Cuti tahunan uji event",
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

  outletA = await seedOutlet("A");
  const policy = await put(hr, "/api/hris/attendance/policy", {
    outletId: outletA,
    policy: basePolicy,
    sampling: noSampling,
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
});

afterAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM shift_assignments WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
    );
    await client.query(
      "DELETE FROM leave_requests WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM leave_balances WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await client.query(
      "DELETE FROM leave_types WHERE tenant_id = $1 AND id = $2",
      [tenant.id, leaveTypeId],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'lv-chg-%'",
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
    // Outlets and outbox rows stay: append-only references (disposable DB).
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
});

interface Staff {
  employeeId: string;
  client: Client;
  year: number;
}

async function newStaff(label: string): Promise<Staff> {
  await avoidOutletMidnight();
  const session = await signedInClient(`Staf Event Cuti ${label}`);
  await grantRole(
    session.userId,
    ["self.profile.view", "self.attendance.clock", "self.leave.request"],
    { type: "outlet", outletIds: [outletA] },
  );
  const employeeId = await seedEmployee(session.userId, outletA);
  const year = Number(wibDate(Date.now()).slice(0, 4));
  await asTenant((client) =>
    client.query(
      `INSERT INTO leave_balances
         (tenant_id, employee_id, leave_type_id, period_year, entitled_days)
       VALUES ($1, $2, $3, $4, '12')`,
      [tenant.id, employeeId, leaveTypeId, year],
    ),
  );
  return { employeeId, client: session.client, year };
}

/** Approved leave start..end (offsets from today) with days already used. */
async function seedApprovedLeave(
  staff: Staff,
  startOffsetDays: number,
  endOffsetDays: number,
  days: number,
  excludedOffsets: number[] = [],
) {
  const id = randomUUID();
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO leave_requests
         (id, tenant_id, outlet_id, employee_id, leave_type_id, period_year,
          start_date, end_date, days, excluded_holiday_dates, status,
          requested_by, requested_at, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $11::date[], 'approved',
               $10, clock_timestamp(), $10, now())`,
      [
        id,
        tenant.id,
        outletA,
        staff.employeeId,
        leaveTypeId,
        staff.year,
        dateAt(startOffsetDays),
        dateAt(endOffsetDays),
        String(days),
        hrUserId,
        excludedOffsets.map(dateAt),
      ],
    );
    await client.query(
      `UPDATE leave_balances SET used_days = used_days + $1
        WHERE tenant_id = $2 AND employee_id = $3 AND leave_type_id = $4 AND period_year = $5`,
      [String(days), tenant.id, staff.employeeId, leaveTypeId, staff.year],
    );
  });
  return id;
}

interface Log {
  id: string;
  outletId: string;
  validity: string;
}

async function clockIn(staff: Staff): Promise<Log> {
  const response = await post(staff.client, "/api/hris/attendance/clock", {
    type: "in",
    method: "selfie_geo",
    occurredAt: new Date().toISOString(),
    location: { ...CENTER, accuracyM: 5 },
    deviceIdHash: null,
    photoUploadRef: null,
    qrToken: null,
    idempotencyKey: key(),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as Log;
}

/** A valid "in" log on the business date `offset` days from today (direct insert). */
async function insertValidLog(staff: Staff, offset: number) {
  const uuid = ulidToUuid(createUlid());
  await asTenant((client) =>
    client.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          validity, business_date, client_event_id)
       VALUES ($1, $2, $3, $4, 'in', 'selfie_geo', $5, now(), 'valid', $6, $7)`,
      [
        uuid,
        tenant.id,
        outletA,
        staff.employeeId,
        new Date(Date.now() + offset * DAY),
        dateAt(offset),
        createUlid(),
      ],
    ),
  );
  return uuid;
}

async function apiIdOf(staff: Staff, uuid: string) {
  const response = await hr.get(
    `/api/hris/attendance/logs?employeeId=${staff.employeeId}`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const found = (response.body.data as { id: string }[]).find(
    (item) => toUuid(item.id) === uuid,
  );
  expect(found, "inserted log listed by the API").toBeDefined();
  return found!.id;
}

const review = (logId: string, body: Record<string, unknown>) =>
  post(hr, `/api/hris/attendance/logs/${logId}/review`, {
    idempotencyKey: key(),
    ...body,
  });

interface LeaveRow {
  id: string;
  status: string;
  start: string;
  end: string;
  days: number;
  excluded: string[];
}

async function leavesOf(staff: Staff): Promise<LeaveRow[]> {
  return asTenant(async (client) => {
    const { rows } = await client.query(
      `SELECT id, status, start_date::text AS start, end_date::text AS "end",
              days::float8 AS days,
              COALESCE(ARRAY(SELECT d::text FROM unnest(excluded_holiday_dates) d ORDER BY d), '{}') AS excluded
         FROM leave_requests
        WHERE tenant_id = $1 AND employee_id = $2
        ORDER BY start_date, id`,
      [tenant.id, staff.employeeId],
    );
    return rows as LeaveRow[];
  });
}

interface OutboxRow {
  destination: string;
  aggregate_type: string;
  aggregate_id: string;
  sequence: number;
  event: {
    name: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  };
}

/** Every `leave.changed` outbox row of the employee, oldest first per aggregate. */
async function changedEvents(staff: Staff): Promise<OutboxRow[]> {
  const needles = [staff.employeeId, uuidToUlid(staff.employeeId)];
  const { rows } = await owner.query<OutboxRow>(
    `SELECT destination, aggregate_type, aggregate_id, sequence, event
       FROM domain_event_outbox
      WHERE tenant_id = $1
        AND event->>'name' = 'leave.changed'
        AND event->'payload'->>'employeeId' = ANY($2::text[])
      ORDER BY sequence`,
    [tenant.id, needles],
  );
  return rows;
}

const eventLeaveId = (row: OutboxRow) =>
  toUuid(String(row.event.payload.leaveRequestId));

function eventFor(rows: OutboxRow[], leaveId: string) {
  return rows.filter((row) => eventLeaveId(row) === leaveId);
}

/** The event payload must say what the leave row in the database says. */
function expectPayloadMatchesRow(row: OutboxRow, leave: LeaveRow) {
  const payload = row.event.payload;
  expect(toUuid(String(payload.leaveRequestId))).toBe(leave.id);
  expect(payload.startDate).toBe(leave.start);
  expect(payload.endDate).toBe(leave.end);
  expect(Number(payload.days)).toBe(leave.days);
  expect(payload.status).toBe(leave.status);
  expect([...(payload.excludedHolidayDates as string[])].sort()).toEqual(
    leave.excluded,
  );
}

/** Flagged clock-in today inside leave `start..end`; the leave is seeded approved. */
async function flaggedInside(
  label: string,
  startOffset: number,
  endOffset: number,
  days: number,
  excludedOffsets: number[] = [],
) {
  const staff = await newStaff(label);
  const leaveId = await seedApprovedLeave(
    staff,
    startOffset,
    endOffset,
    days,
    excludedOffsets,
  );
  const log = await clockIn(staff);
  expect(log.validity, "guard: the clock-in is flagged by the leave").toBe(
    "flagged",
  );
  expect(await changedEvents(staff), "seeding publishes nothing").toHaveLength(
    0,
  );
  return { staff, leaveId, log };
}

// ---- F5: contract -----------------------------------------------------------

describe("[F5] leave.changed event contract", () => {
  const sample = () => ({
    leaveRequestId: randomUUID(),
    employeeId: randomUUID(),
    outletId: randomUUID(),
    startDate: "2031-06-10",
    endDate: "2031-06-12",
    days: "3.0000",
    excludedHolidayDates: [] as string[],
    status: "approved",
    changeReason: "range_split",
    splitFromLeaveRequestId: null as string | null,
  });

  it("[F5] is exported, named leave.changed and registered with the HR events", () => {
    expect(
      leaveChanged,
      "leaveChanged exported by @starter/shared/hris",
    ).toBeDefined();
    expect(leaveChanged?.name).toBe("leave.changed");
    expect(
      (hrisShared as unknown as { hrisEventNames: string[] }).hrisEventNames,
    ).toContain("leave.changed");
  });

  it("[F5] accepts approved range_split (tail row names its head) and cancelled range_cancelled", () => {
    expect(leaveChanged).toBeDefined();
    expect(leaveChanged?.payloadSchema.safeParse(sample()).success).toBe(true);
    expect(
      leaveChanged?.payloadSchema.safeParse({
        ...sample(),
        splitFromLeaveRequestId: randomUUID(),
      }).success,
    ).toBe(true);
    expect(
      leaveChanged?.payloadSchema.safeParse({
        ...sample(),
        status: "cancelled",
        changeReason: "range_cancelled",
      }).success,
    ).toBe(true);
  });

  it("[F5] is strict: rejects unknown keys, other statuses and other reasons", () => {
    expect(leaveChanged).toBeDefined();
    const schema = leaveChanged!.payloadSchema;
    expect(schema.safeParse({ ...sample(), reason: "sakit" }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...sample(), status: "pending" }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ ...sample(), changeReason: "other" }).success,
    ).toBe(false);
    const { splitFromLeaveRequestId: _omit, ...missing } = sample();
    void _omit;
    expect(schema.safeParse(missing).success).toBe(false);
  });
});

// ---- F5: emission -----------------------------------------------------------

describe("[F5] cancel_leave on a multi-day leave publishes leave.changed per changed row", () => {
  it("[F5] middle day: head narrowed and tail added, two events in cloud-sync with matching payloads", async () => {
    const { staff, leaveId, log } = await flaggedInside("m1", -2, 2, 5);

    const response = await review(log.id, { action: "cancel_leave" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const leaves = await leavesOf(staff);
    expect(leaves).toHaveLength(2);
    const head = leaves.find((row) => row.id === leaveId)!;
    const tail = leaves.find((row) => row.id !== leaveId)!;
    expect(head).toMatchObject({ start: dateAt(-2), end: dateAt(-1), days: 2 });
    expect(tail).toMatchObject({ start: dateAt(1), end: dateAt(2), days: 2 });

    const rows = await changedEvents(staff);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.destination).toBe("cloud-sync");
      expect(row.aggregate_type).toBe("leave");
      const envelope = eventEnvelopeSchema.parse(row.event);
      expect(envelope.name).toBe("leave.changed");
      expect(toUuid(String(envelope.aggregateId))).toBe(eventLeaveId(row));
      if (leaveChanged) leaveChanged.payloadSchema.parse(row.event.payload);
    }

    const [headEvent] = eventFor(rows, head.id);
    const [tailEvent] = eventFor(rows, tail.id);
    expect(headEvent, "event for the narrowed head").toBeDefined();
    expect(tailEvent, "event for the new tail").toBeDefined();
    expectPayloadMatchesRow(headEvent!, head);
    expectPayloadMatchesRow(tailEvent!, tail);

    expect(headEvent!.event.payload).toMatchObject({
      employeeId: expect.anything(),
      status: "approved",
      changeReason: "range_split",
      splitFromLeaveRequestId: null,
    });
    expect(tailEvent!.event.payload).toMatchObject({
      status: "approved",
      changeReason: "range_split",
    });
    expect(
      toUuid(String(tailEvent!.event.payload.splitFromLeaveRequestId)),
    ).toBe(head.id);
    for (const row of rows) {
      expect(toUuid(String(row.event.payload.employeeId))).toBe(
        staff.employeeId,
      );
      expect(toUuid(String(row.event.payload.outletId))).toBe(outletA);
    }
    // First event of each aggregate starts its sequence.
    expect(Number(headEvent!.sequence)).toBeGreaterThanOrEqual(1);
    expect(Number(tailEvent!.sequence)).toBeGreaterThanOrEqual(1);
  });

  it("[F5] first day: only the narrowed original row changes, one event, no splitFrom", async () => {
    const { staff, leaveId, log } = await flaggedInside("f1", 0, 4, 5);

    const response = await review(log.id, { action: "cancel_leave" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const leaves = await leavesOf(staff);
    expect(leaves).toHaveLength(1);
    const rows = await changedEvents(staff);
    expect(rows).toHaveLength(1);
    expect(eventLeaveId(rows[0]!)).toBe(leaveId);
    expectPayloadMatchesRow(rows[0]!, leaves[0]!);
    expect(rows[0]!.event.payload).toMatchObject({
      status: "approved",
      changeReason: "range_split",
      splitFromLeaveRequestId: null,
    });
    expect(rows[0]!.destination).toBe("cloud-sync");
  });

  it("[F5] excluded holidays stay with the part of the range that contains them", async () => {
    // 5 calendar days, day -1 is an excluded holiday: 4 paid days.
    const { staff, leaveId, log } = await flaggedInside("h1", -2, 2, 4, [-1]);

    const response = await review(log.id, { action: "cancel_leave" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const leaves = await leavesOf(staff);
    expect(leaves).toHaveLength(2);
    const head = leaves.find((row) => row.id === leaveId)!;
    const tail = leaves.find((row) => row.id !== leaveId)!;
    expect(head.excluded).toEqual([dateAt(-1)]);
    expect(tail.excluded).toEqual([]);

    const rows = await changedEvents(staff);
    expect(rows).toHaveLength(2);
    expectPayloadMatchesRow(eventFor(rows, head.id)[0]!, head);
    expectPayloadMatchesRow(eventFor(rows, tail.id)[0]!, tail);
  });

  it("[F5] sequence per aggregate rises with every change of the same leave row", async () => {
    const staff = await newStaff("q1");
    // Days: -4 (1), -3 (2), -2 (3), -1 (4), 0 (5).
    const leaveId = await seedApprovedLeave(staff, -4, 0, 5);
    const day2 = await insertValidLog(staff, -3);
    const day4 = await insertValidLog(staff, -1);

    const first = await review(await apiIdOf(staff, day2), {
      action: "cancel_leave",
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await changedEvents(staff)).toHaveLength(2);

    const second = await review(await apiIdOf(staff, day4), {
      action: "cancel_leave",
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    const rows = await changedEvents(staff);
    // 2 events from the first cancel + (narrowed middle piece + new tail) from the second.
    expect(rows).toHaveLength(4);
    const leaves = await leavesOf(staff);
    expect(leaves).toHaveLength(3);
    const middle = leaves.find(
      (row) => row.id !== leaveId && row.start === dateAt(-2),
    )!;
    const middleEvents = eventFor(rows, middle.id);
    expect(middleEvents, "created, then narrowed").toHaveLength(2);
    expect(Number(middleEvents[0]!.sequence)).toBeLessThan(
      Number(middleEvents[1]!.sequence),
    );
    expect(Number(middleEvents[0]!.sequence)).toBeGreaterThanOrEqual(1);
    expectPayloadMatchesRow(middleEvents[1]!, middle);
    // Head was changed once only.
    expect(eventFor(rows, leaveId)).toHaveLength(1);
  });
});

describe("[F5] one-day leave cancelled as a whole", () => {
  it("[F5] publishes exactly one leave.changed with status cancelled and no splitFrom", async () => {
    const { staff, leaveId, log } = await flaggedInside("o1", 0, 0, 1);

    const response = await review(log.id, { action: "cancel_leave" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const rows = await changedEvents(staff);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.destination).toBe("cloud-sync");
    expect(rows[0]!.aggregate_type).toBe("leave");
    expect(eventLeaveId(rows[0]!)).toBe(leaveId);
    expect(rows[0]!.event.payload).toMatchObject({
      status: "cancelled",
      changeReason: "range_cancelled",
      splitFromLeaveRequestId: null,
      startDate: dateAt(0),
      endDate: dateAt(0),
    });
    expect(Number(rows[0]!.event.payload.days)).toBe(1);
    expect(toUuid(String(rows[0]!.event.payload.employeeId))).toBe(
      staff.employeeId,
    );
    expect(toUuid(String(rows[0]!.event.payload.outletId))).toBe(outletA);
    if (leaveChanged) leaveChanged.payloadSchema.parse(rows[0]!.event.payload);
  });
});

describe("[F5] repeating cancel_leave publishes nothing more", () => {
  it("[F5] same key replay and a new key leave the outbox as after the first call", async () => {
    const { staff, log } = await flaggedInside("i1", -2, 2, 5);
    const decisionKey = key();

    const first = await review(log.id, {
      action: "cancel_leave",
      idempotencyKey: decisionKey,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const after = await changedEvents(staff);
    expect(after).toHaveLength(2);

    const replay = await review(log.id, {
      action: "cancel_leave",
      idempotencyKey: decisionKey,
    });
    expect([200, 201], JSON.stringify(replay.body)).toContain(replay.status);
    expect(await changedEvents(staff)).toEqual(after);

    const again = await review(log.id, { action: "cancel_leave" });
    expect([200, 409, 422], JSON.stringify(again.body)).toContain(again.status);
    expect(await changedEvents(staff)).toEqual(after);
  });

  it("[F5] a one-day leave cancelled twice keeps a single event", async () => {
    const { staff, log } = await flaggedInside("i2", 0, 0, 1);
    const first = await review(log.id, { action: "cancel_leave" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const after = await changedEvents(staff);
    expect(after).toHaveLength(1);

    const again = await review(log.id, { action: "cancel_leave" });
    expect([200, 409, 422], JSON.stringify(again.body)).toContain(again.status);
    expect(await changedEvents(staff)).toEqual(after);
  });
});

describe("[F5] events are published in the same transaction as the leave change", () => {
  it("[F5] events are exactly the leave rows that changed, and none when the call is refused (ATTENDANCE_LEAVE_STILL_APPROVED rolls everything back)", async () => {
    const staff = await newStaff("r1");
    // Two overlapping approved leaves both cover today: a second approved
    // leave may still contain the day after the first one is split.
    await seedApprovedLeave(staff, -2, 2, 5);
    await seedApprovedLeave(staff, 0, 1, 2);
    const log = await clockIn(staff);
    expect(log.validity).toBe("flagged");
    const before = await leavesOf(staff);

    const response = await review(log.id, { action: "cancel_leave" });
    const after = await leavesOf(staff);
    const rows = await changedEvents(staff);

    const beforeById = new Map(before.map((row) => [row.id, row]));
    const changedIds = after
      .filter((row) => {
        const old = beforeById.get(row.id);
        return !old || JSON.stringify(old) !== JSON.stringify(row);
      })
      .map((row) => row.id)
      .sort();
    const eventIds = [...new Set(rows.map(eventLeaveId))].sort();

    if (response.status >= 200 && response.status < 300) {
      // Accepted: a change must have happened and every changed row has its event.
      expect(changedIds.length).toBeGreaterThan(0);
      expect(eventIds).toEqual(changedIds);
      for (const leave of after.filter((row) => changedIds.includes(row.id)))
        expectPayloadMatchesRow(eventFor(rows, leave.id).at(-1)!, leave);
    } else {
      // Refused: no leave row changed and no event is left behind.
      expect(
        response.status,
        JSON.stringify(response.body),
      ).toBeGreaterThanOrEqual(400);
      expect(after).toEqual(before);
      expect(rows).toHaveLength(0);
    }
  });
});

// ---- F6: attendance.logged carries the flagged validity ---------------------

async function loggedEventsOfLog(logId: string) {
  const { rows } = await owner.query<{
    destination: string;
    event: { name: string; payload: Record<string, unknown> };
  }>(
    `SELECT destination, event FROM domain_event_outbox
      WHERE tenant_id = $1
        AND event->>'name' = 'attendance.logged'
        AND event->'payload'->>'attendanceLogId' = ANY($2::text[])`,
    [tenant.id, [logId, toUuid(logId), uuidToUlid(toUuid(logId))]],
  );
  return rows;
}

describe("[F6] attendance.logged and the pay boundary", () => {
  it("[F6] a clock-in on an approved leave day publishes attendance.logged with validity flagged", async () => {
    const staff = await newStaff("p1");
    await seedApprovedLeave(staff, -1, 1, 3);
    const log = await clockIn(staff);
    expect(log.validity).toBe("flagged");

    const rows = await loggedEventsOfLog(log.id);
    expect(rows, "one initial attendance.logged for the log").toHaveLength(1);
    const payload = rows[0]!.event.payload;
    expect(payload).toMatchObject({ type: "in", validity: "flagged" });
    expect(toUuid(String(payload.employeeId))).toBe(staff.employeeId);
    expect(toUuid(String(payload.attendanceLogId))).toBe(toUuid(log.id));
    expect(() => eventEnvelopeSchema.parse(rows[0]!.event)).not.toThrow();
  });

  it("[F6] a clock-in with no leave publishes validity valid (control)", async () => {
    const staff = await newStaff("p2");
    const log = await clockIn(staff);
    expect(log.validity).toBe("valid");
    const rows = await loggedEventsOfLog(log.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.payload).toMatchObject({ validity: "valid" });
  });

  it("[F6] cancel_leave afterwards does not publish a second attendance.logged for the same log", async () => {
    const { log } = await flaggedInside("p3", -2, 2, 5);
    const response = await review(log.id, { action: "cancel_leave" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await loggedEventsOfLog(log.id)).toHaveLength(1);
  });
});

describe("[F6] attendance.logged contract keeps validity so consumers can exclude flagged logs", () => {
  const base = () => ({
    attendanceLogId: createUlid(),
    employeeId: randomUUID(),
    outletId: randomUUID(),
    type: "in",
    method: "selfie_geo",
    occurredAt: "2031-06-10T01:00:00.000Z",
    validity: "flagged",
    shiftAssignmentId: null,
  });

  it("[F6] the payload has a validity field whose values include valid, flagged and rejected", () => {
    const options = (
      hrisShared as unknown as {
        attendanceValiditySchema: { options: string[] };
      }
    ).attendanceValiditySchema.options;
    expect(options).toEqual(
      expect.arrayContaining(["valid", "flagged", "rejected"]),
    );
    expect(
      (
        hrisShared.attendanceLogged.payloadSchema as unknown as {
          shape: Record<string, unknown>;
        }
      ).shape,
    ).toHaveProperty("validity");
  });

  it("[F6] accepts validity flagged, rejects a payload without validity or with an unknown value", () => {
    const schema = hrisShared.attendanceLogged.payloadSchema;
    expect(schema.safeParse(base()).success).toBe(true);
    const { validity: _omit, ...without } = base();
    void _omit;
    expect(schema.safeParse(without).success).toBe(false);
    expect(schema.safeParse({ ...base(), validity: "pending" }).success).toBe(
      false,
    );
  });
});

// ---- 452 review fixes (architect xhigh, docs/briefs/452-review-fixes.md) ------

describe("[452] leave.changed requester_cancelled", () => {
  it("[452] the contract accepts a cancelled row with changeReason requester_cancelled", () => {
    expect(leaveChanged).toBeDefined();
    expect(
      leaveChanged?.payloadSchema.safeParse({
        leaveRequestId: randomUUID(),
        employeeId: randomUUID(),
        outletId: randomUUID(),
        startDate: "2031-06-10",
        endDate: "2031-06-12",
        days: "3.0000",
        excludedHolidayDates: [],
        status: "cancelled",
        changeReason: "requester_cancelled",
        splitFromLeaveRequestId: null,
      }).success,
    ).toBe(true);
  });

  it("[452] the requester cancelling an approved, not yet started leave publishes one leave.changed", async () => {
    const staff = await newStaff("q1");
    const leaveId = await seedApprovedLeave(staff, 3, 4, 2);

    const response = await post(
      staff.client,
      `/api/hris/leave/requests/${leaveId}/decision`,
      { action: "cancel", idempotencyKey: key() },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const rows = await changedEvents(staff);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.destination).toBe("cloud-sync");
    expect(eventLeaveId(rows[0]!)).toBe(leaveId);
    expect(rows[0]!.event.payload).toMatchObject({
      status: "cancelled",
      changeReason: "requester_cancelled",
      splitFromLeaveRequestId: null,
      startDate: dateAt(3),
      endDate: dateAt(4),
    });
    expect(Number(rows[0]!.event.payload.days)).toBe(2);
    if (leaveChanged) leaveChanged.payloadSchema.parse(rows[0]!.event.payload);

    const replay = await post(
      staff.client,
      `/api/hris/leave/requests/${leaveId}/decision`,
      { action: "cancel", idempotencyKey: key() },
    );
    expect([200, 409], JSON.stringify(replay.body)).toContain(replay.status);
    expect(await changedEvents(staff), "no second event").toHaveLength(1);
  });
});

describe("[452] lock order: hris:leave, employee leave-attendance lock, balance row", () => {
  const employeeLockName = (employeeId: string) =>
    `hris:leave-attendance:${tenant.id}:${employeeId.toLowerCase()}`;

  async function employeeLockWaiters(employeeId: string): Promise<number> {
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
      [employeeLockName(employeeId)],
    );
    return rows[0]!.n;
  }

  it("[452] filing a leave takes the employee lock before the balance row lock (no balance lock held while queued on the employee lock)", async () => {
    const staff = await newStaff("k1");
    const a = await owner.connect();
    let finished = false;
    let committed = false;
    let filing: Promise<{ status: number; body: unknown }> | null = null;
    try {
      await a.query("BEGIN");
      await a.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.id],
      );
      await a.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        employeeLockName(staff.employeeId),
      ]);

      filing = post(staff.client, "/api/hris/leave/requests", {
        leaveTypeId,
        startDate: dateAt(20),
        endDate: dateAt(26),
        reason: "Cuti uji urutan kunci",
        attachmentUploadRef: null,
        idempotencyKey: key(),
      }).then((response) => {
        finished = true;
        return response as unknown as { status: number; body: unknown };
      });
      filing.catch(() => undefined);

      const deadline = Date.now() + 20_000;
      for (;;) {
        if (finished)
          throw new Error(
            "filing finished while the employee lock was held elsewhere: createLeaveRequest does not take lockEmployeeLeaveAttendance unconditionally",
          );
        if ((await employeeLockWaiters(staff.employeeId)) > 0) break;
        if (Date.now() > deadline)
          throw new Error("filing never queued on the employee lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // Queued on the employee lock: the balance row must still be free, else
      // applyOutcome (employee lock, then balance) could deadlock with it.
      const probe = await owner.connect();
      try {
        await probe.query("BEGIN");
        await probe.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
          [tenant.id],
        );
        await probe.query("SET LOCAL lock_timeout = '2s'");
        const locked = await probe.query(
          `SELECT 1 FROM leave_balances
            WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4
              FOR UPDATE NOWAIT`,
          [tenant.id, staff.employeeId, leaveTypeId, staff.year],
        );
        expect(locked.rowCount, "balance row free while queued").toBe(1);
      } finally {
        await probe.query("ROLLBACK").catch(() => undefined);
        probe.release();
      }

      await a.query("COMMIT");
      committed = true;
      // Answer is not the point (this tenant may have no approval matrix:
      // 409 APPROVAL_POLICY_MISSING); it must just finish, not deadlock.
      const response = await filing;
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(500);
    } finally {
      if (!committed) await a.query("ROLLBACK").catch(() => undefined);
      a.release();
      if (filing) await filing.catch(() => undefined);
    }
  });
});
