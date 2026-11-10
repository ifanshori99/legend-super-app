// Selfie signer guard in presentLog (bead legend-0wvoz, C6). An edge
// `attendance.logged` can name any selfie object id as the log's photo_key, and
// the cloud applier cannot see an object of another outlet. The log list must
// not sign an object that is linked to another log, or that is unlinked at
// another outlet than the log's. Real PostgreSQL (RLS on), a recording fake
// signer, logs listed through listAttendanceLogs as the employee who owns them.
//
// Assumptions:
// - A foreign object is simulated by naming a not-yet-uploaded object id in the
//   edge event (the log keeps photo_key, link result "waiting"), then creating
//   the object afterwards with the wanted outlet and source link. A direct link
//   attempt on such an object would be refused and clear photo_key, which is a
//   different path.
// - "Missing object" means no core_storage_objects row for the id: the signer is
//   still called (the selfie may still arrive) and its answer is passed on.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { listAttendanceLogs } from "../services/hris-attendance.service.ts";
import type { HrisFileSigner } from "../services/hris-contract.service.ts";
import {
  createEdgeSelfieFixture,
  type EdgeSelfieFixture,
} from "./helpers/edge-selfie-fixture.ts";

let fx: EdgeSelfieFixture;
let roleId: string;

const signedUrlFor = (objectId: string) =>
  `https://signed.example.test/selfie/${objectId}?sig=fake`;

beforeAll(async () => {
  fx = await createEdgeSelfieFixture();
  // The employee may read their own logs: self profile + clock, at outlets A and
  // B. The caller's scope spans both outlets on purpose: under a scope of outlet A
  // alone, forced RLS hides an outlet B object from the guard's lookup, so the
  // guard would see "missing" and the other-outlet case could not be exercised.
  roleId = randomUUID();
  await fx.asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, 'Selfie guard staff', false, $3, $4)`,
      [
        roleId,
        fx.tenantId,
        JSON.stringify(["self.profile.view", "self.attendance.clock"]),
        JSON.stringify(["outlet"]),
      ],
    );
    for (const outletId of [fx.outletA, fx.outletB])
      await client.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
        [fx.tenantId, fx.employee.userId, roleId, outletId],
      );
  });
});

afterAll(async () => {
  if (!fx) return;
  await fx.asTenant(async (client) => {
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND role_id = $2",
      [fx.tenantId, roleId],
    );
    await client.query("DELETE FROM roles WHERE tenant_id = $1 AND id = $2", [
      fx.tenantId,
      roleId,
    ]);
  });
  await fx.cleanup();
});

async function insertObject(
  objectId: string,
  options: { outletId: string; sourceId?: string },
) {
  await fx.asTenant((client) =>
    client.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          thumbnail_key, owner_user_id, source_kind, source_id)
       VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 2048, $5, $6, $7, $8)`,
      [
        fx.tenantId,
        options.outletId,
        objectId,
        `${objectId}/original.webp`,
        `${objectId}/thumbnail.webp`,
        fx.employee.userId,
        options.sourceId === undefined ? null : "attendance",
        options.sourceId ?? null,
      ],
    ),
  );
}

/** An outlet A log whose photo_key names `objectId`; the object does not exist yet. */
async function logNamingObject(objectId: string) {
  const { event, attendanceLogId } = fx.attendanceEvent({
    selfieObjectId: objectId,
  });
  await fx.applyEvent(event);
  const log = await fx.logByClientEvent(attendanceLogId);
  expect(log?.photo_key).toBe(objectId);
  return log!;
}

/** Lists the employee's outlet A logs and returns the DTO for `logId` (DB uuid; the DTO id is the ULID form). */
async function listedLog(logId: string, signer: HrisFileSigner) {
  const page = await listAttendanceLogs(
    fx.scopeOf([fx.outletA, fx.outletB]),
    fx.employee.userId,
    {
      limit: 50,
      employeeId: fx.employee.id,
      outletId: fx.outletA,
    } as Parameters<typeof listAttendanceLogs>[2],
    new Date(),
    signer,
  );
  const dto = page.data.find((entry) => ulidToUuid(entry.id) === logId);
  expect(dto, "the employee sees their own log").toBeDefined();
  return dto!;
}

// The list signs every visible log of the employee, earlier tests' logs too, so
// each test counts only the signer calls made for its own object id.
const callsFor = (signer: ReturnType<typeof recordingSigner>, id: string) =>
  signer.mock.calls.filter((call) => call[1] === id).length;

const recordingSigner = () =>
  vi.fn<HrisFileSigner>(async (_context, objectId) => signedUrlFor(objectId));

describe("edge selfie signer guard (legend-0wvoz)", () => {
  it("signs an object linked to the log itself", async () => {
    const objectId = randomUUID();
    const log = await logNamingObject(objectId);
    await insertObject(objectId, {
      outletId: fx.outletA,
      sourceId: log.id,
    });
    const signer = recordingSigner();

    const dto = await listedLog(log.id, signer);

    expect(callsFor(signer, objectId)).toBe(1);
    expect(dto.photoUrl).toBe(signedUrlFor(objectId));
  });

  it("does not sign an object linked to another log", async () => {
    const objectId = randomUUID();
    const log = await logNamingObject(objectId);
    // Linked to some other attendance log id, at the same outlet.
    await insertObject(objectId, {
      outletId: fx.outletA,
      sourceId: randomUUID(),
    });
    const signer = recordingSigner();

    const dto = await listedLog(log.id, signer);

    expect(callsFor(signer, objectId)).toBe(0);
    expect(dto.photoUrl).toBeNull();
  });

  it("does not sign an unlinked object of another outlet", async () => {
    const objectId = randomUUID();
    const log = await logNamingObject(objectId);
    await insertObject(objectId, { outletId: fx.outletB });
    const signer = recordingSigner();

    const dto = await listedLog(log.id, signer);

    expect(callsFor(signer, objectId)).toBe(0);
    expect(dto.photoUrl).toBeNull();
  });

  it("signs an unlinked object of the log's own outlet", async () => {
    const objectId = randomUUID();
    const log = await logNamingObject(objectId);
    await insertObject(objectId, { outletId: fx.outletA });
    const signer = recordingSigner();

    const dto = await listedLog(log.id, signer);

    expect(callsFor(signer, objectId)).toBe(1);
    expect(dto.photoUrl).toBe(signedUrlFor(objectId));
  });

  it("still calls the signer when the object has not arrived yet", async () => {
    const objectId = randomUUID();
    const log = await logNamingObject(objectId);
    const signer = recordingSigner();

    const dto = await listedLog(log.id, signer);

    expect(callsFor(signer, objectId)).toBe(1);
    expect(dto.photoUrl).toBe(signedUrlFor(objectId));
  });

  it("passes on a null answer from the signer for a missing object", async () => {
    const objectId = randomUUID();
    const log = await logNamingObject(objectId);
    const signer = vi.fn<HrisFileSigner>(async () => null);

    const dto = await listedLog(log.id, signer);

    expect(callsFor(signer, objectId)).toBe(1);
    expect(dto.photoUrl).toBeNull();
  });
});
