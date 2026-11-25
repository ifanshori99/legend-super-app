// Edge people snapshot, apply side (bead legend-tkycp card C3; design
// docs/design/hris-edge-replication.md 3.3, 3.5 and 9 T2). Written from the
// design and the shared contract, not from the implementation.
//
// The edge is a SECOND database (test/helpers/edge-database.ts) holding only
// outlet O, reached through the restricted application login like production.
// The cloud is the snapshot object each test builds.
//
// Assumptions (spec ambiguities):
//  - A person who is absent from a snapshot is detached, not deleted:
//    employee -> status 'suspended', user_id NULL, employee_no a placeholder
//    matching ^[A-Z0-9][A-Z0-9-]{1,29}$ (the exact placeholder text is not
//    asserted); user -> banned = true with its sessions deleted.
//  - A role that is absent and unreferenced is deleted or renamed
//    '~detached-<id>'; tests accept either and only require that the name is
//    free for the new holder.
//  - A repeat apply is a no-op on every data table; `received_at` of a QR key
//    and the sync-state timestamps are not part of that comparison.
//  - `applyEdgePeopleSnapshot` sets `applied_at` and `last_checked_at` from
//    its `now` argument.
//  - The staff PIN cases need an edge node: EDGE_MODE is faked with the
//    environment variable, like edge-staff-pin-pull.test.ts.
//  - Gap 1 (fail first): before the change, `applyStaffPinRecords(ctx,
//    records, edgeDatabase)` for a user missing in the edge database threw
//    the `staff_pins_user_fk` foreign key error (and took no database
//    argument). After it, the record is skipped and applies once the user
//    arrived with the snapshot.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { STAFF_PIN_HASH_ALGORITHM } from "@starter/shared/access/override";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  applyEdgePeopleSnapshot,
  EdgePeopleSnapshotError,
  loadEdgePeopleSyncState,
  markEdgePeopleSnapshotChecked,
} from "../edge/people-snapshot-apply.ts";
import { pullStaffPins } from "../edge/staff-pin-pull.ts";
import { hashStaffPin } from "../services/device-pin-hash.ts";
import {
  currentStaffPinPepperVersion,
  staffPinPepper,
} from "../services/device-pin-pepper.ts";
import { applyStaffPinRecords } from "../services/staff-pin-sync.ts";
import {
  cloneMainOutlet,
  createEdgeDatabase,
  edgeClaims,
  peopleBuilders,
  qrKey,
  sealKey,
  type EdgeDatabase,
  type Row,
} from "./helpers/edge-database.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const PLACEHOLDER = /^[A-Z0-9][A-Z0-9-]{1,29}$/;
const T1 = new Date("2026-11-10T03:00:00.000Z");
const T2 = new Date("2026-11-10T03:05:00.000Z");

const mainOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
let outletId = "";
let edge: EdgeDatabase;
let claims: ReturnType<typeof edgeClaims>["claims"];
let build: ReturnType<typeof peopleBuilders>;

const previousEdgeMode = process.env.EDGE_MODE;

beforeAll(async () => {
  process.env.EDGE_MODE = "true";
  outletId = await cloneMainOutlet(
    mainOwner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet uji apply snapshot",
  );
  edge = await createEdgeDatabase({ tenantId, outletId });
  claims = edgeClaims(tenantId, outletId).claims;
  build = peopleBuilders({ tenantId, outletId });
}, 240_000);

afterAll(async () => {
  if (previousEdgeMode === undefined) delete process.env.EDGE_MODE;
  else process.env.EDGE_MODE = previousEdgeMode;
  await edge?.cleanup();
  try {
    await mainOwner.query("DELETE FROM outlets WHERE id = $1", [outletId]);
  } catch {
    // Best effort: a private outlet no other file reads.
  }
  await mainOwner.end();
});

beforeEach(async () => {
  await edge.resetPeople();
});

