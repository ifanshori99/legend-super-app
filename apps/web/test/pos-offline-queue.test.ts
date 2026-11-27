// O3 offline queue of the tablet (bead legend-wasr7.7; cloud-only-release.md
// §2, Keputusan CTO O2, review O2). Real store logic over the in-memory
// backend (IndexedDB's transaction contract), real pricing by the shared tax
// engine; only the cloud's batch endpoint is faked.
//
// Assumptions (from the design):
// - Only cash and manual EDC with the slip reference are taken offline, at the
//   kit's list price (no promo, voucher, points or discount).
// - Each sale takes the next `L` number of the kit's run in the same
//   transaction that queues it: a crash leaves neither, never a gap.
// - The queue survives a reload; a resend repeats the same eventIds and the
//   cloud answers `duplicate` for what it already holds.
// - A 409 OFFLINE_EVENT_CONFLICT fails a whole batch: only the sale behind it
//   is parked ("perlu dicek") and reported; the cloud books the report and
//   fills its number slot, the rest of the queue still syncs (review O3 P1).
// - A parked sale blocks the shift close and sign-out until its report is
//   settled; a rejected result stops the sync (review O3 P3).
import {
  OFFLINE_KIT_TTL_MS,
  offlineSaleEventSchema,
  posOfflineKitSchema,
  type OfflineEventResult,
  type OfflineSaleEvent,
  type OfflineSaleTender,
  type PosOfflineBatchResult,
  type PosOfflineKit,
} from "@starter/shared/pos";
import { cafeLegendFixtures } from "@starter/shared/core";
import { cafeLegendTaxFixtures } from "@starter/shared/tax";
import { ApiError } from "@/lib/api/errors";
import { priceOfflineSale } from "@/features/ws04-pos-kasir/offline/price";
import {
  countPendingOfflineSales,
  createOfflineQueue,
  type OfflineReport,
  type OfflineStuckSend,
  type OfflineSubmit,
} from "@/features/ws04-pos-kasir/offline/queue";
import {
  createMemoryOfflineBackend,
  type OfflineBackend,
} from "@/features/ws04-pos-kasir/offline/store";

const OUTLET = cafeLegendFixtures.outlets[0].id;
const RUN = "0a1b2c3d-0000-4000-8000-0000000000f1";
const NEW_RUN = "0a1b2c3d-0000-4000-8000-0000000000f2";
const CATEGORY = "0a1b2c3d-0000-4000-8000-000000000c01";
const KOPI = "0a1b2c3d-0000-4000-8000-000000000101";
const TEH = "0a1b2c3d-0000-4000-8000-000000000102";
const BESAR = "0a1b2c3d-0000-4000-8000-000000000201";
const SHOT_GROUP = "0a1b2c3d-0000-4000-8000-000000000301";
const SHOT = "0a1b2c3d-0000-4000-8000-000000000302";
const ISSUED = new Date(2026, 10, 27, 9, 0, 0);

const catalog = {
  categories: [{ id: CATEGORY, name: "Minuman", sortOrder: 1 }],
  items: [
    {
      id: KOPI,
      categoryId: CATEGORY,
      categoryName: "Minuman",
      name: "Kopi Susu",
      basePriceIdr: 25_000,
      plainPriceIdr: 25_000,
      variants: [],
      imageUrl: null,
      course: null,
      code: null,
      soldOut: false,
      modifierGroups: [
        {
          id: SHOT_GROUP,
          name: "Tambahan",
          required: false,
          min: 0,
          max: 1,
          options: [{ id: SHOT, label: "Extra shot", priceDeltaIdr: 5_000 }],
        },
      ],
    },
    {
      id: TEH,
      categoryId: CATEGORY,
      categoryName: "Minuman",
      name: "Teh",
      basePriceIdr: 30_000,
      plainPriceIdr: null,
      variants: [{ id: BESAR, name: "Besar", priceIdr: 30_000 }],
      imageUrl: null,
      course: null,
      code: null,
      soldOut: false,
      modifierGroups: [],
    },
  ],
  updatedAt: ISSUED.toISOString(),
  source: "live",
};

