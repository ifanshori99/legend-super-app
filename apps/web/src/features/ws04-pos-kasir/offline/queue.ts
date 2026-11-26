// O3 offline sale queue of one outlet on this tablet (bead legend-wasr7.7;
// docs/design/cloud-only-release.md §2, Keputusan CTO O2, review O2).
//
// - recordSale prices the cart from the kit (list prices, no promo), takes the
//   next `L` number and appends the sale in one transaction. Only cash and
//   manual EDC (slip reference) are accepted, as the kit lists them.
// - sync sends the queue in run order, at most OFFLINE_BATCH_MAX_EVENTS per
//   call. Replays are safe: the cloud keys each sale by its eventId. A
//   settled result (ingested, held, duplicate) drops the sale; a rejected one
//   stays queued for the next sync.
// - A 409 CONFLICT fails the whole call (one eventId under two kits): the
//   batch is resent one sale at a time and only the sale that still answers
//   409 is parked ("perlu dicek", shown to a supervisor) so the rest of the
//   queue keeps flowing. Any other refusal stops the sync with the queue kept.
// - pendingCount is what blocks the shift close (tablet guard, and reported to
//   the server as `offlineQueuePending`). Parked sales do not block it: the
//   cloud already holds that eventId, the supervisor reviews them.
import { createUlidFactory } from "@starter/shared/core";
import {
  OFFLINE_BATCH_MAX_EVENTS,
  OFFLINE_EVENT_SETTLED,
  offlineSaleEventSchema,
  posOfflineKitSchema,
  type OfflineEventResult,
  type OfflineSaleEvent,
  type OfflineSaleTender,
  type PosOfflineBatchResult,
  type PosOfflineKit,
} from "@starter/shared/pos";
import { ApiError } from "@/lib/api/errors";
import { OfflineSaleError, priceOfflineSale, type OfflineCart } from "./price";
import type { OfflineBackend, ParkedRecord, QueueRecord } from "./store";

export type OfflineSubmit = (
  events: OfflineSaleEvent[],
) => Promise<PosOfflineBatchResult>;

export type OfflineSyncReport = {
  settled: number;
  parked: number;
  /** Sales still queued after this sync. */
  remaining: number;
  /** Why the sync stopped early (network, 5xx, refusal); null when it ran through. */
  error: unknown;
};

export type OfflineQueue = {
  /** Stores the kit the cloud issued; keeps the local counter of its run. */
  saveKit(kit: PosOfflineKit): Promise<void>;
  kit(): Promise<PosOfflineKit | null>;
  /** The run to name in the next kit request (null: none stored). */
  resumeSequenceId(): Promise<string | null>;
  recordSale(
    cart: OfflineCart,
    tenders: OfflineSaleTender[],
  ): Promise<OfflineSaleEvent>;
  pending(): Promise<OfflineSaleEvent[]>;
  pendingCount(): Promise<number>;
  parked(): Promise<ParkedRecord[]>;
  sync(): Promise<OfflineSyncReport>;
};

/** Tutup shift is refused on the tablet while sales are still queued. */
export const OFFLINE_QUEUE_PENDING = "OFFLINE_QUEUE_PENDING";

const byRun = (a: OfflineSaleEvent, b: OfflineSaleEvent) =>
  a.sequenceId.localeCompare(b.sequenceId) ||
  a.sequenceNumber - b.sequenceNumber;

const isEventConflict = (error: unknown) =>
  error instanceof ApiError &&
  error.status === 409 &&
  error.code === "CONFLICT";

const settles = (result: OfflineEventResult) =>
  OFFLINE_EVENT_SETTLED.includes(result.status);

