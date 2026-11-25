// Freshness of the critical catalog streams on an edge node (legend-10nex).
// A catalog stream failure used to be only logged; nobody learned that prices
// or product status on the edge had stopped updating.
//
//   critical streams  price_lists, item_variants and modifiers (prices: a
//                     variant or modifier price is money), menu_items
//                     (product status), the three tax streams and
//                     floor_zones (service charge per zone).
//   tax               (legend-osqou.22) a tax stream that was never read to its
//                     end leaves no tax to compute with: `taxUnsynced` holds
//                     sales at once and no owner override lifts it.
//   stale             a critical stream failed since its last success (any
//                     reason, offline included: the prices on screen are old
//                     either way).
//   cashier warning   "katalog belum diperbarui sejak HH:MM" while stale.
//   owner alarm       a stale stream whose latest failure came from a
//                     reachable cloud (sync failing, not offline) and whose
//                     failures with a reachable cloud have lasted at least
//                     `failurePersistMs` (default 5 minutes, so one failed
//                     tick after a restart or a wake from sleep does not
//                     alarm). `staleAlarmAfterMs` (default 0, no extra age
//                     condition) can still add one. A purely offline edge
//                     never alarms (it cannot reach the owner; the heartbeat
//                     carries the alarm after reconnect).
//   delivery          `onOwnerAlarm` fires once per stale episode (local log
//                     only). The owner is told through the link heartbeat:
//                     the link client sends `alarmStreams` of every snapshot
//                     while they last (`catalogStaleForHeartbeat`), the cloud
//                     notifies and dedupes. Release order: cloud first, then
//                     edge (an older cloud refuses the heartbeat field).
//   sale policy       founder Q57: `stale24h` (and so `salesBlocked`) when
//                     ANY critical stream has had no success for more than
//                     `blockAfterMs` (24 h; exactly 24 h is not blocked),
//                     whether or not a failure was recorded (a dead loop or
//                     a restart that lost the failure state still blocks).
//                     A stream that never succeeded ages from
//                     `trackingStartedAt`. The owner override is applied in
//                     sales-gate.ts, not here; the cashier warning stays.
//                     Ages use the injected (trusted) clock.
//
// State is in memory, but `seedLastSuccess` restores each stream's last
// success from the pull checkpoint at boot (`edge_pull_checkpoints`), so a
// restart does not hide a stale catalog. No checkpoint (a new edge): the
// stream starts without a success, and a failure counts from its first one.
import {
  CATALOG_TAX_STREAMS,
  isCatalogTaxStream,
  type CatalogFreshness,
} from "@starter/shared/edge";
import type { CatalogStale } from "./protocol.ts";
import { promosEnabled } from "./promo-gate.ts";
import {
  CATALOG_SALES_BLOCK_AFTER_MS,
  getSalesGateState,
  type SalesGateState,
} from "./sales-gate.ts";

/** Streams whose staleness changes what the cashier sells or charges. */
export const CRITICAL_CATALOG_STREAMS = [
  "price_lists",
  "item_variants",
  "modifiers",
  "menu_items",
  ...CATALOG_TAX_STREAMS,
  // The zone's service charge is part of the bill.
  "floor_zones",
] as const;
export type CriticalCatalogStream = (typeof CRITICAL_CATALOG_STREAMS)[number];

/** No extra age condition: a persisted reachable-cloud failure alarms. */
export const CATALOG_STALE_ALARM_AFTER_MS = 0;
/**
 * A reachable-cloud failure must last this long before it can alarm: one
 * failed tick after a restart or a wake from sleep, with an old last success
 * from the checkpoint, is not an incident.
 */
export const CATALOG_FAILURE_PERSIST_MS = 5 * 60_000;

/** Cloud-http codes that mean "no connection", not "the cloud refused". */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  "NETWORK",
  "TIMEOUT",
  // Proxy / gateway answers: the cloud itself did not answer.
  "HTTP_502",
  "HTTP_503",
  "HTTP_504",
]);

/** NETWORK, TIMEOUT and gateway errors (502-504, 520-529): cloud unreachable. */
export function isOfflineFailureCode(code: string): boolean {
  return UNREACHABLE_CODES.has(code) || /^HTTP_52\d$/.test(code);
}

export type CatalogStreamFreshness = {
  lastSuccessAt: Date | null;
  /** Since the last success; null when the stream never succeeded. */
  ageMs: number | null;
  failureReason: string | null;
};

export type CatalogStaleStream = {
  stream: string;
  /** Start of the episode: last success, or first failure when none. */
  staleSince: Date;
  lastSuccessAt: Date | null;
  reason: string;
};

