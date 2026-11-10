// Atomic guard against a consecutive duplicate clock per (employee, shift)
// over HTTP (bead legend-whiwv, finding 2 of the 414 brief; PRD F25 "Absensi",
// HR-02). Runs the real Express app, Better Auth, RBAC and PostgreSQL against
// the seeded Cafe Legend tenant. Expected behaviour comes from the brief and
// the shared contract, not from service code. Written BEFORE the fix: the
// duplicate-prevention tests must fail on the current code.
//
// Assumptions (the brief leaves these open):
//  - A second clock-in of the same kind for the same employee and shift, sent
//    with a DIFFERENT idempotency key, is answered with the EXISTING log (a 2xx
//    with the same id), not a 409 (brief: "pick: return existing log"). No
//    second row is stored and no second `attendance.logged` event is emitted.
//  - "Same shift" means the same published shift assignment. Clock-ins with no
//    shift are not covered here.
//  - Only the immediate predecessor counts (in,in / out,out / break_start,
//    break_start / break_end,break_end); a legit re-entry (break_end then
//    break_start, out then in) stores a new row. No unique index: the UI offers
//    those repeats (finding 2 revision, brief).
//  - A rejected row (outside the geofence, 422) does not count: the employee
//    can still clock in validly afterwards.
//  - A log linked to a correction (`correction_id` set) is excluded from the
//    uniqueness rule: a new valid clock-in is accepted next to it. The link is
//    seeded through the owner pool onto a real, pending correction filed over
//    the API, because approving one needs the approval policy fixtures.
//  - Emitted events are read from `domain_event_outbox` by event name
//    `attendance.logged` and payload `employeeId`, counted by distinct event id.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOutlets: string[] = [];

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
  options: { replica?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    // Replica mode lets cleanup skip the append-only guards (disposable DB).
    if (options.replica)
      await client.query("SET LOCAL session_replication_role = replica");
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
  outletId: string,
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
        `Attendance unique ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["outlet"]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenant.id, userId, roleId, outletId],
    );
  });
}

// Outlet centre; 0.01 deg of latitude is ~1.1 km, outside the 100 m radius.
const CENTER = { latitude: -6.2, longitude: 106.8 };
const FAR = { ...CENTER, latitude: CENTER.latitude + 0.01 };
const at = (point: { latitude: number; longitude: number }) => ({
  ...point,
  accuracyM: 5,
});

let outletId: string;
let publisherUserId: string;
let admin: Client;
let insertedApprovalPolicy = false;

async function seedOutlet() {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, 'Outlet absensi unik', 'Jl. Absensi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $6)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `AU-${id.slice(0, 8)}`.toUpperCase(),
        JSON.stringify({ ...CENTER, radiusMeters: 100 }),
      ],
    ),
  );
  return id;
}

async function newStaff(name = "Staf Absensi Unik") {
  const staff = await signedInClient(name);
  await grantRole(
    staff.userId,
    ["self.profile.view", "self.attendance.clock"],
    outletId,
  );
  const employeeId = randomUUID();
  createdEmployees.push(employeeId);
  await asTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Absensi Unik', $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.id,
        staff.userId,
        `AU-${employeeId.slice(0, 8).toUpperCase()}`,
        outletId,
      ],
    ),
  );
  return { ...staff, employeeId };
}

const key = () => `att-api-${randomUUID()}`;
const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);

function clockBody(
  overrides: Partial<{
    type: string;
    location: unknown;
    idempotencyKey: string;
  }> = {},
) {
  return {
    type: "in",
    method: "selfie_geo",
    occurredAt: new Date().toISOString(),
    location: at(CENTER),
    deviceIdHash: null,
    photoUploadRef: null,
    qrToken: null,
    idempotencyKey: key(),
    ...overrides,
  };
}

const clock = (
  client: Client,
  overrides: Parameters<typeof clockBody>[0] = {},
) => post(client, "/api/hris/attendance/clock", clockBody(overrides));

type LogRow = {
  id: string;
  type: string;
  validity: string;
  correction_id: string | null;
};

async function storedLogs(employeeId: string) {
  return asTenant(async (client) => {
    const { rows } = await client.query<LogRow>(
      `SELECT id, type, validity, correction_id
         FROM attendance_logs
        WHERE tenant_id = $1 AND employee_id = $2
        ORDER BY occurred_at`,
      [tenant.id, employeeId],
    );
    return rows;
  });
}

const notRejected = async (employeeId: string, type = "in") =>
  (await storedLogs(employeeId)).filter(
    (row) => row.type === type && row.validity !== "rejected",
  );

/** Distinct `attendance.logged` events emitted for the employee. */
async function loggedEvents(employeeId: string) {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(DISTINCT event->>'id') AS count FROM domain_event_outbox
      WHERE tenant_id = $1
        AND event->>'name' = 'attendance.logged'
        AND event->'payload'->>'employeeId' = $2`,
    [tenant.id, employeeId],
  );
  return Number(rows[0]?.count);
}

