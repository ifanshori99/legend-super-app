// Fail-first tests for bead legend-3jem1 (Codex 501 P2): the HR review queue
// (GET /api/hris/attendance/review-queue) filters by flag reason on the SERVER,
// so the "clock-in on approved leave" screen no longer scans a capped number of
// pages and loses leave cases that sit deep in the queue.
//
// Expected behaviour comes from docs/briefs/sub-3jem1-filter.md and the shared
// contract (listAttendanceReviewQueue.query.flagReason, an
// attendanceStoredFlagReasonSchema value), never from service code.
//
// Assumptions (the brief leaves these open):
//  - The query param is `flagReason=leave_approved`; only items whose
//    `flagReasons` contain it come back, whatever the reviewStatus branch
//    (pending, accepted, rejected). Without the param nothing changes.
//  - An outlet outside the caller's reach still answers 403 or 404 (never 200,
//    never data) when the filter is present; the filter is no way around scope.
//  - Cursor pages stay stable under the filter: reading every page returns each
//    matching log exactly once and nothing else.
//  - Rows are seeded straight into attendance_logs (owner pool, like
//    hris-attendance-isolation.test.ts) because the page limit (100) must be
//    exceeded by non-leave flagged logs that are NEWER than the leave logs.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { agent, signUp, verifySessionMfa } from "./helpers.ts";

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
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type Client = ReturnType<typeof agent>;