export type CatalogFreshnessSnapshot = {
  streams: Record<string, CatalogStreamFreshness>;
  stale: boolean;
  ownerAlarm: boolean;
  cashierWarning: string | null;
  /** `stale24h` or `taxUnsynced`; the owner override is applied later. */
  salesBlocked: boolean;
  salesGate: {
    /** A critical stream is older than `blockAfterMs` (override ignored). */
    stale24h: boolean;
    /** Oldest last success (or tracking start) among the offending streams. */
    staleSince: Date | null;
    staleStreams: string[];
    /** Tax streams never pulled whole: sales are held, whatever the override. */
    taxUnsynced: string[];
  };
  /** Streams behind `ownerAlarm`; sent to the cloud with the heartbeat. */
  alarmStreams: CatalogStaleStream[];
};

export type CatalogFreshnessTracker = {
  /** The same trusted time used to age catalog data and stamp pull checkpoints. */
  now(): Date;
  /** `at`: when the stream's last page was stored (default now). */
  recordSuccess(stream: string, at?: Date): void;
  recordFailure(
    stream: string,
    failure: { reason: string; cloudReachable: boolean },
  ): void;
  /**
   * Boot: the last success the pull checkpoint remembers. Never moves a
   * stream's last success back; a stream that is not critical is ignored.
   */
  seedLastSuccess(stream: string, at: Date): void;
  /**
   * Late load of the persisted tracking start (local database was down at
   * boot). Only moves the start earlier, never later.
   */
  adoptTrackingStartedAt(at: Date): void;
  /**
   * The trusted clock was proven by the cloud's server time (533 A2): drop
   * the unproven-time state of every stream. Saved last-success stamps stay,
   * so ages keep counting from them.
   */
  clockProven(): void;
  snapshot(): CatalogFreshnessSnapshot;
};

type StreamState = {
  lastSuccessAt: Date | null;
  /** A live successful pull, not a saved checkpoint, is needed to prove freshness. */
  timeUnproven: boolean;
  /** Failure since the last success. */
  failure: {
    firstAt: Date;
    /** Start of the unbroken run of failures with a reachable cloud. */
    reachableSince: Date | null;
    reason: string;
    cloudReachable: boolean;
  } | null;
};

function isCritical(stream: string): boolean {
  return (CRITICAL_CATALOG_STREAMS as readonly string[]).includes(stream);
}