export function createOfflineQueue(options: {
  backend: OfflineBackend;
  outletId: string;
  submit: OfflineSubmit;
  now?: () => Date;
}): OfflineQueue {
  const { backend, submit } = options;
  const outletId = options.outletId.toLowerCase();
  const now = options.now ?? (() => new Date());
  const nextUlid = createUlidFactory({ now: () => now().getTime() });
  let syncing: Promise<OfflineSyncReport> | null = null;

  const queued = () =>
    backend.run("readonly", async (tx) =>
      (await tx.getAll("queue"))
        .filter((row) => row.outletId === outletId)
        .map((row) => row.event)
        .sort(byRun),
    );

  /** Drops settled sales, parks the named ones, raises run counters. */
  const apply = (
    settled: string[],
    parked: { event: OfflineSaleEvent; reason: string }[],
    runs: PosOfflineBatchResult["runs"],
  ) =>
    backend.run("readwrite", async (tx) => {
      for (const eventId of settled) await tx.delete("queue", eventId);
      for (const { event, reason } of parked) {
        await tx.put("parked", {
          eventId: event.eventId,
          outletId,
          event,
          reason,
          parkedAt: now().toISOString(),
        });
        await tx.delete("queue", event.eventId);
      }
      const stored = await tx.get("kits", outletId);
      const run = runs.find(
        (row) => row.sequenceId === stored?.kit.receiptRun.sequenceId,
      );
      if (stored && run && run.lastNumber > stored.counter)
        await tx.put("kits", { ...stored, counter: run.lastNumber });
    });

  /** One call; a 409 CONFLICT is isolated to the sale behind it. */
  async function sendChunk(chunk: OfflineSaleEvent[]) {
    try {
      const answer = await submit(chunk);
      await apply(
        answer.results.filter(settles).map((row) => row.eventId),
        [],
        answer.runs,
      );
      return { settled: answer.results.filter(settles).length, parked: 0 };
    } catch (error) {
      if (!isEventConflict(error) || chunk.length === 1) {
        if (isEventConflict(error)) {
          await apply([], [{ event: chunk[0]!, reason: "CONFLICT" }], []);
          return { settled: 0, parked: 1 };
        }
        throw error;
      }
    }
    // Every sale before the conflicting one was stored: alone it answers
    // `duplicate`. Only the conflicting one answers 409 again.
    let settled = 0;
    let parked = 0;
    for (const event of chunk) {
      const outcome = await sendChunk([event]);
      settled += outcome.settled;
      parked += outcome.parked;
    }
    return { settled, parked };
  }

  async function runSync(): Promise<OfflineSyncReport> {
    let settled = 0;
    let parked = 0;
    let error: unknown = null;
    const events = await queued();
    for (let at = 0; at < events.length; at += OFFLINE_BATCH_MAX_EVENTS) {
      try {
        const outcome = await sendChunk(
          events.slice(at, at + OFFLINE_BATCH_MAX_EVENTS),
        );
        settled += outcome.settled;
        parked += outcome.parked;
      } catch (caught) {
        error = caught;
        break;
      }
    }
    return { settled, parked, remaining: (await queued()).length, error };
  }

  return {
    async saveKit(input) {
      const kit = posOfflineKitSchema.parse(input);
      if (kit.outletId !== outletId)
        throw new OfflineSaleError("KIT_OUTLET_MISMATCH");
      await backend.run("readwrite", async (tx) => {
        const stored = await tx.get("kits", outletId);
        const sameRun =
          stored?.kit.receiptRun.sequenceId === kit.receiptRun.sequenceId;
        // Same run: continue from max(local counter, cloud high-water).
        // A new epoch starts at the cloud's high-water of that run.
        const counter = Math.max(
          sameRun ? stored.counter : 0,
          kit.receiptRun.lastNumber,
        );
        await tx.put("kits", { outletId, kit, counter });
      });
    },

    kit: () =>
      backend.run(
        "readonly",
        async (tx) => (await tx.get("kits", outletId))?.kit ?? null,
      ),

    resumeSequenceId: () =>
      backend.run(
        "readonly",
        async (tx) =>
          (await tx.get("kits", outletId))?.kit.receiptRun.sequenceId ?? null,
      ),

    async recordSale(cart, tenders) {
      const paidAt = now();
      const eventId = nextUlid();
      return backend.run("readwrite", async (tx) => {
        const stored = await tx.get("kits", outletId);
        if (!stored) throw new OfflineSaleError("KIT_MISSING");
        const { kit } = stored;
        if (paidAt.getTime() >= Date.parse(kit.expiresAt))
          throw new OfflineSaleError("KIT_EXPIRED");
        if (tenders.length === 0) throw new OfflineSaleError("TENDER_REQUIRED");
        // Only what the kit allows offline: cash and manual EDC.
        for (const tender of tenders)
          if (!kit.tenders.includes(tender.method))
            throw new OfflineSaleError("TENDER_NOT_OFFLINE");
        const priced = priceOfflineSale(kit, cart, paidAt);
        const tendered = tenders.reduce((sum, row) => sum + row.amountIdr, 0);
        if (tendered !== priced.totalIdr)
          throw new OfflineSaleError("TENDER_TOTAL_MISMATCH");
        for (const tender of tenders)
          if (tender.method === "cash" && tender.receivedIdr < tender.amountIdr)
            throw new OfflineSaleError("CASH_RECEIVED_SHORT");
        const sequenceNumber = stored.counter + 1;
        const parsed = offlineSaleEventSchema.safeParse({
          eventId,
          kitId: kit.kitId,
          sequenceId: kit.receiptRun.sequenceId,
          sequenceNumber,
          paidAt: paidAt.toISOString(),
          ...priced,
          tenders,
        });
        if (!parsed.success) throw new OfflineSaleError("SALE_INVALID");
        const record: QueueRecord = {
          eventId: parsed.data.eventId,
          outletId,
          event: parsed.data,
          queuedAt: paidAt.toISOString(),
        };
        await tx.put("queue", record);
        await tx.put("kits", { ...stored, counter: sequenceNumber });
        return parsed.data;
      });
    },

    pending: queued,

    pendingCount: async () => (await queued()).length,

    parked: () =>
      backend.run("readonly", async (tx) =>
        (await tx.getAll("parked"))
          .filter((row) => row.outletId === outletId)
          .sort((a, b) => byRun(a.event, b.event)),
      ),

    sync() {
      // One sync at a time per queue; another tab's sync is harmless (replay).
      syncing ??= runSync().finally(() => {
        syncing = null;
      });
      return syncing;
    },
  };
}

/**
 * Offline sales this tablet still queues for the outlet (the shift close
 * guard). No IndexedDB: nothing was ever queued. A storage that cannot be
 * read throws: the close is refused rather than guessed.
 */
export async function countPendingOfflineSales(
  backend: OfflineBackend | null,
  outletId: string,
): Promise<number> {
  if (backend === null) return 0;
  const outlet = outletId.toLowerCase();
  return backend.run(
    "readonly",
    async (tx) =>
      (await tx.getAll("queue")).filter((row) => row.outletId === outlet)
        .length,
  );
}
