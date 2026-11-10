// Cloud applier for edge `attendance.logged` v2 (bead legend-0wvoz, C6; design
// docs/design/hris-edge-replication.md 6.2, 6.3 and section 9 "T6 receive").
// Real PostgreSQL (RLS on); events go through the registered applier exactly as
// the cloud link dispatches them (the fixture's `applyEvent`).
//
// Assumptions (the design leaves them open):
// - A v2 payload travels in the same envelope (version 1, schema ref
//   `attendance.logged.v1`); only the payload gained optional fields.
// - "Not onboarding/active at occurredAt" is decided from the employee's
//   current `status` (suspended, resigned, terminated), since the employee
//   table keeps no status history.
// - `selfieObjectId: null` means no selfie: the log keeps photo_key NULL and
//   nothing is flagged for it.
// - A refused event (rejected validity, manual_correction) throws and writes
//   no log; the link would record it as an `applier_refused` conflict.
// - Lateness and overtime are computed by the cloud from its own published
//   shift for the employee (TBD-verify of design 6.2): late 25 minutes when the
//   clock is 25 minutes after the shift start (1 minute of tolerance for
//   rounding), overtime 90 minutes when the clock-out is 90 minutes after end.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createEdgeSelfieFixture,
  type EdgeSelfieFixture,
  type EventOverrides,
} from "./helpers/edge-selfie-fixture.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WIB_OFFSET = 7 * HOUR;
const wibDate = (ms: number) =>
  new Date(ms + WIB_OFFSET).toISOString().slice(0, 10);
const sorted = (values: string[]) => [...values].sort();

let fx: EdgeSelfieFixture;

beforeAll(async () => {
  fx = await createEdgeSelfieFixture();
}, 60_000);

beforeEach(async () => {
  await fx.asTenant((client) =>
    client.query("DELETE FROM attendance_logs WHERE tenant_id = $1", [
      fx.tenantId,
    ]),
  );
});

afterAll(async () => {
  await fx.cleanup();
}, 60_000);

