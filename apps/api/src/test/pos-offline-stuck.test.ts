// 1273 second opinion P2-1 (CTO): a sale the batch refuses for good
// (kit_unknown, sequence_gap, a refused device) is reported by the staff
// session on the tablet with a supervisor's PIN, never the device token. Real
// PostgreSQL with RLS, the shift opened and the kit issued through the real
// services, the report through the real service and once over HTTP.
//
// Assumptions (from the brief, not the implementation):
// - The sale is stored `held` / `stuck_<reason>`: no order, tender, receipt,
//   order.paid event (so no stock or journal), audited with the approver.
// - Idempotent per eventId: a resend answers the same, one row; an eventId
//   already ingested answers `ingested`, no second row.
// - No supervisor PIN (wrong, own, or a supervisor without the permission):
//   refused, nothing stored. A kit outside the session's tenant/outlet/run is
//   refused.
// - A revoked device: the batch refuses it, the staff session still reports.
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
  offlineSaleEventSchema,
  reportPosOfflineStuckInputSchema,
  submitPosOfflineBatchInputSchema,
  type OfflineSaleEvent,
  type OfflineStuckReason,
  type PosOfflineKit,
} from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import {
  type DeviceOutletResolver,
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  reportPosOfflineStuck,
  submitPosOfflineBatch,
} from "../services/pos-offline-batch.service.ts";
import { issuePosOfflineKit } from "../services/pos-offline-kit.service.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { originHeader } from "./helpers.ts";
import {
  owner,
  seededHostname,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers.ts";
import { outletSupervisor } from "./pos-offline-test-helpers.ts";

const PIN = "582914";
const tenant = establishTenantContext({
  tenantId: tenantIdSchema.parse(seededTenantId),
  brandId: null,
  source: "session",
});
const scope = establishScopedTenantContext(tenant, { kind: "tenant" });
const outletId = outletIdSchema.parse(seededOutletA);

type Till = { cashier: Staff; deviceId: string; shiftId: string };
const devices = new Set<string>();
/** Registered devices moved to another outlet (device id -> outlet id). */
const movedDevices = new Map<string, string>();
let itemId = "";
let app: ReturnType<typeof createApp>;
let supervisor = "";
let tenantOwner = "";
let a: Till;

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

const testResolver: DeviceOutletResolver = async ({ tenantId, deviceId }) =>
  tenantId === seededTenantId
    ? (movedDevices.get(deviceId) ??
      (devices.has(deviceId) ? seededOutletA : null))
    : null;

const callerOf = (till: Till) => ({
  userId: userIdSchema.parse(till.cashier.userId),
  deviceId: till.deviceId,
});

async function newTill(): Promise<Till> {
  const cashier = await staffWithRole(app, {
    template: "cashier",
    label: "Offline Stuck Cashier",
  });
  const deviceId = randomUUID();
  devices.add(deviceId);
  await asOwner((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Tablet offline stuck', now() - interval '1 minute')`,
      [deviceId, seededTenantId, seededOutletA],
    ),
  );
  const shift = await openPosShift(
    scope,
    { userId: userIdSchema.parse(cashier.userId), deviceId },
    outletId,
    { openingFloatIdr: idr(500_000), idempotencyKey: randomUUID() },
  );
  return { cashier, deviceId, shiftId: shift.id };
}

/** A dine-in item priced today, tax free (the most specific tax rule). */
async function seedMenu(): Promise<void> {
  await asOwner(async (client) => {
    const { rows } = await client.query<{ brand_id: string; today: string }>(
      `SELECT brand_id, ((now() AT TIME ZONE timezone)::date - 1)::text AS today
         FROM outlets WHERE id = $1`,
      [seededOutletA],
    );
    const brandId = rows[0]!.brand_id;
    const categoryId = randomUUID();
    itemId = randomUUID();
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Offline Stuck Uji', 0)`,
      [categoryId, seededTenantId, brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, course, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Offline Tertahan', 'drink', true, $5)`,
      [itemId, seededTenantId, brandId, categoryId, randomUUID()],
    );
    // Dine-in: the batch file owns today's takeaway list of outlet A.
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM price_lists
        WHERE tenant_id = $1 AND outlet_id = $2 AND channel = 'dine_in' AND effective_from = $3`,
      [seededTenantId, seededOutletA, rows[0]!.today],
    );
    const priceListId = existing.rows[0]?.id ?? randomUUID();
    if (!existing.rows[0])
      await client.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, 'dine_in', $4)`,
        [priceListId, seededTenantId, seededOutletA, rows[0]!.today],
      );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 20000)`,
      [randomUUID(), seededTenantId, priceListId, itemId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, $3, $4, 'Bebas pajak uji offline stuck', 'pbjt', 0, NULL, '[]',
               jsonb_build_object('itemClasses', '[]'::jsonb, 'categoryIds', '[]'::jsonb,
                                  'itemIds', jsonb_build_array($5::text)),
               false, true, true, 1, $6, 'published', now(),
               (SELECT id FROM "user" ORDER BY created_at LIMIT 1))`,
      [
        randomUUID(),
        seededTenantId,
        seededOutletA,
        `STUCK-${itemId.slice(0, 8)}`.toUpperCase(),
        itemId,
        rows[0]!.today,
      ],
    );
  });
}

