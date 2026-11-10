// Attendance selfie retention purge (bead legend-wh71; PRD v1.7 F25, HR-02,
// privacy line 194: attendance_logs.photo_key "dihapus sesuai masa simpan").
// `purgeAttendanceSelfies(now, deps)` runs daily as a worker job. Real
// PostgreSQL and a FakeObjectStorage holding the selfie blobs; `now` is
// injected so the real clock never matters, and every row is seeded with the
// migration owner in throwaway tenants. The job is limited to those tenants
// through its `listTenantIds` hook, so other suites' rows are never touched
// and the `purged` count can be asserted exactly.
//
// Assumptions (from docs/PRD.md and the team brief, not from implementation):
// - A selfie is due when a payroll run covering the log's business_date is
//   closed (status locked, paid or reversed) and locked_at + retention days
//   <= now. Retention comes from attendance_policies.policy.selfieRetentionDays
//   (tenant default row) and is 90 days when the tenant has no policy.
// - photo_key is the id of the selfie's core_storage_objects row (source kind
//   attendance). Purging deletes the blob (original and thumbnail) from object
//   storage and the row, so both are observed as gone.
// - The deleted object is the selfie only: the attendance log itself stays
//   (photo_key NULL, photo_purged_at set).
// - Boundaries are probed one minute either side of the retention instant, so
//   the exact-instant inclusive/exclusive choice is not asserted.
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { purgeAttendanceSelfies } from "../worker/attendance-selfie-purge.job.ts";
import {
  createOwnerPool,
  createSecondTenant,
  removeSecondTenant,
  requireDisposableDatabase,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

requireDisposableDatabase();

const owner: Pool = createOwnerPool();
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** Close time of every payroll run in this file. */
const lockedAt = new Date("2041-01-15T03:00:00.000Z");
const after = (days: number, offsetMs = 0) =>
  new Date(lockedAt.getTime() + days * DAY_MS + offsetMs);

interface Seeded {
  tenant: SecondTenant;
  employeeId: string;
  policyId: string;
}
let defaultTenant: Seeded; // no attendance policy: 90-day default
let shortTenant: Seeded; // tenant policy: 30-day retention
const createdTenants: SecondTenant[] = [];
const storage = new FakeObjectStorage();
const quietLog = { error: () => undefined };

const tenantContext = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

/** One purge run limited to this file's tenants; failures are never expected. */
async function purge(now: Date) {
  const result = await purgeAttendanceSelfies(now, {
    storage,
    log: quietLog,
    listTenantIds: async () => createdTenants.map((tenant) => tenant.tenantId),
  });
  expect(result.failed).toBe(0);
  return result;
}

const blobKeys = (objectId: string) => ({
  original: `attendance/${objectId}/original.webp`,
  thumbnail: `attendance/${objectId}/thumbnail.webp`,
});

async function blobExists(
  log: { tenantId: string; outletId: string },
  objectId: string,
  key: string,
) {
  try {
    await storage.get(tenantContext(log.tenantId), {
      tenantId: tenantIdSchema.parse(log.tenantId),
      outletId: outletIdSchema.parse(log.outletId),
      reference: objectId,
      key,
      visibility: "private",
    });
    return true;
  } catch {
    return false;
  }
}

/** Owner connection with the tenant GUCs set, so fixtures pass forced RLS. */
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

async function seedTenant(label: string): Promise<Seeded> {
  const tenant = await createSecondTenant(owner, label);
  createdTenants.push(tenant);
  const employeeId = randomUUID();
  const policyId = randomUUID();
  await ownerTx(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, NULL, $3, 'Karyawan Purge', $4, 'pkwtt', '2025-03-01', 'active')`,
      [
        employeeId,
        tenant.tenantId,
        `0000PRG${randomBytes(4).toString("hex").toUpperCase()}`,
        tenant.outletId,
      ],
    );
    await client.query(
      `INSERT INTO payroll_policies
         (id, tenant_id, legal_entity_id, name, employee_group_code, employee_group, cycle,
          pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Purge', 'PRG', '{"code":"PRG"}', '{"kind":"monthly"}',
               'none', 'low', '[]')`,
      [policyId, tenant.tenantId, tenant.legalEntityId],
    );
  });
  return { tenant, employeeId, policyId };
}

let periodSeq = 0;
/** A fresh calendar month, so runs of one policy never share a period. */
function nextPeriod() {
  const month = periodSeq++;
  const year = 2042 + Math.floor(month / 12);
  const mm = String((month % 12) + 1).padStart(2, "0");
  return {
    start: `${year}-${mm}-01`,
    end: `${year}-${mm}-28`,
    businessDate: `${year}-${mm}-14`,
  };
}

type RunStatus = "approved" | "locked" | "paid" | "reversed";

/** Walks a run through the real state machine up to `status`. */
async function seedRun(
  seeded: Seeded,
  period: { start: string; end: string },
  status: RunStatus,
): Promise<string> {
  const id = randomUUID();
  await ownerTx(seeded.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO payroll_runs
         (id, tenant_id, legal_entity_id, payroll_policy_id, run_type, period_start, period_end,
          pay_date, created_by)
       VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, 'attendance-purge-test')`,
      [
        id,
        seeded.tenant.tenantId,
        seeded.tenant.legalEntityId,
        seeded.policyId,
        period.start,
        period.end,
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
    if (status === "approved") return;
    await step(
      `status = 'locked', config_snapshot = '{"v":1}', totals = '{"t":1}', locked_by = 'lock-user', locked_at = $2`,
      [lockedAt],
    );
    if (status === "paid")
      await step(`status = 'paid', paid_at = now(), paid_by = 'pay-user'`);
    if (status === "reversed")
      await step(`status = 'reversed', reversal = '{"status":"approved"}'`);
  });
  return id;
}