function kitOf(
  overrides: { sequenceId?: string; lastNumber?: number; issuedAt?: Date } = {},
): PosOfflineKit {
  const issuedAt = overrides.issuedAt ?? ISSUED;
  return posOfflineKitSchema.parse({
    kitId: crypto.randomUUID(),
    outletId: OUTLET,
    deviceId: "0a1b2c3d-0000-4000-8000-0000000000d1",
    shiftId: "0a1b2c3d-0000-4000-8000-0000000000b1",
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + OFFLINE_KIT_TTL_MS).toISOString(),
    catalogVersion: "a".repeat(64),
    catalogs: { dine_in: catalog, takeaway: catalog },
    tax: {
      // The cloud prices POS bills without a region (computePosBill).
      taxRules: cafeLegendTaxFixtures.taxRules.map((rule) => ({
        ...rule,
        regionCode: null,
      })),
      settings: cafeLegendTaxFixtures.settings,
      serviceChargeRules: [],
    },
    tenders: ["cash", "edc_card"],
    receiptRun: {
      sequenceId: overrides.sequenceId ?? RUN,
      prefix: "L1",
      lastNumber: overrides.lastNumber ?? 0,
      startedAt: issuedAt.toISOString(),
    },
  });
}

const kopi = {
  menuItemId: KOPI,
  variantId: null,
  quantity: 1,
  modifierIds: [],
};
const cart = { serviceType: "dine_in" as const, lines: [kopi] };
const cash = (amountIdr: number): OfflineSaleTender =>
  ({ method: "cash", amountIdr, receivedIdr: amountIdr }) as OfflineSaleTender;

/** A fake cloud: one stored order per eventId, like the ledger's key. */
function fakeCloud() {
  const stored = new Map<string, OfflineSaleEvent>();
  const calls: string[][] = [];
  const cloud = {
    stored,
    calls,
    /** eventIds the cloud holds under another kit (409 OFFLINE_EVENT_CONFLICT). */
    conflicting: new Set<string>(),
    /** eventIds answered `rejected` (`retry`). */
    rejecting: new Set<string>(),
    /** The answer is lost after the cloud stored the batch. */
    loseAnswer: false,
    refuse: null as ApiError | null,
    /** Conflict reports the cloud booked, by the sale's eventId. */
    reports: new Map<string, OfflineSaleEvent>(),
    reportCalls: [] as string[],
    /** The report endpoint is unreachable. */
    reportDown: false,
    report: (async (event) => {
      cloud.reportCalls.push(event.eventId);
      if (cloud.reportDown) throw new TypeError("Failed to fetch");
      const known = cloud.reports.has(event.eventId);
      cloud.reports.set(event.eventId, event);
      return {
        eventId: event.eventId,
        status: known ? "duplicate" : "ingested",
        reason: null,
        flags: ["event_conflict"],
        receiptNumber: `L1-${String(event.sequenceNumber).padStart(6, "0")}`,
      } as OfflineEventResult;
    }) as OfflineReport,
    submit: (async (events) => {
      calls.push(events.map((event) => event.eventId));
      if (cloud.refuse) throw cloud.refuse;
      const results: OfflineEventResult[] = [];
      for (const event of events) {
        offlineSaleEventSchema.parse(event);
        if (cloud.conflicting.has(event.eventId))
          throw new ApiError(
            409,
            "OFFLINE_EVENT_CONFLICT",
            "Penjualan offline ini sudah tercatat dari bekal lain",
          );
        if (cloud.rejecting.has(event.eventId)) {
          results.push({
            eventId: event.eventId,
            status: "rejected",
            reason: "retry",
            flags: [],
            receiptNumber: null,
          } as OfflineEventResult);
          continue;
        }
        const known = stored.has(event.eventId);
        stored.set(event.eventId, event);
        results.push({
          eventId: event.eventId,
          status: known ? "duplicate" : "ingested",
          reason: null,
          flags: [],
          receiptNumber: `L1-${String(event.sequenceNumber).padStart(6, "0")}`,
        } as OfflineEventResult);
      }
      if (cloud.loseAnswer) {
        cloud.loseAnswer = false;
        throw new TypeError("Failed to fetch");
      }
      const answer: PosOfflineBatchResult = {
        results,
        runs: [
          {
            sequenceId: RUN,
            lastNumber: Math.max(
              0,
              ...[...stored.values()].map((event) => event.sequenceNumber),
            ),
          },
        ],
      };
      return answer;
    }) as OfflineSubmit,
  };
  return cloud;
}