const kitFor = (till: Till) =>
  issuePosOfflineKit(scope, callerOf(till), outletId, till.shiftId, {
    resumeSequenceId: null,
  });

/** One offline cash sale of the seeded item at the kit's price. */
function sale(kit: PosOfflineKit, sequenceNumber: number): OfflineSaleEvent {
  const item = kit.catalogs.dine_in.items.find((row) => row.id === itemId);
  if (!item || item.plainPriceIdr === null)
    throw new Error("The kit prices no seeded item");
  const total = Number(item.plainPriceIdr);
  return offlineSaleEventSchema.parse({
    eventId: createUlid(),
    kitId: kit.kitId,
    sequenceId: kit.receiptRun.sequenceId,
    sequenceNumber,
    serviceType: "dine_in",
    paidAt: new Date().toISOString(),
    lines: [
      {
        menuItemId: item.id,
        variantId: null,
        name: item.name,
        quantity: 1,
        unitPriceIdr: total,
        modifiers: [],
        modifiersTotalIdr: 0,
        lineTotalIdr: total,
      },
    ],
    subtotalIdr: total,
    serviceChargeIdr: 0,
    taxIdr: 0,
    roundingIdr: 0,
    totalIdr: total,
    pricesIncludeTax: false,
    tenders: [{ method: "cash", amountIdr: total, receivedIdr: total }],
  });
}

const report = (
  till: Till,
  event: OfflineSaleEvent,
  stuck: OfflineStuckReason,
  over: Record<string, unknown> = {},
  caller: { userId: string; deviceId: string | null } = callerOf(till),
  outlet = outletId,
) =>
  reportPosOfflineStuck(
    scope,
    { userId: userIdSchema.parse(caller.userId), deviceId: caller.deviceId },
    outlet,
    reportPosOfflineStuckInputSchema.parse({
      event,
      stuck,
      reason: "Tablet tidak bisa mengirim penjualan ini",
      approverUserId: supervisor,
      pin: PIN,
      ...over,
    }),
  );