interface SeededLog {
  logId: string;
  /** Id of the selfie's storage row, which is also the log's photo_key. */
  photoKey: string | null;
  tenantId: string;
  outletId: string;
}

/** A clock-in log, with a private selfie (blob and row) when `withPhoto`. */
async function seedLog(
  seeded: Seeded,
  businessDate: string,
  withPhoto = true,
): Promise<SeededLog> {
  const logId = ulidToUuid(createUlid());
  const objectId = randomUUID();
  const photoKey = withPhoto ? objectId : null;
  const { tenantId, outletId } = seeded.tenant;
  if (photoKey) {
    const keys = blobKeys(objectId);
    for (const key of [keys.original, keys.thumbnail])
      await storage.put(tenantContext(tenantId), {
        tenantId: tenantIdSchema.parse(tenantId),
        outletId: outletIdSchema.parse(outletId),
        reference: objectId,
        key,
        contentType: "image/webp",
        content: new Uint8Array([1, 2, 3]),
        visibility: "private",
      });
  }
  await ownerTx(tenantId, async (client) => {
    if (photoKey)
      await client.query(
        `INSERT INTO core_storage_objects
           (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
            thumbnail_key, source_kind, source_id)
         VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 2048, $5, 'attendance', $6)`,
        [
          tenantId,
          outletId,
          objectId,
          blobKeys(objectId).original,
          blobKeys(objectId).thumbnail,
          logId,
        ],
      );
    await client.query(
      `INSERT INTO attendance_logs
         (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
          geo_distance_m, validity, business_date, client_event_id, photo_key)
       VALUES ($1, $2, $3, $4, 'in', 'selfie_geo', $5, $5, 12, 'valid', $6, $7, $8)`,
      [
        logId,
        tenantId,
        outletId,
        seeded.employeeId,
        new Date(`${businessDate}T01:00:00.000Z`),
        businessDate,
        createUlid(),
        photoKey,
      ],
    );
  });
  return { logId, photoKey, tenantId, outletId };
}

interface LogState {
  photo_key: string | null;
  photo_purged_at: Date | null;
  type: string;
  validity: string;
  storageRows: number;
  blobs: { original: boolean; thumbnail: boolean };
}

async function logState(log: SeededLog): Promise<LogState> {
  const { rows, storageRows } = await ownerTx(log.tenantId, async (client) => {
    const found = await client.query<
      Pick<LogState, "photo_key" | "photo_purged_at" | "type" | "validity">
    >(
      `SELECT photo_key, photo_purged_at, type, validity
         FROM attendance_logs WHERE tenant_id = $1 AND id = $2`,
      [log.tenantId, log.logId],
    );
    const objects = await client.query(
      "SELECT 1 FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
      // The row id of a log without a selfie is never matched.
      [log.tenantId, log.photoKey ?? randomUUID()],
    );
    return { rows: found.rows, storageRows: objects.rowCount ?? 0 };
  });
  const keys = log.photoKey ? blobKeys(log.photoKey) : null;
  return {
    ...rows[0]!,
    storageRows,
    blobs: {
      original: keys
        ? await blobExists(log, log.photoKey!, keys.original)
        : false,
      thumbnail: keys
        ? await blobExists(log, log.photoKey!, keys.thumbnail)
        : false,
    },
  };
}

function expectKept(state: LogState, photoKey: string | null) {
  expect(state.photo_key).toBe(photoKey);
  expect(state.photo_purged_at).toBeNull();
  expect(state.storageRows).toBe(photoKey ? 1 : 0);
  expect(state.blobs).toEqual({ original: !!photoKey, thumbnail: !!photoKey });
}

function expectPurged(state: LogState) {
  expect(state.photo_key).toBeNull();
  expect(state.photo_purged_at).toBeInstanceOf(Date);
  expect(state.storageRows).toBe(0);
  // Both blobs left object storage, not only the database row.
  expect(state.blobs).toEqual({ original: false, thumbnail: false });
  // Only the selfie goes: the attendance record itself stays for payroll audit.
  expect(state.type).toBe("in");
  expect(state.validity).toBe("valid");
}