async function signedInClient(name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await verifySessionMfa(email);
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
        `Queue flag filter ${roleId.slice(0, 8)}`,
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

async function seedOutlet(label: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Filter', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $7)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `QF-${id.slice(0, 8)}`.toUpperCase(),
        `Outlet filter antrean ${label}`,
        JSON.stringify({ latitude: -6.2, longitude: 106.8, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(homeOutletId: string) {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, NULL, $3, 'Karyawan Filter Antrean', $4, 'pkwtt', '2025-03-01', 'active')`,
      [id, tenant.id, `QF-${id.slice(0, 8).toUpperCase()}`, homeOutletId],
    ),
  );
  return id;
}

type ReviewStatus = "pending" | "accepted" | "rejected";

/**
 * Inserts `count` attendance logs for one outlet/employee, all with the same
 * flag reasons and review status. `minutesAgo` is the age of the OLDEST of the
 * batch; later rows are one minute newer each, so a batch seeded with a smaller
 * `minutesAgo` is entirely newer than one seeded with a bigger value.
 * Returns the public (ULID) ids.
 */
async function seedLogs(input: {
  outletId: string;
  employeeId: string;
  count: number;
  flagReasons: string[];
  reviewStatus: ReviewStatus;
  minutesAgo: number;
  reviewerId: string;
}): Promise<string[]> {
  const ulids = Array.from({ length: input.count }, () => createUlid());
  const uuids = ulids.map((ulid) => ulidToUuid(ulid));
  const reviewed = input.reviewStatus !== "pending";
  await asTenant((client) =>
    client.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          geo_distance_m, validity, flag_reasons, business_date, client_event_id,
          review_status, reviewed_by, reviewed_at)
       SELECT u.id, $2, $3, $4, 'in', 'selfie_geo',
              now() - make_interval(mins => $5::int - (u.n - 1)::int),
              now(), 15,
              CASE $8 WHEN 'accepted' THEN 'valid' WHEN 'rejected' THEN 'rejected' ELSE 'flagged' END,
              $6::jsonb,
              ((now() AT TIME ZONE 'UTC')::date - (u.n % 20)::int),
              'qf-' || u.id::text,
              $8,
              CASE WHEN $7 THEN $9 ELSE NULL END,
              CASE WHEN $7 THEN now() ELSE NULL END
         FROM unnest($1::uuid[]) WITH ORDINALITY AS u(id, n)`,
      [
        uuids,
        tenant.id,
        input.outletId,
        input.employeeId,
        input.minutesAgo,
        JSON.stringify(input.flagReasons),
        reviewed,
        input.reviewStatus,
        input.reviewerId,
      ],
    ),
  );
  return ulids;
}

interface QueueItem {
  log: { id: string };
  flagReasons: string[];
  reviewStatus: string;
}
interface Page {
  status: number;
  items: QueueItem[];
  nextCursor: string | null;
}

async function page(client: Client, query: string): Promise<Page> {
  const response = await client.get(
    `/api/hris/attendance/review-queue?${query}`,
  );
  return {
    status: response.status,
    items: (response.body?.data ?? []) as QueueItem[],
    nextCursor: response.body?.meta?.nextCursor ?? null,
  };
}

/** Follows nextCursor until null; fails loudly instead of looping forever. */
async function readAll(client: Client, query: string, limit = 100) {
  const items: QueueItem[] = [];
  let pages = 0;
  let cursor: string | null = null;
  do {
    const next: Page = await page(
      client,
      `${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    expect(next.status, `queue page ${pages + 1}`).toBe(200);
    items.push(...next.items);
    cursor = next.nextCursor;
    pages += 1;
    expect(pages, "cursor must advance").toBeLessThan(50);
  } while (cursor);
  return { items, pages };
}

const ids = (items: QueueItem[]) => items.map((item) => item.log.id);

let hr: Client;
let hrUserId: string;
let outsiderOutletId: string;
let outletManager: Client;

// Shared outlet: 5 old leave logs, then 105 newer non-leave flagged logs, so the
// leave logs sit past the first page (limit 100) of the unfiltered queue.
let outletId: string;
let leavePending: string[];
let otherPending: string[];

beforeAll(async () => {
  const admin = await signedInClient("HR Filter Antrean");
  await grantRole(admin.userId, ["hr.attendance.manage", "hr.employee.view"], {
    type: "tenant",
  });
  hr = admin.client;
  hrUserId = admin.userId;

  outletId = await seedOutlet("utama");
  outsiderOutletId = await seedOutlet("luar jangkauan");
  const employeeId = await seedEmployee(outletId);

  // Old leave logs first, then a larger batch of newer non-leave flagged logs.
  leavePending = await seedLogs({
    outletId,
    employeeId,
    count: 5,
    flagReasons: ["leave_approved"],
    reviewStatus: "pending",
    minutesAgo: 600,
    reviewerId: hrUserId,
  });
  otherPending = await seedLogs({
    outletId,
    employeeId,
    count: 105,
    flagReasons: ["outside_geofence"],
    reviewStatus: "pending",
    minutesAgo: 300,
    reviewerId: hrUserId,
  });

  // A manager who reaches only the main outlet, never the outsider outlet.
  const manager = await signedInClient("Manajer Filter Antrean");
  await grantRole(manager.userId, ["hr.attendance.manage"], {
    type: "outlet",
    outletIds: [outletId],
  });
  outletManager = manager.client;
});

afterAll(async () => {
  await asTenant(async (client) => {
    await client.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND outlet_id = ANY($2::uuid[])",
      [tenant.id, createdOutlets],
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
  await owner.end();
});

describe("[3jem1] review queue filter by flagReason", () => {
  it("[3jem1] returns only leave_approved logs, including those past the first unfiltered page", async () => {
    const { items } = await readAll(
      hr,
      `outletId=${outletId}&reviewStatus=pending&flagReason=leave_approved`,
    );
    expect(ids(items).sort()).toEqual([...leavePending].sort());
    for (const item of items)
      expect(item.flagReasons).toContain("leave_approved");
  });

  it("[3jem1] the first filtered page already holds the leave logs the unfiltered first page pushes out", async () => {
    // Precondition that makes the bug real: 105 newer non-leave logs fill the
    // first unfiltered page (limit 100), so no leave log shows on it.
    const unfiltered = await page(
      hr,
      `outletId=${outletId}&reviewStatus=pending&limit=100`,
    );
    expect(unfiltered.status).toBe(200);
    expect(
      ids(unfiltered.items).filter((id) => leavePending.includes(id)),
    ).toEqual([]);

    const filtered = await page(
      hr,
      `outletId=${outletId}&reviewStatus=pending&limit=100&flagReason=leave_approved`,
    );
    expect(filtered.status).toBe(200);
    expect(ids(filtered.items).sort()).toEqual([...leavePending].sort());
    expect(filtered.nextCursor).toBeNull();
  });

  it("[3jem1] cursor pages under the filter return each leave log once, none lost", async () => {
    const { items, pages } = await readAll(
      hr,
      `outletId=${outletId}&reviewStatus=pending&flagReason=leave_approved`,
      2,
    );
    expect(pages).toBe(3); // 5 logs, 2 per page
    expect(ids(items)).toHaveLength(5);
    expect(new Set(ids(items)).size).toBe(5);
    expect(ids(items).sort()).toEqual([...leavePending].sort());
  });

  it("[3jem1] without the filter the queue is unchanged: leave and other flagged logs, all pages", async () => {
    const { items } = await readAll(
      hr,
      `outletId=${outletId}&reviewStatus=pending`,
    );
    expect(ids(items).sort()).toEqual(
      [...leavePending, ...otherPending].sort(),
    );
  });

  it("[3jem1] keeps the filter on the accepted and rejected review branches", async () => {
    const branchOutlet = await seedOutlet("cabang keputusan");
    const branchEmployee = await seedEmployee(branchOutlet);
    const seeded: Record<
      "accepted" | "rejected",
      { leave: string[]; other: string[] }
    > = {
      accepted: { leave: [], other: [] },
      rejected: { leave: [], other: [] },
    };
    for (const reviewStatus of ["accepted", "rejected"] as const) {
      seeded[reviewStatus].leave = await seedLogs({
        outletId: branchOutlet,
        employeeId: branchEmployee,
        count: 2,
        flagReasons: ["leave_approved"],
        reviewStatus,
        minutesAgo: 900,
        reviewerId: hrUserId,
      });
      seeded[reviewStatus].other = await seedLogs({
        outletId: branchOutlet,
        employeeId: branchEmployee,
        count: 3,
        flagReasons: ["outside_geofence"],
        reviewStatus,
        minutesAgo: 800,
        reviewerId: hrUserId,
      });
    }

    for (const reviewStatus of ["accepted", "rejected"] as const) {
      const filtered = await readAll(
        hr,
        `outletId=${branchOutlet}&reviewStatus=${reviewStatus}&flagReason=leave_approved`,
      );
      expect(ids(filtered.items).sort(), reviewStatus).toEqual(
        [...seeded[reviewStatus].leave].sort(),
      );
      for (const item of filtered.items) {
        expect(item.flagReasons).toContain("leave_approved");
        expect(item.reviewStatus).toBe(reviewStatus);
      }

      const unfiltered = await readAll(
        hr,
        `outletId=${branchOutlet}&reviewStatus=${reviewStatus}`,
      );
      expect(
        ids(unfiltered.items).sort(),
        `${reviewStatus} unfiltered`,
      ).toEqual(
        [...seeded[reviewStatus].leave, ...seeded[reviewStatus].other].sort(),
      );
    }
  });

  it("[3jem1] returns an empty list (no error) when no log carries the reason", async () => {
    const emptyOutlet = await seedOutlet("tanpa cuti");
    const employeeId = await seedEmployee(emptyOutlet);
    await seedLogs({
      outletId: emptyOutlet,
      employeeId,
      count: 3,
      flagReasons: ["outside_geofence"],
      reviewStatus: "pending",
      minutesAgo: 100,
      reviewerId: hrUserId,
    });
    const result = await page(
      hr,
      `outletId=${emptyOutlet}&reviewStatus=pending&flagReason=leave_approved`,
    );
    expect(result.status).toBe(200);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("[3jem1] an outlet outside the caller's reach is still refused with the filter", async () => {
    // Own outlet first, so the refusal below is scope, not a broken setup.
    const own = await page(
      outletManager,
      `outletId=${outletId}&reviewStatus=pending&flagReason=leave_approved`,
    );
    expect(own.status).toBe(200);
    expect(ids(own.items).sort()).toEqual([...leavePending].sort());

    const foreign = await page(
      outletManager,
      `outletId=${outsiderOutletId}&reviewStatus=pending&flagReason=leave_approved`,
    );
    expect([403, 404]).toContain(foreign.status);
    expect(foreign.items).toEqual([]);
  });

  it("[3jem1] rejects a flagReason that is not a known reason", async () => {
    const response = await hr.get(
      `/api/hris/attendance/review-queue?outletId=${outletId}&flagReason=not_a_reason`,
    );
    expect([400, 422]).toContain(response.status);
  });
});
