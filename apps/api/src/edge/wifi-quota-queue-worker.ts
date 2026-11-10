// Edge worker that pushes queued `wifi_quota.updated` events to the controller
// (bead legend-oeqme; PRD v1.7 §3 F25, FAC-12/FAC-13). The link receive
// transaction only writes `wifi_quota_apply_queue` (wifi-quota-applier.ts);
// this worker applies the rows outside that transaction, so a Wi-Fi agent that
// is not ready (503) can never roll the receive back or hold the outlet link.
//
// One pass (`drainWifiQuotaQueue`), per due row, in session order:
//   - a newer row of the same session exists (pending or already applied):
//     `superseded`. The event is full state, the newest one wins and an older
//     one can never lower the quota.
//   - the session's business day is over, or the device has no live grant
//     here (it is not connected to this node; the guest's own start call
//     applies the current quota): `skipped`.
//   - no agent installed here (another process holds the outlet's agent lock,
//     or it is not up yet): the row is left untouched, no attempt is spent.
//   - the agent accepts: `applied`.
//   - transient answer (503/5xx, timeouts, 408/429, 409 WIFI_GRANT_IN_FLIGHT,
//     any non-domain error): stays `pending` with `next_attempt_at` pushed by
//     the backoff. Once `maxAttempts` attempts are used the row is `failed`.
//   - final refusal (other 4xx, 502 WIFI_AUTHORIZE_REFUSED): `refused`.
//   `failed` and `refused` write an `applier_refused` row to
//   `edge_sync_conflicts` (direction cloud_to_edge), the same evidence the link
//   keeps for an event the domain refused, and a warning (code only) to the log.
//
// The agent call runs between two short transactions: a claim (row lock, state
// checks, attempt counted, lease on `next_attempt_at`) and the result. A crash
// in between leaves the row pending; it is retried after the lease. Idempotent
// per event id: the unique (tenant, event) key at receive, and a row leaves
// `pending` exactly once.
import { and, asc, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import {
  createUlid,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { conflictResolution } from "@starter/shared/edge";
import {
  wifiQuotaUpdatedEvent,
  wifiRemainingMinutes,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import {
  edgeNodes,
  wifiDeviceGrants,
  wifiQuotaApplyQueue,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { CoreError } from "@starter/shared/core";
import { isWifiEnforcementInstalled, wifiEnforcement } from "./wifi/port.ts";

const DAY_SECONDS = 86_400;
/** Attempts before a row is given up (`failed`). */
export const WIFI_QUOTA_MAX_ATTEMPTS = 20;
/** Rows claimed per pass. */
const BATCH_SIZE = 50;
/** A claimed row is not retried by another pass for this long. */
const LEASE_MS = 120_000;
/** Finished rows are kept this long for support, then pruned. */
const RETENTION_MS = 7 * 86_400_000;
/**
 * A row still pending this long after it arrived is past its session's
 * business day (at most 24 h plus the backoff window): dropped by the prune.
 * This is what empties the queue of a standby node, which never drains it.
 */
const STALE_PENDING_MS = 2 * 86_400_000;
/** The runtime loop prunes this often. */
const PRUNE_INTERVAL_MS = 3_600_000;
/** Default pass interval of the runtime loop. */
export const WIFI_QUOTA_WORKER_INTERVAL_MS = 5_000;

/** 5 s, 10 s, 20 s ... capped at 5 min. `attempt` = attempts made so far (1-based). */
export function defaultWifiQuotaBackoffMs(attempt: number): number {
  return Math.min(300_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

export type WifiQuotaDrainOptions = {
  context: ScopedTenantContext;
  /** The edge node the conflicts are recorded for; default: the outlet's primary node. */
  edgeNodeId?: string;
  /** Test seam: the clock. Default: the real time, read again for every row. */
  now?: Date;
  maxAttempts?: number;
  backoffMs?: (attempt: number) => number;
  /** Checked between rows: a stopping runtime does not wait for a whole pass. */
  shouldStop?: () => boolean;
};

export type WifiQuotaDrainResult = {
  applied: number;
  retried: number;
  /** Gave up for good: refused by the controller/domain, or attempts used up. */
  failed: number;
  superseded: number;
  skipped: number;
};

type Claim =
  | { kind: "none" }
  | { kind: "superseded" }
  | { kind: "skipped" }
  | {
      kind: "apply";
      attempts: number;
      controllerDeviceId: string;
      event: (typeof wifiQuotaApplyQueue.$inferSelect)["event"];
    };

/** Domain refusals are final; everything the agent can recover from is not. */
function isFinalAgentRefusal(error: unknown): boolean {
  if (error instanceof HttpError) {
    if (error.code === "WIFI_GRANT_IN_FLIGHT") return false;
    if (error.code === "WIFI_AUTHORIZE_REFUSED") return true;
    return (
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429
    );
  }
  if (error instanceof CoreError) return error.status < 500;
  return false;
}

/** Code only: messages and payloads can quote personal data (ports.ts rule). */
function errorCode(error: unknown): string {
  const code =
    error instanceof HttpError || error instanceof CoreError
      ? error.code
      : error instanceof Error
        ? error.name
        : "UNKNOWN";
  return String(code).slice(0, 100);
}

async function localEdgeNodeId(
  context: ScopedTenantContext,
  override: string | undefined,
): Promise<string | null> {
  if (override) return override;
  return withTenant(db, context, async (tx) => {
    const [node] = await tx
      .select({ id: edgeNodes.id })
      .from(edgeNodes)
      .where(
        and(
          eq(edgeNodes.tenantId, context.tenant.tenantId),
          eq(edgeNodes.status, "active"),
        ),
      )
      .orderBy(
        sql`(${edgeNodes.role} = 'primary') DESC`,
        asc(edgeNodes.createdAt),
      )
      .limit(1);
    return node?.id ?? null;
  });
}

/** One pass over the due rows. Never throws for an agent problem. */
export async function drainWifiQuotaQueue(
  options: WifiQuotaDrainOptions,
): Promise<WifiQuotaDrainResult> {
  const { context } = options;
  const clock = () => options.now ?? new Date();
  const maxAttempts = options.maxAttempts ?? WIFI_QUOTA_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? defaultWifiQuotaBackoffMs;
  const result: WifiQuotaDrainResult = {
    applied: 0,
    retried: 0,
    failed: 0,
    superseded: 0,
    skipped: 0,
  };

  const due = await withTenant(db, context, (tx) =>
    tx
      .select({ id: wifiQuotaApplyQueue.id })
      .from(wifiQuotaApplyQueue)
      .where(
        and(
          eq(wifiQuotaApplyQueue.tenantId, context.tenant.tenantId),
          eq(wifiQuotaApplyQueue.status, "pending"),
          lte(wifiQuotaApplyQueue.nextAttemptAt, clock()),
        ),
      )
      // Session by session, oldest sequence first: order per device is kept.
      .orderBy(
        asc(wifiQuotaApplyQueue.wifiSessionId),
        asc(wifiQuotaApplyQueue.aggregateSequence),
      )
      .limit(BATCH_SIZE),
  );

  for (const { id } of due) {
    if (options.shouldStop?.()) break;
    // One reading per row: a long pass must not hand out stale leases.
    const now = clock();
    const claim = await claimRow(context, id, now);
    if (claim.kind === "none") continue;
    if (claim.kind === "superseded") {
      result.superseded += 1;
      continue;
    }
    if (claim.kind === "skipped") {
      result.skipped += 1;
      continue;
    }
    const { event } = claim;
    const payload = wifiQuotaUpdatedEvent.payloadSchema.parse(event.payload);
    // The snapshot is as old as the event: time that passed since then (a late
    // sync, a retry) is already used. Read from `now` on every attempt, so a
    // retry never hands the same time out again.
    const snapshotSeconds = Math.min(
      DAY_SECONDS,
      wifiRemainingMinutes({
        quotaMinutes: payload.quotaMinutes,
        usedMinutes: payload.usedMinutes,
      }) * 60,
    );
    const elapsedSeconds = Math.max(
      0,
      Math.floor((now.getTime() - new Date(event.occurredAt).getTime()) / 1000),
    );
    const remainingSeconds = Math.max(0, snapshotSeconds - elapsedSeconds);
    const requestedTier =
      payload.speedTier === "full" && remainingSeconds > 0 ? "full" : "base";
    let failure: unknown = null;
    let inFlight = false;
    try {
      const grant = await wifiEnforcement().applySession(context, {
        outletId: event.outletId as OutletId,
        wifiSessionId: payload.sessionId as string,
        controllerDeviceId: claim.controllerDeviceId,
        speedTier: requestedTier,
        fullSpeedKbps: payload.fullSpeedKbps as number,
        baseSpeedKbps: payload.baseSpeedKbps as number,
        remainingSeconds,
        sessionEndsAt: payload.sessionEndsAt as string,
      });
      // An older grant still pending/unknown (or of another tier) may have been
      // returned for this request: the new quota is not at the controller yet.
      inFlight = grant.status !== "active" || grant.speedTier !== requestedTier;
    } catch (error) {
      failure = error;
    }

    if (failure === null && inFlight) {
      if (claim.attempts >= maxAttempts) {
        await giveUp(
          context,
          options.edgeNodeId,
          id,
          now,
          "failed",
          "WIFI_GRANT_IN_FLIGHT",
        );
        result.failed += 1;
      } else {
        await retryLater(
          context,
          id,
          new Date(now.getTime() + backoffMs(claim.attempts)),
          "WIFI_GRANT_IN_FLIGHT",
        );
        result.retried += 1;
      }
      continue;
    }

    if (failure === null) {
      await finish(context, id, { status: "applied", now });
      result.applied += 1;
      continue;
    }
    const code = errorCode(failure);
    if (isFinalAgentRefusal(failure)) {
      await giveUp(context, options.edgeNodeId, id, now, "refused", code);
      result.failed += 1;
    } else if (claim.attempts >= maxAttempts) {
      await giveUp(context, options.edgeNodeId, id, now, "failed", code);
      result.failed += 1;
    } else {
      await retryLater(
        context,
        id,
        new Date(now.getTime() + backoffMs(claim.attempts)),
        code,
      );
      result.retried += 1;
    }
  }

  return result;
}

/**
 * Deletes finished rows after RETENTION_MS and rows that stayed pending past
 * STALE_PENDING_MS. Safe on every node role.
 */
export async function pruneWifiQuotaQueue(
  context: ScopedTenantContext,
  now: Date = new Date(),
): Promise<void> {
  await withTenant(db, context, (tx) =>
    tx
      .delete(wifiQuotaApplyQueue)
      .where(
        and(
          eq(wifiQuotaApplyQueue.tenantId, context.tenant.tenantId),
          or(
            and(
              ne(wifiQuotaApplyQueue.status, "pending"),
              lte(
                wifiQuotaApplyQueue.doneAt,
                new Date(now.getTime() - RETENTION_MS),
              ),
            ),
            and(
              eq(wifiQuotaApplyQueue.status, "pending"),
              lte(
                wifiQuotaApplyQueue.createdAt,
                new Date(now.getTime() - STALE_PENDING_MS),
              ),
            ),
          ),
        ),
      ),
  );
}

/**
 * Locks the row, decides without the agent whether it is still worth sending
 * and, when it is, counts the attempt and leases the row.
 */
async function claimRow(
  context: ScopedTenantContext,
  id: string,
  now: Date,
): Promise<Claim> {
  return withTenant(db, context, async (tx): Promise<Claim> => {
    const [row] = await tx
      .select()
      .from(wifiQuotaApplyQueue)
      .where(
        and(
          eq(wifiQuotaApplyQueue.id, id),
          eq(wifiQuotaApplyQueue.status, "pending"),
          lte(wifiQuotaApplyQueue.nextAttemptAt, now),
        ),
      )
      .for("update", { skipLocked: true });
    if (!row) return { kind: "none" };
    const done = (status: "superseded" | "skipped") =>
      tx
        .update(wifiQuotaApplyQueue)
        .set({ status, doneAt: now })
        .where(eq(wifiQuotaApplyQueue.id, id));

    const [newer] = await tx
      .select({ id: wifiQuotaApplyQueue.id })
      .from(wifiQuotaApplyQueue)
      .where(
        and(
          eq(wifiQuotaApplyQueue.tenantId, row.tenantId),
          eq(wifiQuotaApplyQueue.outletId, row.outletId),
          eq(wifiQuotaApplyQueue.wifiSessionId, row.wifiSessionId),
          inArray(wifiQuotaApplyQueue.status, ["pending", "applied"]),
          sql`${wifiQuotaApplyQueue.aggregateSequence} > ${row.aggregateSequence}`,
        ),
      )
      .limit(1);
    if (newer) {
      await done("superseded");
      return { kind: "superseded" };
    }

    const payload = wifiQuotaUpdatedEvent.payloadSchema.parse(
      row.event.payload,
    );
    if (
      payload.sessionEndsAt !== undefined &&
      new Date(payload.sessionEndsAt).getTime() <= now.getTime()
    ) {
      await done("skipped");
      return { kind: "skipped" };
    }
    const [grant] = await tx
      .select({ controllerDeviceId: wifiDeviceGrants.controllerDeviceId })
      .from(wifiDeviceGrants)
      .where(
        and(
          eq(wifiDeviceGrants.tenantId, row.tenantId),
          eq(wifiDeviceGrants.outletId, row.outletId),
          eq(wifiDeviceGrants.wifiSessionId, row.wifiSessionId),
          inArray(wifiDeviceGrants.status, ["active", "pending", "unknown"]),
        ),
      )
      .orderBy(sql`${wifiDeviceGrants.createdAt} DESC`)
      .limit(1);
    if (!grant?.controllerDeviceId) {
      await done("skipped");
      return { kind: "skipped" };
    }
    // Another process of this outlet holds the agent lock (or the agent is
    // not up yet): nothing to send with, so no attempt is spent on it.
    if (!isWifiEnforcementInstalled()) return { kind: "none" };
    const attempts = row.attempts + 1;
    await tx
      .update(wifiQuotaApplyQueue)
      .set({
        attempts,
        lastAttemptAt: now,
        nextAttemptAt: new Date(now.getTime() + LEASE_MS),
      })
      .where(eq(wifiQuotaApplyQueue.id, id));
    return {
      kind: "apply",
      attempts,
      controllerDeviceId: grant.controllerDeviceId,
      event: row.event,
    };
  });
}

/** Guarded by `status = 'pending'`: a row superseded meanwhile stays so. */
async function finish(
  context: ScopedTenantContext,
  id: string,
  input: { status: "applied"; now: Date },
): Promise<boolean> {
  const updated = await withTenant(db, context, (tx) =>
    tx
      .update(wifiQuotaApplyQueue)
      .set({ status: input.status, doneAt: input.now, lastError: null })
      .where(
        and(
          eq(wifiQuotaApplyQueue.id, id),
          eq(wifiQuotaApplyQueue.status, "pending"),
        ),
      )
      .returning({ id: wifiQuotaApplyQueue.id }),
  );
  return updated.length > 0;
}

async function retryLater(
  context: ScopedTenantContext,
  id: string,
  nextAttemptAt: Date,
  code: string,
): Promise<void> {
  await withTenant(db, context, (tx) =>
    tx
      .update(wifiQuotaApplyQueue)
      .set({ nextAttemptAt, lastError: code })
      .where(
        and(
          eq(wifiQuotaApplyQueue.id, id),
          eq(wifiQuotaApplyQueue.status, "pending"),
        ),
      ),
  );
}

/**
 * Final state plus the conflict row, in one transaction. A row superseded
 * while the agent call ran is left alone (nothing to report: a newer event
 * replaced it).
 */
async function giveUp(
  context: ScopedTenantContext,
  edgeNodeOverride: string | undefined,
  id: string,
  now: Date,
  status: "refused" | "failed",
  code: string,
): Promise<void> {
  const edgeNodeId = await localEdgeNodeId(context, edgeNodeOverride);
  await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .update(wifiQuotaApplyQueue)
      .set({ status, doneAt: now, lastError: code })
      .where(
        and(
          eq(wifiQuotaApplyQueue.id, id),
          eq(wifiQuotaApplyQueue.status, "pending"),
        ),
      )
      .returning();
    if (!row) return;
    logger.warn(
      { code, status, attempts: row.attempts },
      "Wi-Fi quota change was not applied at the controller",
    );
    if (!edgeNodeId) return;
    const { event } = row;
    const detail =
      status === "refused"
        ? `Wi-Fi controller refused the quota change (${code})`
        : `Wi-Fi quota change not applied after ${row.attempts} attempts (${code})`;
    await tx.execute(
      sql`INSERT INTO edge_sync_conflicts (id, tenant_id, outlet_id, edge_node_id, direction, event_id, aggregate_type, aggregate_id, aggregate_sequence, kind, reason, resolution, existing_sequence, detail, event) VALUES (${ulidToUuid(createUlid())}::uuid, ${row.tenantId}::uuid, ${row.outletId}::uuid, ${edgeNodeId}::uuid, 'cloud_to_edge', ${ulidToUuid(row.eventId)}::uuid, ${event.aggregateType}, ${event.aggregateId}, ${event.sequence}, 'master_data', 'applier_refused', ${conflictResolution("master_data")}, ${event.sequence}, ${detail.slice(0, 500)}, ${JSON.stringify(event)}::jsonb) ON CONFLICT DO NOTHING`,
    );
  });
}

export type WifiQuotaWorkerHandle = { stop(): Promise<void> };

/**
 * Runtime loop, started next to the Wi-Fi agent. Every role prunes; only the
 * primary (`drain: true`) pushes to the controller: a standby never talks to
 * it. Never overlaps itself; a failing pass is logged by class and retried
 * next tick; `stop()` waits for the row in flight, not for the whole pass.
 */
export function startWifiQuotaQueueWorker(options: {
  context: ScopedTenantContext;
  edgeNodeId: string;
  drain: boolean;
  intervalMs?: number;
}): WifiQuotaWorkerHandle {
  let inflight: Promise<void> | null = null;
  let stopping = false;
  let lastPruneAt = 0;
  const logFailure = (message: string) => (error: unknown) =>
    logger.warn(
      { name: error instanceof Error ? error.name : "UnknownError" },
      message,
    );
  const tick = () => {
    if (inflight || stopping) return;
    inflight = (async () => {
      if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
        lastPruneAt = Date.now();
        await pruneWifiQuotaQueue(options.context).catch(
          logFailure("Wi-Fi quota queue prune failed"),
        );
      }
      if (options.drain)
        await drainWifiQuotaQueue({
          context: options.context,
          edgeNodeId: options.edgeNodeId,
          shouldStop: () => stopping,
        }).catch(logFailure("Wi-Fi quota queue pass failed"));
    })().finally(() => {
      inflight = null;
    });
  };
  const timer = setInterval(
    tick,
    options.intervalMs ?? WIFI_QUOTA_WORKER_INTERVAL_MS,
  );
  timer.unref();
  tick();
  return {
    async stop() {
      stopping = true;
      clearInterval(timer);
      await inflight;
    },
  };
}