/** A cloud selfie object as the receive endpoint leaves it (no source yet). */
async function seedSelfieObject(
  objectId: string,
  options: {
    outletId?: string;
    ownerUserId?: string;
    sourceKind?: string;
    sourceId?: string;
  } = {},
) {
  await fx.asTenant((client) =>
    client.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          thumbnail_key, owner_user_id, source_kind, source_id)
       VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 2048, $5, $6, $7, $8)`,
      [
        fx.tenantId,
        options.outletId ?? fx.outletA,
        objectId,
        `${objectId}/original.webp`,
        `${objectId}/thumbnail.webp`,
        options.ownerUserId ?? fx.employee.userId,
        options.sourceKind ?? null,
        options.sourceId ?? null,
      ],
    ),
  );
}

async function apply(overrides: EventOverrides = {}) {
  const built = fx.attendanceEvent(overrides);
  await fx.applyEvent(built.event);
  const log = await fx.logByClientEvent(built.attendanceLogId);
  return { ...built, log };
}

describe("legend-0wvoz applier v2 fields (6.2)", () => {
  it("stores photo_key = selfieObjectId, an outlet_device log, flags offline_unverified plus the edge's reasons, review pending", async () => {
    const objectId = randomUUID();
    const clockedAt = new Date(Date.now() - 20 * MINUTE);
    const { log } = await apply({
      method: "outlet_device",
      selfieObjectId: objectId,
      edgeFlagReasons: ["edge_roster_stale"],
      edgeDeviceId: "device-kasir-1",
      clockedAt,
    });
    expect(log).toBeDefined();
    expect(log!.method).toBe("outlet_device");
    expect(log!.offline).toBe(true);
    expect(log!.outlet_id).toBe(fx.outletA);
    expect(log!.employee_id).toBe(fx.employee.id);
    // The edge's clock time is kept.
    expect(log!.occurred_at.toISOString()).toBe(clockedAt.toISOString());
    expect(log!.photo_key).toBe(objectId);
    expect(sorted(log!.flag_reasons)).toEqual(
      sorted(["edge_roster_stale", "offline_unverified"]),
    );
    expect(log!.validity).toBe("flagged");
    expect(log!.review_status).toBe("pending");
  });

  it("the flag reasons are a union: a reason the edge also sent is stored once", async () => {
    const { log } = await apply({
      selfieObjectId: randomUUID(),
      edgeFlagReasons: ["offline_unverified", "edge_roster_stale"],
    });
    expect(sorted(log!.flag_reasons)).toEqual(
      sorted(["edge_roster_stale", "offline_unverified"]),
    );
  });

  it("selfieObjectId null stores photo_key NULL and no selfie flag", async () => {
    const { log } = await apply({ selfieObjectId: null, edgeDeviceId: null });
    expect(log).toBeDefined();
    expect(log!.photo_key).toBeNull();
    expect(log!.flag_reasons).not.toContain("selfie_unlinked");
  });

  it("v1 payload (no new fields) is still applied exactly as before", async () => {
    const clockedAt = new Date(Date.now() - 10 * MINUTE);
    const { event, log } = await apply({ method: "selfie_geo", clockedAt });
    expect(Object.keys(event.payload as object)).not.toContain(
      "selfieObjectId",
    );
    expect(Object.keys(event.payload as object)).not.toContain(
      "edgeFlagReasons",
    );
    expect(log).toBeDefined();
    expect(log!.method).toBe("selfie_geo");
    expect(log!.offline).toBe(true);
    expect(log!.photo_key).toBeNull();
    expect(log!.occurred_at.toISOString()).toBe(clockedAt.toISOString());
    expect(log!.flag_reasons).toEqual(["offline_unverified"]);
    expect(log!.validity).toBe("flagged");
    expect(log!.review_status).toBe("pending");
  });

  it("still rejects a rejected-validity event and a manual_correction event, v2 fields or not, and stores nothing", async () => {
    for (const overrides of [
      { validity: "rejected" as const },
      { method: "manual_correction" as const },
      { validity: "rejected" as const, selfieObjectId: randomUUID() },
      { method: "manual_correction" as const, selfieObjectId: randomUUID() },
    ]) {
      const built = fx.attendanceEvent(overrides);
      await expect(fx.applyEvent(built.event)).rejects.toBeTruthy();
      expect(await fx.logByClientEvent(built.attendanceLogId)).toBeUndefined();
    }
    expect(await fx.logCount()).toBe(0);
  });
});

describe("legend-0wvoz inactive employee is flagged, not rejected (Q81)", () => {
  for (const status of ["suspended", "resigned", "terminated"] as const) {
    it(`an employee who is ${status} gets the flag employee_inactive and the log is kept`, async () => {
      const inactive = await fx.createEmployee(status);
      const { log } = await apply({
        employeeId: inactive.id,
        selfieObjectId: randomUUID(),
      });
      expect(log).toBeDefined();
      expect(log!.employee_id).toBe(inactive.id);
      expect(log!.flag_reasons).toEqual(
        expect.arrayContaining(["employee_inactive", "offline_unverified"]),
      );
      expect(log!.validity).toBe("flagged");
      expect(log!.review_status).toBe("pending");
    });
  }

  it("an onboarding employee and an active employee are not flagged employee_inactive", async () => {
    const onboarding = await fx.createEmployee("onboarding");
    const first = await apply({ employeeId: onboarding.id });
    const second = await apply({});
    expect(first.log!.flag_reasons).not.toContain("employee_inactive");
    expect(second.log!.flag_reasons).not.toContain("employee_inactive");
  });

  it("an employee that does not belong to the tenant is still refused", async () => {
    const built = fx.attendanceEvent({ employeeId: randomUUID() });
    await expect(fx.applyEvent(built.event)).rejects.toBeTruthy();
    expect(await fx.logCount()).toBe(0);
  });
});

describe("legend-0wvoz replay and linking inside the applier (6.3)", () => {
  it("a replayed event is a no-op: one log, same flags, same link", async () => {
    const objectId = randomUUID();
    await seedSelfieObject(objectId);
    const first = await apply({ selfieObjectId: objectId });
    const logBefore = first.log!;
    const objectBefore = await fx.objectRow(objectId);

    await fx.applyEvent(first.event);
    // The edge retried the emit: a new envelope for the very same edge log.
    const again = fx.attendanceEvent({
      attendanceLogId: first.attendanceLogId,
      selfieObjectId: objectId,
      clockedAt: new Date(logBefore.occurred_at),
    });
    await fx.applyEvent(again.event);

    expect(await fx.logCount()).toBe(1);
    expect(await fx.logByClientEvent(first.attendanceLogId)).toEqual(logBefore);
    expect(await fx.objectRow(objectId)).toEqual(objectBefore);
  });

  it("a selfie already in the cloud is linked to the new log, with no unlinked flag", async () => {
    const objectId = randomUUID();
    await seedSelfieObject(objectId);
    const { log } = await apply({ selfieObjectId: objectId });
    expect(log!.photo_key).toBe(objectId);
    expect(log!.flag_reasons).not.toContain("selfie_unlinked");
    expect(await fx.objectRow(objectId)).toMatchObject({
      source_kind: "attendance",
      source_id: log!.id,
    });
  });

  it("a selfie that is still on its way leaves the log waiting with photo_key set and no unlinked flag", async () => {
    const objectId = randomUUID();
    const { log } = await apply({ selfieObjectId: objectId });
    expect(log!.photo_key).toBe(objectId);
    expect(log!.flag_reasons).not.toContain("selfie_unlinked");
    expect(await fx.objectRow(objectId)).toBeUndefined();
  });

  it("owner is not the log's employee: photo_key NULL, selfie_unlinked, review pending, log kept", async () => {
    const objectId = randomUUID();
    await seedSelfieObject(objectId, { ownerUserId: fx.otherEmployee.userId });
    const { log } = await apply({ selfieObjectId: objectId });
    expect(log).toBeDefined();
    expect(log!.photo_key).toBeNull();
    expect(log!.flag_reasons).toEqual(
      expect.arrayContaining(["offline_unverified", "selfie_unlinked"]),
    );
    expect(log!.review_status).toBe("pending");
    expect((await fx.objectRow(objectId))!.source_id).toBeNull();
  });

  it("selfie of another outlet than the log's: photo_key NULL, selfie_unlinked, log kept", async () => {
    const objectId = randomUUID();
    await seedSelfieObject(objectId, { outletId: fx.outletB });
    const { log } = await apply({ selfieObjectId: objectId });
    expect(log).toBeDefined();
    expect(log!.photo_key).toBeNull();
    expect(log!.flag_reasons).toContain("selfie_unlinked");
    expect(log!.review_status).toBe("pending");
  });

  it("selfie already linked to another record: photo_key NULL, selfie_unlinked, the other link untouched", async () => {
    const objectId = randomUUID();
    const elsewhere = randomUUID();
    await seedSelfieObject(objectId, {
      sourceKind: "attendance",
      sourceId: elsewhere,
    });
    const { log } = await apply({ selfieObjectId: objectId });
    expect(log).toBeDefined();
    expect(log!.photo_key).toBeNull();
    expect(log!.flag_reasons).toContain("selfie_unlinked");
    expect(await fx.objectRow(objectId)).toMatchObject({
      source_kind: "attendance",
      source_id: elsewhere,
    });
  });
});

describe("legend-0wvoz lateness and overtime come from the cloud's own shift (TBD-verify 6.2)", () => {
  async function seedShift(
    employeeId: string,
    startMs: number,
    endMs: number,
  ): Promise<string> {
    const id = randomUUID();
    await fx.asTenant((client) =>
      client.query(
        `INSERT INTO shift_assignments
           (id, tenant_id, outlet_id, employee_id, business_date, segments, break_minutes,
            status, source, published_by, published_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 0, 'published', 'user', $7, now(), $7)`,
        [
          id,
          fx.tenantId,
          fx.outletA,
          employeeId,
          wibDate(startMs),
          JSON.stringify([
            {
              startsAt: new Date(startMs).toISOString(),
              endsAt: new Date(endMs).toISOString(),
            },
          ]),
          fx.employee.userId,
        ],
      ),
    );
    return id;
  }

  it("a clock-in 25 minutes after the cloud shift start records the lateness and the shift, though the payload carries neither", async () => {
    const staff = await fx.createEmployee("active");
    const start = Math.floor((Date.now() - 6 * HOUR) / MINUTE) * MINUTE;
    const shiftId = await seedShift(staff.id, start, start + 8 * HOUR);
    const built = fx.attendanceEvent({
      employeeId: staff.id,
      type: "in",
      clockedAt: new Date(start + 25 * MINUTE),
      selfieObjectId: randomUUID(),
    });
    expect(Object.keys(built.event.payload as object)).not.toContain(
      "lateMinutes",
    );
    await fx.applyEvent(built.event);
    const log = (await fx.logByClientEvent(built.attendanceLogId))!;
    expect(log.shift_assignment_id).toBe(shiftId);
    expect(log.late_minutes).toBeGreaterThanOrEqual(25);
    expect(log.late_minutes).toBeLessThanOrEqual(26);
  });

  it("a clock-out 90 minutes after the cloud shift end records the overtime", async () => {
    const staff = await fx.createEmployee("active");
    const end = Math.floor((Date.now() - 3 * HOUR) / MINUTE) * MINUTE;
    await seedShift(staff.id, end - 8 * HOUR, end);
    const built = fx.attendanceEvent({
      employeeId: staff.id,
      type: "out",
      clockedAt: new Date(end + 90 * MINUTE),
      selfieObjectId: randomUUID(),
    });
    await fx.applyEvent(built.event);
    const log = (await fx.logByClientEvent(built.attendanceLogId))!;
    expect(log.overtime_minutes).toBeGreaterThanOrEqual(90);
    expect(log.overtime_minutes).toBeLessThanOrEqual(91);
  });
});