const apply = (
  snapshot: unknown,
  etag = '"etag-1"',
  now: Date = T1,
): Promise<void> =>
  applyEdgePeopleSnapshot({
    claims,
    snapshot,
    etag,
    generatedAt: new Date("2026-11-10T02:59:00.000Z"),
    now,
    database: edge.database,
  });

const id = (row: Row) => row.id as string;

// ---- reads on the edge database ------------------------------------------

const users = () =>
  edge.rows(
    `SELECT id, name, banned, email, email_verified FROM "user" ORDER BY id`,
  );
const employees = () =>
  edge.rows(
    `SELECT id, user_id, employee_no, status, home_outlet_id, full_name FROM employees ORDER BY id`,
  );
const employeeById = async (employeeId: string) =>
  (await employees()).find((row) => row.id === employeeId);
const userById = async (userId: string) =>
  (await users()).find((row) => row.id === userId);
const syncState = async () =>
  (
    await edge.rows(
      `SELECT snapshot_etag, snapshot_generated_at, applied_at, last_checked_at,
              selfie_seal_kid, selfie_seal_public_key
         FROM edge_people_sync_state WHERE tenant_id = $1 AND outlet_id = $2`,
      [tenantId, outletId],
    )
  )[0];

/** Every data table of the snapshot, minus clocks the edge stamps itself. */
async function dump() {
  const tables = {
    users: `SELECT to_jsonb(t) AS r FROM "user" t ORDER BY id`,
    roles: `SELECT to_jsonb(t) AS r FROM roles t ORDER BY id`,
    roleAssignments: `SELECT to_jsonb(t) AS r FROM role_assignments t ORDER BY id`,
    employees: `SELECT to_jsonb(t) AS r FROM employees t ORDER BY id`,
    shifts: `SELECT to_jsonb(t) AS r FROM shift_assignments t ORDER BY id`,
    policies: `SELECT to_jsonb(t) AS r FROM attendance_policies t ORDER BY id`,
    qrKeys: `SELECT to_jsonb(t) - 'received_at' AS r FROM edge_attendance_qr_keys t ORDER BY day_index`,
  };
  const out: Record<string, unknown[]> = {};
  for (const [name, text] of Object.entries(tables))
    out[name] = (await edge.rows(text)).map((row) => row.r);
  return out;
}

async function addSession(userId: string) {
  await edge.rows(
    `INSERT INTO session (id, expires_at, token, user_id)
     VALUES ($1, now() + interval '1 day', $2, $3)`,
    [randomUUID(), randomUUID(), userId],
  );
}
const sessionCount = async (userId: string) =>
  Number(
    (
      await edge.rows(
        `SELECT count(*)::int AS n FROM session WHERE user_id = $1`,
        [userId],
      )
    )[0]!.n,
  );

async function addAttendanceLog(employeeId: string, shiftId: string) {
  await edge.rows(
    `INSERT INTO attendance_logs
       (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, validity,
        business_date, client_event_id, shift_assignment_id)
     VALUES ($1, $2, $3, $4, 'in', 'rotating_qr', '2026-11-12T02:01:00Z', 'valid',
             '2026-11-12', $5, $6)`,
    [randomUUID(), tenantId, outletId, employeeId, randomUUID(), shiftId],
  );
}

// ---- fixtures ---------------------------------------------------------------

/** One user with an employee, as the cloud sends them. */
function person() {
  const user = build.user();
  const employee = build.employee(id(user));
  return { user, employee };
}