beforeAll(async () => {
  defaultTenant = await seedTenant("attpurge");
  shortTenant = await seedTenant("attpurge30");
  await ownerTx(shortTenant.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO attendance_policies (tenant_id, outlet_id, policy, sampling, updated_by)
       VALUES ($1, NULL, $2, $3, 'attendance-purge-test')`,
      [
        shortTenant.tenant.tenantId,
        JSON.stringify({
          geofenceRadiusM: 100,
          outsideGeofenceAction: "flag",
          unboundDeviceAction: "flag",
          requireSelfie: true,
          requireDeviceBinding: false,
          allowRotatingQr: true,
          selfieRetentionDays: 30,
        }),
        JSON.stringify({
          rate: 0.1,
          flaggedAlways: true,
          minPerSupervisorPerWeek: 0,
        }),
      ],
    ),
  );
}, 60_000);

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
    for (const tenant of createdTenants) {
      // Locked payroll runs, audit rows and storage rows are append-only or
      // guarded; replica mode lets the owner remove this file's fixtures.
      await step(() =>
        ownerTx(
          tenant.tenantId,
          async (client) => {
            for (const table of [
              "attendance_logs",
              "attendance_policies",
              "core_storage_objects",
              "payroll_runs",
              "payroll_policies",
              "employees",
              "hris_idempotency",
              "audit_logs",
            ])
              await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
                tenant.tenantId,
              ]);
          },
          { replica: true },
        ),
      );
      await step(() => removeSecondTenant(owner, tenant));
    }
  } finally {
    await step(() => owner.end());
  }
  if (errors.length > 0) throw errors[0];
}, 60_000);

describe("legend-wh71 selfie purge after payroll close", () => {
  it("keeps the selfie before 90 days after the payroll close and purges it right after", async () => {
    const period = nextPeriod();
    await seedRun(defaultTenant, period, "locked");
    const log = await seedLog(defaultTenant, period.businessDate);
    const control = await seedLog(defaultTenant, period.businessDate, false);
    expectKept(await logState(log), log.photoKey);

    const early = await purge(after(90, -MINUTE_MS));
    expect(early.purged).toBe(0);
    expectKept(await logState(log), log.photoKey);

    const due = await purge(after(90, MINUTE_MS));
    // The control log without a selfie is not counted.
    expect(due.purged).toBe(1);
    expectPurged(await logState(log));

    // A log that never had a selfie is left alone.
    expectKept(await logState(control), null);

    // A second run does not touch the already purged log again.
    const purgedAt = (await logState(log)).photo_purged_at;
    expect((await purge(after(120))).purged).toBe(0);
    expect((await logState(log)).photo_purged_at).toEqual(purgedAt);
  });

  it.each(["paid", "reversed"] as const)(
    "a %s run also counts as closed and its selfies are purged after 90 days",
    async (status) => {
      const period = nextPeriod();
      await seedRun(defaultTenant, period, status);
      const log = await seedLog(defaultTenant, period.businessDate);

      expect((await purge(after(90, -MINUTE_MS))).purged).toBe(0);
      expectKept(await logState(log), log.photoKey);

      expect((await purge(after(90, MINUTE_MS))).purged).toBe(1);
      expectPurged(await logState(log));
    },
  );

  it("never purges a selfie while no payroll run covers its business date", async () => {
    const period = nextPeriod();
    const log = await seedLog(defaultTenant, period.businessDate);

    // Ten years later: still no closed period, so the selfie stays.
    expect((await purge(after(3650))).purged).toBe(0);
    expectKept(await logState(log), log.photoKey);
  });

  it("never purges a selfie while the covering payroll run is not closed yet", async () => {
    const period = nextPeriod();
    await seedRun(defaultTenant, period, "approved");
    const log = await seedLog(defaultTenant, period.businessDate);

    expect((await purge(after(3650))).purged).toBe(0);
    expectKept(await logState(log), log.photoKey);
  });

  it("ignores a closed payroll run whose period does not cover the business date", async () => {
    const closed = nextPeriod();
    const other = nextPeriod();
    await seedRun(defaultTenant, closed, "locked");
    const log = await seedLog(defaultTenant, other.businessDate);

    expect((await purge(after(3650))).purged).toBe(0);
    expectKept(await logState(log), log.photoKey);
  });

  it("uses the tenant's own retention days and never another tenant's closed period", async () => {
    const shortPeriod = nextPeriod();
    const defaultPeriod = nextPeriod();
    await seedRun(shortTenant, shortPeriod, "locked");
    await seedRun(defaultTenant, defaultPeriod, "locked");
    const shortLog = await seedLog(shortTenant, shortPeriod.businessDate);
    const defaultLog = await seedLog(defaultTenant, defaultPeriod.businessDate);
    // Same business date as the short tenant's closed run, but no closed run
    // in this tenant: a closed period elsewhere must not release it.
    const uncovered = await seedLog(defaultTenant, shortPeriod.businessDate);

    // Day 31: the 30-day tenant is due, the 90-day default tenant is not.
    expect((await purge(after(31))).purged).toBe(1);
    expectPurged(await logState(shortLog));
    expectKept(await logState(defaultLog), defaultLog.photoKey);
    expectKept(await logState(uncovered), uncovered.photoKey);

    // Day 91: the default tenant is due too.
    expect((await purge(after(91))).purged).toBe(1);
    expectPurged(await logState(defaultLog));
  });
});
