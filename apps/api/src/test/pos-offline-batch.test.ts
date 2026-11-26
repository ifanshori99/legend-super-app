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
  uuidToUlid,
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
import {
  reportPosOfflineConflict,
  submitPosOfflineBatch,
} from "../services/pos-offline-batch.service.ts";
import { issuePosOfflineKit } from "../services/pos-offline-kit.service.ts";
import {
  refundPosOrder,
  voidPosOrderCorrection,
} from "../services/pos-order-corrections.ts";
import {
  receiptGapsForDevice,
  receiptGapsForOutlet,
  receiptGapsForOutletFast,
} from "../services/pos-receipt.service.ts";
import { shiftCapturedTenders } from "../services/pos-shift-print.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { liveExpectedCashIdr } from "../services/pos-shift-support.ts";
import { deliverRecipeDeductionEvent } from "../services/recipe-deduction.service.ts";
import { posShifts } from "../db/schema/pos-shift.ts";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema/index.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import { provisionStandardChart } from "../services/accounting-provisioning.service.ts";
import type { Tx as AccountingTx } from "../services/permission-resolver.ts";
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
import {
  closeShiftExactly,
  outletSupervisor,
} from "./pos-offline-test-helpers.ts";

const scope = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenantIdSchema.parse(seededTenantId),
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);
const outletId = outletIdSchema.parse(seededOutletA);

