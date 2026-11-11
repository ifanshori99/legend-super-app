// Freshness of the critical catalog streams on an edge node (legend-10nex).
// A catalog stream failure used to be only logged; nobody learned that prices
// or product status on the edge had stopped updating.
//
//   critical streams  price_lists, item_variants and modifiers (prices: a
//                     variant or modifier price is money) and menu_items
//                     (product status).
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
import type { CatalogFreshness } from "@starter/shared/edge";
import type { CatalogStale } from "./protocol.ts";
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
  /** Same as `salesGate.stale24h`; the owner override is applied later. */
  salesBlocked: boolean;
  salesGate: {
    /** A critical stream is older than `blockAfterMs` (override ignored). */
    stale24h: boolean;
    /** Oldest last success (or tracking start) among the offending streams. */
    staleSince: Date | null;
    staleStreams: string[];
  };
  /** Streams behind `ownerAlarm`; sent to the cloud with the heartbeat. */
  alarmStreams: CatalogStaleStream[];
};

export type CatalogFreshnessTracker = {
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
  snapshot(): CatalogFreshnessSnapshot;
};

type StreamState = {
  lastSuccessAt: Date | null;
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
    clock?: { now(): Date };
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
  const trackingStartedAt = options.trackingStartedAt ?? now();
  const timeZone = options.timeZone ?? "Asia/Jakarta";
  const alarmAfterMs =
    options.staleAlarmAfterMs ?? CATALOG_STALE_ALARM_AFTER_MS;
  const persistMs = options.failurePersistMs ?? CATALOG_FAILURE_PERSIST_MS;
  const states = new Map<string, StreamState>(
    CRITICAL_CATALOG_STREAMS.map((stream) => [
      stream,
      { lastSuccessAt: null, failure: null },
    ]),
  );
  let episodeAlarmed = false;

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
    const at = now().getTime();
    const streams: Record<string, CatalogStreamFreshness> = {};
    const staleStates: StreamState[] = [];
    const alarmStreams: CatalogStaleStream[] = [];
    const blockedStreams: { stream: string; since: Date }[] = [];
    for (const [stream, state] of states) {
      // Age basis of the sales rule: last success, or tracking start when
      // the stream never succeeded. Independent of any recorded failure.
      const basis = state.lastSuccessAt ?? trackingStartedAt;
      if (at - basis.getTime() > blockAfterMs)
        blockedStreams.push({ stream, since: basis });
      streams[stream] = {
        lastSuccessAt: state.lastSuccessAt,
        ageMs: state.lastSuccessAt
          ? Math.max(0, at - state.lastSuccessAt.getTime())
          : null,
        failureReason: state.failure?.reason ?? null,
      };
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
        : neverSynced || !oldest
          ? "katalog belum pernah diperbarui sejak edge menyala"
          : `katalog belum diperbarui sejak ${clock.format(oldest)}`,
      salesBlocked: stale24h,
      salesGate: {
        stale24h,
        staleSince: blockedSince,
        staleStreams: blockedStreams.map((entry) => entry.stream),
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

  return {
    recordSuccess(stream, at) {
      const state = isCritical(stream) ? states.get(stream) : undefined;
      if (!state) return;
      state.lastSuccessAt = clampToNow(at);
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
      const seeded = clampToNow(at);
      if (
        state.lastSuccessAt &&
        state.lastSuccessAt.getTime() >= seeded.getTime()
      )
        return;
      state.lastSuccessAt = seeded;
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
