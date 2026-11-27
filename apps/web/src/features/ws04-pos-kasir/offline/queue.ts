// O3 offline sale queue of one outlet on this tablet (bead legend-wasr7.7;
// docs/design/cloud-only-release.md §2, Keputusan CTO O2, review O2, review O3).
//
// - recordSale prices the cart from the kit (list prices, no promo), takes the
//   next `L` number and appends the sale in one transaction. Only cash and
//   manual EDC (slip reference) are accepted, as the kit lists them. A kit
//   whose shift closed takes no sale (review O3 P2 4).
// - sync sends the queue in run order, at most OFFLINE_BATCH_MAX_EVENTS per
//   call. Replays are safe: the cloud keys each sale by its eventId. A
//   settled result (ingested, held, duplicate) drops the sale; a rejected one
//   stays queued and the sync stops there (review O3 P3: what follows would
//   only be a false gap).
// - Review O3 P1: a 409 OFFLINE_EVENT_CONFLICT (the eventId is stored under
//   another kit) fails the whole call. The batch is resent one sale at a time;
//   the sale that still answers it is parked and reported to the cloud
//   (reportPosOfflineConflict), which books it and fills its number slot. Only
//   a settled report drops it. Any other refusal stops the sync, nothing parked.
// - pendingCount (queue + parked) blocks the shift close and the sign-out
//   (tablet guard; the count also goes to the server as offlineQueuePending).
// - 1273 P2-1: a sale the cloud refuses for good (kit_unknown, sequence_gap,
//   or a 403 on the whole call: the device is refused) is marked stuck by the
//   sync. reportStuck sends it with a supervisor's PIN
//   (reportPosOfflineStuck); only a settled answer (held / ingested) drops it.
//   A network failure or a refused PIN keeps it on the tablet.
import { createUlidFactory } from "@starter/shared/core";
import {
  OFFLINE_BATCH_MAX_EVENTS,
  OFFLINE_EVENT_SETTLED,
  offlineSaleEventSchema,
  posOfflineKitSchema,
  type OfflineEventResult,
  type OfflineSaleEvent,
  type OfflineStuckReason,
  type OfflineSaleTender,
  type PosOfflineBatchResult,
  type PosOfflineKit,
} from "@starter/shared/pos";
import { ApiError } from "@/lib/api/errors";
import { OfflineSaleError, priceOfflineSale, type OfflineCart } from "./price";
import type {
  OfflineBackend,
  OfflineTx,
  ParkedRecord,
  QueueRecord,
} from "./store";

export type OfflineSubmit = (
  events: OfflineSaleEvent[],
) => Promise<PosOfflineBatchResult>;

export type OfflineReport = (
  event: OfflineSaleEvent,
) => Promise<OfflineEventResult>;

/** The supervisor's approval of a stuck sale report (1273 P2-1). */
export type OfflineStuckApproval = {
  reason: string;
  approverUserId: string;
  pin: string;
};

export type OfflineStuckSend = (
  event: OfflineSaleEvent,
  stuck: OfflineStuckReason,
  approval: OfflineStuckApproval,
) => Promise<OfflineEventResult>;

/** A queued sale the last sync found refused for good. */
export type OfflineStuckSale = {
  event: OfflineSaleEvent;
  stuck: OfflineStuckReason;
};

export type OfflineRecordOptions = {
  /**
   * O5 (1): "pelanggan lain": the cart shares lines with an unclear order and
   * the cashier says it is another customer. Written reason, 4 to 200 letters.
   */
  otherCustomerReason?: string;
};

export type OfflineSyncReport = {
  settled: number;
  parked: number;
  /** Sales still queued or parked after this sync. */
  remaining: number;
  /** Why the sync stopped early (network, 5xx, refusal); null when it ran through. */
  error: unknown;
};

export type OfflineQueue = {
  /** Stores the kit the cloud issued; keeps the local counter of its run. */
  saveKit(kit: PosOfflineKit): Promise<void>;
  /** The usable kit; null when none or its shift closed. */
  kit(): Promise<PosOfflineKit | null>;
  /** The shift closed: the kit takes no sale; its run is kept for the next kit. */
  closeKit(): Promise<void>;
  /** The run to name in the next kit request (null: none stored). */
  resumeSequenceId(): Promise<string | null>;
  recordSale(
    cart: OfflineCart,
    tenders: OfflineSaleTender[],
    options?: OfflineRecordOptions,
  ): Promise<OfflineSaleEvent>;
  pending(): Promise<OfflineSaleEvent[]>;
  /** Queued + parked: what blocks Tutup shift and sign-out. */
  pendingCount(): Promise<number>;
  parked(): Promise<ParkedRecord[]>;
  /** Queued sales the cloud refused for good (1273 P2-1), in run order. */
  stuck(): Promise<OfflineStuckSale[]>;
  /**
   * Reports a stuck sale with a supervisor's PIN; drops it only when the
   * cloud answers it settled. A failure, or an answer that is not settled
   * (STUCK_NOT_SETTLED), throws and keeps it queued.
   */
  reportStuck(
    eventId: string,
    approval: OfflineStuckApproval,
  ): Promise<OfflineEventResult>;
  sync(): Promise<OfflineSyncReport>;
};

