// O1 offline kit + per-device offline receipt series (bead legend-wasr7.5;
// docs/design/cloud-only-release.md §2). Real PostgreSQL with RLS: the shift
// is opened through the real service, the kit is issued through the real
// service as legend_app, fixtures and checks are read as the migration owner.
//
// Assumptions (from the design, not from the implementation):
// - The cloud hands a kit to the device of an open shift (the caller's own
//   shift on its own device). It lives 24 hours and carries the versioned
//   catalogue (dine-in and takeaway price lists), the tax and service-charge
//   rules, the offline tenders (cash and manual EDC only) and one offline
//   receipt run of the device: series `offline`, prefix `L<n>`.
// - The run is one epoch. A kit request that names the device's current
//   offline run continues it; any other request (lost local storage) opens a
//   new epoch with a new prefix, and the old run is retired with reason
//   `offline_epoch`. A prefix is never reused.
// - `L<digits>` is reserved for the offline series: a caller or an edge can
//   never claim it, and the device's regular P-run never sees the L-run.
// - Every kit is stored append-only with its snapshot (O2 compares synced
//   prices against it).
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  OFFLINE_KIT_TTL_MS,
  OFFLINE_RECEIPT_PREFIX_PATTERN,
  OFFLINE_TENDER_METHODS,
  posOfflineKitSchema,
  receiptPrefixSchema,
  RECEIPT_SERIES,
} from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { issuePosOfflineKit } from "../services/pos-offline-kit.service.ts";
import {
  allocateReceipt,
  localReceiptRunReport,
} from "../services/pos-receipt.service.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { withTenant } from "../db/tenant.ts";
import { db } from "../db/index.ts";
import { readFileSync } from "node:fs";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { signDeviceToken } from "../lib/device-token.ts";
import { originHeader } from "./helpers.ts";
import {
  closeShiftExactly,
  forceCloseShiftExactly,
  outletSupervisor,
} from "./pos-offline-test-helpers.ts";
import {
  owner,
  seededHostname,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers.ts";

const scope = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenantIdSchema.parse(seededTenantId),
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);
const outletId = outletIdSchema.parse(seededOutletA);

type Till = { cashier: Staff; deviceId: string; shiftId: string };
const tills: Till[] = [];
const devices = new Set<string>();

async function asOwner<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const callerOf = (till: Till, deviceId: string | null = till.deviceId) => ({
  userId: userIdSchema.parse(till.cashier.userId),
  deviceId,
});

