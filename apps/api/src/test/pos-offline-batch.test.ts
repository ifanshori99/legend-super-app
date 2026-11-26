// O2 offline batch ingest (bead legend-wasr7.6; docs/design/cloud-only-release.md
// §2 and "Keputusan CTO O2"). Real PostgreSQL with RLS: the shift is opened and
// the kit issued through the real services (O1), the batch goes through the
// real service as legend_app (and once through the HTTP route), fixtures and
// checks are read as the migration owner.
//
// Assumptions (from the design and the CTO decisions, not the implementation):
// - One event = one sale = one cloud order; the event id is the order id. A
//   replay (same event id) is `duplicate`: never a second order, tender,
//   receipt or outbox event.
// - Numbers continue the run exactly: a gap is `rejected` / `sequence_gap` and
//   nothing is stored (the tablet resends); another event under a number the
//   cloud already holds is `rejected` / `number_taken`.
// - (a) Offline cash enters the kit shift's drawer (its expected cash).
// - (b) Every ingested sale holds its `L<n>` receipt row.
// - (c) Stock is deducted by the cloud: the ingest appends the normal
//   `order.paid` outbox event, which the recipe consumer turns into the
//   `sale:order:<id>` deduction.
// - (d) Ledger `pos_offline_sales`, not `edge_order_ingests`: the order is a
//   normal cloud order and refunds take the normal cloud path.
// - Amounts come from the payload; a price that differs from the kit is
//   ingested with the `price_mismatch` flag. Tenders that do not settle the
//   total are `held`: stored for finance, no order, the number is used up.
// - Review O1 P3 4: a sale on a run already retired (`offline_epoch`) is still
//   ingested (the money was taken).
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
import type { EventEnvelope } from "@starter/shared/events";
import { posOverrideIdSchema } from "@starter/shared/access/override";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import {
  offlineSaleEventSchema,
  submitPosOfflineBatchInputSchema,
  type OfflineSaleEvent,
  type PosOfflineKit,
} from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { submitPosOfflineBatch } from "../services/pos-offline-batch.service.ts";
import { issuePosOfflineKit } from "../services/pos-offline-kit.service.ts";
import { refundPosOrder } from "../services/pos-order-corrections.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { liveExpectedCashIdr } from "../services/pos-shift-support.ts";
import { deliverRecipeDeductionEvent } from "../services/recipe-deduction.service.ts";
import { posShifts } from "../db/schema/pos-shift.ts";
import { and, eq } from "drizzle-orm";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  owner,
  seededHostname,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers.ts";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";

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
type Menu = { itemId: string; name: string; priceIdr: number };
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

const callerOf = (till: Till) => ({
  userId: userIdSchema.parse(till.cashier.userId),
  deviceId: till.deviceId,
});

