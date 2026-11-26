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
import { allocateReceipt } from "../services/pos-receipt.service.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { withTenant } from "../db/tenant.ts";
import { db } from "../db/index.ts";
import {
  owner,
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

async function newTill(app: ReturnType<typeof createApp>): Promise<Till> {
  const cashier = await staffWithRole(app, {
    template: "cashier",
    label: "Offline Kit Cashier",
  });
  const deviceId = randomUUID();
  devices.add(deviceId);
  await asOwner((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
       VALUES ($1, $2, $3, 'pos', 'Tablet offline uji', now() - interval '1 minute', true)`,
      [deviceId, seededTenantId, seededOutletA],
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
