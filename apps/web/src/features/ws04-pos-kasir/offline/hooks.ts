// O3 wiring of the offline POS on a cashier screen (bead legend-wasr7.7):
// registers the /pos shell worker, keeps the kit of the open shift fresh while
// online, and syncs the queue when the tablet comes back online and every 30
// seconds while sales are queued. The counts feed the O4 banner ("N transaksi
// belum terkirim"). All of it is best-effort: a failure is retried on the next
// tick, the queue stays on the tablet.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PosOfflineKit } from "@starter/shared/pos";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useOutletId } from "../hooks";
import { useActiveShift } from "../shift-hooks";
import {
  fetchOfflineKit,
  sendOfflineBatch,
  sendOfflineConflict,
  sendOfflineStuck,
} from "./api";
import { useApiReachable } from "./connectivity";
import { createOfflineQueue, type OfflineQueue } from "./queue";
import { registerPosShell } from "./shell";
import { defaultOfflineBackend } from "./store";

const SYNC_EVERY_MS = 30_000;
/** A kit this close to its 24 hours is replaced while still online. */
const KIT_REFRESH_BEFORE_MS = 60 * 60 * 1000;

export type PosOfflineState = {
  queue: OfflineQueue | null;
  /** Sales on this tablet the cloud has not settled (blocks Tutup shift). */
  pending: number;
  /** Sales set aside after a 409 ("perlu dicek"). */
  parked: number;
  /** O4: the API answers (ping), not only the browser's signal. */
  online: boolean;
  /** O4: the kit an offline sale may use now; null when none or expired. */
  kit: PosOfflineKit | null;
  /** O4: reads the counts and the kit again (after a sale). */
  refresh: () => Promise<void>;
  /** O4: one sync now ("Coba kirim sekarang"); false when it failed. */
  syncNow: () => Promise<boolean>;
};

/** Kit for the open shift: issued again for a new shift or near expiry. */
async function ensureKit(
  queue: OfflineQueue,
  outletId: string,
  shiftId: string,
  now: number,
) {
  const kit = await queue.kit();
  if (
    kit &&
    kit.shiftId === shiftId.toLowerCase() &&
    Date.parse(kit.expiresAt) - now > KIT_REFRESH_BEFORE_MS
  )
    return;
  await queue.saveKit(
    await fetchOfflineKit(outletId, shiftId, await queue.resumeSequenceId()),
  );
}

export function usePosOffline(): PosOfflineState {
  const outletId = useOutletId();
  const shift = useActiveShift();
  const shiftId = shift.data?.status === "open" ? shift.data.id : null;
  // Review O3 P2 4: the cloud says this outlet has no open shift, so the
  // kit of the last one takes no more sales.
  const shiftGone = shift.isSuccess && shiftId === null;
  const queue = useMemo(() => {
    const backend = API_MOCK ? null : defaultOfflineBackend();
    if (!backend || outletId === "") return null;
    return createOfflineQueue({
      backend,
      outletId,
      submit: (events) => sendOfflineBatch(outletId, events),
      report: (event) => sendOfflineConflict(outletId, event),
      reportStuck: (event, stuck, approval) =>
        sendOfflineStuck(outletId, event, stuck, approval),
    });
  }, [outletId]);
  const online = useApiReachable();
  const [counts, setCounts] = useState({ pending: 0, parked: 0 });
  const [kit, setKit] = useState<PosOfflineKit | null>(null);

  const refresh = useCallback(async () => {
    if (!queue) return;
    const [pending, parked, stored] = await Promise.all([
      queue.pendingCount(),
      queue.parked().then((rows) => rows.length),
      queue.kit(),
    ]);
    setCounts({ pending, parked });
    setKit(stored && Date.parse(stored.expiresAt) > Date.now() ? stored : null);
  }, [queue]);

  const syncNow = useCallback(async () => {
    if (!queue) return false;
    try {
      await queue.sync();
      return true;
    } catch {
      return false;
    } finally {
      await refresh().catch(() => undefined);
    }
  }, [queue, refresh]);

  useEffect(() => {
    void registerPosShell();
  }, []);

  useEffect(() => {
    if (!queue) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      clearTimeout(timer);
      // Review O3 P3: one failing step does not skip the other. O4: "online"
      // is the API's answer, not only the browser's signal.
      if (online) {
        try {
          if (shiftId) await ensureKit(queue, outletId, shiftId, Date.now());
          else if (shiftGone) await queue.closeKit();
        } catch {
          // Offline or refused: the old kit stays usable until it expires.
        }
        try {
          if ((await queue.pendingCount()) > 0) await queue.sync();
        } catch {
          // Offline, 5xx or a refusal: the queue is kept, the next tick retries.
        }
      }
      try {
        if (alive) await refresh();
      } catch {
        // Storage unreadable: the close guard refuses on its own read.
      }
      if (alive) timer = setTimeout(() => void tick(), SYNC_EVERY_MS);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [queue, outletId, shiftId, shiftGone, online, refresh]);

  return { queue, ...counts, online, kit, refresh, syncNow };
}