let clock = new Date(2026, 10, 27, 10, 0, 0);
const neverReported: OfflineReport = async () => {
  throw new Error("no conflict expected");
};
const queueOver = (
  backend: OfflineBackend,
  submit: OfflineSubmit,
  report: OfflineReport = neverReported,
) =>
  createOfflineQueue({
    backend,
    outletId: OUTLET,
    submit,
    report,
    now: () => clock,
  });

beforeEach(() => {
  clock = new Date(2026, 10, 27, 10, 0, 0);
});

describe("recording an offline sale", () => {
  it("prices from the kit's list and tax snapshot, numbers L1, L2 in order", async () => {
    const backend = createMemoryOfflineBackend();
    const queue = queueOver(backend, fakeCloud().submit);
    const kit = kitOf();
    await queue.saveKit(kit);
    const priced = priceOfflineSale(kit, cart, clock);
    // PBJT 10% of the list price; no service charge without a zone.
    expect(priced.subtotalIdr).toBe(25_000);
    expect(priced.serviceChargeIdr).toBe(0);
    expect(priced.taxIdr).toBe(2_500);
    expect(priced.taxes.map((row) => [row.code, row.taxIdr])).toEqual([
      ["PBJT-FNB", 2_500],
    ]);
    expect(priced.totalIdr).toBe(
      priced.subtotalIdr +
        priced.serviceChargeIdr +
        priced.taxIdr +
        priced.roundingIdr,
    );
    const first = await queue.recordSale(cart, [cash(priced.totalIdr)]);
    clock = new Date(clock.getTime() + 60_000);
    const second = await queue.recordSale(
      {
        serviceType: "takeaway",
        lines: [
          { ...kopi, quantity: 2, modifierIds: [SHOT] },
          { menuItemId: TEH, variantId: BESAR, quantity: 1, modifierIds: [] },
        ],
      },
      [
        {
          method: "edc_card",
          amountIdr: priceOfflineSale(
            kit,
            {
              serviceType: "takeaway",
              lines: [
                { ...kopi, quantity: 2, modifierIds: [SHOT] },
                {
                  menuItemId: TEH,
                  variantId: BESAR,
                  quantity: 1,
                  modifierIds: [],
                },
              ],
            },
            clock,
          ).totalIdr,
          reference: "SLIP-0042",
        } as OfflineSaleTender,
      ],
    );
    expect([first.sequenceNumber, second.sequenceNumber]).toEqual([1, 2]);
    expect(first.sequenceId).toBe(RUN);
    expect(first.kitId).toBe(kit.kitId);
    expect(second.lines.map((line) => line.lineTotalIdr)).toEqual([
      60_000, 30_000,
    ]);
    expect(second.subtotalIdr).toBe(90_000);
    expect(first.eventId < second.eventId).toBe(true);
    expect(await queue.pendingCount()).toBe(2);
  });

  it("O5 (1): a sale for another customer carries its written reason to the cloud; a short reason is refused", async () => {
    const backend = createMemoryOfflineBackend();
    const cloud = fakeCloud();
    const queue = queueOver(backend, cloud.submit);
    const kit = kitOf();
    await queue.saveKit(kit);
    const total = priceOfflineSale(kit, cart, clock).totalIdr;
    await expect(
      queue.recordSale(cart, [cash(total)], { otherCustomerReason: " ab " }),
    ).rejects.toMatchObject({ code: "SALE_INVALID" });
    // Nothing was taken: no number used, no sale queued.
    expect(await queue.pendingCount()).toBe(0);
    const event = await queue.recordSale(cart, [cash(total)], {
      otherCustomerReason: "  Meja 4, pelanggan lain pesan sama  ",
    });
    expect(event.sequenceNumber).toBe(1);
    expect(event.otherCustomerReason).toBe("Meja 4, pelanggan lain pesan sama");
    const plain = await queue.recordSale(cart, [cash(total)]);
    expect(plain.otherCustomerReason).toBeUndefined();
    const report = await queue.sync();
    expect(report.remaining).toBe(0);
    expect(cloud.stored.get(event.eventId)?.otherCustomerReason).toBe(
      "Meja 4, pelanggan lain pesan sama",
    );
  });

  it("refuses QRIS, points or a voucher offline, a short tender (promo), and an EDC without slip", async () => {
    const backend = createMemoryOfflineBackend();
    const queue = queueOver(backend, fakeCloud().submit);
    const kit = kitOf();
    await queue.saveKit(kit);
    const total = priceOfflineSale(kit, cart, clock).totalIdr;
    for (const method of ["qris", "points", "voucher", "va", "ewallet"])
      await expect(
        queue.recordSale(cart, [
          { method, amountIdr: total } as unknown as OfflineSaleTender,
        ]),
      ).rejects.toMatchObject({ code: "TENDER_NOT_OFFLINE" });
    await expect(
      queue.recordSale(cart, [cash(total - 5_000)]),
    ).rejects.toMatchObject({ code: "TENDER_TOTAL_MISMATCH" });
    await expect(
      queue.recordSale(cart, [
        {
          method: "cash",
          amountIdr: total,
          receivedIdr: total - 1,
        } as OfflineSaleTender,
      ]),
    ).rejects.toMatchObject({ code: "CASH_RECEIVED_SHORT" });
    await expect(
      queue.recordSale(cart, [
        {
          method: "edc_card",
          amountIdr: total,
          reference: "  ",
        } as OfflineSaleTender,
      ]),
    ).rejects.toMatchObject({ code: "SALE_INVALID" });
    // A kit without EDC takes cash only.
    await queue.saveKit({ ...kit, tenders: ["cash"] });
    await expect(
      queue.recordSale(cart, [
        {
          method: "edc_card",
          amountIdr: total,
          reference: "SLIP-1",
        } as OfflineSaleTender,
      ]),
    ).rejects.toMatchObject({ code: "TENDER_NOT_OFFLINE" });
    expect(await queue.pendingCount()).toBe(0);
  });

  it("refuses an item or option the kit does not know, and an expired kit", async () => {
    const backend = createMemoryOfflineBackend();
    const queue = queueOver(backend, fakeCloud().submit);
    await expect(queue.recordSale(cart, [cash(1)])).rejects.toMatchObject({
      code: "KIT_MISSING",
    });
    await queue.saveKit(kitOf());
    await expect(
      queue.recordSale(
        {
          serviceType: "dine_in",
          lines: [{ ...kopi, menuItemId: crypto.randomUUID() }],
        },
        [cash(1)],
      ),
    ).rejects.toMatchObject({ code: "ITEM_NOT_IN_KIT" });
    await expect(
      queue.recordSale(
        { serviceType: "dine_in", lines: [{ ...kopi, modifierIds: [TEH] }] },
        [cash(1)],
      ),
    ).rejects.toMatchObject({ code: "MODIFIER_NOT_IN_KIT" });
    clock = new Date(ISSUED.getTime() + OFFLINE_KIT_TTL_MS);
    await expect(queue.recordSale(cart, [cash(1)])).rejects.toMatchObject({
      code: "KIT_EXPIRED",
    });
    expect(await queue.pendingCount()).toBe(0);
  });
});