export function createCatalogFreshness(
  options: {
    /** Trusted clock (edge/trusted-clock.ts); wins over `now`. */
    clock?: { now(): Date; elapsedTimeUnproven?(): boolean };
    now?: () => Date;
    /** First boot of the freshness tracking (default: now). */
    trackingStartedAt?: Date;
    /** Age above which sales are held (default 24 h). */
    blockAfterMs?: number;
    timeZone?: string;
    staleAlarmAfterMs?: number;
    /** How long reachable-cloud failures must last to alarm (default 5 min). */
    failurePersistMs?: number;
    /** Once per stale episode; a throw or rejection is swallowed. */
    onOwnerAlarm?: (alarm: {
      stream: string;
      reason: string;
      lastSuccessAt: Date | null;
      streams: readonly CatalogStaleStream[];
    }) => void | Promise<void>;
  } = {},
): CatalogFreshnessTracker {
  const trustedClock = options.clock;
  const now = trustedClock
    ? () => trustedClock.now()
    : (options.now ?? (() => new Date()));
  const blockAfterMs = options.blockAfterMs ?? CATALOG_SALES_BLOCK_AFTER_MS;
  let trackingStartedAt = options.trackingStartedAt ?? now();
  const timeZone = options.timeZone ?? "Asia/Jakarta";
  const alarmAfterMs =
    options.staleAlarmAfterMs ?? CATALOG_STALE_ALARM_AFTER_MS;
  const persistMs = options.failurePersistMs ?? CATALOG_FAILURE_PERSIST_MS;
  const states = new Map<string, StreamState>(
    CRITICAL_CATALOG_STREAMS.map((stream) => [
      stream,
      { lastSuccessAt: null, timeUnproven: false, failure: null },
    ]),
  );
  let episodeAlarmed = false;
  let observedUnprovenTime = false;
  let unprovenAgeLowerBoundAt: number | null = null;
  // False until the boot evaluation below ran; a later observation (a wall
  // clock set back while running, 533c) must raise the owner alarm itself.
  let started = false;

  // A high water loaded after a database outage can discover uncertainty
  // after this tracker was created. Adopt it once, then allow each live pull
  // to recover its own stream without the clock's latched boot flag undoing it.
  const observeUnprovenTime = () => {
    if (observedUnprovenTime || !trustedClock?.elapsedTimeUnproven?.()) return;
    observedUnprovenTime = true;
    unprovenAgeLowerBoundAt = now().getTime();
    for (const state of states.values()) state.timeUnproven = true;
    if (started) evaluate();
  };

  // A success stamp from a wall clock ahead of the trusted one (the puller
  // stamps with `new Date()`) must not hide a stale catalog: never in the future.
  const clampToNow = (at: Date | undefined): Date => {
    const current = now();
    return at && at.getTime() < current.getTime() ? at : current;
  };

  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const snapshot = (): CatalogFreshnessSnapshot => {
    observeUnprovenTime();
    const at = now().getTime();
    const streams: Record<string, CatalogStreamFreshness> = {};
    const staleStates: StreamState[] = [];
    const alarmStreams: CatalogStaleStream[] = [];
    const blockedStreams: { stream: string; since: Date }[] = [];
    const taxUnsynced: string[] = [];
    for (const [stream, state] of states) {
      // Age basis of the sales rule: last success, or tracking start when
      // the stream never succeeded. Independent of any recorded failure.
      const basis = state.lastSuccessAt ?? trackingStartedAt;
      if (isCatalogTaxStream(stream) && state.lastSuccessAt === null)
        taxUnsynced.push(stream);
      // Q62 does not turn unknown downtime into a 24-hour hold, but the age of
      // the saved checkpoint keeps growing on the trusted clock (533 A1): a
      // catalog 20 hours old at an offline restart blocks sales 4 hours later,
      // so the outlet never sells on prices that are really over 24 hours old.
      const ageReference = at;
      if (ageReference - basis.getTime() > blockAfterMs)
        blockedStreams.push({ stream, since: basis });
      streams[stream] = {
        lastSuccessAt: state.lastSuccessAt,
        ageMs:
          state.lastSuccessAt && !state.timeUnproven
            ? Math.max(0, at - state.lastSuccessAt.getTime())
            : null,
        failureReason:
          state.failure?.reason ??
          (state.timeUnproven ? "CLOCK_ELAPSED_UNPROVEN" : null),
      };
      if (state.timeUnproven) {
        staleStates.push(state);
        // This is a queued alarm even without a reachable cloud. The runtime
        // persists it locally and the heartbeat delivers it after reconnect.
        alarmStreams.push({
          stream,
          // Seeding checkpoints after the immediate boot alarm must not
          // create a second notification identity for the same episode.
          staleSince: new Date(unprovenAgeLowerBoundAt ?? at),
          lastSuccessAt: state.lastSuccessAt,
          reason: "CLOCK_ELAPSED_UNPROVEN",
        });
        continue;
      }
      if (!state.failure) continue;
      staleStates.push(state);
      const since = state.lastSuccessAt ?? state.failure.firstAt;
      if (
        state.failure.cloudReachable &&
        state.failure.reachableSince !== null &&
        at - state.failure.reachableSince.getTime() >= persistMs &&
        at - since.getTime() > alarmAfterMs
      )
        alarmStreams.push({
          stream,
          staleSince: since,
          lastSuccessAt: state.lastSuccessAt,
          reason: state.failure.reason,
        });
    }
    const stale = staleStates.length > 0;
    const timeUnproven = staleStates.some((state) => state.timeUnproven);
    const stale24h = blockedStreams.length > 0;
    const blockedSince =
      blockedStreams
        .map((entry) => entry.since)
        .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    // Oldest success among the stale streams; none when one never synced.
    const neverSynced = staleStates.some((state) => !state.lastSuccessAt);
    const oldest = staleStates
      .map((state) => state.lastSuccessAt)
      .filter((value): value is Date => value !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    return {
      streams,
      stale,
      ownerAlarm: alarmStreams.length > 0,
      cashierWarning: !stale
        ? null
        : timeUnproven
          ? "waktu sejak pembaruan katalog tidak dapat dipastikan; promo dan voucher dinonaktifkan"
          : neverSynced || !oldest
            ? "katalog belum pernah diperbarui sejak edge menyala"
            : `katalog belum diperbarui sejak ${clock.format(oldest)}`,
      salesBlocked: stale24h || taxUnsynced.length > 0,
      salesGate: {
        stale24h,
        staleSince: blockedSince,
        staleStreams: blockedStreams.map((entry) => entry.stream),
        taxUnsynced,
      },
      alarmStreams,
    };
  };

  const evaluate = () => {
    const snap = snapshot();
    if (!snap.stale) {
      episodeAlarmed = false;
      return;
    }
    const first = snap.alarmStreams[0];
    if (episodeAlarmed || !first) return;
    episodeAlarmed = true;
    try {
      void Promise.resolve(
        options.onOwnerAlarm?.({
          stream: first.stream,
          reason: first.reason,
          lastSuccessAt: first.lastSuccessAt,
          streams: snap.alarmStreams,
        }),
      ).catch(() => {});
    } catch {
      // A broken alarm sink must not stop the sync loop.
    }
  };

  // Queue the boot warning/alarm even if no checkpoint or failed tick exists.
  evaluate();
  started = true;

  return {
    now,
    recordSuccess(stream, at) {
      const state = isCritical(stream) ? states.get(stream) : undefined;
      if (!state) return;
      observeUnprovenTime();
      // Explicit dates on older call sites came from the wall clock. Once a
      // trusted clock is installed, a successful live sync uses that basis.
      state.lastSuccessAt = trustedClock ? now() : clampToNow(at);
      state.timeUnproven = false;
      state.failure = null;
      evaluate();
    },
    recordFailure(stream, failure) {
      const state = isCritical(stream) ? states.get(stream) : undefined;
      if (!state) return;
      state.failure = {
        firstAt: state.failure?.firstAt ?? now(),
        reachableSince: failure.cloudReachable
          ? (state.failure?.reachableSince ?? now())
          : null,
        reason: failure.reason,
        cloudReachable: failure.cloudReachable,
      };
      evaluate();
    },
    seedLastSuccess(stream, at) {
      const state = isCritical(stream) ? states.get(stream) : undefined;
      if (!state) return;
      // The epoch marks a pull that never reached its end (catalog-puller.ts).
      if (isCatalogTaxStream(stream) && at.getTime() === 0) return;
      const seeded = clampToNow(at);
      if (
        state.lastSuccessAt &&
        state.lastSuccessAt.getTime() >= seeded.getTime()
      )
        return;
      state.lastSuccessAt = seeded;
      evaluate();
    },
    adoptTrackingStartedAt(at) {
      if (at.getTime() < trackingStartedAt.getTime()) {
        trackingStartedAt = at;
      }
      evaluate();
    },
    clockProven() {
      // A later late-adopted high water may find new doubt: let it be observed.
      observedUnprovenTime = false;
      unprovenAgeLowerBoundAt = null;
      for (const state of states.values()) state.timeUnproven = false;
      evaluate();
    },
    snapshot,
  };
}

/** Pull error of an edge whose cloud predates the catalog page version. */
export const CATALOG_CLOUD_OUTDATED_REASON = "CATALOG_CLOUD_OUTDATED";

/**
 * What the link heartbeat reports: the owner-alarm streams, in wire form.
 * Nothing while a critical stream fails with CATALOG_CLOUD_OUTDATED: that
 * cloud is older than this edge, and its strict heartbeat frame refuses
 * `catalogStale` (the link would drop and reconnect over and over). Release
 * order is cloud first; this guards the edge-first mistake.
 */
export function catalogStaleForHeartbeat(
  snapshot: CatalogFreshnessSnapshot,
): CatalogStale {
  if (
    Object.values(snapshot.streams).some(
      (entry) => entry.failureReason === CATALOG_CLOUD_OUTDATED_REASON,
    )
  )
    return [];
  return snapshot.alarmStreams.map((entry) => ({
    stream: entry.stream,
    staleSince: entry.staleSince.toISOString(),
    reason: entry.reason.slice(0, 255) || "UNKNOWN",
  }));
}

/**
 * JSON form for `/api/edge/status` and `/api/edge/health`. `gate` is the
 * sales gate state with the owner override applied (default: the installed
 * provider); the age facts come from the snapshot.
 */
export function catalogFreshnessToDto(
  snapshot: CatalogFreshnessSnapshot,
  gate: SalesGateState = getSalesGateState(),
): CatalogFreshness {
  return {
    stale: snapshot.stale,
    ownerAlarm: snapshot.ownerAlarm,
    cashierWarning: snapshot.cashierWarning,
    salesBlocked: gate.blocked,
    salesGate: {
      blocked: gate.blocked,
      stale24h: snapshot.salesGate.stale24h,
      reason: gate.reason,
      staleSince: snapshot.salesGate.staleSince?.toISOString() ?? null,
      staleStreams: snapshot.salesGate.staleStreams,
      override: gate.override
        ? {
            grantedAt: gate.override.grantedAt.toISOString(),
            untilAt: gate.override.untilAt.toISOString(),
          }
        : null,
      promoDisabled: !promosEnabled(),
    },
    streams: Object.fromEntries(
      Object.entries(snapshot.streams).map(([stream, entry]) => [
        stream,
        {
          lastSuccessAt: entry.lastSuccessAt?.toISOString() ?? null,
          ageMs: entry.ageMs,
          failureReason: entry.failureReason,
        },
      ]),
    ),
  };
}
