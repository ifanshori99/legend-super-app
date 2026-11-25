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
/** Boot waits at most this long for the saved gate state (DB down: no hang). */
export const CATALOG_GATE_BOOT_WAIT_MS = 3_000;

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
  /**
   * Called once, right after the trusted clock exists and before `seed` or any
   * owner alarm can fire. The caller uses it to time-stamp the boot alarm with
   * the trusted clock instead of a wall clock that may be dead (RTC at 1970).
   */
  onClock?: (clock: TrustedClock) => void;
  persistMs?: number;
  /** First load of the saved state waits this long; default 3 s. */
  bootWaitMs?: number;
  database?: typeof db;
  /** Tests: wall and monotonic sources. */
  wall?: () => Date;
  mono?: () => number;
}): Promise<CatalogGateHandle> {
  const { context, scope, overrides } = options;
  const database = options.database ?? db;
  const onError = options.onError ?? (() => {});
  // Fail closed and never hang (founder decision, legend-10nex): sales stay
  // held (GATE_UNAVAILABLE) until the persisted state loads. A local database
  // that is down at boot must not stall the rest of the edge runtime, so the
  // first load gets a bounded wait and later attempts retry in the background.
  const unavailable = (): SalesGateState => ({
    blocked: true,
    stale24h: false,
    reason: "GATE_UNAVAILABLE",
    staleSince: null,
    staleStreams: [],
    override: null,
  });
  installSalesGateProvider(unavailable);
  const retryMs = Math.min(options.persistMs ?? CATALOG_GATE_PERSIST_MS, 5_000);
  const bootWaitMs = options.bootWaitMs ?? CATALOG_GATE_BOOT_WAIT_MS;
  const loadBounded = async (
    waitMs: number,
  ): Promise<{ ok: true; state: PersistedCatalogGateState | null } | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        loadCatalogGateState(context, scope.edgeNodeId, database).then(
          (state) => ({ ok: true as const, state }),
        ),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), waitMs);
        }),
      ]);
    } catch (error) {
      onError(error);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const first = await loadBounded(bootWaitMs);
  // Provisional until the state loads: wall clock only, tracking from now.
  const clock = createTrustedClock({
    wall: options.wall,
    mono: options.mono,
    persistedHighWater: first?.state?.clockHighWaterAt ?? null,
  });
  try {
    options.onClock?.(clock);
  } catch (error) {
    onError(error);
  }
  let trackingStartedAt = first?.state?.trackingStartedAt ?? clock.now();
  const freshness = createCatalogFreshness({
    clock,
    trackingStartedAt,
    onOwnerAlarm: options.onOwnerAlarm,
  });
  // One report per regression episode; re-armed once the clock recovers.
  let regressionReported = false;
  const reportRegression = (highWater: Date) => {
    if (!clock.regressed()) {
      regressionReported = false;
      return;
    }
    if (regressionReported) return;
    regressionReported = true;
    try {
      options.onClockRegressed?.({
        wallNow: (options.wall ?? (() => new Date()))(),
        highWater,
      });
    } catch (error) {
      onError(error);
    }
  };
  if (first) reportRegression(first.state?.clockHighWaterAt ?? clock.now());
  let ready = first !== null;

  let override: CatalogGateOverride | null = null;
  // Every cache decision invalidates loads started before that decision.
  let overrideGeneration = 0;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const persist = async () => {
    // Never write provisional values over a state that did not load yet.
    if (!ready) return;
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
    const generation = ++overrideGeneration;
    try {
      const loaded = await overrides.load(clock.now());
      // A committed grant/close or a newer reload wins over this old read.
      if (!stopped && generation === overrideGeneration) override = loaded;
    } catch (error) {
      onError(error);
    }
    await persist();
  };

  installSalesGateProvider((): SalesGateState => {
    if (!ready) return unavailable();
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
    // A wall clock set back while running shows up here, so report it too.
    reportRegression(clock.highWater());
    const regressed = clock.regressed();
    // The owner may sell on old prices, not without knowing the tax.
    const taxUnsynced = snap.salesGate.taxUnsynced.length > 0;
    return {
      blocked: taxUnsynced || ((stale24h || regressed) && !active),
      stale24h,
      reason: taxUnsynced
        ? "TAX_NOT_SYNCED"
        : regressed
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
    if (stopped || !ready) return;
    reportRegression(clock.highWater());
    // Close only once the catalog and device clock have both recovered.
    const observed = override;
    const snapshot = freshness.snapshot();
    if (
      observed &&
      !snapshot.stale &&
      !snapshot.salesGate.stale24h &&
      snapshot.salesGate.taxUnsynced.length === 0 &&
      !clock.regressed()
    ) {
      try {
        await overrides.close(clock.now(), "SYNC_OK", observed.id);
        // A grant that landed during the await replaced the cache: keep it.
        if (override?.id === observed.id) {
          override = null;
          overrideGeneration += 1;
        }
      } catch (error) {
        onError(error);
      }
    }
    await persist();
  };

  // A failed read is tried again: unseeded tax holds sales, and an offline
  // edge has no pull that could release it.
  const seedFreshness = async (): Promise<void> => {
    if (stopped) return;
    try {
      await options.seed?.(freshness);
    } catch (error) {
      onError(error);
      if (stopped) return;
      const timer = setTimeout(() => void seedFreshness(), retryMs);
      timer.unref?.();
      retryTimer = timer;
    }
  };
  // Boot: record the tracking start, then load an override that survived.
  if (ready) {
    await seedFreshness();
    await persist();
    await refreshOverride();
  } else {
    // Local database not readable yet: boot goes on with sales held; keep
    // trying to load the saved state in the background.
    const retry = async (): Promise<void> => {
      if (stopped || ready) return;
      const loaded = await loadBounded(bootWaitMs);
      if (stopped) return;
      if (loaded === null) {
        const timer = setTimeout(() => void retry(), retryMs);
        timer.unref?.();
        retryTimer = timer;
        return;
      }
      const state = loaded.state;
      if (state) {
        clock.adoptHighWater(state.clockHighWaterAt);
        freshness.adoptTrackingStartedAt(state.trackingStartedAt);
        trackingStartedAt = state.trackingStartedAt;
      }
      await seedFreshness();
      ready = true;
      reportRegression(state?.clockHighWaterAt ?? clock.now());
      await persist();
      await refreshOverride();
    };
    void retry();
  }
  const timer = setInterval(
    () => void tick(),
    options.persistMs ?? CATALOG_GATE_PERSIST_MS,
  );
  timer.unref?.();

  return {
    freshness,
    clock,
    async applyOverrideChange(next) {
      overrideGeneration += 1;
      override = next;
      await persist();
    },
    refreshOverride,
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (retryTimer) clearTimeout(retryTimer);
      installSalesGateProvider(null);
      await persist();
    },
  };
}