async function newTill(
  app: ReturnType<typeof createApp>,
  sharedMode = true,
): Promise<Till> {
  const cashier = await staffWithRole(app, {
    template: "cashier",
    label: "Offline Kit Cashier",
  });
  const deviceId = randomUUID();
  devices.add(deviceId);
  await asOwner((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
       VALUES ($1, $2, $3, 'pos', 'Tablet offline uji', now() - interval '1 minute', $4)`,
      [deviceId, seededTenantId, seededOutletA, sharedMode],
    ),
  );
  const shift = await openPosShift(
    scope,
    { userId: userIdSchema.parse(cashier.userId), deviceId },
    outletId,
    { openingFloatIdr: idr(500_000), idempotencyKey: randomUUID() },
  );
  const till = { cashier, deviceId, shiftId: shift.id };
  tills.push(till);
  return till;
}

type RunRow = {
  id: string;
  prefix: string;
  series: string;
  last_number: number;
  retired_at: Date | null;
  retired_reason: string | null;
};

async function runsOf(deviceId: string): Promise<RunRow[]> {
  const { rows } = await owner.query<RunRow>(
    `SELECT id, prefix, series, last_number, retired_at, retired_reason
       FROM receipt_sequences
      WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $3
      ORDER BY created_at, prefix`,
    [seededTenantId, seededOutletA, deviceId],
  );
  return rows;
}

/** A completed POS order without a receipt yet (as a sale before allocation). */
async function completedOrder(): Promise<string> {
  const orderId = createUlid();
  const uuid = ulidToUuid(orderId);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at, deposit_applied_idr, table_session_id)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', 0, 0, 0, 0, 0, 0,
               'completed', '2026-11-26', now(), 0, NULL)`,
      [uuid, seededTenantId, seededOutletA, `OFK-${orderId.slice(-20)}`],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), now())`,
      [uuid, seededTenantId, seededOutletA],
    );
  });
  return orderId;
}

let app: ReturnType<typeof createApp>;
let a: Till;
let b: Till;

beforeAll(async () => {
  app = createApp();
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === seededTenantId && devices.has(deviceId) ? seededOutletA : null,
  );
  a = await newTill(app);
  b = await newTill(app);
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.end();
});

describe("O1 contract: the offline series", () => {
  it("adds the offline series and reserves L<digits> for it", () => {
    expect(RECEIPT_SERIES).toContain("offline");
    expect(OFFLINE_RECEIPT_PREFIX_PATTERN.test("L1")).toBe(true);
    expect(OFFLINE_RECEIPT_PREFIX_PATTERN.test("L999999")).toBe(true);
    expect(OFFLINE_RECEIPT_PREFIX_PATTERN.test("L1234567")).toBe(false);
    expect(OFFLINE_RECEIPT_PREFIX_PATTERN.test("P1")).toBe(false);
    expect(receiptPrefixSchema.safeParse("L7").success).toBe(false);
    expect(receiptPrefixSchema.safeParse("LOBBY1").success).toBe(true);
    expect(OFFLINE_TENDER_METHODS).toEqual(["cash", "edc_card"]);
    expect(OFFLINE_KIT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("O1 kit issue", () => {
  it("hands the shift's device a 24-hour kit with an L-run at 0", async () => {
    const now = new Date();
    const kit = await issuePosOfflineKit(
      scope,
      callerOf(a),
      outletId,
      a.shiftId,
      { resumeSequenceId: null },
      now,
    );
    expect(posOfflineKitSchema.parse(kit)).toEqual(kit);
    expect(kit.outletId).toBe(seededOutletA);
    expect(kit.deviceId).toBe(a.deviceId);
    expect(kit.shiftId).toBe(a.shiftId);
    expect(Date.parse(kit.expiresAt) - Date.parse(kit.issuedAt)).toBe(
      OFFLINE_KIT_TTL_MS,
    );
    expect(kit.catalogVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(kit.catalogs).sort()).toEqual(["dine_in", "takeaway"]);
    expect(kit.tenders).toEqual(["cash", "edc_card"]);
    expect(kit.receiptRun.prefix).toMatch(OFFLINE_RECEIPT_PREFIX_PATTERN);
    expect(kit.receiptRun.lastNumber).toBe(0);
    const runs = (await runsOf(a.deviceId)).filter(
      (run) => run.series === "offline",
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(kit.receiptRun.sequenceId);
    expect(runs[0]!.prefix).toBe(kit.receiptRun.prefix);
    expect(runs[0]!.retired_at).toBeNull();
    const { rows } = await owner.query<{
      shift_id: string;
      sequence_id: string;
      catalog_version: string;
      expires_at: Date;
    }>(
      `SELECT shift_id, sequence_id, catalog_version, expires_at
         FROM pos_offline_kits WHERE tenant_id = $1 AND id = $2`,
      [seededTenantId, kit.kitId],
    );
    expect(rows).toEqual([
      {
        shift_id: a.shiftId,
        sequence_id: kit.receiptRun.sequenceId,
        catalog_version: kit.catalogVersion,
        expires_at: new Date(kit.expiresAt),
      },
    ]);
  });

  it("continues the same epoch when the device names its current run", async () => {
    const first = await issuePosOfflineKit(
      scope,
      callerOf(a),
      outletId,
      a.shiftId,
      { resumeSequenceId: null },
    );
    const again = await issuePosOfflineKit(
      scope,
      callerOf(a),
      outletId,
      a.shiftId,
      { resumeSequenceId: first.receiptRun.sequenceId },
    );
    expect(again.kitId).not.toBe(first.kitId);
    expect(again.receiptRun.sequenceId).toBe(first.receiptRun.sequenceId);
    expect(again.receiptRun.prefix).toBe(first.receiptRun.prefix);
    expect(again.catalogVersion).toBe(first.catalogVersion);
  });

  it("review O1 P3 2: one snapshot per (outlet, catalogue version), shared by every kit", async () => {
    // Fresh tills: the shared ones spend their hourly epoch budget elsewhere.
    const tillOne = await newTill(app);
    const tillTwo = await newTill(app);
    const first = await issuePosOfflineKit(
      scope,
      callerOf(tillOne),
      outletId,
      tillOne.shiftId,
      {
        resumeSequenceId: null,
      },
    );
    const second = await issuePosOfflineKit(
      scope,
      callerOf(tillTwo),
      outletId,
      tillTwo.shiftId,
      {
        resumeSequenceId: null,
      },
    );
    const third = await issuePosOfflineKit(
      scope,
      callerOf(tillOne),
      outletId,
      tillOne.shiftId,
      {
        resumeSequenceId: first.receiptRun.sequenceId,
      },
    );
    expect(second.catalogVersion).toBe(first.catalogVersion);
    expect(third.catalogVersion).toBe(first.catalogVersion);
    const snapshots = await owner.query<{ catalogs: unknown }>(
      `SELECT snapshot -> 'catalogs' AS catalogs FROM pos_offline_catalog_snapshots
        WHERE tenant_id = $1 AND outlet_id = $2 AND catalog_version = $3`,
      [seededTenantId, seededOutletA, first.catalogVersion],
    );
    expect(snapshots.rows).toHaveLength(1);
    // The catalogue version leaves the read stamp (`updatedAt`) out, so the
    // stored snapshot keeps the stamp of whichever kit stored it first (an
    // earlier test of this outlet can have): compare the priced content only.
    const withoutStamp = (catalogs: unknown) => {
      const copy = JSON.parse(JSON.stringify(catalogs)) as Record<
        string,
        Record<string, unknown>
      >;
      for (const catalog of Object.values(copy)) delete catalog.updatedAt;
      return copy;
    };
    expect(withoutStamp(snapshots.rows[0]!.catalogs)).toEqual(
      withoutStamp(first.catalogs),
    );
    const kits = await owner.query<{ snapshot: unknown }>(
      "SELECT snapshot FROM pos_offline_kits WHERE tenant_id = $1 AND id = ANY($2)",
      [seededTenantId, [first.kitId, second.kitId, third.kitId]],
    );
    expect(kits.rows).toHaveLength(3);
    expect(kits.rows.every((row) => row.snapshot === null)).toBe(true);
    // Append-only like the kits.
    await expect(
      owner.query(
        "UPDATE pos_offline_catalog_snapshots SET snapshot = '{}'::jsonb WHERE tenant_id = $1 AND catalog_version = $2",
        [seededTenantId, first.catalogVersion],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("opens a new epoch with a never-used prefix when storage was lost", async () => {
    const before = await issuePosOfflineKit(
      scope,
      callerOf(a),
      outletId,
      a.shiftId,
      { resumeSequenceId: null },
    );
    const lost = await issuePosOfflineKit(
      scope,
      callerOf(a),
      outletId,
      a.shiftId,
      { resumeSequenceId: null },
    );
    expect(lost.receiptRun.sequenceId).not.toBe(before.receiptRun.sequenceId);
    expect(lost.receiptRun.prefix).not.toBe(before.receiptRun.prefix);
    const runs = (await runsOf(a.deviceId)).filter(
      (run) => run.series === "offline",
    );
    const old = runs.find((run) => run.id === before.receiptRun.sequenceId);
    expect(old?.retired_at).not.toBeNull();
    expect(old?.retired_reason).toBe("offline_epoch");
    expect(runs.filter((run) => run.retired_at === null)).toHaveLength(1);
    expect(new Set(runs.map((run) => run.prefix)).size).toBe(runs.length);
  });

  it("a stale or foreign run id never continues someone else's epoch", async () => {
    const kitB = await issuePosOfflineKit(
      scope,
      callerOf(b),
      outletId,
      b.shiftId,
      { resumeSequenceId: null },
    );
    const kitA = await issuePosOfflineKit(
      scope,
      callerOf(a),
      outletId,
      a.shiftId,
      { resumeSequenceId: kitB.receiptRun.sequenceId },
    );
    expect(kitA.receiptRun.sequenceId).not.toBe(kitB.receiptRun.sequenceId);
    expect(kitA.receiptRun.prefix).not.toBe(kitB.receiptRun.prefix);
    const bRuns = await runsOf(b.deviceId);
    expect(
      bRuns.find((run) => run.id === kitB.receiptRun.sequenceId)?.retired_at,
    ).toBeNull();
  });

  it("a regular sale of the device never takes the L-run", async () => {
    await issuePosOfflineKit(scope, callerOf(b), outletId, b.shiftId, {
      resumeSequenceId: null,
    });
    const orderId = await completedOrder();
    const regular = await withTenant(db, scope, (tx) =>
      allocateReceipt(tx as never, scope, {
        orderId,
        outletId: seededOutletA,
        deviceId: b.deviceId,
        at: new Date(),
      }),
    );
    expect(regular.number).not.toMatch(/^L[0-9]+-/);
  });
});

describe("O1 kit refusals", () => {
  it("refuses a caller without a registered device", async () => {
    await expect(
      issuePosOfflineKit(scope, callerOf(a, null), outletId, a.shiftId, {
        resumeSequenceId: null,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses another device or cashier than the shift's", async () => {
    await expect(
      issuePosOfflineKit(scope, callerOf(a, b.deviceId), outletId, a.shiftId, {
        resumeSequenceId: null,
      }),
    ).rejects.toMatchObject({ code: "SHIFT_NOT_OPEN" });
    await expect(
      issuePosOfflineKit(
        scope,
        { userId: userIdSchema.parse(b.cashier.userId), deviceId: a.deviceId },
        outletId,
        a.shiftId,
        { resumeSequenceId: null },
      ),
    ).rejects.toMatchObject({ code: "SHIFT_NOT_OPEN" });
  });

  it("refuses a shift that is not open", async () => {
    await expect(
      issuePosOfflineKit(scope, callerOf(a), outletId, randomUUID(), {
        resumeSequenceId: null,
      }),
    ).rejects.toMatchObject({ code: "SHIFT_NOT_OPEN" });
  });
});

describe("O1 database backstops", () => {
  it("only the offline series may hold an L prefix, and vice versa", async () => {
    const deviceId = randomUUID();
    await expect(
      asOwner((client) =>
        client.query(
          `INSERT INTO receipt_sequences (tenant_id, outlet_id, device_id, prefix, series)
           VALUES ($1, $2, $3, 'L900001', 'device')`,
          [seededTenantId, seededOutletA, deviceId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      asOwner((client) =>
        client.query(
          `INSERT INTO receipt_sequences (tenant_id, outlet_id, device_id, prefix, series)
           VALUES ($1, $2, $3, 'P900001', 'offline')`,
          [seededTenantId, seededOutletA, deviceId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("a kit row is never changed or deleted", async () => {
    const kit = await issuePosOfflineKit(
      scope,
      callerOf(a),
      outletId,
      a.shiftId,
      { resumeSequenceId: null },
    );
    await expect(
      asOwner((client) =>
        client.query(
          "UPDATE pos_offline_kits SET catalog_version = $3 WHERE tenant_id = $1 AND id = $2",
          [seededTenantId, kit.kitId, "0".repeat(64)],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      asOwner((client) =>
        client.query(
          "DELETE FROM pos_offline_kits WHERE tenant_id = $1 AND id = $2",
          [seededTenantId, kit.kitId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

/** Runs `work` with the process in edge mode, then restores the setting. */
async function asEdgeProcess<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.EDGE_MODE;
  process.env.EDGE_MODE = "true";
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.EDGE_MODE;
    else process.env.EDGE_MODE = previous;
  }
}

const offlineRunsOf = async (deviceId: string) =>
  (await runsOf(deviceId)).filter((run) => run.series === "offline");

describe("Review O1 fixes", () => {
  it("P2: an edge process never issues a kit nor reports an offline run", async () => {
    const till = await newTill(app);
    await expect(
      asEdgeProcess(() =>
        issuePosOfflineKit(scope, callerOf(till), outletId, till.shiftId, {
          resumeSequenceId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await offlineRunsOf(till.deviceId)).toEqual([]);
    // The outlet does hold offline runs: the edge report leaves them out.
    await issuePosOfflineKit(scope, callerOf(b), outletId, b.shiftId, {
      resumeSequenceId: null,
    });
    const report = await asEdgeProcess(() =>
      withTenant(db, scope, (tx) => localReceiptRunReport(tx, scope, outletId)),
    );
    expect(
      [...report.keys()].filter((prefix) => /^L[0-9]+$/.test(prefix)),
    ).toEqual([]);
  });

  it("P3 2: at most 6 new epochs per device per hour (429); continuing a run is not limited", async () => {
    const till = await newTill(app);
    let last = null as string | null;
    for (let epoch = 0; epoch < 6; epoch += 1)
      last = (
        await issuePosOfflineKit(
          scope,
          callerOf(till),
          outletId,
          till.shiftId,
          {
            resumeSequenceId: null,
          },
        )
      ).receiptRun.sequenceId;
    await expect(
      issuePosOfflineKit(scope, callerOf(till), outletId, till.shiftId, {
        resumeSequenceId: null,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
    expect(await offlineRunsOf(till.deviceId)).toHaveLength(6);
    const resumed = await issuePosOfflineKit(
      scope,
      callerOf(till),
      outletId,
      till.shiftId,
      { resumeSequenceId: last },
    );
    expect(resumed.receiptRun.sequenceId).toBe(last);
  });

  it("P3 3: resuming the device's own retired run opens a new epoch", async () => {
    const till = await newTill(app);
    const first = await issuePosOfflineKit(
      scope,
      callerOf(till),
      outletId,
      till.shiftId,
      { resumeSequenceId: null },
    );
    const second = await issuePosOfflineKit(
      scope,
      callerOf(till),
      outletId,
      till.shiftId,
      { resumeSequenceId: null },
    );
    const third = await issuePosOfflineKit(
      scope,
      callerOf(till),
      outletId,
      till.shiftId,
      { resumeSequenceId: first.receiptRun.sequenceId },
    );
    expect(
      new Set([
        first.receiptRun.sequenceId,
        second.receiptRun.sequenceId,
        third.receiptRun.sequenceId,
      ]).size,
    ).toBe(3);
    const runs = await offlineRunsOf(till.deviceId);
    expect(runs.map((run) => [run.id, run.retired_reason])).toEqual([
      [first.receiptRun.sequenceId, "offline_epoch"],
      [second.receiptRun.sequenceId, "offline_epoch"],
      [third.receiptRun.sequenceId, null],
    ]);
  });

  it("O3: refuses the close while the tablet reports unsent offline sales", async () => {
    const till = await newTill(app);
    const supervisorId = await outletSupervisor(app, "Offline Queue Close");
    const close = (offlineQueuePending: number) =>
      closeShiftExactly({
        scope,
        cashierId: till.cashier.userId,
        deviceId: till.deviceId,
        shiftId: till.shiftId,
        supervisorId,
        drawerIdr: 500_000,
        offlineQueuePending,
      });
    await expect(close(2)).rejects.toMatchObject({
      code: "OFFLINE_QUEUE_PENDING",
      status: 409,
    });
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM pos_shifts WHERE id = $1",
      [till.shiftId],
    );
    expect(rows[0]?.status).toBe("open");
    await close(0);
    const after = await owner.query<{ status: string }>(
      "SELECT status FROM pos_shifts WHERE id = $1",
      [till.shiftId],
    );
    expect(after.rows[0]?.status).toBe("closed");
  });

  it("review O3 P2 1: a shift with a kit closes only with its device's queue count; a force close marks it", async () => {
    const till = await newTill(app);
    const supervisorId = await outletSupervisor(
      app,
      "Offline Unverified Close",
    );
    const close = (offlineQueuePending: number | null) =>
      closeShiftExactly({
        scope,
        cashierId: till.cashier.userId,
        deviceId: till.deviceId,
        shiftId: till.shiftId,
        supervisorId,
        drawerIdr: 500_000,
        offlineQueuePending,
      });
    // Once a kit is out, the close needs the kit device's queue count.
    await issuePosOfflineKit(scope, callerOf(till), outletId, till.shiftId, {
      resumeSequenceId: null,
    });
    await expect(close(null)).rejects.toMatchObject({
      code: "OFFLINE_QUEUE_UNVERIFIED",
      status: 409,
    });
    const statusOf = async () =>
      (
        await owner.query<{ status: string; unverified: boolean }>(
          "SELECT status, offline_queue_unverified AS unverified FROM pos_shifts WHERE id = $1",
          [till.shiftId],
        )
      ).rows[0];
    expect(await statusOf()).toEqual({ status: "open", unverified: false });

    // The tablet is broken: a supervisor force closes, the shift is marked.
    await forceCloseShiftExactly({
      scope,
      deviceId: till.deviceId,
      shiftId: till.shiftId,
      supervisorId,
      witnessId: await outletSupervisor(app, "Offline Unverified Witness"),
      drawerIdr: 500_000,
    });
    expect(await statusOf()).toEqual({ status: "closed", unverified: true });
    // Supervisors and owners (finance) are told.
    const alerts = await owner.query(
      "SELECT 1 FROM notifications WHERE tenant_id = $1 AND title = $2 AND created_at > now() - interval '1 minute'",
      [seededTenantId, "Antrean offline shift belum dicek"],
    );
    expect(alerts.rows.length).toBeGreaterThan(0);
  });

  it("re-review O3 P3: a kit on another device of the shift needs the force close", async () => {
    const till = await newTill(app);
    await issuePosOfflineKit(scope, callerOf(till), outletId, till.shiftId, {
      resumeSequenceId: null,
    });
    // A second kit holder: its queue count never reaches this close.
    await owner.query(
      `INSERT INTO pos_offline_kits (tenant_id, outlet_id, device_id, shift_id, sequence_id, issued_by, catalog_version, snapshot, issued_at, expires_at)
       SELECT tenant_id, outlet_id, gen_random_uuid(), shift_id, sequence_id, issued_by, catalog_version, snapshot, issued_at, expires_at
         FROM pos_offline_kits WHERE shift_id = $1 LIMIT 1`,
      [till.shiftId],
    );
    await expect(
      closeShiftExactly({
        scope,
        cashierId: till.cashier.userId,
        deviceId: till.deviceId,
        shiftId: till.shiftId,
        supervisorId: await outletSupervisor(app, "Offline Two Kits Close"),
        drawerIdr: 500_000,
        offlineQueuePending: 0,
      }),
    ).rejects.toMatchObject({ code: "OFFLINE_QUEUE_UNVERIFIED", status: 409 });
  });

  it("review O3 P2 1: a shift without a kit closes as before, count or not", async () => {
    const till = await newTill(app);
    await closeShiftExactly({
      scope,
      cashierId: till.cashier.userId,
      deviceId: till.deviceId,
      shiftId: till.shiftId,
      supervisorId: await outletSupervisor(app, "Offline No Kit Close"),
      drawerIdr: 500_000,
      offlineQueuePending: null,
    });
  });

  it("P3 3: refuses a shift that was really closed", async () => {
    const till = await newTill(app);
    await closeShiftExactly({
      scope,
      cashierId: till.cashier.userId,
      deviceId: till.deviceId,
      shiftId: till.shiftId,
      supervisorId: await outletSupervisor(app, "Offline Kit Close"),
      drawerIdr: 500_000,
    });
    await expect(
      issuePosOfflineKit(scope, callerOf(till), outletId, till.shiftId, {
        resumeSequenceId: null,
      }),
    ).rejects.toMatchObject({ code: "SHIFT_NOT_OPEN" });
    expect(await offlineRunsOf(till.deviceId)).toEqual([]);
  });

  it("P3 3: refuses the shift's cashier once shift.cash.operate is gone", async () => {
    const till = await newTill(app);
    await owner.query(
      "UPDATE role_assignments SET valid_until = now() - interval '1 second' WHERE tenant_id = $1 AND user_id = $2",
      [seededTenantId, till.cashier.userId],
    );
    await expect(
      issuePosOfflineKit(scope, callerOf(till), outletId, till.shiftId, {
        resumeSequenceId: null,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await offlineRunsOf(till.deviceId)).toEqual([]);
  });

  it("P3 3: the HTTP route needs the trusted origin", async () => {
    const till = await newTill(app, false);
    const path = `/api/outlets/${encodeURIComponent(seededOutletA)}/pos/shifts/${till.shiftId}/offline-kit`;
    const token = signDeviceToken({
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      tenantId: seededTenantId,
      brandId: null,
      deviceId: till.deviceId,
    });
    const refused = await till.cashier.client
      .post(path)
      .set({ Host: seededHostname })
      .set(DEVICE_TOKEN_HEADER, token)
      .send({ resumeSequenceId: null });
    expect(refused.status).toBe(403);
    expect(await offlineRunsOf(till.deviceId)).toEqual([]);
    const issued = await till.cashier.client
      .post(path)
      .set({ Host: seededHostname })
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, token)
      .send({ resumeSequenceId: null });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(posOfflineKitSchema.parse(issued.body.data).deviceId).toBe(
      till.deviceId,
    );
  });

  it("P3 3: the 0534 preflight stops on a run already printing under L<n>", async () => {
    const migration = readFileSync(
      new URL("../../drizzle/0534_pos_offline_kits.sql", import.meta.url),
      "utf8",
    );
    const preflight = /DO \$\$[\s\S]*?END \$\$;/.exec(migration)?.[0];
    expect(preflight).toContain("O1 preflight");
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [seededTenantId],
      );
      // The state before 0534: no L rule yet, a device run named L<n>.
      await client.query(
        "ALTER TABLE receipt_sequences DROP CONSTRAINT receipt_sequences_offline_prefix_check",
      );
      await client.query(
        `INSERT INTO receipt_sequences (tenant_id, outlet_id, device_id, prefix, series)
         VALUES ($1, $2, $3, 'L999998', 'device')`,
        [seededTenantId, seededOutletA, randomUUID()],
      );
      await client.query(
        "ALTER TABLE receipt_sequences NO FORCE ROW LEVEL SECURITY",
      );
      await expect(client.query(preflight!)).rejects.toMatchObject({
        code: "23514",
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