describe("the queue survives reload and crash", () => {
  it("a reload sees the queued sales and continues the numbers", async () => {
    const backend = createMemoryOfflineBackend();
    const kit = kitOf();
    const before = queueOver(backend, fakeCloud().submit);
    await before.saveKit(kit);
    const total = priceOfflineSale(kit, cart, clock).totalIdr;
    await before.recordSale(cart, [cash(total)]);
    await before.recordSale(cart, [cash(total)]);
    // Reload: a new queue over the same storage.
    const after = queueOver(backend, fakeCloud().submit);
    expect(await after.pendingCount()).toBe(2);
    expect(await countPendingOfflineSales(backend, OUTLET)).toBe(2);
    expect(await after.resumeSequenceId()).toBe(RUN);
    const third = await after.recordSale(cart, [cash(total)]);
    expect(third.sequenceNumber).toBe(3);
  });

  it("a crash between numbering and queueing leaves neither: no gap, no reuse", async () => {
    const inner = createMemoryOfflineBackend();
    let crash = false;
    const backend: OfflineBackend = {
      run: (mode, body) =>
        inner.run(mode, (tx) =>
          body({
            ...tx,
            put: async (store, value) => {
              await tx.put(store, value);
              if (crash && store === "queue") throw new Error("tab killed");
            },
          }),
        ),
    };
    const queue = queueOver(backend, fakeCloud().submit);
    const kit = kitOf();
    await queue.saveKit(kit);
    const total = priceOfflineSale(kit, cart, clock).totalIdr;
    crash = true;
    await expect(queue.recordSale(cart, [cash(total)])).rejects.toThrow(
      "tab killed",
    );
    crash = false;
    expect(inner.snapshot().queue.size).toBe(0);
    expect(inner.snapshot().kits.get(OUTLET)?.counter).toBe(0);
    const sale = await queue.recordSale(cart, [cash(total)]);
    expect(sale.sequenceNumber).toBe(1);
  });

  it("a new kit on the same run keeps the local counter; a new epoch starts at the cloud's high-water", async () => {
    const backend = createMemoryOfflineBackend();
    const queue = queueOver(backend, fakeCloud().submit);
    const kit = kitOf();
    await queue.saveKit(kit);
    const total = priceOfflineSale(kit, cart, clock).totalIdr;
    await queue.recordSale(cart, [cash(total)]);
    await queue.recordSale(cart, [cash(total)]);
    // The cloud has synced only #1 of this run: the tablet keeps #2.
    await queue.saveKit(kitOf({ lastNumber: 1 }));
    expect((await queue.recordSale(cart, [cash(total)])).sequenceNumber).toBe(
      3,
    );
    await queue.saveKit(kitOf({ sequenceId: NEW_RUN, lastNumber: 0 }));
    const fresh = await queue.recordSale(cart, [cash(total)]);
    expect([fresh.sequenceId, fresh.sequenceNumber]).toEqual([NEW_RUN, 1]);
    // The old run's sales are still queued under their own run.
    expect(await queue.pendingCount()).toBe(4);
  });
});

