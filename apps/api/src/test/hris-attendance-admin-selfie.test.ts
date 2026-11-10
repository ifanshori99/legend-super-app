// Finding 3 of brief 414 (legend-whiwv): the admin review path must only issue
// a selfie URL when the stored photo belongs to THAT attendance log. A log whose
// photo_key points at another log's selfie, or at an object of another outlet,
// must answer photoUrl null, must never reach the signer, and must not write a
// `hris.attendance.photo_url_issued` audit event. Expected behaviour comes from
// the brief (docs/briefs/414-hris-attendance-fix.md), not from service code.
//
// Assumptions (the brief leaves these open):
//  - "Owned" means the log's selfie storage row (photo_key = core_storage_objects.id)
//    has source_id = the log id (source kind attendance), or has no source and
//    lives in the log's own outlet. Anything else is foreign.
//  - A foreign photo is refused by answering `photoUrl: null` on the review item
//    (the decision itself still succeeds); it does not throw.
//  - A photo_key with no storage row at all is not covered (brief is silent).
//  - Exercised through `decideAttendanceReview` (the same item shape the queue
//    returns) so the test does not depend on the sampling policy of the tenant.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tenantIdSchema, uuidToUlid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  decideAttendanceReview,
  type AttendancePhotoSigner,
} from "../services/hris-attendance-admin.service.ts";
import { createApp } from "../app.ts";
import { agent, signUp } from "./helpers.ts";

const tenant = cafeLegendPlatformFixtures.tenant;
const [otherOutlet, outlet] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const KEY_PREFIX = "att-admin-selfie-";
const createdEmployees: string[] = [];
const createdLogs: string[] = [];
const createdObjects: string[] = [];
let REVIEWER = "";
const createdUsers: string[] = [];
const createdRoles: string[] = [];

// The reviewer is a real user holding hr.attendance.manage tenant-wide.
beforeAll(async () => {
  const client = agent(createApp());
  await signUp(client, "Reviewer Selfie Admin");
  const session = await client.get("/api/auth/get-session");
  REVIEWER = session.body.user.id as string;
  createdUsers.push(REVIEWER);
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await ownerTx(async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, 'Selfie Admin Reviewer', false, $3, '["tenant"]')`,
      [roleId, tenant.id, JSON.stringify(["hr.attendance.manage"])],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
      [tenant.id, REVIEWER, roleId],
    );
  });
}, 60_000);

async function ownerTx<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
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

const context = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.id),
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);

async function seedEmployee(): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await ownerTx((db) =>
    db.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, NULL, $3, 'Karyawan Selfie Admin', $4, 'pkwtt', '2025-03-01', 'active')`,
      [id, tenant.id, `AS-${id.slice(0, 8).toUpperCase()}`, outlet.id],
    ),
  );
  return id;
}

/** A selfie storage row; `sourceId` null means no owner recorded. */
async function seedObject(spec: {
  outletId: string;
  sourceId: string | null;
}): Promise<string> {
  const id = randomUUID();
  createdObjects.push(id);
  await ownerTx((db) =>
    db.query(
      `INSERT INTO core_storage_objects
         (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
          source_kind, source_id)
       VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 2048, $5, $6)`,
      [
        tenant.id,
        spec.outletId,
        id,
        `${KEY_PREFIX}${id}.webp`,
        spec.sourceId ? "attendance" : null,
        spec.sourceId,
      ],
    ),
  );
  return id;
}

/** A flagged clock-in awaiting review whose photo_key is `photoKey`. */
async function seedLog(
  employeeId: string,
  photoKey: string,
  logId: string = randomUUID(),
): Promise<string> {
  createdLogs.push(logId);
  await ownerTx((db) =>
    db.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          geo_distance_m, validity, business_date, client_event_id, photo_key)
       VALUES ($1, $2, $3, $4, 'in', 'selfie_geo', now(), now(), 500, 'flagged',
               (now() AT TIME ZONE 'UTC')::date, $5, $6)`,
      [
        logId,
        tenant.id,
        outlet.id,
        employeeId,
        `${KEY_PREFIX}${randomUUID()}`,
        photoKey,
      ],
    ),
  );
  return logId;
}

const issuedAudits = async (logId: string) => {
  const { rows } = await owner.query(
    `SELECT 1 FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2
        AND event->>'action' = 'hris.attendance.photo_url_issued'`,
    [tenant.id, uuidToUlid(logId)], // audit objectId is the public ULID
  );
  return rows.length;
};

async function review(logId: string) {
  const signer = vi.fn<AttendancePhotoSigner>(
    async (_context, photoKey) => `https://files.test/${photoKey}`,
  );
  const item = await decideAttendanceReview(
    context,
    REVIEWER,
    uuidToUlid(logId), // the service takes the public ULID of the log
    { action: "accept", idempotencyKey: `${KEY_PREFIX}${randomUUID()}` },
    signer,
  );
  return { item, signer };
}

afterAll(async () => {
  try {
    await owner.query("BEGIN");
    await owner.query("SET LOCAL session_replication_role = replica");
    await owner.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    await owner.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdLogs],
    );
    await owner.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE $2",
      [tenant.id, `${KEY_PREFIX}%`],
    );
    await owner.query(
      `DELETE FROM audit_logs
        WHERE tenant_id = $1 AND (event->>'objectId' = ANY($2::text[])
           OR event->>'actorId' = $3)`,
      [tenant.id, createdLogs.map(uuidToUlid), REVIEWER],
    );
    await owner.query(
      `DELETE FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->'payload'->>'employeeId' = ANY($2::text[])`,
      [tenant.id, createdEmployees],
    );
    await owner.query(
      "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdObjects],
    );
    await owner.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await owner.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
    await owner.query("COMMIT");
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUsers,
    ]);
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await owner.end();
  }
}, 60_000);

describe("hris.attendance.review admin selfie URL ownership", () => {
  it("issues a URL (and audits it) for a photo owned by the log", async () => {
    const employeeId = await seedEmployee();
    const logId = randomUUID();
    const photoKey = await seedObject({ outletId: outlet.id, sourceId: logId });
    await seedLog(employeeId, photoKey, logId);

    const { item, signer } = await review(logId);

    expect(item.data.log.photoUrl).toBe(`https://files.test/${photoKey}`);
    expect(signer).toHaveBeenCalledTimes(1);
    expect(await issuedAudits(logId)).toBe(1);
  });

  it("refuses the URL when the photo belongs to another log", async () => {
    const employeeId = await seedEmployee();
    const victimLogId = randomUUID();
    // The selfie is recorded as owned by a different log of the same outlet.
    const victimPhoto = await seedObject({
      outletId: outlet.id,
      sourceId: victimLogId,
    });
    const logId = await seedLog(employeeId, victimPhoto);

    const { item, signer } = await review(logId);

    expect(item.data.log.photoUrl).toBeNull();
    expect(signer).not.toHaveBeenCalled();
    expect(await issuedAudits(logId)).toBe(0);
  });

  it("refuses the URL when an unowned photo lives in another outlet", async () => {
    const employeeId = await seedEmployee();
    const foreignPhoto = await seedObject({
      outletId: otherOutlet.id,
      sourceId: null,
    });
    const logId = await seedLog(employeeId, foreignPhoto);

    const { item, signer } = await review(logId);

    expect(item.data.log.photoUrl).toBeNull();
    expect(signer).not.toHaveBeenCalled();
    expect(await issuedAudits(logId)).toBe(0);
  });
});
