// Cloud orphan sweep for edge selfies, and the purge-then-late-selfie rule
// (bead legend-0wvoz, C6; design docs/design/hris-edge-replication.md 6.1, 6.3).
// Real PostgreSQL, a FakeObjectStorage, `now` injected so the real clock never
// matters. The sweep is limited to the fixture tenant through `listTenantIds`.
//
// Assumptions (the design and brief leave them open):
// - "older than 14 days" is probed one hour either side of 14 days; the exact
//   instant is not asserted.
// - The sweep deletes S3 original and thumbnail and the object row, but the
//   receipt stays (the table is append-only), so a late retry of the same
//   sealed file answers 200 and writes nothing.
// - A storage failure counts as `failed`, keeps the object row, and the next
//   run retries it.
// - The purge job writes a `discarded` receipt (zero-filled 32-byte hash) only
//   when the selfie object is absent and an edge node exists for the log's
//   outlet; a selfie arriving later is answered 200 and discarded.
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { receiveEdgeSelfie } from "../services/edge-selfie-receive.ts";
import { purgeAttendanceSelfies } from "../worker/attendance-selfie-purge.job.ts";
import { sweepOrphanEdgeSelfies } from "../worker/edge-selfie-orphan-sweep.job.ts";
import {
  createEdgeSelfieFixture,
  type EdgeSelfieFixture,
} from "./helpers/edge-selfie-fixture.ts";
import {
  generateSealKeyPair,
  sampleWebp,
  sealKeysEnvValue,
  sealSelfie,
  sha256Hex,
  type SealKeyPair,
} from "./helpers/edge-selfie-seal.ts";

const SEAL_KEYS_ENV = "ATTENDANCE_SELFIE_SEAL_KEYS";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const quietLog = { error: () => undefined, warn: () => undefined };

class FailingDeleteStorage extends FakeObjectStorage {
  failFor = new Set<string>();
  override async delete(
    ...args: Parameters<FakeObjectStorage["delete"]>
  ): ReturnType<FakeObjectStorage["delete"]> {
    if ([...this.failFor].some((id) => args[1].key.startsWith(id)))
      throw new Error("storage unavailable");
    return super.delete(...args);
  }
}

let fx: EdgeSelfieFixture;
let pair: SealKeyPair;
let storage: FailingDeleteStorage;
let previousKeys: string | undefined;
let payrollPolicyId: string;

const lookup = (objectId: string, key: string) => ({
  tenantId: tenantIdSchema.parse(fx.tenantId),
  outletId: outletIdSchema.parse(fx.outletA),
  reference: objectId,
  key,
  visibility: "private" as const,
});

async function blobExists(objectId: string, name: "original" | "thumbnail") {
  try {
    await storage.get(
      fx.scopeOf([fx.outletA]),
      lookup(objectId, `${objectId}/${name}.webp`),
    );
    return true;
  } catch {
    return false;
  }
}

async function putBlobs(objectId: string) {
  for (const name of ["original", "thumbnail"])
    await storage.put(fx.scopeOf([fx.outletA]), {
      ...lookup(objectId, `${objectId}/${name}.webp`),
      contentType: "image/webp",
      content: new Uint8Array([1, 2, 3]),
    });
}

