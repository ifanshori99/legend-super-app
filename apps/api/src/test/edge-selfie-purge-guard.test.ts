// Purge ownership guard and edge-selfie lock (bead legend-0wvoz, architect
// findings #1 and #4). Real PostgreSQL, a FakeObjectStorage, `now` injected.
//
// - #1: the purge deletes an object only when it belongs to the log being
//   purged (source_id = the log's uuid) or is an unlinked legacy object at the
//   log's outlet. A log whose photo_key points at anyone else's object only
//   gets its own photo_key nulled; the foreign object and blobs stay.
// - #4: the purge takes the same advisory lock as the edge receive endpoint
//   (`edge-selfie:<tenantId>:<objectId>`) before it touches the object.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import { purgeAttendanceSelfies } from "../worker/attendance-selfie-purge.job.ts";
import {
  createEdgeSelfieFixture,
  type EdgeSelfieFixture,
} from "./helpers/edge-selfie-fixture.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const quietLog = { error: () => undefined, warn: () => undefined };
const lockedAt = new Date("2041-01-15T03:00:00.000Z");
const purgeNow = new Date(lockedAt.getTime() + 91 * DAY_MS);

let fx: EdgeSelfieFixture;
let storage: FakeObjectStorage;
let payrollPolicyId: string;
let periodSeq = 0;

const lookup = (objectId: string, key: string, outletId: string) => ({
  tenantId: tenantIdSchema.parse(fx.tenantId),
  outletId: outletIdSchema.parse(outletId),
  reference: objectId,
  key,
  visibility: "private" as const,
});

async function blobExists(
  objectId: string,
  name: "original" | "thumbnail",
  outletId: string,
) {
  try {
    await storage.get(
      fx.scopeOf([outletId]),
      lookup(objectId, `${objectId}/${name}.webp`, outletId),
    );
    return true;
  } catch {
    return false;
  }
}

async function putBlobs(objectId: string, outletId: string) {
  for (const name of ["original", "thumbnail"])
    await storage.put(fx.scopeOf([outletId]), {
      ...lookup(objectId, `${objectId}/${name}.webp`, outletId),
      contentType: "image/webp",
      content: new Uint8Array([1, 2, 3]),
    });
}

async function insertLog(
  client: PoolClient,
  photoKey: string | null,
  businessDate: string,
): Promise<string> {
  const logId = ulidToUuid(createUlid());
  await client.query(
    `INSERT INTO attendance_logs
       (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
        geo_distance_m, validity, business_date, client_event_id, photo_key)
     VALUES ($1, $2, $3, $4, 'in', 'outlet_device', $5, $5, 12, 'flagged', $6, $7, $8)`,
    [
      logId,
      fx.tenantId,
      fx.outletA,
      fx.employee.id,
      new Date(`${businessDate}T01:00:00.000Z`),
      businessDate,
      createUlid(),
      photoKey,
    ],
  );
  return logId;
}

/** An attendance selfie object with blobs; `sourceId` null means unlinked. */
async function insertObject(
  client: PoolClient,
  options: { outletId: string; sourceId: string | null },
): Promise<string> {
  const objectId = randomUUID();
  await putBlobs(objectId, options.outletId);
  await client.query(
    `INSERT INTO core_storage_objects
       (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
        thumbnail_key, owner_user_id, source_kind, source_id)
     VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 2048, $5, $6, 'attendance', $7)`,
    [
      fx.tenantId,
      options.outletId,
      objectId,
      `${objectId}/original.webp`,
      `${objectId}/thumbnail.webp`,
      fx.employee.userId,
      options.sourceId,
    ],
  );
  return objectId;
}

/** A locked payroll run whose period covers the returned business date. */
async function lockedPeriod(): Promise<string> {
  const month = periodSeq++;
  const year = 2043 + Math.floor(month / 12);
  const mm = String((month % 12) + 1).padStart(2, "0");
  const id = randomUUID();
  await fx.asTenant(async (client) => {
    await client.query(
      `INSERT INTO payroll_runs
         (id, tenant_id, legal_entity_id, payroll_policy_id, run_type, period_start, period_end,
          pay_date, created_by)
       VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, 'edge-selfie-test')`,
      [
        id,
        fx.tenantId,
        fx.legalEntityId,
        payrollPolicyId,
        `${year}-${mm}-01`,
        `${year}-${mm}-28`,
      ],
    );
    const step = (sql: string, values: unknown[] = []) =>
      client.query(`UPDATE payroll_runs SET ${sql} WHERE id = $1`, [
        id,
        ...values,
      ]);
    await step(`status = 'simulated'`);
    await step(
      `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
    );
    await step(
      `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
    );
    await step(
      `status = 'locked', config_snapshot = '{"v":1}', totals = '{"t":1}', locked_by = 'lock-user', locked_at = $2`,
      [lockedAt],
    );
  });
  return `${year}-${mm}-14`;
}

