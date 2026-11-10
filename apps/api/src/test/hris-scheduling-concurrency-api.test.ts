// Concurrency of the scheduling write paths over HTTP (PRD v1.7 §3 Kelompok D
// 28 "Tukar & Ganti Shift", F26, HR-05, TEN-01/02; WS-10 brief, round 2). Runs
// the real Express app, Better Auth, RBAC and PostgreSQL against the seeded
// Cafe Legend tenant. Fixtures follow hris-scheduling-swap-api.test.ts.
//
// Assumptions (the spec leaves these open):
//  - Replays of a create or publish with the same idempotency key answer a 2xx
//    (200 or 201) with the same `data`; concurrent duplicates are replays.
//  - Cancel-assignment is POST /api/hris/shifts/:id/cancel { idempotencyKey } and
//    answers 200; cancelling an assignment with a pending swap cancels that swap.
//  - A decision that loses the race against a cancel (or the reverse) answers
//    a 4xx (404, 409 or 422), never 5xx; a deadlock would surface as 500 or
//    SQLSTATE 40P01 in the body.
//  - Lock order: a cancel locks the swap rows before the assignment row. While
//    another session holds the pending swap row, the cancel waits on that row
//    and has not yet locked the assignment (a second session can still take
//    FOR UPDATE NOWAIT on the assignment).
//  - Tables/columns read directly: shift_swap_requests(id, tenant_id, status,
//    from_assignment_id), shift_assignments(id, employee_id, business_date,
//    shift_template_id, status), domain_event_outbox(destination, event).
//  - Dates are Mondays-based weeks from 2037-01-05, one week per scenario, so
//    publishing a week never touches rows of other suites.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addBusinessDays } from "@starter/shared/hris";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outlet] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const createdUsers: string[] = [];
const createdRoles: { tenantId: string; id: string }[] = [];
const createdEmployees: string[] = [];
const BASE_WEEK = "2037-01-05";
const END_WEEK = "2038-01-04";
const KEY_PREFIX = "conc-api-";
const TEST_TIMEOUT = 45_000;

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
        `Conc API ${roleId.slice(0, 8)}`,
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

async function seedEmployee(userId: string | null, outletId: string) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Konkurensi API', $5, 'pkwtt', '2025-03-01', 'active')`,
      [id, tenant.id, userId, `CC-${id.slice(0, 8).toUpperCase()}`, outletId],
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
];
const MANAGER_PERMISSIONS = [
  "hr.schedule.manage",
  "hr.shift_swap.approve",
  "hr.employee.view",
];

let hr: { client: Client; userId: string };
let requester: { client: Client; userId: string };
let target: { client: Client; userId: string };
let employeeR: string;
let employeeT: string;
let pagiId: string;

