// TL-16 draft_shift_schedule executor: rollback scope on a mid-run failure
// (bead legend-39d.3 follow-up). Fail-first for this rule: when the executor
// fails part-way, its compensation may cancel ONLY the draft shifts that THIS
// attempt created. It must never cancel a shift that an earlier attempt of the
// same request already created and the executor merely reused (idempotent
// replay), nor one a manager has since published.
//
// Real PostgreSQL. The executor is called directly (same pattern as
// ai-promotion-idempotency.test.ts) with the requester's access; replays reuse
// the same action request row id, which is what makes the executor's writes
// idempotent. Written from the rule above and the shared HRIS contract, not
// from the executor.
//
// How the failure is forced: vi.spyOn on the roster service's
// `createShiftAssignment` (the module service the executor calls to create each
// shift). The spy delegates to the real function, except for the call that
// mentions the THIRD employee's id, which rejects. Each shift uses a different
// employee, so exactly shift 3 fails, after shifts 1 and 2 were handled.
//
// Assumptions (the spec leaves these open):
// - A first "attempt" is simulated by running the executor with the same row id
//   and a payload holding only the first N shifts; its keys for those shifts
//   equal those of the full payload, so the full run reuses them.
// - A rolled-back shift ends with status "cancelled" (cancelShiftAssignment),
//   not a deleted row.
// - Publishing the week publishes every draft of that outlet/week, so in
//   scenario (a) shift 2 is published too; the rule under test is only that
//   neither is cancelled.
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "../services/permission-resolver.ts";
import { logger } from "../lib/logger.ts";
import * as roster from "../services/hris-scheduling-roster.service.ts";
import { executeShiftSchedule } from "../services/ai-action-executors/shift-schedule.ts";
import type { ActionRequestRow } from "../services/ai-action-executors/types.ts";
import {
  cleanupAcceptance,
  grantTemplateRole,
  originHeader,
  outletA,
  ownerPool,
  signedIn,
  tenantId,
  type Actor,
} from "./ai-acceptance-helpers.ts";

const tenant = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const workerContext = establishScopedTenantContext(tenant, { kind: "tenant" });

afterEach(() => vi.restoreAllMocks());

// ---- fixtures ---------------------------------------------------------------

let hr: Actor;
let manager: Actor;