/** Tutup shift is refused on the tablet while sales are still queued. */
export const OFFLINE_QUEUE_PENDING = "OFFLINE_QUEUE_PENDING";
/** The only 409 that parks a sale (review O3 P1). */
export const OFFLINE_EVENT_CONFLICT = "OFFLINE_EVENT_CONFLICT";

const byRun = (a: OfflineSaleEvent, b: OfflineSaleEvent) =>
  a.sequenceId.localeCompare(b.sequenceId) ||
  a.sequenceNumber - b.sequenceNumber;

const isEventConflict = (error: unknown) =>
  error instanceof ApiError &&
  error.status === 409 &&
  error.code === OFFLINE_EVENT_CONFLICT;

const settles = (result: OfflineEventResult) =>
  OFFLINE_EVENT_SETTLED.includes(result.status);

/** Batch refusals the tablet can never get past by resending (1273 P2-1). */
const STUCK_RESULT_REASONS: readonly string[] = ["kit_unknown", "sequence_gap"];

/** The device itself is refused: every sale of the call is stuck. */
const isDeviceRefused = (error: unknown) =>
  error instanceof ApiError && error.status === 403;

type Step = { settled: number; parked: number; stop: boolean };

async function countOf(tx: OfflineTx, outletId: string | null) {
  const mine = (row: { outletId: string }) =>
    outletId === null || row.outletId === outletId;
  return (
    (await tx.getAll("queue")).filter(mine).length +
    (await tx.getAll("parked")).filter(mine).length
  );
}