type Till = {
  cashier: Staff;
  deviceId: string;
  shiftId: string;
  /** The offline run the tablet holds (review O1 P3 2: epochs are rate-limited). */
  run?: string;
};
type Menu = { itemId: string; name: string; priceIdr: number };
const devices = new Set<string>();
let seededItemId = "";

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
    // Review O2 P1: the kit's tax snapshot must compute this item's bill
    // whatever other files left in the shared tenant (an item rule is the
    // most specific): no tax, so the plain sales below match it exactly.
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, $3, $4, 'Bebas pajak uji offline', 'pbjt', 0, NULL, '[]',
               jsonb_build_object('itemClasses', '[]'::jsonb, 'categoryIds', '[]'::jsonb,
                                  'itemIds', jsonb_build_array($5::text)),
               false, true, true, 1, $6, 'published', now(),
               (SELECT id FROM "user" ORDER BY created_at LIMIT 1))`,
      [
        randomUUID(),
        seededTenantId,
        seededOutletA,
        `OFFLINE-${itemId.slice(0, 8)}`.toUpperCase(),
        itemId,
        rows[0]!.today,
      ],
    );
    seededItemId = itemId;
  });
}

/** The seeded takeaway item in the kit (plain price, no modifier group). */
function menuOf(kit: PosOfflineKit): Menu {
  const item = kit.catalogs.takeaway.items.find(
    (row) => row.id === seededItemId && row.plainPriceIdr !== null,
  );
  if (!item) throw new Error("The kit prices no plain takeaway item");
  return {
    itemId: item.id,
    name: item.name,
    priceIdr: Number(item.plainPriceIdr),
  };
}

/** The till's kit; continues the run it holds unless `resume` says otherwise. */
async function kitFor(till: Till, resume?: string | null) {
  const kit = await issuePosOfflineKit(
    scope,
    callerOf(till),
    outletId,
    till.shiftId,
    { resumeSequenceId: resume === undefined ? (till.run ?? null) : resume },
  );
  till.run = kit.receiptRun.sequenceId;
  return kit;
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

/**
 * Posts `events` to the journal in one transaction that is rolled back (the
 * shared tenant keeps its own accounting state) and returns the net
 * debit - credit per account role.
 */
async function netByRole(
  events: EventEnvelope[],
): Promise<Record<string, number>> {
  const client = await owner.connect();
  const rollback = new Error("rollback");
  let byRole: Record<string, number> = {};
  try {
    await drizzle(client, { schema }).transaction(async (raw) => {
      const tx = raw as unknown as AccountingTx;
      await tx.execute(
        sql`SELECT set_config('app.tenant_id', ${seededTenantId}, true), set_config('app.outlet_ids', '*', true)`,
      );
      await tx.execute(
        sql`UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{modules}', (feature_flags->'modules') || '["accounting"]'::jsonb)
               WHERE id = ${seededTenantId} AND NOT (feature_flags->'modules') ? 'accounting'`,
      );
      const entity = (
        await tx.execute<{ id: string }>(
          sql`SELECT legal_entity_id AS id FROM outlets WHERE id = ${seededOutletA}`,
        )
      ).rows[0]!.id;
      await provisionStandardChart(tx as never, scope, entity, null);
      await tx.execute(
        sql`INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
              VALUES (${seededTenantId}, ${entity}, to_char(now(), 'YYYY-MM'))
              ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      );
      const posted = [];
      for (const event of events)
        posted.push(await deliverAutoJournalEvent(scope, event, tx));
      expect(posted.map((row) => row.status)).toEqual(
        events.map(() => "posted"),
      );
      const ids = posted.map((row) =>
        row.status === "posted" ? row.journalEntryId : "",
      );
      const lines = await tx.execute<{ role: string; net: string }>(
        sql`SELECT m.role, sum(l.debit_idr - l.credit_idr)::text AS net
                FROM journal_lines l
                JOIN account_mappings m
                  ON m.tenant_id = l.tenant_id AND m.account_id = l.account_id
               WHERE l.tenant_id = ${seededTenantId}
                 AND l.entry_id = ANY(${`{${ids.join(",")}}`}::uuid[])
               GROUP BY m.role`,
      );
      byRole = Object.fromEntries(
        lines.rows.map((row) => [row.role, Number(row.net)]),
      );
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    client.release();
  }
  return byRole;
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
  // Someone to receive the supervisor alerts.
  await outletSupervisor(app, "Offline Batch Alerts");
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
      {
        state: "ingested",
        reason: null,
        sequence_number: 1,
        shift_id: a.shiftId,
      },
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

  it("review O2 P3 1: holds a second sale under a number the cloud already holds (number_taken)", async () => {
    const kit = await kitFor(a);
    const menu = menuOf(kit);
    const n = kit.receiptRun.lastNumber + 1;
    await submit(a, [sale(kit, menu, n)]);
    const twin = sale(kit, menu, n);
    const result = await submit(a, [twin]);
    expect(result.results[0]).toMatchObject({
      eventId: twin.eventId,
      status: "held",
      reason: "number_taken",
      receiptNumber: null,
    });
    expect(result.runs).toEqual([
      { sequenceId: kit.receiptRun.sequenceId, lastNumber: n },
    ]);
    expect(await ordersOf(twin.eventId)).toBe(0);
    // Stored for finance (the money was taken), so the tablet stops resending.
    const { rows } = await owner.query(
      "SELECT state, reason FROM pos_offline_sales WHERE tenant_id = $1 AND event_id = $2",
      [seededTenantId, ulidToUuid(twin.eventId)],
    );
    expect(rows).toEqual([{ state: "held", reason: "number_taken" }]);
    expect((await submit(a, [twin])).results[0]).toMatchObject({
      status: "duplicate",
      reason: "number_taken",
      receiptNumber: null,
    });
    expect((await submit(a, [sale(kit, menu, n + 1)])).results[0]!.status).toBe(
      "ingested",
    );
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
    // The gap is alerted, never silent.
    expect(
      await countOf(
        "SELECT count(*) AS n FROM notifications WHERE tenant_id = $1 AND body LIKE $2",
        [
          seededTenantId,
          `%${kit.receiptRun.prefix}-${String(n).padStart(6, "0")}%`,
        ],
      ),
    ).toBeGreaterThan(0);
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
    expect((await submit(a, [sale(kit, menu, n + 1)])).results[0]!.status).toBe(
      "ingested",
    );
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
  it("(a) a sale on a shift already closed: ingested, cash outside any drawer, flagged", async () => {
    const till = await newTill(app);
    const kit = await kitFor(till);
    const menu = menuOf(kit);
    await closeShiftExactly({
      scope,
      cashierId: till.cashier.userId,
      deviceId: till.deviceId,
      shiftId: till.shiftId,
      supervisorId: await outletSupervisor(app, "Offline Batch Close"),
      drawerIdr: 500_000,
    });
    const event = sale(kit, menu, kit.receiptRun.lastNumber + 1);
    const result = await submit(till, [event]);
    expect(result.results[0]).toMatchObject({
      status: "ingested",
      flags: ["shift_closed"],
    });
    const { rows } = await owner.query(
      "SELECT shift_id FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = $2",
      [seededTenantId, ulidToUuid(event.eventId)],
    );
    expect(rows).toEqual([{ shift_id: null }]);
    const { rows: shift } = await owner.query(
      "SELECT status, expected_idr FROM pos_shifts WHERE tenant_id = $1 AND id = $2",
      [seededTenantId, till.shiftId],
    );
    // The closed drawer's figures never change.
    expect(shift[0]).toEqual({ status: "closed", expected_idr: "500000" });
  });

  it("review O1 P2: refuses on an edge process and stores nothing", async () => {
    const kit = await kitFor(a);
    const menu = menuOf(kit);
    const event = sale(kit, menu, kit.receiptRun.lastNumber + 1);
    const previous = process.env.EDGE_MODE;
    process.env.EDGE_MODE = "true";
    try {
      await expect(submit(a, [event])).rejects.toMatchObject({
        code: "CONFLICT",
      });
    } finally {
      if (previous === undefined) delete process.env.EDGE_MODE;
      else process.env.EDGE_MODE = previous;
    }
    expect(await ordersOf(event.eventId)).toBe(0);
  });
});