describe("sync to the cloud", () => {
  async function queuedSales(count: number) {
    const backend = createMemoryOfflineBackend();
    const cloud = fakeCloud();
    const queue = queueOver(backend, cloud.submit, cloud.report);
    const kit = kitOf();
    await queue.saveKit(kit);
    const total = priceOfflineSale(kit, cart, clock).totalIdr;
    const sales: OfflineSaleEvent[] = [];
    for (let i = 0; i < count; i += 1) {
      clock = new Date(clock.getTime() + 1_000);
      sales.push(await queue.recordSale(cart, [cash(total)]));
    }
    return { backend, cloud, queue, sales };
  }

  it("sends the queue in run order and drops what the cloud settled", async () => {
    const { cloud, queue, sales } = await queuedSales(3);
    const report = await queue.sync();
    expect(report).toMatchObject({
      settled: 3,
      parked: 0,
      remaining: 0,
      error: null,
    });
    expect(cloud.calls).toEqual([sales.map((sale) => sale.eventId)]);
    expect(await queue.pendingCount()).toBe(0);
  });

  it("a lost answer resends the same eventIds; the cloud holds each sale once", async () => {
    const { cloud, queue, sales } = await queuedSales(2);
    cloud.loseAnswer = true;
    const lost = await queue.sync();
    expect(lost.error).toBeInstanceOf(TypeError);
    expect(lost.remaining).toBe(2);
    const again = await queue.sync();
    expect(again).toMatchObject({ settled: 2, remaining: 0, error: null });
    expect(cloud.calls).toEqual([
      sales.map((sale) => sale.eventId),
      sales.map((sale) => sale.eventId),
    ]);
    expect(cloud.stored.size).toBe(2);
  });

  it("keeps a rejected sale queued for the next sync", async () => {
    const { cloud, queue, sales } = await queuedSales(2);
    cloud.rejecting.add(sales[1]!.eventId);
    expect(await queue.sync()).toMatchObject({ settled: 1, remaining: 1 });
    cloud.rejecting.clear();
    expect(await queue.sync()).toMatchObject({ settled: 1, remaining: 0 });
  });

  it("splits a long queue into batches of at most 100", async () => {
    const { cloud, queue } = await queuedSales(101);
    expect(await queue.sync()).toMatchObject({ settled: 101, remaining: 0 });
    expect(cloud.calls.map((call) => call.length)).toEqual([100, 1]);
  });

  it("review O3 P3: a rejected result stops the sync; later batches wait", async () => {
    const { cloud, queue, sales } = await queuedSales(101);
    cloud.rejecting.add(sales[0]!.eventId);
    expect(await queue.sync()).toMatchObject({ settled: 99, remaining: 2 });
    expect(cloud.calls.map((call) => call.length)).toEqual([100]);
    cloud.rejecting.clear();
    expect(await queue.sync()).toMatchObject({ settled: 2, remaining: 0 });
  });

  it("review O3 P1: a conflicting sale is parked and reported, the rest still syncs", async () => {
    const { cloud, queue, sales } = await queuedSales(3);
    cloud.conflicting.add(sales[1]!.eventId);
    const report = await queue.sync();
    expect(report).toMatchObject({
      settled: 3,
      parked: 0,
      remaining: 0,
      error: null,
    });
    expect(cloud.stored.has(sales[0]!.eventId)).toBe(true);
    expect(cloud.stored.has(sales[2]!.eventId)).toBe(true);
    expect([...cloud.reports.keys()]).toEqual([sales[1]!.eventId]);
    expect(await queue.parked()).toEqual([]);
    expect(await queue.pendingCount()).toBe(0);
  });

  it("review O3 P1: an unreported conflict blocks the close and is reported before the rest", async () => {
    const { backend, cloud, queue, sales } = await queuedSales(3);
    cloud.conflicting.add(sales[1]!.eventId);
    cloud.reportDown = true;
    const first = await queue.sync();
    expect(first.error).toBeInstanceOf(TypeError);
    expect(first.remaining).toBe(2);
    expect((await queue.pending()).map((sale) => sale.eventId)).toEqual([
      sales[2]!.eventId,
    ]);
    const parked = await queue.parked();
    expect(parked.map((row) => [row.eventId, row.reason])).toEqual([
      [sales[1]!.eventId, "OFFLINE_EVENT_CONFLICT"],
    ]);
    // Parked sales still hold the shift close and the sign-out.
    expect(await queue.pendingCount()).toBe(2);
    expect(await countPendingOfflineSales(backend, null)).toBe(2);
    // Still down: the queue behind the gap is not sent.
    cloud.calls.length = 0;
    await queue.sync();
    expect(cloud.calls).toEqual([]);
    cloud.reportDown = false;
    expect(await queue.sync()).toMatchObject({
      settled: 2,
      remaining: 0,
      error: null,
    });
    expect(cloud.reports.has(sales[1]!.eventId)).toBe(true);
    expect(cloud.reportCalls.at(-1)).toBe(sales[1]!.eventId);
    expect(cloud.stored.has(sales[2]!.eventId)).toBe(true);
    expect(await queue.pendingCount()).toBe(0);
  });

  it("another refusal of the whole call parks nothing and keeps the queue", async () => {
    const { cloud, queue, sales } = await queuedSales(2);
    cloud.refuse = new ApiError(409, "CONFLICT", "other");
    const report = await queue.sync();
    expect(report).toMatchObject({ settled: 0, parked: 0, remaining: 2 });
    expect(report.error).toMatchObject({ code: "CONFLICT" });
    expect(await queue.parked()).toEqual([]);
    expect(cloud.reportCalls).toEqual([]);
    expect(sales).toHaveLength(2);
  });

  it("review O3 P2 4: a closed shift's kit takes no sale", async () => {
    const { queue } = await queuedSales(1);
    await queue.closeKit();
    expect(await queue.kit()).toBeNull();
    await expect(queue.recordSale(cart, [cash(1)])).rejects.toMatchObject({
      code: "KIT_SHIFT_CLOSED",
    });
    // The queued sale is still sent.
    expect(await queue.pendingCount()).toBe(1);
  });

  it("two syncs at once send the queue once", async () => {
    const { cloud, queue } = await queuedSales(2);
    await Promise.all([queue.sync(), queue.sync()]);
    expect(cloud.calls).toHaveLength(1);
  });
});