export function createOfflineQueue(options: {
  backend: OfflineBackend;
  outletId: string;
  submit: OfflineSubmit;
  report: OfflineReport;
  /** 1273 P2-1: the stuck sale report; without it reportStuck refuses. */
  reportStuck?: OfflineStuckSend;
  now?: () => Date;
}): OfflineQueue {
  const { backend, submit, report } = options;
  /** eventId -> why the cloud refuses it for good, as the last sync saw. */
  const stuckMarks = new Map<string, OfflineStuckReason>();
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

  const parkedRows = () =>
    backend.run("readonly", async (tx) =>
      (await tx.getAll("parked"))
        .filter((row) => row.outletId === outletId)
        .sort((a, b) => byRun(a.event, b.event)),
    );

  /** Drops settled sales and raises the run counter. */
  const apply = (settled: string[], runs: PosOfflineBatchResult["runs"]) =>
    backend.run("readwrite", async (tx) => {
      for (const eventId of settled) await tx.delete("queue", eventId);
      const stored = await tx.get("kits", outletId);
      const run = runs.find(
        (row) => row.sequenceId === stored?.kit.receiptRun.sequenceId,
      );
      if (stored && run && run.lastNumber > stored.counter)
        await tx.put("kits", { ...stored, counter: run.lastNumber });
    });

  const park = (event: OfflineSaleEvent) =>
    backend.run("readwrite", async (tx) => {
      await tx.put("parked", {
        eventId: event.eventId,
        outletId,
        event,
        reason: OFFLINE_EVENT_CONFLICT,
        parkedAt: now().toISOString(),
      });
      await tx.delete("queue", event.eventId);
    });

  /** Reports a parked sale; true once the cloud settled it (slot filled). */
  async function reportParked(event: OfflineSaleEvent): Promise<boolean> {
    const answer = await report(event);
    if (!settles(answer)) return false;
    await backend.run("readwrite", (tx) => tx.delete("parked", event.eventId));
    return true;
  }

  /** One call; a 409 OFFLINE_EVENT_CONFLICT is isolated to its sale. */
  async function sendChunk(chunk: OfflineSaleEvent[]): Promise<Step> {
    try {
      const answer = await submit(chunk);
      const settled = answer.results.filter(settles).map((row) => row.eventId);
      for (const row of answer.results) {
        if (
          row.status === "rejected" &&
          row.reason !== null &&
          STUCK_RESULT_REASONS.includes(row.reason)
        )
          stuckMarks.set(row.eventId, row.reason as OfflineStuckReason);
        else stuckMarks.delete(row.eventId);
      }
      await apply(settled, answer.runs);
      return {
        settled: settled.length,
        parked: 0,
        stop: settled.length < answer.results.length,
      };
    } catch (error) {
      if (isDeviceRefused(error))
        for (const event of chunk)
          stuckMarks.set(event.eventId, "device_refused");
      if (!isEventConflict(error)) throw error;
    }
    if (chunk.length === 1) {
      await park(chunk[0]!);
      const filled = await reportParked(chunk[0]!);
      return { settled: filled ? 1 : 0, parked: filled ? 0 : 1, stop: !filled };
    }
    // Every sale before the conflicting one was stored: alone it answers
    // `duplicate`. Only the conflicting one answers 409 again.
    const total: Step = { settled: 0, parked: 0, stop: false };
    for (const event of chunk) {
      const step = await sendChunk([event]);
      total.settled += step.settled;
      total.parked += step.parked;
      if (step.stop) return { ...total, stop: true };
    }
    return total;
  }

  async function runSync(): Promise<OfflineSyncReport> {
    let settled = 0;
    let parked = 0;
    let error: unknown = null;
    try {
      // Reports first: an unreported conflict leaves a gap before the rest.
      let blocked = false;
      for (const row of await parkedRows()) {
        if (await reportParked(row.event)) settled += 1;
        else blocked = true;
      }
      const events = blocked ? [] : await queued();
      for (let at = 0; at < events.length; at += OFFLINE_BATCH_MAX_EVENTS) {
        const step = await sendChunk(
          events.slice(at, at + OFFLINE_BATCH_MAX_EVENTS),
        );
        settled += step.settled;
        parked += step.parked;
        if (step.stop) break;
      }
    } catch (caught) {
      error = caught;
    }
    const remaining = await backend.run("readonly", (tx) =>
      countOf(tx, outletId),
    );
    return { settled, parked, remaining, error };
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
        await tx.put("kits", { outletId, kit, counter, closed: false });
      });
    },

    kit: () =>
      backend.run("readonly", async (tx) => {
        const stored = await tx.get("kits", outletId);
        return stored && !stored.closed ? stored.kit : null;
      }),

    closeKit: () => closeOfflineKit(backend, outletId),

    resumeSequenceId: () =>
      backend.run(
        "readonly",
        async (tx) =>
          (await tx.get("kits", outletId))?.kit.receiptRun.sequenceId ?? null,
      ),

    async recordSale(cart, tenders, recordOptions) {
      const paidAt = now();
      const eventId = nextUlid();
      return backend.run("readwrite", async (tx) => {
        const stored = await tx.get("kits", outletId);
        if (!stored) throw new OfflineSaleError("KIT_MISSING");
        if (stored.closed) throw new OfflineSaleError("KIT_SHIFT_CLOSED");
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
          ...(recordOptions?.otherCustomerReason !== undefined
            ? { otherCustomerReason: recordOptions.otherCustomerReason }
            : {}),
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

    pendingCount: () => backend.run("readonly", (tx) => countOf(tx, outletId)),

    parked: parkedRows,

    async stuck() {
      return (await queued())
        .filter((event) => stuckMarks.has(event.eventId))
        .map((event) => ({ event, stuck: stuckMarks.get(event.eventId)! }));
    },

    async reportStuck(eventId, approval) {
      const stuck = stuckMarks.get(eventId);
      const row = await backend.run("readonly", (tx) =>
        tx.get("queue", eventId),
      );
      if (!options.reportStuck || !stuck || !row || row.outletId !== outletId)
        throw new OfflineSaleError("STUCK_UNKNOWN");
      const answer = await options.reportStuck(row.event, stuck, approval);
      // Only a settled answer: the cloud holds the sale (held or ingested).
      // Anything else is a failure the cashier must see; the sale stays.
      if (!settles(answer)) throw new OfflineSaleError("STUCK_NOT_SETTLED");
      await backend.run("readwrite", (tx) => tx.delete("queue", eventId));
      stuckMarks.delete(eventId);
      return answer;
    },

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
 * Offline sales this tablet still holds for the outlet, queued or parked (the
 * shift close guard); every outlet when `outletId` is null (sign-out). No
 * IndexedDB: nothing was ever queued. A storage that cannot be read throws:
 * the close is refused rather than guessed.
 */
export async function countPendingOfflineSales(
  backend: OfflineBackend | null,
  outletId: string | null,
): Promise<number> {
  if (backend === null) return 0;
  const outlet = outletId === null ? null : outletId.toLowerCase();
  return backend.run("readonly", (tx) => countOf(tx, outlet));
}

/**
 * Review O3 P2 4: the shift closed, so its kit takes no more sales. The run
 * and counter stay so the next shift's kit continues it.
 */
export async function closeOfflineKit(
  backend: OfflineBackend | null,
  outletId: string,
): Promise<void> {
  if (backend === null) return;
  const outlet = outletId.toLowerCase();
  await backend.run("readwrite", async (tx) => {
    const stored = await tx.get("kits", outlet);
    if (stored && !stored.closed)
      await tx.put("kits", { ...stored, closed: true });
  });
}