/** A received selfie as the receive endpoint leaves it: blobs, object row, receipt. */
async function seedReceived(options: {
  receivedAt: Date;
  state?: "stored" | "discarded";
  withObject?: boolean;
  logPointsAtIt?: boolean;
}): Promise<string> {
  const objectId = randomUUID();
  const withObject = options.withObject ?? true;
  if (withObject) await putBlobs(objectId);
  await fx.asTenant(async (client) => {
    if (withObject)
      await client.query(
        `INSERT INTO core_storage_objects
           (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
            thumbnail_key, owner_user_id)
         VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 2048, $5, $6)`,
        [
          fx.tenantId,
          fx.outletA,
          objectId,
          `${objectId}/original.webp`,
          `${objectId}/thumbnail.webp`,
          fx.employee.userId,
        ],
      );
    await client.query(
      `INSERT INTO edge_received_selfies
         (tenant_id, object_id, outlet_id, edge_node_id, sealed_sha256, state, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        fx.tenantId,
        objectId,
        fx.outletA,
        fx.nodeA.verified.edgeNodeId,
        randomBytes(32),
        options.state ?? "stored",
        options.receivedAt,
      ],
    );
    if (options.logPointsAtIt) await insertLog(client, objectId);
  });
  return objectId;
}

async function insertLog(
  client: PoolClient,
  photoKey: string | null,
  options: { outletId?: string; businessDate?: string } = {},
): Promise<string> {
  const logId = ulidToUuid(createUlid());
  const businessDate = options.businessDate ?? "2043-05-14";
  await client.query(
    `INSERT INTO attendance_logs
       (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
        geo_distance_m, validity, business_date, client_event_id, photo_key)
     VALUES ($1, $2, $3, $4, 'in', 'outlet_device', $5, $5, 12, 'flagged', $6, $7, $8)`,
    [
      logId,
      fx.tenantId,
      options.outletId ?? fx.outletA,
      fx.employee.id,
      new Date(`${businessDate}T01:00:00.000Z`),
      businessDate,
      createUlid(),
      photoKey,
    ],
  );
  return logId;
}

/** Fresh slate for the three tables the sweep and the receive endpoint touch. */
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

const sweep = (now: Date) =>
  sweepOrphanEdgeSelfies(now, {
    storage,
    log: quietLog,
    listTenantIds: async () => [fx.tenantId],
  });

beforeAll(async () => {
  previousKeys = process.env[SEAL_KEYS_ENV];
  pair = generateSealKeyPair("sweep-kid-1");
  process.env[SEAL_KEYS_ENV] = sealKeysEnvValue(pair);
  fx = await createEdgeSelfieFixture();
  payrollPolicyId = randomUUID();
  await fx.asTenant((client) =>
    client.query(
      `INSERT INTO payroll_policies
         (id, tenant_id, legal_entity_id, name, employee_group_code, employee_group, cycle,
          pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Sweep', 'SWP', '{"code":"SWP"}', '{"kind":"monthly"}',
               'none', 'low', '[]')`,
      [payrollPolicyId, fx.tenantId, fx.legalEntityId],
    ),
  );
}, 60_000);

beforeEach(async () => {
  storage = new FailingDeleteStorage();
  await wipe();
});

afterAll(async () => {
  if (previousKeys === undefined) delete process.env[SEAL_KEYS_ENV];
  else process.env[SEAL_KEYS_ENV] = previousKeys;
  await fx.cleanup();
}, 60_000);

describe("legend-0wvoz orphan sweep (6.3)", () => {
  it("deletes an orphan selfie received more than 14 days ago: both blobs and the object row, the receipt stays", async () => {
    const now = new Date();
    const objectId = await seedReceived({
      receivedAt: new Date(now.getTime() - 14 * DAY_MS - HOUR_MS),
    });
    expect(await blobExists(objectId, "original")).toBe(true);

    const result = await sweep(now);
    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect(await blobExists(objectId, "original")).toBe(false);
    expect(await blobExists(objectId, "thumbnail")).toBe(false);
    expect(await fx.objectRow(objectId)).toBeUndefined();
    expect((await fx.receiptRow(objectId))!.state).toBe("stored");
  });

  it("keeps an orphan received less than 14 days ago", async () => {
    const now = new Date();
    const objectId = await seedReceived({
      receivedAt: new Date(now.getTime() - 14 * DAY_MS + HOUR_MS),
    });
    expect(await sweep(now)).toEqual({ deleted: 0, failed: 0 });
    expect(await blobExists(objectId, "original")).toBe(true);
    expect(await blobExists(objectId, "thumbnail")).toBe(true);
    expect(await fx.objectRow(objectId)).toBeDefined();
  });

  it("keeps an old selfie that an attendance log points at", async () => {
    const now = new Date();
    const objectId = await seedReceived({
      receivedAt: new Date(now.getTime() - 30 * DAY_MS),
      logPointsAtIt: true,
    });
    expect(await sweep(now)).toEqual({ deleted: 0, failed: 0 });
    expect(await blobExists(objectId, "original")).toBe(true);
    expect(await fx.objectRow(objectId)).toBeDefined();
  });

  it("ignores a discarded receipt that never had an object", async () => {
    const now = new Date();
    const objectId = await seedReceived({
      receivedAt: new Date(now.getTime() - 30 * DAY_MS),
      state: "discarded",
      withObject: false,
    });
    expect(await sweep(now)).toEqual({ deleted: 0, failed: 0 });
    expect((await fx.receiptRow(objectId))!.state).toBe("discarded");
  });

  it("a second run deletes nothing more", async () => {
    const now = new Date();
    await seedReceived({
      receivedAt: new Date(now.getTime() - 20 * DAY_MS),
    });
    expect((await sweep(now)).deleted).toBe(1);
    expect(await sweep(now)).toEqual({ deleted: 0, failed: 0 });
  });

  it("a storage failure counts as failed and keeps the object row, the next run retries it", async () => {
    const now = new Date();
    const objectId = await seedReceived({
      receivedAt: new Date(now.getTime() - 20 * DAY_MS),
    });
    storage.failFor.add(objectId);
    expect(await sweep(now)).toEqual({ deleted: 0, failed: 1 });
    expect(await fx.objectRow(objectId)).toBeDefined();

    storage.failFor.clear();
    expect(await sweep(now)).toEqual({ deleted: 1, failed: 0 });
    expect(await fx.objectRow(objectId)).toBeUndefined();
  });

  it("a late retry of a swept selfie gets 200 and nothing is written again", async () => {
    const objectId = randomUUID();
    const sealed = sealSelfie({
      pair,
      tenantId: fx.tenantId,
      objectId,
      meta: { outletId: fx.outletA, ownerUserId: fx.employee.userId },
      webp: await sampleWebp(9),
    });
    const input = {
      objectId,
      body: sealed,
      sealedSha256Header: sha256Hex(sealed),
    };
    const deps = { database: db, storage, scanner: new NoopMalwareScanner() };
    expect(await receiveEdgeSelfie(deps, fx.nodeA.verified, input)).toEqual({
      status: 201,
    });

    const result = await sweep(new Date(Date.now() + 15 * DAY_MS));
    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect(await fx.objectRow(objectId)).toBeUndefined();

    // The edge never saw the answer and retries the same file.
    expect(await receiveEdgeSelfie(deps, fx.nodeA.verified, input)).toEqual({
      status: 200,
    });
    expect(await fx.objectRow(objectId)).toBeUndefined();
    expect(await blobExists(objectId, "original")).toBe(false);
    expect((await fx.receiptRow(objectId))!.state).toBe("stored");
  });
});

describe("legend-0wvoz purge then a late selfie is discarded (6.1)", () => {
  const lockedAt = new Date("2041-01-15T03:00:00.000Z");
  const purgeNow = new Date(lockedAt.getTime() + 91 * DAY_MS);
  let periodSeq = 0;

  /** A locked payroll run whose period covers the business date of the logs. */
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

  const purge = () =>
    purgeAttendanceSelfies(purgeNow, {
      storage,
      log: quietLog,
      listTenantIds: async () => [fx.tenantId],
    });

  it("a log whose selfie never arrived is purged, a discarded receipt is written, and the late selfie answers 200 without storing", async () => {
    const businessDate = await lockedPeriod();
    const objectId = randomUUID();
    const logId = await fx.asTenant((client) =>
      insertLog(client, objectId, { businessDate }),
    );

    const result = await purge();
    expect(result.failed).toBe(0);
    expect(result.purged).toBe(1);
    const after = (
      await fx.asTenant((client) =>
        client.query(
          "SELECT photo_key, photo_purged_at FROM attendance_logs WHERE tenant_id = $1 AND id = $2",
          [fx.tenantId, logId],
        ),
      )
    ).rows[0];
    expect(after.photo_key).toBeNull();
    expect(after.photo_purged_at).toBeInstanceOf(Date);

    const receipt = await fx.receiptRow(objectId);
    expect(receipt).toMatchObject({
      state: "discarded",
      outlet_id: fx.outletA,
      edge_node_id: fx.nodeA.verified.edgeNodeId,
    });
    expect(receipt!.sealed_sha256).toEqual(Buffer.alloc(32, 0));

    // The edge uploads the selfie after the purge: accepted, never stored.
    const sealed = sealSelfie({
      pair,
      tenantId: fx.tenantId,
      objectId,
      meta: { outletId: fx.outletA, ownerUserId: fx.employee.userId },
      webp: await sampleWebp(5),
    });
    expect(
      await receiveEdgeSelfie(
        { database: db, storage, scanner: new NoopMalwareScanner() },
        fx.nodeA.verified,
        { objectId, body: sealed, sealedSha256Header: sha256Hex(sealed) },
      ),
    ).toEqual({ status: 200 });
    expect(await fx.objectRow(objectId)).toBeUndefined();
    expect(await blobExists(objectId, "original")).toBe(false);
    expect(await blobExists(objectId, "thumbnail")).toBe(false);
    expect((await fx.receiptRow(objectId))!.state).toBe("discarded");
  });

  it("no receipt is written for an outlet without an edge node", async () => {
    const businessDate = await lockedPeriod();
    const objectId = randomUUID();
    await fx.asTenant((client) =>
      insertLog(client, objectId, { businessDate, outletId: fx.outletC }),
    );
    const result = await purge();
    expect(result.failed).toBe(0);
    expect(result.purged).toBe(1);
    expect(await fx.receiptRow(objectId)).toBeUndefined();
  });

  it("no receipt is written when the selfie object exists and is purged normally", async () => {
    const businessDate = await lockedPeriod();
    const objectId = randomUUID();
    await putBlobs(objectId);
    await fx.asTenant(async (client) => {
      const logId = await insertLog(client, objectId, { businessDate });
      await client.query(
        `INSERT INTO core_storage_objects
           (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
            thumbnail_key, owner_user_id, source_kind, source_id)
         VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 2048, $5, $6, 'attendance', $7)`,
        [
          fx.tenantId,
          fx.outletA,
          objectId,
          `${objectId}/original.webp`,
          `${objectId}/thumbnail.webp`,
          fx.employee.userId,
          logId,
        ],
      );
    });
    const result = await purge();
    expect(result.failed).toBe(0);
    expect(result.purged).toBe(1);
    expect(await fx.objectRow(objectId)).toBeUndefined();
    expect(await blobExists(objectId, "original")).toBe(false);
    expect(await fx.receiptRow(objectId)).toBeUndefined();
  });
});