describe("legend-tkycp T2 people snapshot apply on the edge", () => {
  it("applies a snapshot to a fresh edge database and records the sync state", async () => {
    const a = person();
    const b = person();
    b.employee.status = "onboarding";
    const role = build.role();
    const assignmentTenant = build.assignment(id(a.user), id(role), {
      scope: { type: "tenant", id: null },
    });
    const assignmentOutlet = build.assignment(id(b.user), id(role));
    const shift = build.shift(id(a.employee), id(a.user));
    const policy = build.policy(id(a.user));
    const keys = [qrKey(20_400), qrKey(20_401)];
    const seal = sealKey();

    await apply(
      build.snapshot({
        users: [a.user, b.user],
        roles: [role],
        roleAssignments: [assignmentTenant, assignmentOutlet],
        employees: [a.employee, b.employee],
        shiftAssignments: [shift],
        attendancePolicies: [policy],
        qrKeys: keys,
        selfieSealKey: seal,
      }),
    );

    const edgeUsers = await users();
    expect(edgeUsers.map(id).sort()).toEqual([id(a.user), id(b.user)].sort());
    for (const row of edgeUsers) {
      expect(row.banned).toBe(false);
      expect(row.email).toBe(`${row.id}@edge.invalid`);
      expect(row.email_verified).toBe(false);
    }

    const edgeEmployees = await employees();
    expect(edgeEmployees).toHaveLength(2);
    const edgeA = await employeeById(id(a.employee));
    expect(edgeA).toMatchObject({
      user_id: id(a.user),
      employee_no: a.employee.employeeNo,
      status: "active",
      home_outlet_id: outletId,
    });
    expect((await employeeById(id(b.employee)))?.status).toBe("onboarding");

    // Sealed PII columns stay empty: the snapshot never carries them.
    const sealed = (
      await edge.rows(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'employees'
            AND (column_name LIKE '%\\_encrypted' OR column_name LIKE '%\\_hmac')`,
      )
    ).map((row) => row.column_name as string);
    expect(sealed.length).toBeGreaterThan(0);
    const sealedRows = await edge.rows(
      `SELECT ${sealed.map((column) => `"${column}"`).join(", ")} FROM employees`,
    );
    for (const row of sealedRows)
      for (const column of sealed) expect(row[column]).toBeNull();

    expect(
      (await edge.rows(`SELECT id, name FROM roles`)).map((row) => row.name),
    ).toEqual([role.name]);
    const assignments = await edge.rows(
      `SELECT user_id, scope_type, scope_id, assigned_by FROM role_assignments ORDER BY scope_type`,
    );
    expect(assignments).toHaveLength(2);
    expect(
      assignments.find((row) => row.scope_type === "tenant"),
    ).toMatchObject({
      user_id: id(a.user),
      scope_id: null,
      assigned_by: id(a.user),
    });
    expect(
      assignments.find((row) => row.scope_type === "outlet"),
    ).toMatchObject({ user_id: id(b.user), scope_id: outletId });
    expect(
      await edge.rows(`SELECT id, status, outlet_id FROM shift_assignments`),
    ).toEqual([{ id: id(shift), status: "published", outlet_id: outletId }]);
    expect(
      (await edge.rows(`SELECT id FROM attendance_policies`)).map(id),
    ).toEqual([id(policy)]);
    const edgeKeys = await edge.rows(
      `SELECT day_index, encode(key, 'base64') AS key, octet_length(key) AS bytes
         FROM edge_attendance_qr_keys ORDER BY day_index`,
    );
    expect(edgeKeys).toEqual(
      keys.map((key) => ({ day_index: key.dayIndex, key: key.key, bytes: 32 })),
    );

    const state = await syncState();
    expect(state).toMatchObject({
      snapshot_etag: '"etag-1"',
      selfie_seal_kid: seal.kid,
      selfie_seal_public_key: seal.publicKeyPem,
    });
    expect(state!.applied_at).toEqual(T1);
    expect(state!.last_checked_at).toEqual(T1);
  });

  it("applying the same snapshot again changes nothing, and the cloud wins on a changed row", async () => {
    const a = person();
    const first = build.snapshot({
      users: [a.user],
      employees: [a.employee],
      qrKeys: [qrKey(20_400)],
    });
    await apply(first);
    const before = await dump();
    await apply(first);
    expect(await dump()).toEqual(before);

    await apply(
      build.snapshot({
        users: [{ ...a.user, name: "Nama dari cloud" }],
        employees: [{ ...a.employee, fullName: "Nama karyawan dari cloud" }],
        qrKeys: first.qrKeys,
      }),
      '"etag-2"',
      T2,
    );
    expect((await userById(id(a.user)))?.name).toBe("Nama dari cloud");
    expect((await employeeById(id(a.employee)))?.full_name).toBe(
      "Nama karyawan dari cloud",
    );
    expect((await syncState())!.snapshot_etag).toBe('"etag-2"');
  });

  it("removes what the next snapshot no longer carries and replaces the QR key set as a whole", async () => {
    const a = person();
    const role = build.role();
    await apply(
      build.snapshot({
        users: [a.user],
        roles: [role],
        roleAssignments: [build.assignment(id(a.user), id(role))],
        employees: [a.employee],
        shiftAssignments: [build.shift(id(a.employee), id(a.user))],
        attendancePolicies: [build.policy(id(a.user))],
        qrKeys: [qrKey(20_400), qrKey(20_401)],
      }),
    );

    await apply(
      build.snapshot({
        users: [a.user],
        employees: [a.employee],
        qrKeys: [qrKey(20_401), qrKey(20_402)],
      }),
      '"etag-2"',
      T2,
    );

    expect(await edge.rows(`SELECT id FROM role_assignments`)).toEqual([]);
    expect(await edge.rows(`SELECT id FROM shift_assignments`)).toEqual([]);
    expect(await edge.rows(`SELECT id FROM attendance_policies`)).toEqual([]);
    expect(
      await edge.rows(
        `SELECT id, name FROM roles WHERE name NOT LIKE '~detached-%'`,
      ),
    ).toEqual([]);
    expect(
      (
        await edge.rows(
          `SELECT day_index FROM edge_attendance_qr_keys ORDER BY day_index`,
        )
      ).map((row) => row.day_index),
    ).toEqual([20_401, 20_402]);
  });

  // Assumption: the cloud sends a banned user together with that user's active
  // role assignment; the edge keeps the user row (banned) but never holds a
  // role assignment for a banned user, also when one was applied earlier.
  it("a banned user with an active role assignment applies: the user is banned, their assignment is absent, other assignments stay, and a stale one is removed", async () => {
    const banned = person();
    const other = person();
    const role = build.role();
    const bannedAssignment = build.assignment(id(banned.user), id(role));
    const otherAssignment = build.assignment(id(other.user), id(role));
    const assignmentsOf = async () =>
      (
        await edge.rows(`SELECT id, user_id FROM role_assignments ORDER BY id`)
      ).map((row) => ({ id: id(row), userId: row.user_id as string }));

    // First apply: the user is not banned, so the assignment lands on the edge.
    await apply(
      build.snapshot({
        users: [banned.user, other.user],
        roles: [role],
        roleAssignments: [bannedAssignment, otherAssignment],
        employees: [banned.employee, other.employee],
      }),
    );
    expect((await assignmentsOf()).map((row) => row.id).sort()).toEqual(
      [id(bannedAssignment), id(otherAssignment)].sort(),
    );

    // Later snapshot: the cloud bans the user but still sends the assignment.
    await expect(
      apply(
        build.snapshot({
          users: [{ ...banned.user, banned: true }, other.user],
          roles: [role],
          roleAssignments: [bannedAssignment, otherAssignment],
          employees: [banned.employee, other.employee],
        }),
        '"etag-2"',
        T2,
      ),
    ).resolves.toBeUndefined();

    expect((await userById(id(banned.user)))?.banned).toBe(true);
    expect((await userById(id(other.user)))?.banned).toBe(false);
    expect(await assignmentsOf()).toEqual([
      { id: id(otherAssignment), userId: id(other.user) },
    ]);
  });

  it("E2 a user who stays but holds no assignment any more loses the edge PIN session; others and other sessions stay", async () => {
    const demoted = person();
    const ended = person();
    const other = person();
    const role = build.role();
    const people = {
      users: [demoted.user, ended.user, other.user],
      roles: [role],
      employees: [demoted.employee, ended.employee, other.employee],
    };
    const otherAssignment = build.assignment(id(other.user), id(role));
    const endedAssignment = build.assignment(id(ended.user), id(role));
    await apply(
      build.snapshot({
        ...people,
        roleAssignments: [
          build.assignment(id(demoted.user), id(role)),
          endedAssignment,
          otherAssignment,
        ],
      }),
    );
    for (const who of [demoted, ended, other]) {
      await addSession(id(who.user));
      await edge.rows(
        `INSERT INTO session (id, expires_at, token, user_id, tenant_id, auth_method, edge_device_id)
         VALUES ($1, now() + interval '1 day', $2, $3, $4, 'edge_staff_pin', $5)`,
        [randomUUID(), randomUUID(), id(who.user), tenantId, randomUUID()],
      );
    }
    await apply(
      build.snapshot({
        ...people,
        roleAssignments: [
          {
            ...endedAssignment,
            validFrom: "2026-01-01T00:00:00.000Z",
            validUntil: "2026-01-02T00:00:00.000Z",
          },
          otherAssignment,
        ],
      }),
      '"etag-2"',
      T2,
    );
    expect(await sessionCount(id(demoted.user))).toBe(1);
    expect(await sessionCount(id(ended.user))).toBe(1);
    expect(await sessionCount(id(other.user))).toBe(2);
  });

  it("an employee moved out of the outlet is detached, their user banned and sessions gone", async () => {
    const gone = person();
    const stays = person();
    const role = build.role();
    await apply(
      build.snapshot({
        users: [gone.user, stays.user],
        roles: [role],
        roleAssignments: [build.assignment(id(gone.user), id(role))],
        employees: [gone.employee, stays.employee],
      }),
    );
    await addSession(id(gone.user));
    expect(await sessionCount(id(gone.user))).toBe(1);

    await apply(
      build.snapshot({
        users: [stays.user],
        roles: [role],
        employees: [stays.employee],
      }),
      '"etag-2"',
      T2,
    );

    const detached = await employeeById(id(gone.employee));
    expect(detached).toMatchObject({ status: "suspended", user_id: null });
    expect(detached!.employee_no).toMatch(PLACEHOLDER);
    expect(detached!.employee_no).not.toBe(gone.employee.employeeNo);
    expect((await userById(id(gone.user)))?.banned).toBe(true);
    expect(await sessionCount(id(gone.user))).toBe(0);
    expect(
      await edge.rows(`SELECT id FROM role_assignments WHERE user_id = $1`, [
        id(gone.user),
      ]),
    ).toEqual([]);
    // The user who stays is untouched.
    expect((await userById(id(stays.user)))?.banned).toBe(false);
    expect((await employeeById(id(stays.employee)))?.status).toBe("active");
  });

  it("a re-hire with a new employee id, the old employee number and the old user applies", async () => {
    const old = person();
    await apply(
      build.snapshot({ users: [old.user], employees: [old.employee] }),
    );
    const rehired = build.employee(id(old.user), {
      employeeNo: old.employee.employeeNo,
    });

    await apply(
      build.snapshot({ users: [old.user], employees: [rehired] }),
      '"etag-2"',
      T2,
    );

    expect(await employeeById(id(rehired))).toMatchObject({
      user_id: id(old.user),
      employee_no: old.employee.employeeNo,
      status: "active",
    });
    const former = await employeeById(id(old.employee));
    if (former) {
      expect(former.user_id).toBeNull();
      expect(former.employee_no).not.toBe(old.employee.employeeNo);
      expect(former.employee_no).toMatch(PLACEHOLDER);
    }
    expect((await userById(id(old.user)))?.banned).toBe(false);
  });

  it("two employees that swap employee numbers apply", async () => {
    const a = person();
    const b = person();
    await apply(
      build.snapshot({
        users: [a.user, b.user],
        employees: [a.employee, b.employee],
      }),
    );

    await apply(
      build.snapshot({
        users: [a.user, b.user],
        employees: [
          { ...a.employee, employeeNo: b.employee.employeeNo },
          { ...b.employee, employeeNo: a.employee.employeeNo },
        ],
      }),
      '"etag-2"',
      T2,
    );

    expect((await employeeById(id(a.employee)))?.employee_no).toBe(
      b.employee.employeeNo,
    );
    expect((await employeeById(id(b.employee)))?.employee_no).toBe(
      a.employee.employeeNo,
    );
  });

  it("a user moved from one employee to another applies, also when the old holder leaves", async () => {
    const a = person();
    const b = person();
    await apply(
      build.snapshot({
        users: [a.user, b.user],
        employees: [a.employee, b.employee],
      }),
    );

    // The users swap employees.
    await apply(
      build.snapshot({
        users: [a.user, b.user],
        employees: [
          { ...a.employee, userId: id(b.user) },
          { ...b.employee, userId: id(a.user) },
        ],
      }),
      '"etag-2"',
      T2,
    );
    expect((await employeeById(id(a.employee)))?.user_id).toBe(id(b.user));
    expect((await employeeById(id(b.employee)))?.user_id).toBe(id(a.user));

    // The first employee takes the second user and the second employee is gone.
    await apply(
      build.snapshot({
        users: [a.user, b.user],
        employees: [{ ...a.employee, userId: id(a.user) }],
      }),
      '"etag-3"',
      T2,
    );
    expect((await employeeById(id(a.employee)))?.user_id).toBe(id(a.user));
    const left = await employeeById(id(b.employee));
    if (left) expect(left.user_id).toBeNull();
  });

  it("a role renamed onto a name held by a stale edge role applies", async () => {
    const stale = "Peran lokal basi";
    const r1 = build.role({ name: "Peran satu" });
    await apply(build.snapshot({ roles: [r1] }));
    await edge.rows(
      `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, false, NULL, '["self.attendance.clock"]'::jsonb, false, '["outlet"]'::jsonb)`,
      [tenantId, stale],
    );

    await apply(
      build.snapshot({ roles: [{ ...r1, name: stale }] }),
      '"etag-2"',
      T2,
    );

    const holders = await edge.rows(`SELECT id FROM roles WHERE name = $1`, [
      stale,
    ]);
    expect(holders.map(id)).toEqual([id(r1)]);
  });

  it("two roles that swap names apply", async () => {
    const r1 = build.role({ name: "Peran tukar A" });
    const r2 = build.role({ name: "Peran tukar B" });
    await apply(build.snapshot({ roles: [r1, r2] }));

    await apply(
      build.snapshot({
        roles: [
          { ...r1, name: "Peran tukar B" },
          { ...r2, name: "Peran tukar A" },
        ],
      }),
      '"etag-2"',
      T2,
    );

    const byId = new Map(
      (await edge.rows(`SELECT id, name FROM roles`)).map((row) => [
        id(row),
        row.name,
      ]),
    );
    expect(byId.get(id(r1))).toBe("Peran tukar B");
    expect(byId.get(id(r2))).toBe("Peran tukar A");
  });

  it("an employee who comes back with the same id is restored", async () => {
    const a = person();
    const other = person();
    await apply(
      build.snapshot({
        users: [a.user, other.user],
        employees: [a.employee, other.employee],
      }),
    );
    await apply(
      build.snapshot({ users: [other.user], employees: [other.employee] }),
      '"etag-2"',
      T2,
    );
    expect((await employeeById(id(a.employee)))?.status).toBe("suspended");
    expect((await userById(id(a.user)))?.banned).toBe(true);

    await apply(
      build.snapshot({
        users: [a.user, other.user],
        employees: [a.employee, other.employee],
      }),
      '"etag-3"',
      new Date("2026-11-10T03:10:00.000Z"),
    );

    expect(await employeeById(id(a.employee))).toMatchObject({
      status: "active",
      user_id: id(a.user),
      employee_no: a.employee.employeeNo,
    });
    expect((await userById(id(a.user)))?.banned).toBe(false);
  });

  it("a shift a local attendance log points at is cancelled, an unreferenced one is deleted", async () => {
    const a = person();
    const used = build.shift(id(a.employee), id(a.user));
    const free = build.shift(id(a.employee), id(a.user), {
      businessDate: "2026-11-13",
      segments: [
        {
          startsAt: "2026-11-13T02:00:00.000Z",
          endsAt: "2026-11-13T10:00:00.000Z",
        },
      ],
    });
    await apply(
      build.snapshot({
        users: [a.user],
        employees: [a.employee],
        shiftAssignments: [used, free],
      }),
    );
    await addAttendanceLog(id(a.employee), id(used));

    await apply(
      build.snapshot({ users: [a.user], employees: [a.employee] }),
      '"etag-2"',
      T2,
    );

    const shifts = await edge.rows(`SELECT id, status FROM shift_assignments`);
    expect(shifts).toEqual([{ id: id(used), status: "cancelled" }]);
    // The attendance log stays and still points at the shift.
    expect(
      await edge.rows(`SELECT shift_assignment_id FROM attendance_logs`),
    ).toEqual([{ shift_assignment_id: id(used) }]);

    // The cloud publishes it again: the same id is restored.
    await apply(
      build.snapshot({
        users: [a.user],
        employees: [a.employee],
        shiftAssignments: [used],
      }),
      '"etag-3"',
      new Date("2026-11-10T03:10:00.000Z"),
    );
    expect(await edge.rows(`SELECT id, status FROM shift_assignments`)).toEqual(
      [{ id: id(used), status: "published" }],
    );
  });

  it("a failed apply leaves the previous state and ETag", async () => {
    const a = person();
    await apply(
      build.snapshot({
        users: [a.user],
        employees: [a.employee],
        qrKeys: [qrKey(20_400)],
      }),
    );
    const before = await dump();
    const stateBefore = await syncState();

    // Not a snapshot: a user that claims a verified email.
    await expect(
      apply(
        build.rawSnapshot({
          users: [{ ...a.user, emailVerified: true }],
        }),
        '"etag-bad"',
        T2,
      ),
    ).rejects.toMatchObject({ code: "BAD_SNAPSHOT" });
    expect(await dump()).toEqual(before);
    expect(await syncState()).toEqual(stateBefore);

    // A valid snapshot whose last section is outside this outlet: the new
    // user and employee written before it must not stay.
    const fresh = person();
    await expect(
      apply(
        build.snapshot({
          users: [a.user, fresh.user],
          employees: [a.employee, fresh.employee],
          shiftAssignments: [
            build.shift(id(a.employee), id(a.user), { outletId: randomUUID() }),
          ],
          qrKeys: [qrKey(20_500)],
        }),
        '"etag-bad-2"',
        T2,
      ),
    ).rejects.toBeInstanceOf(EdgePeopleSnapshotError);
    expect(await userById(id(fresh.user))).toBeUndefined();
    expect(await dump()).toEqual(before);
    expect(await syncState()).toEqual(stateBefore);

    // Another tenant's employee is refused the same way.
    await expect(
      apply(
        build.snapshot({
          users: [a.user],
          employees: [{ ...a.employee, tenantId: randomUUID() }],
        }),
        '"etag-bad-3"',
        T2,
      ),
    ).rejects.toMatchObject({ code: "SCOPE_MISMATCH" });
    expect(await dump()).toEqual(before);
    expect((await syncState())!.snapshot_etag).toBe('"etag-1"');
  });

  it("a 304 check moves only last_checked_at", async () => {
    const a = person();
    await apply(
      build.snapshot({
        users: [a.user],
        employees: [a.employee],
        qrKeys: [qrKey(20_400)],
      }),
    );
    const before = await dump();
    const stateBefore = await syncState();

    await markEdgePeopleSnapshotChecked({
      claims,
      now: T2,
      database: edge.database,
    });

    const stateAfter = await syncState();
    expect(stateAfter!.last_checked_at).toEqual(T2);
    expect({ ...stateAfter, last_checked_at: null }).toEqual({
      ...stateBefore,
      last_checked_at: null,
    });
    expect(await dump()).toEqual(before);
    expect(
      await loadEdgePeopleSyncState({ claims, database: edge.database }),
    ).toEqual({ snapshotEtag: '"etag-1"', lastCheckedAt: T2, appliedAt: T1 });
  });

  it("a 304 check on an edge that never applied a snapshot records the time and no ETag", async () => {
    expect(
      await loadEdgePeopleSyncState({ claims, database: edge.database }),
    ).toBeNull();

    await markEdgePeopleSnapshotChecked({
      claims,
      now: T2,
      database: edge.database,
    });

    expect(
      await loadEdgePeopleSyncState({ claims, database: edge.database }),
    ).toEqual({ snapshotEtag: null, lastCheckedAt: T2, appliedAt: null });
    expect(await users()).toEqual([]);
  });

  describe("staff PIN of a user the snapshot has not delivered yet", () => {
    const context = () =>
      establishScopedTenantContext(
        establishTenantContext({ tenantId, brandId: null, source: "device" }),
        { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
      );

    async function pinRecord(userId: string) {
      const hashed = await hashStaffPin({
        pepper: staffPinPepper(tenantId, outletId),
        binding: { tenantId, outletId, userId },
        pin: "482916",
      });
      const at = new Date().toISOString();
      return {
        id: randomUUID(),
        tenantId,
        outletId,
        userId,
        algorithm: STAFF_PIN_HASH_ALGORITHM,
        salt: hashed.salt,
        pinHash: hashed.pinHash,
        params: hashed.params,
        pepperVersion: currentStaffPinPepperVersion(),
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: at,
        pinGenerationAt: at,
      };
    }
    const pinCount = async (userId: string) =>
      Number(
        (
          await edge.rows(
            `SELECT count(*)::int AS n FROM staff_pins WHERE user_id = $1`,
            [userId],
          )
        )[0]!.n,
      );

    it("is skipped without an error, then applies once the snapshot brought the user", async () => {
      const a = person();
      const record = await pinRecord(id(a.user));

      const skipped = await applyStaffPinRecords(
        context(),
        [record],
        edge.database,
      );
      expect(skipped.applied).toBe(0);
      expect(skipped.skipped).toBe(1);
      expect(await pinCount(id(a.user))).toBe(0);

      await apply(build.snapshot({ users: [a.user], employees: [a.employee] }));

      const applied = await applyStaffPinRecords(
        context(),
        [record],
        edge.database,
      );
      expect(applied.applied).toBe(1);
      expect(await pinCount(id(a.user))).toBe(1);
    });

    it("keeps the watermark at its old value while a record waits for its user", async () => {
      const a = person();
      const record = await pinRecord(id(a.user));
      const fetchPage = async () => ({
        data: [record],
        meta: { limit: 100, nextCursor: null, watermark: "wm-new" },
      });

      const waiting = await pullStaffPins({
        context: context(),
        since: "wm-old",
        fetchPage,
        database: edge.database,
      });
      expect(waiting.applied).toBe(0);
      expect(waiting.watermark).toBe("wm-old");
      expect(await pinCount(id(a.user))).toBe(0);

      await apply(build.snapshot({ users: [a.user], employees: [a.employee] }));
      const caughtUp = await pullStaffPins({
        context: context(),
        since: "wm-old",
        fetchPage,
        database: edge.database,
      });
      expect(caughtUp.applied).toBe(1);
      expect(caughtUp.watermark).toBe("wm-new");
      expect(await pinCount(id(a.user))).toBe(1);
    });
  });
});