describe("Review O2 fixes", () => {
  let c: Till;
  beforeAll(async () => {
    c = await newTill(app);
  });

  const alertsWith = (text: string) =>
    countOf(
      "SELECT count(*) AS n FROM notifications WHERE tenant_id = $1 AND body LIKE $2",
      [seededTenantId, `%${text}%`],
    );

  it("P1: ingests a rounding the snapshot never allows with amount_mismatch, and alerts", async () => {
    const kit = await kitFor(c);
    const menu = menuOf(kit);
    const quantity = Math.ceil(60_000 / menu.priceIdr);
    const base = sale(kit, menu, kit.receiptRun.lastNumber + 1, { quantity });
    const totalIdr = Number(base.subtotalIdr) - 50_000;
    const event = offlineSaleEventSchema.parse({
      ...base,
      roundingIdr: -50_000,
      totalIdr,
      tenders: [{ method: "cash", amountIdr: totalIdr, receivedIdr: totalIdr }],
    });
    const result = await submit(c, [event]);
    expect(result.results[0]).toMatchObject({
      status: "ingested",
      flags: ["amount_mismatch"],
    });
    expect(await alertsWith(result.results[0]!.receiptNumber!)).toBeGreaterThan(
      0,
    );
  });

  it("P1: flags a service charge or tax the snapshot does not compute", async () => {
    const kit = await kitFor(c);
    const menu = menuOf(kit);
    const base = sale(kit, menu, kit.receiptRun.lastNumber + 1);
    const totalIdr = Number(base.subtotalIdr) + 3_000;
    const event = offlineSaleEventSchema.parse({
      ...base,
      serviceChargeIdr: 3_000,
      totalIdr,
      tenders: [{ method: "cash", amountIdr: totalIdr, receivedIdr: totalIdr }],
    });
    expect((await submit(c, [event])).results[0]).toMatchObject({
      status: "ingested",
      flags: ["amount_mismatch"],
    });
  });

  it("P2 1: a held sale's number counts as present in every gap check (Tutup Hari)", async () => {
    const kit = await kitFor(c);
    const menu = menuOf(kit);
    const n = kit.receiptRun.lastNumber + 1;
    const held = sale(kit, menu, n, { tenderIdr: menu.priceIdr - 1000 });
    expect((await submit(c, [held])).results[0]!.status).toBe("held");
    const run = kit.receiptRun.sequenceId;
    await withTenant(db, scope, async (tx) => {
      for (const gaps of [
        await receiptGapsForOutlet(tx, scope, outletId),
        await receiptGapsForOutletFast(tx, scope, outletId),
      ])
        expect(gaps.filter((gap) => gap.sequenceId === run)).toEqual([]);
      const device = await receiptGapsForDevice(tx, scope, {
        outletId,
        deviceId: c.deviceId,
      });
      expect(
        device.filter(
          (gap) =>
            gap.prefix === kit.receiptRun.prefix && gap.missing.length > 0,
        ),
      ).toEqual([]);
    });
  });

  it("P2 2 + P3 4: a sale after the shift closed names shift, L number and amount; the closed shift's report leaves it out", async () => {
    const till = await newTill(app);
    const kit = await kitFor(till);
    const menu = menuOf(kit);
    await closeShiftExactly({
      scope,
      cashierId: till.cashier.userId,
      deviceId: till.deviceId,
      shiftId: till.shiftId,
      supervisorId: await outletSupervisor(app, "Offline Review Close"),
      drawerIdr: 500_000,
    });
    const event = sale(kit, menu, kit.receiptRun.lastNumber + 1);
    const result = await submit(till, [event]);
    expect(result.results[0]).toMatchObject({
      status: "ingested",
      flags: ["shift_closed"],
    });
    const receiptNumber = result.results[0]!.receiptNumber!;
    const { rows } = await owner.query<{ body: string }>(
      "SELECT body FROM notifications WHERE tenant_id = $1 AND body LIKE $2",
      [seededTenantId, `%${receiptNumber}%`],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.body).toContain("shift");
    expect(rows[0]!.body).toContain(
      new Intl.NumberFormat("id-ID").format(menu.priceIdr),
    );
    // P3 4: the closed drawer's report keeps its own sales only.
    const captured = await withTenant(db, scope, async (tx) => {
      const [shift] = await tx
        .select()
        .from(posShifts)
        .where(
          and(
            eq(posShifts.tenantId, scope.tenant.tenantId),
            eq(posShifts.id, till.shiftId),
          ),
        );
      return shiftCapturedTenders(tx, shift!);
    });
    expect(captured).toEqual([]);
  });

  it("P3 2: flags a paidAt in the future and books it on today's business date", async () => {
    const kit = await kitFor(c);
    const menu = menuOf(kit);
    const n = kit.receiptRun.lastNumber + 1;
    const today = sale(kit, menu, n);
    const future = offlineSaleEventSchema.parse({
      ...sale(kit, menu, n + 1),
      paidAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const result = await submit(c, [today, future]);
    expect(result.results[0]!.flags).toEqual([]);
    expect(result.results[1]).toMatchObject({ status: "ingested" });
    expect(result.results[1]!.flags).toContain("paid_in_future");
    const { rows } = await owner.query<{ id: string; business_date: string }>(
      "SELECT id, business_date::text FROM orders WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [seededTenantId, [ulidToUuid(today.eventId), ulidToUuid(future.eventId)]],
    );
    expect(new Set(rows.map((row) => row.business_date)).size).toBe(1);
  });

  it("O5 (1): a sale marked another customer is ingested once, flagged for finance with the reason, cash in the drawer", async () => {
    const kit = await kitFor(c);
    const menu = menuOf(kit);
    const event = offlineSaleEventSchema.parse({
      ...sale(kit, menu, kit.receiptRun.lastNumber + 1),
      otherCustomerReason: "Meja 4 minta kopi yang sama, orang lain",
    });
    const result = await submit(c, [event]);
    expect(result.results[0]).toMatchObject({
      status: "ingested",
      flags: ["other_customer"],
    });
    const receiptNumber = result.results[0]!.receiptNumber!;
    const { rows: alerts } = await owner.query<{ body: string }>(
      "SELECT body FROM notifications WHERE tenant_id = $1 AND body LIKE $2",
      [seededTenantId, `%${receiptNumber}%`],
    );
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]!.body).toContain("Meja 4 minta kopi yang sama");
    // Not a shift_closed sale: the shift is open, so the cash is in its drawer.
    const { rows: tenders } = await owner.query<{ shift_id: string | null }>(
      "SELECT shift_id FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = $2",
      [seededTenantId, ulidToUuid(event.eventId)],
    );
    expect(tenders).toHaveLength(1);
    expect(tenders[0]!.shift_id).not.toBeNull();
    // A replay never doubles the sale (money: paid once).
    const again = await submit(c, [event]);
    expect(again.results[0]!.status).toBe("duplicate");
    expect(await ordersOf(event.eventId)).toBe(1);
  });

  it("O5 (1): the reason of another customer must be written (4 to 200 characters)", async () => {
    const kit = await kitFor(c);
    const base = sale(kit, menuOf(kit), kit.receiptRun.lastNumber + 1);
    for (const reason of ["", "  ab ", "x".repeat(201)])
      expect(
        offlineSaleEventSchema.safeParse({
          ...base,
          otherCustomerReason: reason,
        }).success,
      ).toBe(false);
  });

  it("P3 3: the same event id under another kit is a conflict (409), nothing stored", async () => {
    const kit = await kitFor(c);
    const menu = menuOf(kit);
    const event = sale(kit, menu, kit.receiptRun.lastNumber + 1);
    expect((await submit(c, [event])).results[0]!.status).toBe("ingested");
    const other = await kitFor(b);
    const twin = sale(other, menuOf(other), other.receiptRun.lastNumber + 1, {
      eventId: event.eventId,
    });
    await expect(submit(b, [twin])).rejects.toMatchObject({
      code: "OFFLINE_EVENT_CONFLICT",
      status: 409,
    });
    const next = await kitFor(b);
    expect(next.receiptRun.lastNumber).toBe(other.receiptRun.lastNumber);
  });

  it("P2 2 journal: the close books the offline cash as overage, the late sale debits offline_cash_clearing; cash is booked once", async () => {
    const till = await newTill(app);
    const kit = await kitFor(till);
    const menu = menuOf(kit);
    // The tablet sold offline; its cash is in the drawer the cashier counts.
    await closeShiftExactly({
      scope,
      cashierId: till.cashier.userId,
      deviceId: till.deviceId,
      shiftId: till.shiftId,
      supervisorId: await outletSupervisor(app, "Offline Review Journal"),
      drawerIdr: 500_000 + menu.priceIdr,
      varianceIdr: menu.priceIdr,
    });
    const event = sale(kit, menu, kit.receiptRun.lastNumber + 1);
    expect((await submit(till, [event])).results[0]).toMatchObject({
      status: "ingested",
      flags: ["shift_closed"],
    });
    const [paid] = await paidEventsOf(event.eventId);
    const { rows: closed } = await owner.query<{ event: EventEnvelope }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'cashier_shift.closed'
          AND event->'payload'->>'shiftId' = $2`,
      [seededTenantId, till.shiftId],
    );
    expect(closed).toHaveLength(1);

    const byRole = await netByRole([closed[0]!.event, paid!]);
    // Drawer cash once (the close's overage), the sale in the suspense account.
    expect(byRole.cash_on_hand).toBe(menu.priceIdr);
    expect(byRole.offline_cash_clearing).toBe(menu.priceIdr);
    expect(byRole.sales_revenue).toBe(-menu.priceIdr);
  });
});

describe("Review O3 P1: a conflicting sale is reported, never lost", () => {
  it("middle sale conflicts -> report -> next sale ingests, close passes, 1205 holds its cash; a second report is one row", async () => {
    const till = await newTill(app);
    const other = await newTill(app);
    const kit = await kitFor(till);
    const menu = menuOf(kit);
    const otherKit = await kitFor(other);
    const first = sale(kit, menu, kit.receiptRun.lastNumber + 1);
    const middle = sale(kit, menu, kit.receiptRun.lastNumber + 2);
    const last = sale(kit, menu, kit.receiptRun.lastNumber + 3);
    // Another kit already holds the middle sale's eventId.
    const twin = sale(
      otherKit,
      menuOf(otherKit),
      otherKit.receiptRun.lastNumber + 1,
      {
        eventId: middle.eventId,
      },
    );
    expect((await submit(other, [twin])).results[0]!.status).toBe("ingested");

    await expect(submit(till, [first, middle, last])).rejects.toMatchObject({
      code: "OFFLINE_EVENT_CONFLICT",
      status: 409,
    });
    const report = () =>
      reportPosOfflineConflict(scope, callerOf(till), outletId, {
        event: middle,
      });
    const reported = await report();
    expect(reported).toMatchObject({
      eventId: middle.eventId,
      status: "ingested",
      receiptNumber: expect.stringMatching(
        new RegExp(`-0*${middle.sequenceNumber}$`),
      ),
    });
    expect(reported.flags).toContain("event_conflict");
    expect((await report()).status).toBe("duplicate");
    const { rows } = await owner.query<{ event_id: string }>(
      `SELECT event_id FROM pos_offline_sales
        WHERE tenant_id = $1 AND kit_id = $2 AND flags ? 'event_conflict'`,
      [seededTenantId, kit.kitId],
    );
    expect(rows).toHaveLength(1);
    const conflictOrder = uuidToUlid(rows[0]!.event_id);
    expect(conflictOrder).not.toBe(middle.eventId);

    // The slot is filled: the rest of the queue goes in.
    const rest = await submit(
      till,
      [first, middle, last].filter((e) => e !== middle),
    );
    expect(rest.results.map((row) => row.status)).toEqual([
      "duplicate",
      "ingested",
    ]);
    // The conflicting sale's cash is not in the drawer's figures.
    expect(await expectedCash(till.shiftId)).toBe(500_000 + 2 * menu.priceIdr);
    await closeShiftExactly({
      scope,
      cashierId: till.cashier.userId,
      deviceId: till.deviceId,
      shiftId: till.shiftId,
      supervisorId: await outletSupervisor(app, "Offline Conflict Close"),
      drawerIdr: 500_000 + 2 * menu.priceIdr,
      offlineQueuePending: 0,
    });
    const [paid] = await paidEventsOf(conflictOrder);
    const byRole = await netByRole([paid!]);
    expect(byRole.offline_cash_clearing).toBe(menu.priceIdr);
    expect(byRole.cash_on_hand ?? 0).toBe(0);
  });

  it("a report of a sale that does not conflict ingests it as a normal sale", async () => {
    const till = await newTill(app);
    const kit = await kitFor(till);
    const event = sale(kit, menuOf(kit), kit.receiptRun.lastNumber + 1);
    const reported = await reportPosOfflineConflict(
      scope,
      callerOf(till),
      outletId,
      { event },
    );
    expect(reported).toMatchObject({ status: "ingested", flags: [] });
    expect(await ordersOf(event.eventId)).toBe(1);
  });
});

describe("legend-ss7n5: void of a shift_closed offline sale", () => {
  it("refuses the cloud void (409, nothing written), refund still goes through", async () => {
    const till = await newTill(app);
    const kit = await kitFor(till);
    const menu = menuOf(kit);
    await closeShiftExactly({
      scope,
      cashierId: till.cashier.userId,
      deviceId: till.deviceId,
      shiftId: till.shiftId,
      supervisorId: await outletSupervisor(app, "Offline Void Close"),
      drawerIdr: 500_000 + menu.priceIdr,
      varianceIdr: menu.priceIdr,
    });
    const event = sale(kit, menu, kit.receiptRun.lastNumber + 1);
    expect((await submit(till, [event])).results[0]).toMatchObject({
      status: "ingested",
      flags: ["shift_closed"],
    });

    const supervisor = agent(app);
    await signUp(supervisor, "Offline Void Supervisor");
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
    const caller = {
      userId: userIdSchema.parse(till.cashier.userId),
      deviceId: null,
      expectedVersion: null,
    };
    const amountIdr = menu.priceIdr;
    const reason = "Koreksi penjualan offline shift tutup";
    const approve = async (
      action: "void" | "refund",
      objectId = event.eventId,
    ) => {
      const overrideId = createUlid();
      await asOwner((client) =>
        client.query(
          `INSERT INTO pos_overrides (id, tenant_id, outlet_id, action, method, status,
             requested_by, approved_by, reason, value_idr, object_type, object_id,
             request_fingerprint, created_at, resolved_at)
           VALUES ($1, $2, $3, $10, 'supervisor_pin', 'approved', $4, $5, $6,
             $7, 'order', $8, $9, now(), now())`,
          [
            ulidToUuid(overrideId),
            seededTenantId,
            seededOutletA,
            till.cashier.userId,
            approverId,
            reason,
            amountIdr,
            objectId,
            pinOverrideFixtureFingerprint({
              requestedBy: till.cashier.userId,
              outletId: seededOutletA,
              action,
              valueIdr: amountIdr,
              reason,
              objectType: "order",
              objectId,
              approverUserId: approverId,
            }),
            action,
          ],
        ),
      );
      return posOverrideIdSchema.parse(overrideId);
    };

    await expect(
      voidPosOrderCorrection(scope, caller, outletId, event.eventId, {
        idempotencyKey: randomUUID(),
        reason: "other",
        reasonNote: reason,
        overrideId: await approve("void"),
        approvedBy: userIdSchema.parse(approverId),
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Koreksi lewat refund back office"),
    });
    // Nothing was written: no void row, no void event (so no reversal to 1205).
    expect(
      await countOf(
        "SELECT count(*) AS n FROM pos_order_voids WHERE tenant_id = $1 AND order_id = $2",
        [seededTenantId, ulidToUuid(event.eventId)],
      ),
    ).toBe(0);
    expect(
      await countOf(
        `SELECT count(*) AS n FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->>'name' LIKE '%void%'
            AND event::text LIKE $2`,
        [seededTenantId, `%${event.eventId}%`],
      ),
    ).toBe(0);

    // The refund (cash back office path, here a manual EDC slip sale of the
    // same closed shift) is untouched by the rule.
    const card = sale(kit, menu, kit.receiptRun.lastNumber + 2, {
      method: "edc_card",
    });
    expect((await submit(till, [card])).results[0]).toMatchObject({
      status: "ingested",
      flags: ["shift_closed"],
    });
    const refund = await refundPosOrder(scope, caller, outletId, card.eventId, {
      idempotencyKey: randomUUID(),
      amountIdr: idr(amountIdr),
      reason: "quality_complaint",
      reasonNote: reason,
      overrideId: await approve("refund", card.eventId),
      approvedBy: userIdSchema.parse(approverId),
    });
    expect(Number(refund.amountIdr)).toBe(amountIdr);
  });
});