async function countOf(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

const rowsOf = (eventId: string) =>
  countOf(
    "SELECT count(*) AS n FROM pos_offline_sales WHERE tenant_id = $1 AND event_id = $2",
    [seededTenantId, ulidToUuid(eventId)],
  );

/** Order, tender, receipt and order.paid (stock + journal) of the sale. */
const moneyTrailOf = async (eventId: string) => ({
  orders: await countOf(
    "SELECT count(*) AS n FROM orders WHERE tenant_id = $1 AND id = $2",
    [seededTenantId, ulidToUuid(eventId)],
  ),
  tenders: await countOf(
    "SELECT count(*) AS n FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = $2",
    [seededTenantId, ulidToUuid(eventId)],
  ),
  receipts: await countOf(
    "SELECT count(*) AS n FROM pos_receipts WHERE tenant_id = $1 AND order_id = $2",
    [seededTenantId, ulidToUuid(eventId)],
  ),
  paidEvents: await countOf(
    `SELECT count(*) AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_type = 'order' AND aggregate_id = $2
        AND event->>'name' = 'order.paid'`,
    [seededTenantId, ulidToUuid(eventId)],
  ),
});

const lastNumberOf = async (sequenceId: string) => {
  const { rows } = await owner.query<{ last_number: number }>(
    "SELECT last_number FROM receipt_sequences WHERE tenant_id = $1 AND id = $2",
    [seededTenantId, sequenceId],
  );
  return Number(rows[0]!.last_number);
};

beforeAll(async () => {
  app = createApp();
  setDeviceOutletResolver(testResolver);
  await seedMenu();
  supervisor = await outletSupervisor(app, "Offline Stuck Supervisor");
  await setStaffPin(
    tenant,
    supervisor,
    { outletId: seededOutletA, userId: supervisor },
    { pin: PIN },
  );
  tenantOwner = (
    await staffWithRole(app, {
      template: "owner",
      label: "Offline Stuck Owner",
    })
  ).userId;
  a = await newTill();
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.end();
});

describe("offline stuck report (1273 P2-1)", () => {
  it("stores a sale behind a gap held / stuck_sequence_gap: no order, stock or journal; audited", async () => {
    const kit = await kitFor(a);
    const before = await lastNumberOf(kit.receiptRun.sequenceId);
    const event = sale(kit, before + 2);
    const batch = await submitPosOfflineBatch(scope, callerOf(a), outletId, {
      events: submitPosOfflineBatchInputSchema.parse({ events: [event] })
        .events,
    });
    expect(batch.results[0]).toMatchObject({
      status: "rejected",
      reason: "sequence_gap",
    });

    const answer = await report(a, event, "sequence_gap");
    expect(answer).toMatchObject({
      eventId: event.eventId,
      status: "held",
      reason: "stuck_sequence_gap",
    });
    const { rows } = await owner.query<{
      state: string;
      reason: string;
      device_id: string;
      received_by: string;
    }>(
      "SELECT state, reason, device_id, received_by FROM pos_offline_sales WHERE tenant_id = $1 AND event_id = $2",
      [seededTenantId, ulidToUuid(event.eventId)],
    );
    expect(rows).toEqual([
      {
        state: "held",
        reason: "stuck_sequence_gap",
        device_id: a.deviceId,
        received_by: a.cashier.userId,
      },
    ]);
    expect(await moneyTrailOf(event.eventId)).toEqual({
      orders: 0,
      tenders: 0,
      receipts: 0,
      paidEvents: 0,
    });
    // A gap is never written off: the run keeps its high-water.
    expect(await lastNumberOf(kit.receiptRun.sequenceId)).toBe(before);
    expect(
      await countOf(
        `SELECT count(*) AS n FROM audit_logs WHERE tenant_id = $1
           AND event->>'action' = 'pos_offline_sale.stuck_reported'
           AND event::text LIKE $2 AND event::text LIKE $3`,
        [seededTenantId, `%${event.eventId}%`, `%${supervisor}%`],
      ),
    ).toBe(1);
    // Review P3-4: supervisors and owners are alerted (finance must see it).
    const { rows: alerted } = await owner.query<{ user_id: string }>(
      `SELECT user_id FROM notifications
        WHERE tenant_id = $1 AND title = 'Penjualan offline perlu dicek' AND body LIKE $2`,
      [seededTenantId, `%${answer.receiptNumber}%PIN supervisor%`],
    );
    const alertedIds = alerted.map((row) => row.user_id.toLowerCase());
    expect(alertedIds).toContain(supervisor.toLowerCase());
    expect(alertedIds).toContain(tenantOwner.toLowerCase());

    // A resend is the same answer, one row.
    expect(await report(a, event, "sequence_gap")).toEqual(answer);
    expect(await rowsOf(event.eventId)).toBe(1);
  });

  it("answers ingested for a sale the cloud already took, without a second row", async () => {
    const kit = await kitFor(a);
    const event = sale(
      kit,
      (await lastNumberOf(kit.receiptRun.sequenceId)) + 1,
    );
    const batch = await submitPosOfflineBatch(scope, callerOf(a), outletId, {
      events: [event],
    });
    expect(batch.results[0]?.status).toBe("ingested");
    expect(await report(a, event, "kit_unknown")).toMatchObject({
      eventId: event.eventId,
      status: "ingested",
      reason: null,
    });
    expect(await rowsOf(event.eventId)).toBe(1);
    expect((await moneyTrailOf(event.eventId)).orders).toBe(1);
  });

  it("needs another person's right supervisor PIN with the permission; nothing is stored otherwise", async () => {
    const kit = await kitFor(a);
    const event = sale(
      kit,
      (await lastNumberOf(kit.receiptRun.sequenceId)) + 2,
    );
    await expect(
      report(a, event, "sequence_gap", { pin: "111111" }),
    ).rejects.toThrow();
    await expect(
      report(a, event, "sequence_gap", { approverUserId: a.cashier.userId }),
    ).rejects.toMatchObject({ code: "APPROVER_IS_REQUESTER" });
    const other = await staffWithRole(app, {
      template: "cashier",
      label: "Offline Stuck Kasir Lain",
    });
    await setStaffPin(
      tenant,
      other.userId,
      { outletId: seededOutletA, userId: other.userId },
      { pin: PIN },
    );
    await expect(
      report(a, event, "sequence_gap", { approverUserId: other.userId }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await rowsOf(event.eventId)).toBe(0);
  });

  it("review P3-1: refuses a reason that does not hold, so a normal sale is never held", async () => {
    const kit = await kitFor(a);
    const next = sale(kit, (await lastNumberOf(kit.receiptRun.sequenceId)) + 1);
    // The next number is no gap.
    await expect(report(a, next, "sequence_gap")).rejects.toMatchObject({
      status: 409,
      code: "OFFLINE_SALE_NOT_STUCK",
    });
    // The kit's own registered device is neither unknown nor refused.
    for (const stuck of ["kit_unknown", "device_refused"] as const)
      await expect(report(a, next, stuck)).rejects.toMatchObject({
        status: 409,
        code: "OFFLINE_SALE_NOT_STUCK",
      });
    expect(await rowsOf(next.eventId)).toBe(0);
    // Without a device token (a browser) the kit's device must be gone from
    // the outlet, or any staff with a PIN could hold a normal sale.
    for (const stuck of ["kit_unknown", "device_refused"] as const)
      await expect(
        report(a, next, stuck, {}, { ...callerOf(a), deviceId: null }),
      ).rejects.toMatchObject({ status: 409, code: "OFFLINE_SALE_NOT_STUCK" });
    expect(await rowsOf(next.eventId)).toBe(0);
  });

  it("without a device token the report holds once the kit's device is no longer registered at the outlet", async () => {
    const till = await newTill();
    const kit = await kitFor(till);
    const next = sale(kit, (await lastNumberOf(kit.receiptRun.sequenceId)) + 1);
    devices.delete(till.deviceId);
    expect(
      await report(
        till,
        next,
        "kit_unknown",
        {},
        { ...callerOf(till), deviceId: null },
      ),
    ).toMatchObject({ status: "held", reason: "stuck_kit_unknown" });
  });

  it("a registry lookup error is a 503 to retry, not a missing device: nothing is held", async () => {
    const till = await newTill();
    const kit = await kitFor(till);
    const next = sale(kit, (await lastNumberOf(kit.receiptRun.sequenceId)) + 1);
    devices.delete(till.deviceId);
    setDeviceOutletResolver(
      createDeviceOutletResolver({
        lookup: async () => {
          throw new Error("registry down");
        },
      }),
    );
    try {
      for (const caller of [
        { ...callerOf(till), deviceId: null },
        callerOf(till),
      ])
        await expect(
          report(till, next, "kit_unknown", {}, caller),
        ).rejects.toMatchObject({ status: 503 });
      expect(await rowsOf(next.eventId)).toBe(0);
      expect(await lastNumberOf(kit.receiptRun.sequenceId)).toBe(
        next.sequenceNumber - 1,
      );
    } finally {
      setDeviceOutletResolver(testResolver);
    }
  });

  it("a tablet moved to another outlet is not its own device: its report holds", async () => {
    const till = await newTill();
    const kit = await kitFor(till);
    const next = sale(kit, (await lastNumberOf(kit.receiptRun.sequenceId)) + 1);
    // Still registered here: it is the kit's holder, nothing is stuck.
    await expect(report(till, next, "device_refused")).rejects.toMatchObject({
      status: 409,
      code: "OFFLINE_SALE_NOT_STUCK",
    });
    movedDevices.set(till.deviceId, seededOutletB);
    expect(await report(till, next, "device_refused")).toMatchObject({
      status: "held",
      reason: "stuck_device_refused",
    });
  });

  it("refuses a kit outside the session's tenant, outlet or run", async () => {
    const kit = await kitFor(a);
    const event = sale(
      kit,
      (await lastNumberOf(kit.receiptRun.sequenceId)) + 2,
    );
    await expect(
      report(a, { ...event, kitId: randomUUID() }, "kit_unknown"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      report(a, { ...event, sequenceId: randomUUID() }, "kit_unknown"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The kit is outlet A's: an outlet B report is refused (the cashier is
    // tenant wide, so it is the kit that refuses).
    await expect(
      report(
        a,
        event,
        "kit_unknown",
        {},
        callerOf(a),
        outletIdSchema.parse(seededOutletB),
      ),
    ).rejects.toThrow();
    // Another tenant's session never sees the kit (RLS + tenant filter).
    const otherTenant = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(randomUUID()),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    await expect(
      reportPosOfflineStuck(
        otherTenant,
        callerOf(a),
        outletId,
        reportPosOfflineStuckInputSchema.parse({
          event,
          stuck: "kit_unknown",
          reason: "Tablet tidak bisa mengirim",
          approverUserId: supervisor,
          pin: PIN,
        }),
      ),
    ).rejects.toThrow();
    expect(await rowsOf(event.eventId)).toBe(0);
  });

  it("a revoked device: the batch refuses it, the staff session reports over HTTP and the number is used up", async () => {
    const till = await newTill();
    const kit = await kitFor(till);
    const before = await lastNumberOf(kit.receiptRun.sequenceId);
    const event = sale(kit, before + 1);
    devices.delete(till.deviceId);
    await asOwner((client) =>
      client.query(
        `UPDATE devices SET status = 'revoked', revoked_at = now(), revoked_by = $2,
                revoke_reason = 'Tablet hilang'
          WHERE id = $1`,
        [till.deviceId, supervisor],
      ),
    );
    const base = `/api/outlets/${encodeURIComponent(seededOutletA)}/pos`;
    const batch = await till.cashier.client
      .post(`${base}/offline-batch`)
      .set({ Host: seededHostname })
      .set(originHeader)
      .send({ events: [event] });
    expect(batch.status).toBe(403);

    const body = {
      event,
      stuck: "device_refused",
      reason: "Perangkat dicabut, penjualan masih di tablet",
      approverUserId: supervisor,
      pin: PIN,
    };
    const refused = await till.cashier.client
      .post(`${base}/offline-stuck`)
      .set({ Host: seededHostname })
      .send(body);
    expect(refused.status).toBe(403);
    const response = await till.cashier.client
      .post(`${base}/offline-stuck`)
      .set({ Host: seededHostname })
      .set(originHeader)
      .send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      eventId: event.eventId,
      status: "held",
      reason: "stuck_device_refused",
    });
    expect(JSON.stringify(response.body)).not.toContain(PIN);
    expect(await moneyTrailOf(event.eventId)).toEqual({
      orders: 0,
      tenders: 0,
      receipts: 0,
      paidEvents: 0,
    });
    // The number continued the run: used up, like any held sale.
    expect(await lastNumberOf(kit.receiptRun.sequenceId)).toBe(before + 1);
  });
});
