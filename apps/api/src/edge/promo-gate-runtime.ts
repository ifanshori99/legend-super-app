// Edge wiring of the promo freshness gate (edge/promo-gate.ts). Evidence is
// the pull checkpoint of the promo and voucher catalog streams. No such
// stream is synced to the edge today, so promos stay off on an edge until one
// exists (fail closed). Ages use the trusted clock; a read failure keeps the
// last known success times, which only age.
import { and, eq, sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { edgePullCheckpoints } from "../db/schema/edge-node.ts";
import { withTenant } from "../db/tenant.ts";
import { CATALOG_GATE_PERSIST_MS } from "./catalog-gate.ts";
import {
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

/**
 * The high water is persisted only every CATALOG_GATE_PERSIST_MS, and a
 * lagging or failed persist can leave the saved value two ticks old, so a
 * checkpoint written just before shutdown can be stamped after it. Evidence
 * counts as written since the boot only beyond this margin (533 R1).
 */
export const PROMO_CHECKPOINT_PERSIST_MARGIN_MS =
  2 * CATALOG_GATE_PERSIST_MS + 5_000;

export type PromoGateHandle = {
  refresh(): Promise<void>;
  stop(): void;
};

export function startPromoGate(options: {
  context: ScopedTenantContext;
  edgeNodeId: string;
  clock: Pick<TrustedClock, "now"> &
    Partial<Pick<TrustedClock, "elapsedTimeUnproven" | "bootHighWater">>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  database?: typeof db;
}): PromoGateHandle {
  const database = options.database ?? db;
  const lastSuccess = new Map<string, Date>();
  const refresh = async () => {
    try {
      const rows = await withTenant(database, options.context, (tx) =>
        tx
          .select({
            stream: edgePullCheckpoints.stream,
            lastSuccessAt: edgePullCheckpoints.lastSuccessAt,
          })
          .from(edgePullCheckpoints)
          .where(
            and(
              eq(edgePullCheckpoints.edgeNodeId, options.edgeNodeId),
              // The column type lists the streams known today; the table
              // check allows any `catalog:%` stream, so compare in SQL.
              sql`${edgePullCheckpoints.stream} IN (${sql.join(
                PROMO_CHECKPOINT_STREAMS.map((stream) => sql`${stream}`),
                sql`, `,
              )})`,
            ),
          ),
      );
      for (const row of rows)
        lastSuccess.set(String(row.stream), row.lastSuccessAt);
    } catch (error) {
      options.onError?.(error);
    }
  };
  installPromoFreshnessProvider(() => {
    // Fresh-looking saved checkpoints cannot prove time spent powered off.
    // Q62 allows ordinary sales in this case, while discounts stay closed.
    // 533 A3: a checkpoint written strictly after the boot high water plus the
    // persist margin was made by a pull since this boot, so it proves itself;
    // one at or before that could predate the shutdown and does not. Without a
    // boot high water: closed.
    const unproven = options.clock.elapsedTimeUnproven?.() === true;
    const bootHigh = options.clock.bootHighWater?.()?.getTime();
    if (unproven && bootHigh === undefined) return false;
    const at = options.clock.now().getTime();
    return PROMO_CHECKPOINT_STREAMS.every((stream) => {
      const last = lastSuccess.get(stream);
      if (!last) return false;
      if (
        unproven &&
        last.getTime() <= bootHigh! + PROMO_CHECKPOINT_PERSIST_MARGIN_MS
      )
        return false;
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
    },
  };
}
