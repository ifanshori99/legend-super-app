// Freshness of the critical catalog streams on an edge node (legend-10nex).
// A catalog stream failure used to be only logged; nobody learned that prices
// or product status on the edge had stopped updating.
//
//   critical streams  price_lists (prices) and menu_items (product status).
//   stale             a critical stream failed since its last success (any
//                     reason, offline included: the prices on screen are old
//                     either way).
//   cashier warning   "katalog belum diperbarui sejak HH:MM" while stale.
//   owner alarm       a stale stream whose latest failure came from a
//                     reachable cloud (sync failing, not offline) and whose
//                     age (since its last success; since its first failure
//                     when it never succeeded) is strictly more than
//                     `staleAlarmAfterMs` (default 30 minutes). A purely
//                     offline edge never alarms.
//   delivery          `onOwnerAlarm` fires once per stale episode (local log
//                     only). The owner is told through the link heartbeat:
//                     the link client sends `alarmStreams` of every snapshot
//                     while they last (`catalogStaleForHeartbeat`), the cloud
//                     notifies and dedupes. Release order: cloud first, then
//                     edge (an older cloud refuses the heartbeat field).
//   sale policy       none: selling is never blocked while stale (founder
//                     decision, `salesBlocked` is always false); the cashier
//                     warning and the owner alarm are the whole reaction.
//
// State is in memory: a restart begins a fresh episode.
import type { CatalogFreshness } from "@starter/shared/edge";
import type { CatalogStale } from "./protocol.ts";

/** Streams whose staleness changes what the cashier sells or charges. */
export const CRITICAL_CATALOG_STREAMS = ["price_lists", "menu_items"] as const;
export type CriticalCatalogStream = (typeof CRITICAL_CATALOG_STREAMS)[number];

export const CATALOG_STALE_ALARM_AFTER_MS = 30 * 60_000;

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
  /** Always false: a stale catalog never blocks selling. */
  salesBlocked: false;
  /** Streams behind `ownerAlarm`; sent to the cloud with the heartbeat. */
  alarmStreams: CatalogStaleStream[];
};

export type CatalogFreshnessTracker = {
  recordSuccess(stream: string): void;
  recordFailure(
    stream: string,
    failure: { reason: string; cloudReachable: boolean },
  ): void;
  snapshot(): CatalogFreshnessSnapshot;
};

type StreamState = {
  lastSuccessAt: Date | null;
  /** Failure since the last success. */
  failure: {
    firstAt: Date;
    reason: string;
    cloudReachable: boolean;
  } | null;
};

function isCritical(stream: string): boolean {
  return (CRITICAL_CATALOG_STREAMS as readonly string[]).includes(stream);
}

export function createCatalogFreshness(
  options: {
    now?: () => Date;
    timeZone?: string;
    staleAlarmAfterMs?: number;
    /** Once per stale episode; a throw or rejection is swallowed. */
    onOwnerAlarm?: (alarm: {
      stream: string;
      reason: string;
      lastSuccessAt: Date | null;
      streams: readonly CatalogStaleStream[];
    }) => void | Promise<void>;
  } = {},
): CatalogFreshnessTracker {
  const now = options.now ?? (() => new Date());
  const timeZone = options.timeZone ?? "Asia/Jakarta";
  const alarmAfterMs =
    options.staleAlarmAfterMs ?? CATALOG_STALE_ALARM_AFTER_MS;
  const states = new Map<string, StreamState>(
    CRITICAL_CATALOG_STREAMS.map((stream) => [
      stream,
      { lastSuccessAt: null, failure: null },
    ]),
  );
  let episodeAlarmed = false;

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
    for (const [stream, state] of states) {
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
      if (state.failure.cloudReachable && at - since.getTime() > alarmAfterMs)
        alarmStreams.push({
          stream,
          staleSince: since,
          lastSuccessAt: state.lastSuccessAt,
          reason: state.failure.reason,
        });
    }
    const stale = staleStates.length > 0;
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
      salesBlocked: false,
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
    recordSuccess(stream) {
      const state = isCritical(stream) ? states.get(stream) : undefined;
      if (!state) return;
      state.lastSuccessAt = now();
      state.failure = null;
      evaluate();
    },
    recordFailure(stream, failure) {
      const state = isCritical(stream) ? states.get(stream) : undefined;
      if (!state) return;
      state.failure = {
        firstAt: state.failure?.firstAt ?? now(),
        reason: failure.reason,
        cloudReachable: failure.cloudReachable,
      };
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

/** JSON form for `/api/edge/status` and `/api/edge/health`. */
export function catalogFreshnessToDto(
  snapshot: CatalogFreshnessSnapshot,
): CatalogFreshness {
  return {
    stale: snapshot.stale,
    ownerAlarm: snapshot.ownerAlarm,
    cashierWarning: snapshot.cashierWarning,
    salesBlocked: false,
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