// ---- shifts, seeded relative to "now" (server time is the attendance time) --

const MINUTE = 60_000;
const WIB_OFFSET = 7 * 60 * MINUTE;
const wibDate = (ms: number) =>
  new Date(ms + WIB_OFFSET).toISOString().slice(0, 10);

/** Never straddle outlet midnight: the business date is the local calendar day. */
async function avoidOutletMidnight() {
  const sinceMidnight = (Date.now() + WIB_OFFSET) % (24 * 60 * MINUTE);
  const untilMidnight = 24 * 60 * MINUTE - sinceMidnight;
  if (sinceMidnight < MINUTE || untilMidnight < 2 * MINUTE)
    await new Promise((resolve) =>
      setTimeout(resolve, untilMidnight + 2 * MINUTE),
    );
}

async function seedShift(employeeId: string) {
  await avoidOutletMidnight();
  const id = randomUUID();
  const now = Date.now();
  await asTenant((client) =>
    client.query(
      `INSERT INTO shift_assignments
         (id, tenant_id, outlet_id, employee_id, business_date, segments, break_minutes,
          status, source, published_by, published_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'published', 'user', $7, now(), $7)`,
      [
        id,
        tenant.id,
        outletId,
        employeeId,
        wibDate(now),
        JSON.stringify([
          {
            startsAt: new Date(now - 10 * MINUTE).toISOString(),
            endsAt: new Date(now + 4 * 60 * MINUTE).toISOString(),
          },
        ]),
        publisherUserId,
      ],
    ),
  );
  return id;
}