async function newTill(app: ReturnType<typeof createApp>): Promise<Till> {
  const cashier = await staffWithRole(app, {
    template: "cashier",
    label: "Offline Batch Cashier",
  });
  const deviceId = randomUUID();
  devices.add(deviceId);
  await asOwner((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Tablet offline batch', now() - interval '1 minute')`,
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

/** A menu item the cloud prices for takeaway POS today (own price list). */
async function seedMenu(): Promise<void> {
  await asOwner(async (client) => {
    const { rows } = await client.query<{ brand_id: string; today: string }>(
      `SELECT brand_id, ((now() AT TIME ZONE timezone)::date - 1)::text AS today
         FROM outlets WHERE id = $1`,
      [seededOutletA],
    );
    const brandId = rows[0]!.brand_id;
    const categoryId = randomUUID();
    const itemId = randomUUID();
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Offline Batch Uji', 0)`,
      [categoryId, seededTenantId, brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, course, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Es Teh Offline', 'drink', true, $5)`,
      [itemId, seededTenantId, brandId, categoryId, randomUUID()],
    );
    const priceListId = randomUUID();
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', $4)`,
      [priceListId, seededTenantId, seededOutletA, rows[0]!.today],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 20000)`,
      [randomUUID(), seededTenantId, priceListId, itemId],
    );
  });
}

/** A plain-priced takeaway item of the kit (no variant, no required group). */
function menuOf(kit: PosOfflineKit): Menu {
  const item = kit.catalogs.takeaway.items.find(
    (row) =>
      row.plainPriceIdr !== null &&
      row.modifierGroups.every((group) => !group.required && group.min === 0),
  );
  if (!item) throw new Error("The kit prices no plain takeaway item");
  return {
    itemId: item.id,
    name: item.name,
    priceIdr: Number(item.plainPriceIdr),
  };
}

async function kitFor(till: Till, resume: string | null = null) {
  return issuePosOfflineKit(scope, callerOf(till), outletId, till.shiftId, {
    resumeSequenceId: resume,
  });
}

/** One offline cash (or EDC) sale of `quantity` x the menu item, no tax. */
function sale(
  kit: PosOfflineKit,
  menu: Menu,
  sequenceNumber: number,
  options: {
    quantity?: number;
    unitPriceIdr?: number;
    method?: "cash" | "edc_card";
    tenderIdr?: number;
    eventId?: string;
  } = {},
): OfflineSaleEvent {
  const quantity = options.quantity ?? 1;
  const unit = options.unitPriceIdr ?? menu.priceIdr;
  const total = unit * quantity;
  const tendered = options.tenderIdr ?? total;
  return offlineSaleEventSchema.parse({
    eventId: options.eventId ?? createUlid(),
    kitId: kit.kitId,
    sequenceId: kit.receiptRun.sequenceId,
    sequenceNumber,
    serviceType: "takeaway",
    paidAt: new Date().toISOString(),
    lines: [
      {
        menuItemId: menu.itemId,
        variantId: null,
        name: menu.name,
        quantity,
        unitPriceIdr: unit,
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
    tenders: [
      (options.method ?? "cash") === "cash"
        ? { method: "cash", amountIdr: tendered, receivedIdr: tendered + 5000 }
        : {
            method: "edc_card",
            amountIdr: tendered,
            reference: `SLIP-${sequenceNumber}`,
          },
    ],
  });
}

const submit = (till: Till, events: OfflineSaleEvent[]) =>
  submitPosOfflineBatch(scope, callerOf(till), outletId, {
    events: submitPosOfflineBatchInputSchema.parse({ events }).events,
  });

async function countOf(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

const ordersOf = (eventId: string) =>
  countOf("SELECT count(*) AS n FROM orders WHERE tenant_id = $1 AND id = $2", [
    seededTenantId,
    ulidToUuid(eventId),
  ]);

async function paidEventsOf(eventId: string): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: EventEnvelope }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_type = 'order' AND aggregate_id = $2
        AND event->>'name' = 'order.paid'`,
    [seededTenantId, ulidToUuid(eventId)],
  );
  return rows.map((row) => row.event);
}

async function expectedCash(shiftId: string): Promise<number> {
  return withTenant(db, scope, async (tx) => {
    const [shift] = await tx
      .select()
      .from(posShifts)
      .where(
        and(
          eq(posShifts.tenantId, scope.tenant.tenantId),
          eq(posShifts.id, shiftId),
        ),
      );
    return Number(await liveExpectedCashIdr(tx, shift!));
  });
}

let app: ReturnType<typeof createApp>;
let a: Till;
let b: Till;

beforeAll(async () => {
  app = createApp();
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === seededTenantId && devices.has(deviceId) ? seededOutletA : null,
  );
  await seedMenu();
  a = await newTill(app);
  b = await newTill(app);
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.end();
});

describe("O2 contract", () => {
  it("takes cash and manual EDC (slip reference required) only", () => {
    const base = {
      eventId: createUlid(),
      kitId: randomUUID(),
      sequenceId: randomUUID(),
      sequenceNumber: 1,
      serviceType: "takeaway",
      paidAt: new Date().toISOString(),
      lines: [
        {
          menuItemId: randomUUID(),
          variantId: null,
          name: "Kopi",
          quantity: 1,
          unitPriceIdr: 10000,
          modifiers: [],
          modifiersTotalIdr: 0,
          lineTotalIdr: 10000,
        },
      ],
      subtotalIdr: 10000,
      serviceChargeIdr: 0,
      taxIdr: 0,
      roundingIdr: 0,
      totalIdr: 10000,
      pricesIncludeTax: false,
    };
    for (const tender of [
      { method: "qris", amountIdr: 10000 },
      { method: "points", amountIdr: 10000 },
      { method: "edc_card", amountIdr: 10000 },
      { method: "cash", amountIdr: 10000 },
    ])
      expect(
        offlineSaleEventSchema.safeParse({ ...base, tenders: [tender] })
          .success,
      ).toBe(false);
    expect(
      offlineSaleEventSchema.safeParse({
        ...base,
        tenders: [{ method: "edc_card", amountIdr: 10000, reference: "A1" }],
      }).success,
    ).toBe(true);
  });
});

describe("O2 ingest", () => {
  it("turns an offline cash sale into a cloud order: L receipt, drawer cash, order.paid", async () => {
    const kit = await kitFor(a);
    const menu = menuOf(kit);
    const before = await expectedCash(a.shiftId);
    const event = sale(kit, menu, 1, { quantity: 2 });
    const result = await submit(a, [event]);
    expect(result.results).toEqual([
      {
        eventId: event.eventId,
        status: "ingested",
        reason: null,
        flags: [],
        receiptNumber: `${kit.receiptRun.prefix}-000001`,
      },
    ]);
    expect(result.runs).toEqual([
      { sequenceId: kit.receiptRun.sequenceId, lastNumber: 1 },
    ]);

    const { rows: order } = await owner.query(
      `SELECT o.status, o.channel, o.total_idr, o.number, p.shift_id, p.device_id, p.cashier_id
         FROM orders o JOIN pos_orders p ON p.tenant_id = o.tenant_id AND p.order_id = o.id
        WHERE o.tenant_id = $1 AND o.id = $2`,
      [seededTenantId, ulidToUuid(event.eventId)],
    );
    expect(order[0]).toMatchObject({
      status: "completed",
      channel: "pos",
      total_idr: String(menu.priceIdr * 2),
      number: `${kit.receiptRun.prefix}-000001`,
      shift_id: a.shiftId,
      device_id: a.deviceId,
      cashier_id: a.cashier.userId,
    });
    // (b) the L receipt row, on the device's offline run.
    const { rows: receipt } = await owner.query(
      `SELECT number, sequence_id, sequence_number, status FROM pos_receipts
        WHERE tenant_id = $1 AND order_id = $2`,
      [seededTenantId, ulidToUuid(event.eventId)],
    );
    expect(receipt).toEqual([
      {
        number: `${kit.receiptRun.prefix}-000001`,
        sequence_id: kit.receiptRun.sequenceId,
        sequence_number: 1,
        status: "issued",
      },
    ]);
    // (a) the cash is in the kit shift's drawer.
    expect(await expectedCash(a.shiftId)).toBe(before + menu.priceIdr * 2);
    const { rows: tender } = await owner.query(
      `SELECT method, shift_id, amount_idr FROM pos_order_tenders
        WHERE tenant_id = $1 AND order_id = $2`,
      [seededTenantId, ulidToUuid(event.eventId)],
    );
    expect(tender).toEqual([
      {
        method: "cash",
        shift_id: a.shiftId,
        amount_idr: String(menu.priceIdr * 2),
      },
    ]);
    // (d) its own ledger, never the edge's.
    const { rows: ledger } = await owner.query(
      `SELECT state, reason, sequence_number, shift_id FROM pos_offline_sales
        WHERE tenant_id = $1 AND event_id = $2`,
      [seededTenantId, ulidToUuid(event.eventId)],
    );
    expect(ledger).toEqual([
      { state: "ingested", reason: null, sequence_number: 1, shift_id: a.shiftId },
    ]);
    expect(
      await countOf(
        "SELECT count(*) AS n FROM edge_order_ingests WHERE tenant_id = $1 AND order_id = $2",
        [seededTenantId, ulidToUuid(event.eventId)],
      ),
    ).toBe(0);
    // The kit run's high-water moved: the next kit continues from it.
    const next = await kitFor(a, kit.receiptRun.sequenceId);
    expect(next.receiptRun.lastNumber).toBe(1);
  });

  it("(c) deducts stock through the normal order.paid consumer", async () => {
    const kit = await kitFor(a);
    const menu = menuOf(kit);
    const n = kit.receiptRun.lastNumber + 1;
    const event = sale(kit, menu, n);
    expect((await submit(a, [event])).results[0]!.status).toBe("ingested");
    const paid = await paidEventsOf(event.eventId);
    expect(paid).toHaveLength(1);
    await deliverRecipeDeductionEvent(scope, paid[0]!);
    expect(
      await countOf(
        "SELECT count(*) AS n FROM recipe_deductions WHERE tenant_id = $1 AND idempotency_key = $2",
        [seededTenantId, `sale:order:${event.eventId}`],
      ),
    ).toBe(1);
  });

  it("is idempotent per event id: a replayed batch is duplicate, nothing twice", async () => {
    const kit = await kitFor(a);
    const menu = menuOf(kit);
    const n = kit.receiptRun.lastNumber + 1;
    const events = [sale(kit, menu, n), sale(kit, menu, n + 1)];
    const before = await expectedCash(a.shiftId);
    const first = await submit(a, events);
    expect(first.results.map((row) => row.status)).toEqual([
      "ingested",
      "ingested",
    ]);
    const replay = await submit(a, events);
    expect(replay.results.map((row) => row.status)).toEqual([
      "duplicate",
      "duplicate",
    ]);
    expect(replay.results.map((row) => row.receiptNumber)).toEqual(
      first.results.map((row) => row.receiptNumber),
    );
    for (const event of events) {
      expect(await ordersOf(event.eventId)).toBe(1);
      expect(await paidEventsOf(event.eventId)).toHaveLength(1);
    }
    expect(await expectedCash(a.shiftId)).toBe(before + menu.priceIdr * 2);
  });

  it("refuses a second sale under a number the cloud already holds (number_taken)", async () => {
    const kit = await kitFor(a);
    const menu = menuOf(kit);
    const n = kit.receiptRun.lastNumber + 1;
    await submit(a, [sale(kit, menu, n)]);
    const twin = sale(kit, menu, n);
    const result = await submit(a, [twin]);
    expect(result.results[0]).toMatchObject({
      eventId: twin.eventId,
      status: "rejected",
      reason: "number_taken",
      receiptNumber: null,
    });
    expect(await ordersOf(twin.eventId)).toBe(0);
    expect(
      await countOf(
        "SELECT count(*) AS n FROM pos_offline_sales WHERE tenant_id = $1 AND event_id = $2",
        [seededTenantId, ulidToUuid(twin.eventId)],
      ),
    ).toBe(0);
  });

  it("refuses a gap in the run, stores nothing, then takes the run once the gap is filled", async () => {
    const kit = await kitFor(a);
    const menu = menuOf(kit);
    const n = kit.receiptRun.lastNumber + 1;
    const missing = sale(kit, menu, n);
    const later = sale(kit, menu, n + 1);
    const gap = await submit(a, [later]);
    expect(gap.results[0]).toMatchObject({
      status: "rejected",
      reason: "sequence_gap",
    });
    expect(gap.runs).toEqual([
      { sequenceId: kit.receiptRun.sequenceId, lastNumber: n - 1 },
    ]);
    expect(await ordersOf(later.eventId)).toBe(0);
    // Sent out of order in one batch: the cloud walks them by number.
    const filled = await submit(a, [later, missing]);
    expect(
      Object.fromEntries(
        filled.results.map((row) => [row.eventId, row.status]),
      ),
    ).toEqual({ [missing.eventId]: "ingested", [later.eventId]: "ingested" });
    expect(filled.runs).toEqual([
      { sequenceId: kit.receiptRun.sequenceId, lastNumber: n + 1 },
    ]);
  });

  it("ingests a price that differs from the kit with the price_mismatch flag", async () => {
    const kit = await kitFor(a);
    const menu = menuOf(kit);
    const event = sale(kit, menu, kit.receiptRun.lastNumber + 1, {
      unitPriceIdr: menu.priceIdr + 1000,
    });
    const result = await submit(a, [event]);
    expect(result.results[0]).toMatchObject({
      status: "ingested",
      flags: ["price_mismatch"],
    });
    const { rows } = await owner.query(
      "SELECT total_idr FROM orders WHERE tenant_id = $1 AND id = $2",
      [seededTenantId, ulidToUuid(event.eventId)],
    );
    // R2: the amount the guest paid, never repriced.
    expect(rows[0]).toEqual({ total_idr: String(menu.priceIdr + 1000) });
  });

  it("holds a sale whose tenders do not settle the total: stored, no order, number used", async () => {
    const kit = await kitFor(a);
    const menu = menuOf(kit);
    const n = kit.receiptRun.lastNumber + 1;
    const bad = sale(kit, menu, n, { tenderIdr: menu.priceIdr - 1000 });
    const result = await submit(a, [bad]);
    expect(result.results[0]).toMatchObject({
      status: "held",
      reason: "money_mismatch",
      receiptNumber: `${kit.receiptRun.prefix}-${String(n).padStart(6, "0")}`,
    });
    expect(await ordersOf(bad.eventId)).toBe(0);
    const { rows } = await owner.query(
      "SELECT state, reason, payload->>'eventId' AS event FROM pos_offline_sales WHERE tenant_id = $1 AND event_id = $2",
      [seededTenantId, ulidToUuid(bad.eventId)],
    );
    expect(rows).toEqual([
      { state: "held", reason: "money_mismatch", event: bad.eventId },
    ]);
    expect((await submit(a, [bad])).results[0]!.status).toBe("duplicate");
    // The number is accounted for: the run continues after it.
    expect(
      (await submit(a, [sale(kit, menu, n + 1)])).results[0]!.status,
    ).toBe("ingested");
  });

  it("refuses another device's kit and stores nothing", async () => {
    const kit = await kitFor(a);
    const menu = menuOf(kit);
    const event = sale(kit, menu, kit.receiptRun.lastNumber + 1);
    const result = await submit(b, [event]);
    expect(result.results[0]).toMatchObject({
      status: "rejected",
      reason: "kit_unknown",
    });
    expect(await ordersOf(event.eventId)).toBe(0);
  });

  it("review O1 P3 4: still ingests a sale on a run retired as offline_epoch", async () => {
    const old = await kitFor(b);
    const menu = menuOf(old);
    // A second request without the run (lost storage, or a racing request)
    // retires the run the tablet still sells on.
    const fresh = await kitFor(b, null);
    expect(fresh.receiptRun.sequenceId).not.toBe(old.receiptRun.sequenceId);
    const event = sale(old, menu, old.receiptRun.lastNumber + 1);
    const result = await submit(b, [event]);
    expect(result.results[0]).toMatchObject({
      status: "ingested",
      receiptNumber: `${old.receiptRun.prefix}-000001`,
    });
  });

  it("(d) refunds an ingested offline sale through the normal cloud refund path", async () => {
    const kit = await kitFor(a);
    const menu = menuOf(kit);
    const event = sale(kit, menu, kit.receiptRun.lastNumber + 1, {
      method: "edc_card",
    });
    expect((await submit(a, [event])).results[0]!.status).toBe("ingested");

    const supervisor = agent(app);
    await signUp(supervisor, "Offline Batch Supervisor");
    const session = await supervisor.get("/api/auth/get-session");
    const approverId = session.body.user.id as string;
    const { rows: roles } = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'supervisor'",
      [seededTenantId],
    );
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
      [seededTenantId, approverId, roles[0]!.id, seededOutletA],
    );
    const amountIdr = menu.priceIdr;
    const overrideId = createUlid();
    const reason = "Refund penjualan offline O2";
    await asOwner((client) =>
      client.query(
        `INSERT INTO pos_overrides (id, tenant_id, outlet_id, action, method, status,
           requested_by, approved_by, reason, value_idr, object_type, object_id,
           request_fingerprint, created_at, resolved_at)
         VALUES ($1, $2, $3, 'refund', 'supervisor_pin', 'approved', $4, $5, $6,
           $7, 'order', $8, $9, now(), now())`,
        [
          ulidToUuid(overrideId),
          seededTenantId,
          seededOutletA,
          a.cashier.userId,
          approverId,
          reason,
          amountIdr,
          event.eventId,
          pinOverrideFixtureFingerprint({
            requestedBy: a.cashier.userId,
            outletId: seededOutletA,
            action: "refund",
            valueIdr: amountIdr,
            reason,
            objectType: "order",
            objectId: event.eventId,
            approverUserId: approverId,
          }),
        ],
      ),
    );
    const refund = await refundPosOrder(
      scope,
      {
        userId: userIdSchema.parse(a.cashier.userId),
        deviceId: null,
        expectedVersion: null,
      },
      outletId,
      event.eventId,
      {
        idempotencyKey: randomUUID(),
        amountIdr: idr(amountIdr),
        reason: "quality_complaint",
        reasonNote: reason,
        overrideId: posOverrideIdSchema.parse(overrideId),
        approvedBy: userIdSchema.parse(approverId),
      },
    );
    expect(Number(refund.amountIdr)).toBe(amountIdr);
  });

  it("answers over HTTP for the shift's device (trusted origin, device token)", async () => {
    const kit = await kitFor(a);
    const menu = menuOf(kit);
    const event = sale(kit, menu, kit.receiptRun.lastNumber + 1);
    const token = signDeviceToken({
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      tenantId: seededTenantId,
      brandId: null,
      deviceId: a.deviceId,
    });
    const path = `/api/outlets/${encodeURIComponent(seededOutletA)}/pos/offline-batch`;
    const refused = await a.cashier.client
      .post(path)
      .set({ Host: seededHostname })
      .set(DEVICE_TOKEN_HEADER, token)
      .send({ events: [event] });
    expect(refused.status).toBe(403);
    const response = await a.cashier.client
      .post(path)
      .set({ Host: seededHostname })
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, token)
      .send({ events: [event] });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.results[0]).toMatchObject({
      eventId: event.eventId,
      status: "ingested",
    });
  });
});
