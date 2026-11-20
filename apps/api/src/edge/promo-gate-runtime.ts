// Edge wiring of the promo freshness gate (edge/promo-gate.ts). Evidence is
// the pull checkpoint of the promo and voucher catalog streams. Missing
// checkpoints keep promos off (fail closed). Ages use the trusted clock; a read
// failure keeps the last known success times, which only age. A rewound stream
// (watermark = CATALOG_REWIND_MARK) or an open promotions replay marker keeps
// promos off whatever the success times say (legend-1212, fail closed).
import { and, eq, sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { edgePullCheckpoints } from "../db/schema/edge-node.ts";
import { withTenant } from "../db/tenant.ts";
import {
  CATALOG_PROMO_REPLAY_STREAM,
  CATALOG_REWIND_MARK,
} from "./catalog-puller.ts";
import {
  installPromoClockProvider,
  installPromoFreshnessProvider,
  PROMO_STALE_AFTER_MS,
} from "./promo-gate.ts";
import type { TrustedClock } from "./trusted-clock.ts";

/** Checkpoint streams that must be fresh for promos and vouchers to apply. */
export const PROMO_CHECKPOINT_STREAMS = [
  "catalog:promotions",
  "catalog:vouchers",
] as const;

export const PROMO_GATE_REFRESH_MS = 60_000;

export type PromoGateHandle = {
  refresh(): Promise<void>;
  stop(): void;
};

export function startPromoGate(options: {
  context: ScopedTenantContext;
  edgeNodeId: string;
  clock: Pick<TrustedClock, "now"> &
    Partial<Pick<TrustedClock, "elapsedTimeUnproven">>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  database?: typeof db;
}): PromoGateHandle {
  const database = options.database ?? db;
  installPromoClockProvider(() => options.clock.now());
  const lastSuccess = new Map<string, Date>();
  // Streams whose catalog was rewound, and whether the promotions replay is
  // still open: both close the gate until a confirming pull clears them.
  let rewound = new Set<string>();
  let replayOpen = false;
  const refresh = async () => {
    try {
      const rows = await withTenant(database, options.context, (tx) =>
        tx
          .select({
            stream: edgePullCheckpoints.stream,
            lastSuccessAt: edgePullCheckpoints.lastSuccessAt,
            watermark: edgePullCheckpoints.watermark,
          })
          .from(edgePullCheckpoints)
          .where(
            and(
              eq(edgePullCheckpoints.edgeNodeId, options.edgeNodeId),
              // The column type lists the streams known today; the table
              // check allows any `catalog:%` stream, so compare in SQL.
              sql`${edgePullCheckpoints.stream} IN (${sql.join(
                [...PROMO_CHECKPOINT_STREAMS, CATALOG_PROMO_REPLAY_STREAM].map(
                  (stream) => sql`${stream}`,
                ),
                sql`, `,
              )})`,
            ),
          ),
      );
      const nextRewound = new Set<string>();
      let nextReplayOpen = false;
      for (const row of rows) {
        const stream = String(row.stream);
        if (stream === CATALOG_PROMO_REPLAY_STREAM) {
          nextReplayOpen = true;
          continue;
        }
        lastSuccess.set(stream, row.lastSuccessAt);
        if (row.watermark === CATALOG_REWIND_MARK) nextRewound.add(stream);
      }
      rewound = nextRewound;
      replayOpen = nextReplayOpen;
    } catch (error) {
      options.onError?.(error);
    }
  };
  installPromoFreshnessProvider(() => {
    // Fresh-looking saved checkpoints cannot prove time spent powered off.
    // Q62 allows ordinary sales in this case, while discounts stay closed.
    // 533b: while the elapsed time is unproven, promos stay off, full stop.
    // They return only once the clock is proven (server time evidence), then
    // the normal checkpoint age rules apply.
    if (options.clock.elapsedTimeUnproven?.() === true) return false;
    // Rewound after a cloud restore: a promo the cloud no longer has may still
    // be here until the replay is confirmed (also while the cloud is unreachable).
    if (rewound.size > 0 || replayOpen) return false;
    const at = options.clock.now().getTime();
    return PROMO_CHECKPOINT_STREAMS.every((stream) => {
      const last = lastSuccess.get(stream);
      if (!last) return false;
      const age = at - last.getTime();
      return age >= 0 && age <= PROMO_STALE_AFTER_MS;
    });
  });
  void refresh();
  const timer = setInterval(
    () => void refresh(),
    options.intervalMs ?? PROMO_GATE_REFRESH_MS,
  );
  timer.unref?.();
  return {
    refresh,
    stop() {
      clearInterval(timer);
      installPromoFreshnessProvider(null);
      installPromoClockProvider(null);
    },
  };
}