beforeAll(async () => {
  hr = await signedInClient("HR Konkurensi API", { mfa: true });
  await grantCustomRole(tenant.id, hr.userId, MANAGER_PERMISSIONS, {
    type: "tenant",
  });
  const staffScope = { type: "outlet", id: outlet.id } as const;
  requester = await signedInClient("Peminta Konkurensi API");
  target = await signedInClient("Target Konkurensi API");
  for (const staff of [requester, target])
    await grantCustomRole(
      tenant.id,
      staff.userId,
      STAFF_PERMISSIONS,
      staffScope,
    );
  employeeR = await seedEmployee(requester.userId, outlet.id);
  employeeT = await seedEmployee(target.userId, outlet.id);

  const pagi = await post(hr.client, "/api/hris/shift-templates", {
    outletId: outlet.id,
    name: "CONCAPI Pagi",
    segments: [{ startTime: "07:00", endTime: "15:00" }],
    breakMinutes: 60,
    stationId: null,
    positionId: null,
  });
  expect(pagi.status, JSON.stringify(pagi.body)).toBe(201);
  pagiId = pagi.body.data.id;
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
          "DELETE FROM roster_publications WHERE tenant_id = $1 AND outlet_id = $2 AND week_start >= $3 AND week_start < $4",
          [tenant.id, outlet.id, BASE_WEEK, END_WEEK],
        );
        await db.query(
          "DELETE FROM shift_templates WHERE tenant_id = $1 AND name LIKE 'CONCAPI %'",
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

const createBody = (
  employeeId: string,
  businessDate: string,
  idempotencyKey = key(),
) => ({
  outletId: outlet.id,
  employeeId,
  businessDate,
  shiftTemplateId: pagiId,
  stationId: null,
  idempotencyKey,
});

async function createShift(
  employeeId: string,
  businessDate: string,
): Promise<string> {
  const created = await post(
    hr.client,
    "/api/hris/shifts",
    createBody(employeeId, businessDate),
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

const publishBody = (week: number, idempotencyKey = key()) => ({
  outletId: outlet.id,
  weekStart: weekOf(week),
  idempotencyKey,
});

async function publishedWeek(week: number, entries: [string, number][]) {
  const ids: string[] = [];
  for (const [employeeId, day] of entries)
    ids.push(await createShift(employeeId, dayOf(week, day)));
  const published = await post(
    hr.client,
    "/api/hris/rosters/publish",
    publishBody(week),
  );
  expect([200, 201], JSON.stringify(published.body)).toContain(
    published.status,
  );
  return ids;
}

const requestSwap = (
  client: Client,
  fromAssignmentId: string,
  idempotencyKey: string,
) =>
  post(client, "/api/hris/shift-swaps", {
    outletId: outlet.id,
    fromAssignmentId,
    toEmployeeId: employeeT,
    toAssignmentId: null,
    idempotencyKey,
  });

async function openCover(assignmentId: string) {
  const created = await requestSwap(requester.client, assignmentId, key());
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data as { id: string; status: string };
}

const decideSwap = (swapId: string, action: "approve" | "reject") =>
  post(hr.client, `/api/hris/shift-swaps/${swapId}/decision`, {
    action,
    overrideReason: null,
    idempotencyKey: key(),
  });

const cancelAssignment = (assignmentId: string) =>
  post(hr.client, `/api/hris/shifts/${assignmentId}/cancel`, {
    idempotencyKey: key(),
  });

async function swapRowStatus(swapId: string): Promise<string | undefined> {
  const { rows } = await asTenant((db) =>
    db.query<{ status: string }>(
      "SELECT status FROM shift_swap_requests WHERE tenant_id = $1 AND id = $2",
      [tenant.id, swapId],
    ),
  );
  return rows[0]?.status;
}

async function assignmentRow(assignmentId: string) {
  const { rows } = await asTenant((db) =>
    db.query<{ employee_id: string; status: string }>(
      "SELECT employee_id, status FROM shift_assignments WHERE tenant_id = $1 AND id = $2",
      [tenant.id, assignmentId],
    ),
  );
  return rows[0];
}

/** Sends the requests without awaiting; supertest starts a request on `then`. */
type Response = { status: number; body: { data?: unknown } };
const fire = (request: PromiseLike<unknown>): Promise<Response> =>
  Promise.resolve(request).then((response) => response as Response);

const hasDeadlock = (response: Response) =>
  /40P01|deadlock/i.test(JSON.stringify(response.body));

// ---- tests ---------------------------------------------------------------

describe("concurrency of scheduling writes", () => {
  it(
    "[F26 swap] cancelling an assignment takes the swap lock first: with the pending swap row held, the assignment row is still free (no 55P03), and cancel then completes",
    async () => {
      const [shift] = await publishedWeek(0, [[employeeR, 1]]);
      const swap = await openCover(shift);

      const holder = await owner.connect();
      let cancelling: Promise<Response> | undefined;
      let holding = false;
      let nowaitError: unknown;
      let nowaitRows = 0;
      let waited = false;
      try {
        await holder.query("BEGIN");
        holding = true;
        await holder.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
          [tenant.id],
        );
        await holder.query(
          "SELECT id FROM shift_swap_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
          [tenant.id, swap.id],
        );
        const { rows: pidRows } = await holder.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const holderPid = pidRows[0].pid;

        cancelling = fire(cancelAssignment(shift));

        // Wait until a backend is blocked on a lock held by our session.
        const deadline = Date.now() + 3000;
        while (!waited && Date.now() < deadline) {
          const { rows } = await owner.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND $1::int = ANY(pg_blocking_pids(pid))`,
            [holderPid],
          );
          waited = rows[0].n > 0;
          if (!waited) await new Promise((resolve) => setTimeout(resolve, 20));
        }

        if (waited) {
          const second = await owner.connect();
          try {
            await second.query("BEGIN");
            await second.query(
              "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
              [tenant.id],
            );
            const result = await second.query(
              "SELECT id FROM shift_assignments WHERE tenant_id = $1 AND id = $2 FOR UPDATE NOWAIT",
              [tenant.id, shift],
            );
            nowaitRows = result.rowCount ?? 0;
          } catch (error) {
            nowaitError = error;
          } finally {
            await second.query("ROLLBACK").catch(() => undefined);
            second.release();
          }
        }
      } finally {
        if (holding) await holder.query("COMMIT").catch(() => undefined);
        holder.release();
      }

      expect(waited, "cancel never waited on the held swap row").toBe(true);
      expect(
        nowaitError,
        "assignment row must be free while the cancel waits for the swap row",
      ).toBeUndefined();
      expect(nowaitRows).toBe(1);

      const cancelled = await cancelling!;
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
      expect(await swapRowStatus(swap.id)).toBe("cancelled");
      expect((await assignmentRow(shift))?.status).toBe("cancelled");
    },
    TEST_TIMEOUT,
  );

  it(
    "[F26 idempotensi] 6 parallel creates with the same key all succeed with the same assignment and leave one row",
    async () => {
      const businessDate = dayOf(1, 1);
      const body = createBody(employeeR, businessDate);
      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          fire(post(hr.client, "/api/hris/shifts", body)),
        ),
      );
      for (const response of responses) {
        expect([200, 201], JSON.stringify(response.body)).toContain(
          response.status,
        );
      }
      const ids = new Set(
        responses.map((response) => (response.body.data as { id: string }).id),
      );
      expect(ids.size).toBe(1);

      const { rows } = await asTenant((db) =>
        db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM shift_assignments
            WHERE tenant_id = $1 AND employee_id = $2 AND business_date = $3
              AND status <> 'cancelled'`,
          [tenant.id, employeeR, businessDate],
        ),
      );
      expect(rows[0].n).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "[F26 notifikasi] 4 parallel publishes with the same key give identical results and exactly one shift.published per assignment per destination",
    async () => {
      const week = 2;
      const ids = [
        await createShift(employeeR, dayOf(week, 1)),
        await createShift(employeeT, dayOf(week, 2)),
      ];
      const body = publishBody(week);
      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          fire(post(hr.client, "/api/hris/rosters/publish", body)),
        ),
      );
      for (const response of responses) {
        expect([200, 201], JSON.stringify(response.body)).toContain(
          response.status,
        );
        expect(response.body.data).toEqual(responses[0].body.data);
      }

      for (const id of ids) {
        const { rows } = await asTenant((db) =>
          db.query<{ destination: string; n: number }>(
            `SELECT destination, count(*)::int AS n FROM domain_event_outbox
              WHERE tenant_id = $1 AND event->>'name' = 'shift.published'
                AND event->'payload'->>'shiftAssignmentId' = $2
              GROUP BY destination`,
            [tenant.id, id],
          ),
        );
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(row.n, row.destination).toBe(1);
        expect(rows.map((row) => row.destination)).toContain("cloud-sync");
        expect((await assignmentRow(id))?.status).toBe("published");
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "[F26 swap] approving a swap while its origin assignment is cancelled never deadlocks or answers 500, and the final state is consistent (5 rounds)",
    async () => {
      for (let round = 0; round < 5; round += 1) {
        const [shift] = await publishedWeek(3 + round, [[employeeR, 1]]);
        const swap = await openCover(shift);

        const requests =
          round % 2 === 0
            ? [
                fire(decideSwap(swap.id, "approve")),
                fire(cancelAssignment(shift)),
              ]
            : [
                fire(cancelAssignment(shift)),
                fire(decideSwap(swap.id, "approve")),
              ];
        const [first, second] = await Promise.all(requests);
        const approve = round % 2 === 0 ? first : second;
        const cancel = round % 2 === 0 ? second : first;
        const label = `round ${round}`;

        for (const response of [approve, cancel]) {
          expect(
            response.status,
            `${label} ${JSON.stringify(response.body)}`,
          ).toBeLessThan(500);
          expect(hasDeadlock(response), label).toBe(false);
        }
        const approved = approve.status === 200;
        const cancelled = cancel.status === 200;
        expect(approved || cancelled, label).toBe(true);
        if (!approved) expect([404, 409, 422], label).toContain(approve.status);
        if (!cancelled) expect([404, 409, 422], label).toContain(cancel.status);

        const swapStatus = await swapRowStatus(swap.id);
        const row = await assignmentRow(shift);
        expect(swapStatus, label).not.toBe("pending");
        expect(cancelled, label).toBe(row?.status === "cancelled");
        if (approved) {
          // Approval won (a later cancel may still have cancelled the shift).
          expect(swapStatus, label).toBe("approved");
          expect(row?.employee_id, label).toBe(employeeT);
          expect(["swapped", "cancelled"], label).toContain(row?.status);
        } else {
          // Cancel won: the pending swap was cancelled with the shift.
          expect(swapStatus, label).toBe("cancelled");
          expect(row?.employee_id, label).toBe(employeeR);
          expect(row?.status, label).toBe("cancelled");
        }
      }
    },
    TEST_TIMEOUT * 2,
  );

  it(
    "[F26 idempotensi] 5 parallel swap requests with the same key all return the same request and leave one swap row",
    async () => {
      const [shift] = await publishedWeek(8, [[employeeR, 1]]);
      const idempotencyKey = key();
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          fire(requestSwap(requester.client, shift, idempotencyKey)),
        ),
      );
      for (const response of responses) {
        expect([200, 201], JSON.stringify(response.body)).toContain(
          response.status,
        );
        expect(response.body.data).toEqual(responses[0].body.data);
      }
      const ids = new Set(
        responses.map((response) => (response.body.data as { id: string }).id),
      );
      expect(ids.size).toBe(1);

      const { rows } = await asTenant((db) =>
        db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM shift_swap_requests
            WHERE tenant_id = $1 AND from_assignment_id = $2`,
          [tenant.id, shift],
        ),
      );
      expect(rows[0].n).toBe(1);
      expect(await swapRowStatus([...ids][0])).toBe("pending");
    },
    TEST_TIMEOUT,
  );
});