beforeAll(async () => {
  // Filing a correction needs an approval policy for the action; keep an
  // existing one.
  const inserted = await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     SELECT $1, 'attendance_correction', NULL,
            (SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'outlet_manager'), 1
      WHERE NOT EXISTS (SELECT 1 FROM approval_policies
                         WHERE tenant_id = $1 AND action_type = 'attendance_correction')`,
    [tenant.id],
  );
  insertedApprovalPolicy = (inserted.rowCount ?? 0) > 0;
  outletId = await seedOutlet();
  const publisher = await signedInClient("Penerbit Shift Unik");
  publisherUserId = publisher.userId;

  const policyAdmin = await signedInClient("Admin Kebijakan Unik", {
    mfa: true,
  });
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
      [
        roleId,
        tenant.id,
        `Attendance unique admin ${roleId.slice(0, 8)}`,
        JSON.stringify(["hr.attendance.manage"]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
      [tenant.id, policyAdmin.userId, roleId],
    );
  });
  admin = policyAdmin.client;
  const response = await admin
    .put("/api/hris/attendance/policy")
    .set(originHeader)
    .send({
      outletId,
      policy: {
        geofenceRadiusM: 100,
        outsideGeofenceAction: "reject",
        unboundDeviceAction: "reject",
        requireSelfie: false,
        requireDeviceBinding: false,
        allowRotatingQr: true,
        selfieRetentionDays: 90,
      },
      sampling: { rate: 0, flaggedAlways: true, minPerSupervisorPerWeek: 0 },
    });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}, 60_000);

afterAll(async () => {
  await asTenant(
    async (client) => {
      // Logs first: a correction-linked log references its correction.
      await client.query(
        "DELETE FROM attendance_logs WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
        [tenant.id, createdOutlets],
      );
      await client.query(
        "DELETE FROM attendance_corrections WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
        [tenant.id, createdOutlets],
      );
      await client.query(
        "DELETE FROM attendance_policies WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
        [tenant.id, createdOutlets],
      );
      await client.query(
        "DELETE FROM shift_assignments WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
        [tenant.id, createdOutlets],
      );
      await client.query(
        "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'att-api-%'",
        [tenant.id],
      );
      await client.query(
        "DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])",
        [tenant.id, createdUsers],
      );
      await client.query(
        `DELETE FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->'payload'->>'employeeId' = ANY($2::text[])`,
        [tenant.id, createdEmployees],
      );
      await client.query(
        `DELETE FROM audit_logs
        WHERE tenant_id = $1
          AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS e(id)
                       WHERE audit_logs.event::text LIKE '%' || e.id || '%')`,
        [tenant.id, createdEmployees],
      );
      if (insertedApprovalPolicy)
        await client.query(
          "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'attendance_correction'",
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
      // Outlets stay: audit_logs is append-only and references them.
    },
    { replica: true },
  );
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
    createdUsers,
  ]);
  await owner.end();
});

const ok = (status: number) => status >= 200 && status < 300;

describe("consecutive duplicate clock guard per employee and shift (legend-whiwv #2)", () => {
  it("[F25] a single clock-in on a shift makes one valid log and one event", async () => {
    // Baseline: proves the outbox probe and the shift fixture work.
    const staff = await newStaff();
    const shiftId = await seedShift(staff.employeeId);
    const response = await clock(staff.client);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.shiftAssignmentId).toBe(shiftId);
    expect(await notRejected(staff.employeeId)).toHaveLength(1);
    expect(await loggedEvents(staff.employeeId)).toBe(1);
  });

  it("[F25] two parallel clock-ins with different keys make one valid log, one event, and answer with the same log", async () => {
    const staff = await newStaff();
    const shiftId = await seedShift(staff.employeeId);
    const results = await Promise.all([
      clock(staff.client),
      clock(staff.client),
    ]);
    for (const result of results) {
      expect(ok(result.status), JSON.stringify(result.body)).toBe(true);
      expect(result.body.data.shiftAssignmentId).toBe(shiftId);
    }
    expect(new Set(results.map((result) => result.body.data.id)).size).toBe(1);
    const rows = await notRejected(staff.employeeId);
    expect(rows).toHaveLength(1);
    expect(results[0]!.body.data.id).toBe(results[1]!.body.data.id);
    expect(await loggedEvents(staff.employeeId)).toBe(1);
  });

  it("[F25] five parallel clock-ins with different keys still make exactly one valid log and one event", async () => {
    const staff = await newStaff();
    await seedShift(staff.employeeId);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => clock(staff.client)),
    );
    for (const result of results)
      expect(ok(result.status), JSON.stringify(result.body)).toBe(true);
    expect(new Set(results.map((result) => result.body.data.id)).size).toBe(1);
    expect(await notRejected(staff.employeeId)).toHaveLength(1);
    expect(await loggedEvents(staff.employeeId)).toBe(1);
  });

  it("[F25] a sequential second clock-in with a different key returns the existing log and adds none", async () => {
    const staff = await newStaff();
    await seedShift(staff.employeeId);
    const first = await clock(staff.client);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await clock(staff.client);
    expect(ok(second.status), JSON.stringify(second.body)).toBe(true);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await notRejected(staff.employeeId)).toHaveLength(1);
    expect(await loggedEvents(staff.employeeId)).toBe(1);
  });

  it("[F25] clock-in and clock-out on the same shift are different kinds and both stay", async () => {
    const staff = await newStaff();
    await seedShift(staff.employeeId);
    const clockIn = await clock(staff.client);
    const clockOut = await clock(staff.client, { type: "out" });
    expect(clockIn.status, JSON.stringify(clockIn.body)).toBe(201);
    expect(clockOut.status, JSON.stringify(clockOut.body)).toBe(201);
    expect(clockOut.body.data.id).not.toBe(clockIn.body.data.id);
    expect(await notRejected(staff.employeeId, "in")).toHaveLength(1);
    expect(await notRejected(staff.employeeId, "out")).toHaveLength(1);
  });

  it("[F25] another employee on the same shift day is not blocked by the first one", async () => {
    const a = await newStaff("Staf A Unik");
    const b = await newStaff("Staf B Unik");
    await seedShift(a.employeeId);
    await seedShift(b.employeeId);
    const [first, second] = await Promise.all([
      clock(a.client),
      clock(b.client),
    ]);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.data.id).not.toBe(first.body.data.id);
  });

  it("[F25] a rejected clock-in does not block a later valid one", async () => {
    const staff = await newStaff();
    await seedShift(staff.employeeId);
    const rejected = await clock(staff.client, { location: at(FAR) });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
    expect(await notRejected(staff.employeeId)).toHaveLength(0);

    const valid = await clock(staff.client);
    expect(valid.status, JSON.stringify(valid.body)).toBe(201);
    expect(valid.body.data.validity).toBe("valid");
    expect(await notRejected(staff.employeeId)).toHaveLength(1);

    // A second rejected attempt afterwards also leaves the valid row alone.
    const again = await clock(staff.client, { location: at(FAR) });
    expect(again.status, JSON.stringify(again.body)).toBe(422);
    expect(await notRejected(staff.employeeId)).toHaveLength(1);
  });

  it("[F25] a log linked to a correction does not block a new valid clock-in", async () => {
    const staff = await newStaff();
    await seedShift(staff.employeeId);
    const first = await clock(staff.client);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // File a real (pending) correction, then link the first log to it, as a
    // corrected row would be.
    const correction = await post(
      staff.client,
      "/api/hris/attendance/corrections",
      {
        outletId,
        attendanceLogId: null,
        requestedType: "in",
        requestedOccurredAt: new Date(
          Date.now() - 2 * 86_400_000,
        ).toISOString(),
        reason: "Koreksi untuk uji keunikan",
        idempotencyKey: key(),
      },
    );
    expect([200, 201], JSON.stringify(correction.body)).toContain(
      correction.status,
    );
    await asTenant((client) =>
      client.query(
        "UPDATE attendance_logs SET correction_id = $3 WHERE tenant_id = $1 AND id = $2",
        [
          tenant.id,
          ulidToUuid(first.body.data.id),
          correction.body.data.id as string,
        ],
      ),
    );

    const next = await clock(staff.client);
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(next.body.data.id).not.toBe(first.body.data.id);
    const rows = await notRejected(staff.employeeId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.correction_id === null)).toHaveLength(1);
  });

  it("[F25] a second break_start after break_end is a legit repeat and makes a new row", async () => {
    const staff = await newStaff();
    await seedShift(staff.employeeId);
    const ids: string[] = [];
    for (const type of [
      "in",
      "break_start",
      "break_end",
      "break_start",
      "break_end",
      "out",
      "in",
    ]) {
      const response = await clock(staff.client, { type });
      expect(response.status, `${type}: ${JSON.stringify(response.body)}`).toBe(
        201,
      );
      ids.push(response.body.data.id as string);
    }
    expect(new Set(ids).size).toBe(7);
    expect(await notRejected(staff.employeeId, "break_start")).toHaveLength(2);
    expect(await notRejected(staff.employeeId, "break_end")).toHaveLength(2);
    expect(await notRejected(staff.employeeId, "in")).toHaveLength(2);
    expect(await loggedEvents(staff.employeeId)).toBe(7);
  });

  it("[F25] a clock-in after a clock-out succeeds as a new row", async () => {
    const staff = await newStaff();
    await seedShift(staff.employeeId);
    const first = await clock(staff.client);
    const out = await clock(staff.client, { type: "out" });
    const again = await clock(staff.client);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data.id).not.toBe(first.body.data.id);
    expect(await notRejected(staff.employeeId, "in")).toHaveLength(2);
  });

  it("[F25] consecutive duplicates of every kind with different keys dedupe to the predecessor", async () => {
    const staff = await newStaff();
    await seedShift(staff.employeeId);
    const sequence = ["in", "break_start", "break_end", "out"];
    for (const type of sequence) {
      const first = await clock(staff.client, { type });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const second = await clock(staff.client, { type });
      expect(ok(second.status), JSON.stringify(second.body)).toBe(true);
      expect(second.body.data.id).toBe(first.body.data.id);
    }
    expect(await storedLogs(staff.employeeId)).toHaveLength(sequence.length);
    expect(await loggedEvents(staff.employeeId)).toBe(sequence.length);
  });

  it("[F25] a rejected log is not the predecessor: a valid log of the same kind still stores", async () => {
    const staff = await newStaff();
    await seedShift(staff.employeeId);
    const first = await clock(staff.client);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const rejected = await clock(staff.client, {
      type: "out",
      location: at(FAR),
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
    const out = await clock(staff.client, { type: "out" });
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    expect(out.body.data.validity).toBe("valid");
    expect(await notRejected(staff.employeeId, "out")).toHaveLength(1);
  });
});