/** Fresh slate for the tables the purge touches. */
async function wipe() {
  const client = await fx.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "attendance_logs",
      "core_storage_objects",
      "edge_received_selfies",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        fx.tenantId,
      ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const purge = () =>
  purgeAttendanceSelfies(purgeNow, {
    storage,
    log: quietLog,
    listTenantIds: async () => [fx.tenantId],
  });

async function logRow(logId: string) {
  return (
    await fx.asTenant((client) =>
      client.query(
        "SELECT photo_key, photo_purged_at FROM attendance_logs WHERE tenant_id = $1 AND id = $2",
        [fx.tenantId, logId],
      ),
    )
  ).rows[0];
}

async function expectPurgedLog(logId: string) {
  const row = await logRow(logId);
  expect(row.photo_key).toBeNull();
  expect(row.photo_purged_at).toBeInstanceOf(Date);
}

async function expectObjectLeft(objectId: string, outletId: string) {
  expect(await fx.objectRow(objectId)).toBeDefined();
  expect(await blobExists(objectId, "original", outletId)).toBe(true);
  expect(await blobExists(objectId, "thumbnail", outletId)).toBe(true);
}

beforeAll(async () => {
  fx = await createEdgeSelfieFixture();
  payrollPolicyId = randomUUID();
  await fx.asTenant((client) =>
    client.query(
      `INSERT INTO payroll_policies
         (id, tenant_id, legal_entity_id, name, employee_group_code, employee_group, cycle,
          pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Guard', 'GRD', '{"code":"GRD"}', '{"kind":"monthly"}',
               'none', 'low', '[]')`,
      [payrollPolicyId, fx.tenantId, fx.legalEntityId],
    ),
  );
}, 60_000);

beforeEach(async () => {
  storage = new FakeObjectStorage();
  await wipe();
});

afterAll(async () => {
  await fx.cleanup();
}, 60_000);

describe("legend-0wvoz purge ownership guard (finding #1)", () => {
  it("deletes an object linked to the purged log", async () => {
    const businessDate = await lockedPeriod();
    const objectId = await fx.asTenant(async (client) => {
      const logId = await insertLog(client, null, businessDate);
      const id = await insertObject(client, {
        outletId: fx.outletA,
        sourceId: logId,
      });
      await client.query(
        "UPDATE attendance_logs SET photo_key = $3 WHERE tenant_id = $1 AND id = $2",
        [fx.tenantId, logId, id],
      );
      return id;
    });
    const result = await purge();
    expect(result).toEqual({ purged: 1, failed: 0 });
    expect(await fx.objectRow(objectId)).toBeUndefined();
    expect(await blobExists(objectId, "original", fx.outletA)).toBe(false);
    expect(await blobExists(objectId, "thumbnail", fx.outletA)).toBe(false);
  });

  it("deletes an unlinked legacy object at the log's outlet", async () => {
    const businessDate = await lockedPeriod();
    const objectId = await fx.asTenant(async (client) => {
      const id = await insertObject(client, {
        outletId: fx.outletA,
        sourceId: null,
      });
      await insertLog(client, id, businessDate);
      return id;
    });
    const result = await purge();
    expect(result).toEqual({ purged: 1, failed: 0 });
    expect(await fx.objectRow(objectId)).toBeUndefined();
    expect(await blobExists(objectId, "original", fx.outletA)).toBe(false);
  });

  it("leaves an object linked to another log, and still nulls the purged log's photo_key", async () => {
    const businessDate = await lockedPeriod();
    const { logId, objectId } = await fx.asTenant(async (client) => {
      const otherLogId = ulidToUuid(createUlid());
      const id = await insertObject(client, {
        outletId: fx.outletA,
        sourceId: otherLogId,
      });
      return { logId: await insertLog(client, id, businessDate), objectId: id };
    });
    const result = await purge();
    expect(result).toEqual({ purged: 1, failed: 0 });
    await expectPurgedLog(logId);
    await expectObjectLeft(objectId, fx.outletA);
    expect(await fx.receiptRow(objectId)).toBeUndefined();
  });

  it("leaves an unlinked object that belongs to another outlet", async () => {
    const businessDate = await lockedPeriod();
    const { logId, objectId } = await fx.asTenant(async (client) => {
      const id = await insertObject(client, {
        outletId: fx.outletB,
        sourceId: null,
      });
      return { logId: await insertLog(client, id, businessDate), objectId: id };
    });
    const result = await purge();
    expect(result).toEqual({ purged: 1, failed: 0 });
    await expectPurgedLog(logId);
    await expectObjectLeft(objectId, fx.outletB);
    expect(await fx.receiptRow(objectId)).toBeUndefined();
  });
});

describe("legend-0wvoz purge takes the edge-selfie lock (finding #4)", () => {
  it("waits while the receive endpoint holds the lock for the same object", async () => {
    const businessDate = await lockedPeriod();
    const { logId, objectId } = await fx.asTenant(async (client) => {
      const id = await insertObject(client, {
        outletId: fx.outletA,
        sourceId: null,
      });
      return { logId: await insertLog(client, id, businessDate), objectId: id };
    });

    const holder = await fx.owner.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`edge-selfie:${fx.tenantId}:${objectId}`],
      );
      let settled = false;
      const running = purge().finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(settled).toBe(false);
      expect((await logRow(logId)).photo_key).toBe(objectId);
      expect(await fx.objectRow(objectId)).toBeDefined();

      await holder.query("COMMIT");
      expect(await running).toEqual({ purged: 1, failed: 0 });
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    await expectPurgedLog(logId);
    expect(await fx.objectRow(objectId)).toBeUndefined();
  });
});