beforeAll(async () => {
  hr = await signedIn("HR Rollback W16");
  await grantTemplateRole(hr.userId, "hr", { type: "tenant" });
  manager = await signedIn("Manajer Rollback W16");
  await grantTemplateRole(manager.userId, "outlet_manager", {
    type: "outlet",
    id: outletA,
  });
  // Unique names: the shift template name is unique per outlet.
  const suffix = randomUUID().slice(0, 8);
  for (const [name, startTime, endTime] of [
    [`W16R Pagi ${suffix}`, "07:00", "15:00"],
    [`W16R Sore ${suffix}`, "15:00", "23:00"],
  ] as const) {
    const res = await hr.client
      .post("/api/hris/shift-templates")
      .set(originHeader)
      .send({
        outletId: outletA,
        name,
        segments: [{ startTime, endTime }],
        breakMinutes: 60,
        stationId: null,
        positionId: null,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
}, 120_000);

afterAll(async () => {
  await cleanupAcceptance().catch(() => undefined);
  await ownerPool.end();
});

async function seedEmployees(count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    for (const id of ids)
      await client.query(
        `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                                employment_type, join_date, status)
         VALUES ($1, $2, NULL, $3, 'Karyawan Rollback W16', $4, 'pkwtt', '2025-03-01', 'active')`,
        [id, tenantId, `W16R-${id.slice(0, 8).toUpperCase()}`, outletA],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return ids;
}

/** First Monday of a far-future year, one year per call so weeks never collide. */
let yearCounter = 0;
function freshWeek(): { weekStart: string; day: (offset: number) => string } {
  yearCounter += 1;
  const date = new Date(Date.UTC(2090 + yearCounter, 0, 1));
  while (date.getUTCDay() !== 1) date.setUTCDate(date.getUTCDate() + 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    weekStart: iso(date),
    day: (offset) => iso(new Date(date.getTime() + offset * 86_400_000)),
  };
}

type Week = ReturnType<typeof freshWeek>;

/** The first `count` of three shifts, one distinct employee each. */
function payloadOf(employees: string[], week: Week, count: number) {
  const all = [
    {
      employeeId: employees[0]!,
      date: week.day(0),
      startTime: "07:00",
      endTime: "15:00",
    },
    {
      employeeId: employees[1]!,
      date: week.day(1),
      startTime: "15:00",
      endTime: "23:00",
    },
    {
      employeeId: employees[2]!,
      date: week.day(2),
      startTime: "07:00",
      endTime: "15:00",
    },
  ];
  return {
    outletId: outletA,
    weekStart: week.weekStart,
    shifts: all.slice(0, count),
  };
}

const rowOf = (id: string, payload: unknown): ActionRequestRow =>
  ({
    id,
    tenantId,
    requestedByUserId: hr.userId,
    toolCode: "TL-16",
    payload,
  }) as unknown as ActionRequestRow;

async function run(id: string, payload: unknown) {
  const data = await loadTenantAccess(workerContext, hr.userId);
  const access = resolveAccessSnapshot({
    tenant,
    userId: hr.userId,
    ...data,
    mfaVerified: true,
    now: new Date(),
  });
  return executeShiftSchedule({
    tx: undefined as never,
    context: workerContext,
    access,
    row: rowOf(id, payload),
    now: new Date(),
  });
}

/** Status per employee (each employee holds one shift in these tests). */
async function statusByEmployee(
  employees: string[],
): Promise<Record<string, string[]>> {
  const { rows } = await ownerPool.query<{
    employee_id: string;
    status: string;
  }>(
    `SELECT employee_id, status FROM shift_assignments
      WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])`,
    [tenantId, employees],
  );
  const out: Record<string, string[]> = {};
  for (const id of employees) out[id] = [];
  for (const row of rows) out[row.employee_id]!.push(row.status);
  return out;
}

function mentions(value: unknown, needle: string, depth = 0): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (depth > 4 || value === null || typeof value !== "object") return false;
  return Object.values(value).some((entry) =>
    mentions(entry, needle, depth + 1),
  );
}

/** Real createShiftAssignment, except the call for `failEmployeeId` rejects. */
function failShiftOf(failEmployeeId: string) {
  const original = roster.createShiftAssignment;
  const hits = { forced: 0 };
  vi.spyOn(roster, "createShiftAssignment").mockImplementation(((
    ...args: Parameters<typeof original>
  ) => {
    if (mentions(args, failEmployeeId)) {
      hits.forced += 1;
      return Promise.reject(new Error("forced failure at shift 3"));
    }
    return original(...args);
  }) as typeof original);
  return hits;
}

/**
 * Forces the check-then-act race deterministically. Every roster-service export
 * whose name matches /cancel/i is wrapped (found at runtime from the module
 * namespace, so this does not depend on how the executor is structured
 * internally). The FIRST call into any of them first lets a manager publish the
 * week over real HTTP, then delegates to the real function. So the publish lands
 * after the executor decided the shifts are its drafts to cancel, and right
 * before the cancel statement runs. `hits.cancelCalls` proves the window opened.
 */
function publishRightBeforeCancel(week: Week) {
  const hits = { cancelCalls: 0, publishStatus: 0 };
  const namespace = roster as unknown as Record<string, unknown>;
  for (const name of Object.keys(namespace)) {
    const original = namespace[name];
    if (!/cancel/i.test(name) || typeof original !== "function") continue;
    vi.spyOn(
      namespace as Record<string, (...args: unknown[]) => unknown>,
      name,
    ).mockImplementation(async (...args: unknown[]) => {
      hits.cancelCalls += 1;
      if (hits.cancelCalls === 1) {
        const res = await manager.client
          .post("/api/hris/rosters/publish")
          .set(originHeader)
          .send({
            outletId: outletA,
            weekStart: week.weekStart,
            idempotencyKey: `w16r-race-${randomUUID()}`,
          });
        hits.publishStatus = res.status;
      }
      return (original as (...a: unknown[]) => unknown)(...args);
    });
  }
  return hits;
}

// ---- TL-16 rollback scope ---------------------------------------------------

describe("TL-16 draft_shift_schedule: rollback cancels only this attempt's drafts", () => {
  it("(c) shifts newly created by the failing attempt are cancelled", async () => {
    const employees = await seedEmployees(3);
    const week = freshWeek();
    const requestId = randomUUID();
    const hits = failShiftOf(employees[2]!);

    await expect(
      run(requestId, payloadOf(employees, week, 3)),
    ).rejects.toThrow();

    expect(hits.forced).toBeGreaterThan(0);
    const status = await statusByEmployee(employees);
    // Shifts 1 and 2 were created by this attempt: rolled back.
    for (const id of [employees[0]!, employees[1]!])
      expect(status[id]!.filter((s) => s !== "cancelled")).toEqual([]);
    // Shift 3 never got created.
    expect(status[employees[2]!]).toEqual([]);
  }, 90_000);

  it("(d) race: a shift created by the failing attempt is published by a manager just before the rollback cancels it, and stays published", async () => {
    // Assumption: a manager publishing a draft in that gap wins; the rollback
    // must not cancel a shift that is no longer a draft (a published shift is
    // visible to staff).
    const employees = await seedEmployees(3);
    const week = freshWeek();
    const requestId = randomUUID();
    const failed = failShiftOf(employees[2]!);
    const race = publishRightBeforeCancel(week);

    await expect(
      run(requestId, payloadOf(employees, week, 3)),
    ).rejects.toThrow();

    expect(failed.forced).toBeGreaterThan(0);
    // The window really opened: a cancel was attempted and the publish ran.
    expect(race.cancelCalls).toBeGreaterThan(0);
    expect(race.publishStatus).toBeLessThan(300);
    expect(race.publishStatus).toBeGreaterThan(0);

    const status = await statusByEmployee(employees);
    expect(status[employees[0]!]).toEqual(["published"]);
    expect(status[employees[1]!]).toEqual(["published"]);
    expect(status[employees[2]!]).toEqual([]);
  }, 90_000);

  it("(b) a shift that existed before the attempt (reused via idempotency) survives a later failure", async () => {
    const employees = await seedEmployees(3);
    const week = freshWeek();
    const requestId = randomUUID();

    // Earlier attempt: only shift 1 exists afterwards, as a draft.
    const first = await run(requestId, payloadOf(employees, week, 1));
    expect(first.resultRef).toBeTruthy();
    expect(await statusByEmployee(employees)).toMatchObject({
      [employees[0]!]: ["draft"],
    });

    // Replay of the same request fails at shift 3.
    const hits = failShiftOf(employees[2]!);
    await expect(
      run(requestId, payloadOf(employees, week, 3)),
    ).rejects.toThrow();
    expect(hits.forced).toBeGreaterThan(0);

    const status = await statusByEmployee(employees);
    // Reused shift 1 stays a draft: it is not this attempt's to cancel.
    expect(status[employees[0]!]).toEqual(["draft"]);
    // Shift 2 was created by the failing attempt: rolled back.
    expect(status[employees[1]!]!.filter((s) => s !== "cancelled")).toEqual([]);
    expect(status[employees[2]!]).toEqual([]);
  }, 90_000);

  it("(a) shifts from an earlier attempt, one since published by a manager, stay when the replay fails at shift 3", async () => {
    const employees = await seedEmployees(3);
    const week = freshWeek();
    const requestId = randomUUID();

    // Attempt 1 created shift 1 and shift 2.
    await run(requestId, payloadOf(employees, week, 2));
    expect(await statusByEmployee(employees)).toMatchObject({
      [employees[0]!]: ["draft"],
      [employees[1]!]: ["draft"],
    });

    // A manager publishes the week before the replay.
    const published = await manager.client
      .post("/api/hris/rosters/publish")
      .set(originHeader)
      .send({
        outletId: outletA,
        weekStart: week.weekStart,
        idempotencyKey: `w16r-publish-${randomUUID()}`,
      });
    expect(published.status, JSON.stringify(published.body)).toBeLessThan(300);
    const before = await statusByEmployee(employees);
    expect(before[employees[0]!]).toEqual(["published"]);

    // Attempt 2 (replay) fails at shift 3.
    const hits = failShiftOf(employees[2]!);
    await expect(
      run(requestId, payloadOf(employees, week, 3)),
    ).rejects.toThrow();
    expect(hits.forced).toBeGreaterThan(0);

    const after = await statusByEmployee(employees);
    // Published shift 1 and reused shift 2 are untouched.
    expect(after[employees[0]!]).toEqual(["published"]);
    expect(after[employees[1]!]).toEqual(before[employees[1]!]);
    expect(after[employees[1]!]).not.toContain("cancelled");
    expect(after[employees[2]!]).toEqual([]);
  }, 90_000);
});

// ---- Kartu C legend-4cjn6 point 5: a failing rollback is logged, not swallowed
//
// When shift 3 fails AND the compensation (cancel of shifts 1 and 2) fails too,
// the executor must (a) log the rollback error, (b) keep the log free of
// personal data and (c) tell the approver in the failure message that part of
// the schedule may already be live.
//
// ASSUMPTIONS:
//  - The executor logs through the shared `logger` singleton (lib/logger.ts) at
//    error or warn level; both are spied.
//  - "Personal data" = the employee's full name and the shift times/dates of
//    the payload; ids are not personal.
//  - The failure message is Indonesian, like the other executor failures, and
//    contains "sebagian" plus one of live/tayang/terbit/publish.
//  - Any roster-service export whose name matches /cancel/i is the rollback
//    path (same seam as the race test above); all of them are made to reject.
describe("TL-16 draft_shift_schedule: a failing rollback is logged and reported (legend-4cjn6)", () => {
  function failAllCancels() {
    const hits = { cancelCalls: 0 };
    const namespace = roster as unknown as Record<string, unknown>;
    for (const name of Object.keys(namespace)) {
      if (!/cancel/i.test(name) || typeof namespace[name] !== "function")
        continue;
      vi.spyOn(
        namespace as Record<string, (...args: unknown[]) => unknown>,
        name,
      ).mockImplementation(async () => {
        hits.cancelCalls += 1;
        throw new Error("forced rollback failure");
      });
    }
    return hits;
  }

  it("the rollback error is logged without personal data and the failure says part of the schedule may be live", async () => {
    const employees = await seedEmployees(3);
    const week = freshWeek();
    const errorLog = vi.spyOn(logger, "error");
    const warnLog = vi.spyOn(logger, "warn");
    const failed = failShiftOf(employees[2]!);
    const cancels = failAllCancels();

    const error = await run(randomUUID(), payloadOf(employees, week, 3)).then(
      () => null,
      (e: unknown) => e,
    );

    // Setup proof: shift 3 failed and the rollback was attempted and failed.
    expect(failed.forced).toBeGreaterThan(0);
    expect(cancels.cancelCalls).toBeGreaterThan(0);
    // (c) the failure message
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/sebagian/i);
    expect(message).toMatch(/live|tayang|terbit|publish/i);
    // (a) the rollback error is logged
    const logged = [...errorLog.mock.calls, ...warnLog.mock.calls];
    expect(logged.length).toBeGreaterThan(0);
    // JSON.stringify drops an Error's message: expand Errors first.
    const dump = JSON.stringify(logged, (_key, value: unknown) =>
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value,
    );
    expect(dump).toMatch(/forced rollback failure/);
    // (b) no personal data in what was logged
    expect(dump).not.toContain("Karyawan Rollback W16");
    expect(dump).not.toContain("07:00");
    expect(dump).not.toContain("15:00");
    expect(dump).not.toContain(week.day(0));
  }, 90_000);

  it("a successful rollback does not claim part of the schedule is live", async () => {
    const employees = await seedEmployees(3);
    const week = freshWeek();
    failShiftOf(employees[2]!);
    const error = await run(randomUUID(), payloadOf(employees, week, 3)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/sebagian/i);
    const status = await statusByEmployee(employees);
    for (const id of [employees[0]!, employees[1]!])
      expect(status[id]!.filter((s) => s !== "cancelled")).toEqual([]);
  }, 90_000);
});