// 1273 second opinion P2-1: a sale the cloud refuses for good is reported with
// a supervisor's PIN; the tablet drops it only after the cloud holds it.
describe("a sale the cloud refuses for good", () => {
  const approval = {
    reason: "Tablet dipasang ulang",
    approverUserId: "0a1b2c3d-0000-4000-8000-0000000000a1",
    pin: "582914",
  };

  async function stuckSales(count: number) {
    const backend = createMemoryOfflineBackend();
    const kit = kitOf();
    const refusals = new Map<string, string>();
    let refuseAll: ApiError | null = null;
    const submit = (async (events) => {
      if (refuseAll) throw refuseAll;
      return {
        results: events.map(
          (event) =>
            ({
              eventId: event.eventId,
              status: "rejected",
              reason: refusals.get(event.eventId) ?? "retry",
              flags: [],
              receiptNumber: null,
            }) as OfflineEventResult,
        ),
        runs: [],
      };
    }) as OfflineSubmit;
    const sent: string[] = [];
    let answer: OfflineEventResult["status"] | "down" = "held";
    const reportStuck: OfflineStuckSend = async (event, stuck, given) => {
      sent.push(`${event.eventId}:${stuck}:${given.approverUserId}`);
      if (answer === "down") throw new TypeError("Failed to fetch");
      return {
        eventId: event.eventId,
        status: answer,
        reason: answer === "held" ? `stuck_${stuck}` : null,
        flags: [],
        receiptNumber: null,
      } as OfflineEventResult;
    };
    const queue = createOfflineQueue({
      backend,
      outletId: OUTLET,
      submit,
      report: neverReported,
      reportStuck,
      now: () => clock,
    });
    await queue.saveKit(kit);
    const total = priceOfflineSale(kit, cart, clock).totalIdr;
    const sales: OfflineSaleEvent[] = [];
    for (let i = 0; i < count; i += 1) {
      clock = new Date(clock.getTime() + 1_000);
      sales.push(await queue.recordSale(cart, [cash(total)]));
    }
    return {
      backend,
      queue,
      sales,
      refusals,
      sent,
      refuse: (error: ApiError | null) => {
        refuseAll = error;
      },
      answer: (next: typeof answer) => {
        answer = next;
      },
    };
  }

  it("marks kit_unknown and sequence_gap as stuck, a retry is not", async () => {
    const { queue, sales, refusals } = await stuckSales(3);
    refusals.set(sales[0]!.eventId, "kit_unknown");
    refusals.set(sales[1]!.eventId, "sequence_gap");
    await queue.sync();
    expect(
      (await queue.stuck()).map((row) => [row.event.eventId, row.stuck]),
    ).toEqual([
      [sales[0]!.eventId, "kit_unknown"],
      [sales[1]!.eventId, "sequence_gap"],
    ]);
  });

  it("a 403 on the whole call (device refused) marks every sale of it", async () => {
    const { queue, sales, refuse } = await stuckSales(2);
    refuse(new ApiError(403, "FORBIDDEN", "Perangkat tidak terdaftar"));
    expect((await queue.sync()).remaining).toBe(2);
    expect((await queue.stuck()).map((row) => row.stuck)).toEqual([
      "device_refused",
      "device_refused",
    ]);
    expect(sales).toHaveLength(2);
  });

  it("drops the sale only once the cloud holds it; a network failure keeps it", async () => {
    const { backend, queue, sales, refusals, sent, answer } =
      await stuckSales(2);
    refusals.set(sales[0]!.eventId, "kit_unknown");
    await queue.sync();
    answer("down");
    await expect(
      queue.reportStuck(sales[0]!.eventId, approval),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await queue.pendingCount()).toBe(2);
    answer("rejected");
    expect(
      (await queue.reportStuck(sales[0]!.eventId, approval)).status,
    ).toBe("rejected");
    expect(await queue.pendingCount()).toBe(2);
    answer("held");
    expect(await queue.reportStuck(sales[0]!.eventId, approval)).toMatchObject(
      { status: "held", reason: "stuck_kit_unknown" },
    );
    expect(sent.at(-1)).toBe(
      `${sales[0]!.eventId}:kit_unknown:${approval.approverUserId}`,
    );
    expect((await queue.pending()).map((sale) => sale.eventId)).toEqual([
      sales[1]!.eventId,
    ]);
    expect(await countPendingOfflineSales(backend, null)).toBe(1);
    expect(await queue.stuck()).toEqual([]);
  });

  it("an already ingested answer drops it too; a sale not marked stuck is refused", async () => {
    const { queue, sales, refusals, sent, answer } = await stuckSales(2);
    await expect(
      queue.reportStuck(sales[0]!.eventId, approval),
    ).rejects.toMatchObject({ code: "STUCK_UNKNOWN" });
    expect(sent).toEqual([]);
    refusals.set(sales[0]!.eventId, "sequence_gap");
    await queue.sync();
    answer("ingested");
    await queue.reportStuck(sales[0]!.eventId, approval);
    expect(await queue.pendingCount()).toBe(1);
  });
});
