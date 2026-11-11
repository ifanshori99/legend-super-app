// Wiring of the catalog sales gate on an edge (legend-10nex, founder Q57):
// persisted gate state (tracking start + clock high water), the trusted clock,
// and the sales-gate provider that combines the freshness snapshot with the
// cached owner override. The override service is injected (edge/runtime.ts
// passes edge/catalog-override.ts) so this file stays free of its tables.
import { and, eq, lt } from "drizzle-orm";
import type {
  OutletId,
  ScopedTenantContext,
  TenantId,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { edgeCatalogGateState } from "../db/schema/edge-catalog-gate-state.ts";
import { withTenant } from "../db/tenant.ts";
import { createCatalogFreshness } from "./catalog-freshness.ts";
import type { CatalogFreshnessTracker } from "./catalog-freshness.ts";
import {
  CATALOG_SALES_BLOCK_AFTER_MS,
  installSalesGateProvider,
  type SalesGateState,
} from "./sales-gate.ts";
import { createTrustedClock, type TrustedClock } from "./trusted-clock.ts";

/** High water is written at most this often (and on an override grant). */
export const CATALOG_GATE_PERSIST_MS = 60_000;

export type CatalogGateOverride = NonNullable<SalesGateState["override"]>;

export type CatalogGateOverrides = {
  /** Active (not superseded, not closed, not expired) override or null. */
  load(now: Date): Promise<CatalogGateOverride | null>;
  /** Ends the episode: closes the active override (reason SYNC_OK). */
  close(now: Date, reason: "SYNC_OK", onlyId?: string): Promise<void>;
};

export type PersistedCatalogGateState = {
  trackingStartedAt: Date;
  clockHighWaterAt: Date;
};

export async function loadCatalogGateState(
  context: ScopedTenantContext,
  edgeNodeId: string,
  database: typeof db = db,
): Promise<PersistedCatalogGateState | null> {
  const [row] = await withTenant(database, context, (tx) =>
    tx
      .select({
        trackingStartedAt: edgeCatalogGateState.trackingStartedAt,
        clockHighWaterAt: edgeCatalogGateState.clockHighWaterAt,
      })
      .from(edgeCatalogGateState)
      .where(eq(edgeCatalogGateState.edgeNodeId, edgeNodeId))
      .limit(1),
  );
  return row ?? null;
}

/** Upsert; `trackingStartedAt` is written once and never changed. */
export async function saveCatalogGateState(
  context: ScopedTenantContext,
  scope: { tenantId: string; outletId: string; edgeNodeId: string },
  input: { trackingStartedAt: Date; clockHighWaterAt: Date },
  database: typeof db = db,
): Promise<void> {
  await withTenant(database, context, async (tx) => {
    await tx
      .insert(edgeCatalogGateState)
      .values({
        tenantId: scope.tenantId as TenantId,
        outletId: scope.outletId as OutletId,
        edgeNodeId: scope.edgeNodeId,
        trackingStartedAt: input.trackingStartedAt,
        clockHighWaterAt: input.clockHighWaterAt,
        updatedAt: input.clockHighWaterAt,
      })
      .onConflictDoNothing();
    // Never moves the high water back: only a strictly higher value is written.
    await tx
      .update(edgeCatalogGateState)
      .set({
        clockHighWaterAt: input.clockHighWaterAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(edgeCatalogGateState.tenantId, scope.tenantId as TenantId),
          eq(edgeCatalogGateState.edgeNodeId, scope.edgeNodeId),
          lt(edgeCatalogGateState.clockHighWaterAt, input.clockHighWaterAt),
        ),
      );
  });
}

export type CatalogGateHandle = {
  freshness: CatalogFreshnessTracker;
  clock: TrustedClock;
  /**
   * Sync cache update after a committed grant (override) or close (null), so
   * the very next sale sees it. Also persists the high water (awaited).
   */
  applyOverrideChange(next: CatalogGateOverride | null): Promise<void>;
  /** Reload the override cache (after a grant or close). Persists high water. */
  refreshOverride(): Promise<void>;
  /** One housekeeping pass (also what the interval runs): persist + close. */
  tick(): Promise<void>;
  stop(): Promise<void>;
};

/**
 * Builds the trusted clock from the persisted high water, the freshness
 * tracker on it, and installs the sales-gate provider. Persistence and
 * override failures are reported to `onError` and never throw: a persist
 * failure keeps the in-memory clock (still monotonic within the process); an
 * override load failure keeps the last cached override.
 */
export async function startCatalogGate(options: {
  context: ScopedTenantContext;
  scope: { tenantId: string; outletId: string; edgeNodeId: string };
  overrides: CatalogGateOverrides;
  onOwnerAlarm?: NonNullable<
    Parameters<typeof createCatalogFreshness>[0]
  >["onOwnerAlarm"];
  /** Boot: restore each stream's last success before the gate opens. */
  seed?: (freshness: CatalogFreshnessTracker) => Promise<void>;
  onError?: (error: unknown) => void;
  /** Boot: the wall clock was behind the saved high water (audit/log line). */
  onClockRegressed?: (info: { wallNow: Date; highWater: Date }) => void;
  persistMs?: number;
  database?: typeof db;
  /** Tests: wall and monotonic sources. */
  wall?: () => Date;
  mono?: () => number;
}): Promise<CatalogGateHandle> {
  const { context, scope, overrides } = options;
  const database = options.database ?? db;
  const onError = options.onError ?? (() => {});
  // Fail closed: until the persisted state loads, sales are blocked
  // (GATE_UNAVAILABLE). Starting from "now" would reset the tracking start and
  // could persist a lower high water, so keep retrying instead.
  installSalesGateProvider(() => ({
    blocked: true,
    stale24h: false,
    reason: "GATE_UNAVAILABLE",
    staleSince: null,
    staleStreams: [],
    override: null,
  }));
  const retryMs = Math.min(options.persistMs ?? CATALOG_GATE_PERSIST_MS, 5_000);
  let persisted: PersistedCatalogGateState | null = null;
  for (;;) {
    try {
      persisted = await loadCatalogGateState(
        context,
        scope.edgeNodeId,
        database,
      );
      break;
    } catch (error) {
      onError(error);
      await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
    }
  }
  const clock = createTrustedClock({
    wall: options.wall,
    mono: options.mono,
    persistedHighWater: persisted?.clockHighWaterAt ?? null,
  });
  if (clock.regressed()) {
    try {
      options.onClockRegressed?.({
        wallNow: (options.wall ?? (() => new Date()))(),
        highWater: persisted?.clockHighWaterAt ?? clock.now(),
      });
    } catch (error) {
      onError(error);
    }
  }
  const trackingStartedAt = persisted?.trackingStartedAt ?? clock.now();
  const freshness = createCatalogFreshness({
    clock,
    trackingStartedAt,
    onOwnerAlarm: options.onOwnerAlarm,
  });

  try {
    await options.seed?.(freshness);
  } catch (error) {
    onError(error);
  }

  let override: CatalogGateOverride | null = null;
  let stopped = false;

  const persist = async () => {
    try {
      await saveCatalogGateState(
        context,
        scope,
        { trackingStartedAt, clockHighWaterAt: clock.highWater() },
        database,
      );
    } catch (error) {
      onError(error);
    }
  };
  const refreshOverride = async () => {
    try {
      override = await overrides.load(clock.now());
    } catch (error) {
      onError(error);
    }
    await persist();
  };

  installSalesGateProvider((): SalesGateState => {
    const snap = freshness.snapshot();
    const at = clock.now().getTime();
    // An override that is in the future or runs past 24 h is ignored.
    const active =
      override &&
      override.grantedAt.getTime() <= at &&
      override.untilAt.getTime() > at &&
      override.untilAt.getTime() <= at + CATALOG_SALES_BLOCK_AFTER_MS
        ? override
        : null;
    const stale24h = snap.salesGate.stale24h;
    const regressed = clock.regressed();
    return {
      blocked: (stale24h || regressed) && !active,
      stale24h,
      reason: regressed
        ? "CLOCK_REGRESSED"
        : stale24h
          ? "CATALOG_STALE_24H"
          : null,
      staleSince: snap.salesGate.staleSince,
      staleStreams: snap.salesGate.staleStreams,
      override: active,
    };
  });

  const tick = async () => {
    if (stopped) return;
    // All critical streams within 24 h again: the episode ends.
    const observed = override;
    if (observed && !freshness.snapshot().salesGate.stale24h) {
      try {
        await overrides.close(clock.now(), "SYNC_OK", observed.id);
        // A grant that landed during the await replaced the cache: keep it.
        if (override?.id === observed.id) override = null;
      } catch (error) {
        onError(error);
      }
    }
    await persist();
  };

  // Boot: record the tracking start, then load an override that survived.
  await persist();
  await refreshOverride();
  const timer = setInterval(
    () => void tick(),
    options.persistMs ?? CATALOG_GATE_PERSIST_MS,
  );
  timer.unref?.();

  return {
    freshness,
    clock,
    async applyOverrideChange(next) {
      override = next;
      await persist();
    },
    refreshOverride,
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      installSalesGateProvider(null);
      await persist();
    },
  };
}
