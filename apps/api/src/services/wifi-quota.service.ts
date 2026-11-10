// Wi-Fi daily quota engine, DB side (bead legend-kmd3 slice S2; brief
// docs/briefs/sub-kmd3-wifi-quota.md design 3-8; PRD v1.7 §3 F25, FAC-12/13/14).
//
// The quota of an account for one business day is derived, never stored as the
// source of truth: the spend ledger (`wifi_spend_entries`, written by
// `wifi-quota-consumer.ts`) gives the net spend per order, the policy row of the
// zone gives the rules (the pure helpers in `@starter/shared/facility` do the
// math), and the open `wifi_sessions` rows cache the result. Usage is accrued
// lazily: whole minutes since `accrued_at` are added before every read.
//
// FAC-13: a spent quota throttles (`speed_tier: base`), it never ends a
// session. Sessions end only for the user (`session_ended`) or a closed
// business day (`day_closed`).
//
// Used by the sessions service (S3) inside its `withTenant` transaction and by
// the outbox consumer. Callers hold the account lock (`withWifiAccountLock`)
// before they read or write the open sessions of an account.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  businessDateOf,
  businessDayRange,
  createUlid,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  isPeakAt,
  WIFI_MAX_DAILY_MINUTES,
  wifiQuotaMinutesForOrders,
  wifiQuotaUpdatedEvent,
  wifiRemainingMinutes,
  wifiSpeedTier,
  type WifiPolicy,
} from "@starter/shared/facility";
import { wifiEnforcement } from "../edge/wifi/port.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import {
  customerProfiles,
  loyaltyTiers,
  outlets,
  wifiDeviceGrants,
  wifiPolicies,
  wifiSessions,
  wifiSpendEntries,
  type WifiSessionRow,
} from "../db/schema/index.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { appendOutbox } from "./core-outbox.ts";
import type { Tx } from "./inventory-ops.shared.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";
import { toWifiPolicy } from "./wifi-policy.service.ts";

export type { WifiSessionRow };

/** Same destination the other facility events use (cloud sync + consumers). */
const WIFI_EVENT_DESTINATION = "cloud-sync";
/** Longest tier key `wifiPolicySchema.tierBonusMinutes` accepts. */
const MAX_TIER_KEY_LENGTH = 30;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export type QuotaReason = "spend" | "tier_bonus" | "peak_window";

type PolicyRow = typeof wifiPolicies.$inferSelect;

/** The contract policy of a row, with the quota engine's `spendMode` (null = default). */
export function policyOfRow(row: PolicyRow): WifiPolicy {
  const policy = toWifiPolicy(row);
  return row.spendMode === null
    ? policy
    : { ...policy, spendMode: row.spendMode };
}

/**
 * Serialises everything that changes the open sessions of one account: the
 * device limit check, the spend ledger replay guard and the recompute. Held
 * until the transaction ends.
 */
export async function withWifiAccountLock(
  tx: Tx,
  tenantId: string,
  customerProfileId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`wifi:${tenantId}:${customerProfileId}`}))`,
  );
}

/**
 * Design 4: add the whole minutes elapsed since `accrued_at` (cap 1440) and move
 * `accrued_at` forward by the minutes that were counted. An ended session and a
 * clock that is behind accrue nothing.
 */
export function accrueUsage(
  row: Pick<WifiSessionRow, "usedMinutes" | "accruedAt" | "endedAt">,
  now: Date,
): { usedMinutes: number; accruedAt: Date } {
  const unchanged = { usedMinutes: row.usedMinutes, accruedAt: row.accruedAt };
  if (row.endedAt !== null) return unchanged;
  const elapsed = Math.floor(
    (now.getTime() - row.accruedAt.getTime()) / MINUTE_MS,
  );
  if (elapsed <= 0) return unchanged;
  const usedMinutes = Math.min(
    WIFI_MAX_DAILY_MINUTES,
    row.usedMinutes + elapsed,
  );
  const counted = usedMinutes - row.usedMinutes;
  return {
    usedMinutes,
    accruedAt: new Date(row.accruedAt.getTime() + counted * MINUTE_MS),
  };
}

/**
 * The daily quota of one account (design 3): free minutes of the moment (peak
 * or off-peak) plus the tier bonus plus the extra hours of the day's net spend
 * under the policy's `spendMode`. Net spend of an order = paid minus the
 * refunds of that order (whatever day the refund happened), never below zero.
 */
export async function computeAccountQuota(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    policy: WifiPolicy;
    outletTimeZone: string;
    customerProfileId: string;
    businessDate: string;
    now: Date;
  },
): Promise<{
  quotaMinutes: number;
  isPeak: boolean;
  tierKey: string | undefined;
}> {
  const tenantId = context.tenant.tenantId;
  const paid = await tx
    .select({
      orderId: wifiSpendEntries.orderId,
      amountIdr: wifiSpendEntries.amountIdr,
    })
    .from(wifiSpendEntries)
    .where(
      and(
        eq(wifiSpendEntries.tenantId, tenantId),
        eq(wifiSpendEntries.customerProfileId, input.customerProfileId),
        eq(wifiSpendEntries.businessDate, input.businessDate),
        eq(wifiSpendEntries.kind, "paid"),
      ),
    );
  const refundedByOrder = new Map<string, number>();
  if (paid.length > 0) {
    const refunds = await tx
      .select({
        orderId: wifiSpendEntries.orderId,
        total: sql<string>`COALESCE(SUM(${wifiSpendEntries.amountIdr}), 0)`,
      })
      .from(wifiSpendEntries)
      .where(
        and(
          eq(wifiSpendEntries.tenantId, tenantId),
          eq(wifiSpendEntries.customerProfileId, input.customerProfileId),
          eq(wifiSpendEntries.kind, "refund"),
          inArray(
            wifiSpendEntries.orderId,
            paid.map((row) => row.orderId),
          ),
        ),
      )
      .groupBy(wifiSpendEntries.orderId);
    for (const row of refunds)
      refundedByOrder.set(row.orderId, Number(row.total));
  }
  const orderNetSpendIdr = paid.map((row) =>
    Math.max(
      0,
      Number(row.amountIdr) - (refundedByOrder.get(row.orderId) ?? 0),
    ),
  );

  const [tier] = await tx
    .select({ name: loyaltyTiers.name })
    .from(customerProfiles)
    .innerJoin(
      loyaltyTiers,
      and(
        eq(loyaltyTiers.tenantId, customerProfiles.tenantId),
        eq(loyaltyTiers.id, customerProfiles.tierId),
      ),
    )
    .where(
      and(
        eq(customerProfiles.tenantId, tenantId),
        eq(customerProfiles.id, input.customerProfileId),
      ),
    )
    .limit(1);
  const key = tier?.name.toLowerCase();
  // A key the policy contract cannot hold never has a bonus.
  const tierKey =
    key !== undefined && key.length <= MAX_TIER_KEY_LENGTH ? key : undefined;

  const isPeak = isPeakAt(input.policy, input.now, input.outletTimeZone);
  const quotaMinutes = wifiQuotaMinutesForOrders(input.policy, {
    isPeak,
    orderNetSpendIdr,
    ...(tierKey === undefined ? {} : { tierKey }),
  });
  return { quotaMinutes, isPeak, tierKey };
}

/**
 * Design 7: push the session's speed tier and remaining time to the edge agent.
 * Quota spent = base speed with 0 seconds left (throttle, never a cut). Nothing
 * to do while the controller id of the device is unknown. A cloud process has
 * no agent (`WIFI_AGENT_NOT_READY`): that is logged and swallowed. Any other
 * edge failure is logged with its code and swallowed too (best effort, the
 * quota itself is already stored and the `wifi_quota.updated` event lets the
 * edge apply it later), unless `strict` is set: the guest's own start call
 * must see a refusal such as `WIFI_DEVICE_BOUND_ELSEWHERE`.
 */
export async function applyWifiQuotaToEdge(
  context: ScopedTenantContext,
  session: WifiSessionRow,
  policy: WifiPolicy,
  controllerDeviceId?: string,
  sessionEndsAt?: Date,
  options: { strict?: boolean } = {},
): Promise<void> {
  if (controllerDeviceId === undefined) return;
  const remaining = wifiRemainingMinutes({
    quotaMinutes: session.quotaMinutes,
    usedMinutes: session.usedMinutes,
  });
  try {
    await wifiEnforcement().applySession(context, {
      outletId: session.outletId,
      wifiSessionId: session.id,
      controllerDeviceId,
      speedTier: session.speedTier as "full" | "base",
      fullSpeedKbps: policy.fullSpeedKbps,
      baseSpeedKbps: policy.baseSpeedKbps,
      remainingSeconds: Math.min(86_400, remaining * 60),
      sessionEndsAt: (
        sessionEndsAt ?? new Date(session.startedAt.getTime() + DAY_MS)
      ).toISOString(),
    });
  } catch (error) {
    if (error instanceof HttpError && error.code === "WIFI_AGENT_NOT_READY") {
      logger.info("Wi-Fi agent not ready; quota not applied at the edge");
      return;
    }
    if (options.strict) throw error;
    logger.warn(
      {
        code: (error as { code?: unknown } | null)?.code,
        errorName: error instanceof Error ? error.name : "unknown",
      },
      "wifi quota not applied at the edge",
    );
  }
}

/** Best-effort end of the grants of a session at the edge (`day_closed`). */
async function endSessionAtEdge(
  context: ScopedTenantContext,
  session: WifiSessionRow,
  reason: "day_closed",
): Promise<void> {
  try {
    await wifiEnforcement().endSession(context, {
      outletId: session.outletId,
      wifiSessionId: session.id,
      reason,
    });
  } catch (error) {
    logger.warn(
      {
        code: (error as { code?: unknown } | null)?.code,
        errorName: error instanceof Error ? error.name : "unknown",
      },
      "wifi session not ended at the edge",
    );
  }
}

/** The raw controller id of the live grant of a session (edge-local), if any. */
async function liveControllerDeviceId(
  tx: Tx,
  tenantId: TenantId,
  sessionId: string,
): Promise<string | undefined> {
  const [grant] = await tx
    .select({ controllerDeviceId: wifiDeviceGrants.controllerDeviceId })
    .from(wifiDeviceGrants)
    .where(
      and(
        eq(wifiDeviceGrants.tenantId, tenantId),
        eq(wifiDeviceGrants.wifiSessionId, sessionId),
        inArray(wifiDeviceGrants.status, ["active", "pending", "unknown"]),
      ),
    )
    .orderBy(sql`${wifiDeviceGrants.createdAt} DESC`)
    .limit(1);
  return grant?.controllerDeviceId ?? undefined;
}

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, WIFI_EVENT_DESTINATION),
        eq(
          domainEventOutbox.aggregateType,
          wifiQuotaUpdatedEvent.entry.aggregateType,
        ),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/** One `wifi_quota.updated` per change, inside the caller's transaction. */
async function appendQuotaUpdated(
  tx: Tx,
  context: ScopedTenantContext,
  session: WifiSessionRow,
  reason: QuotaReason | "quota_spent",
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const sequence = await nextSequence(tx, tenantId, session.id);
  const event = wifiQuotaUpdatedEvent.envelopeSchema.parse({
    id: createUlid(now.getTime()),
    tenantId,
    outletId: session.outletId,
    name: wifiQuotaUpdatedEvent.name,
    version: wifiQuotaUpdatedEvent.version,
    aggregateType: wifiQuotaUpdatedEvent.entry.aggregateType,
    aggregateId: session.id,
    sequence,
    occurredAt: now.toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `wifi_quota.updated:${session.id}:${sequence}`,
    payloadSchemaRef: wifiQuotaUpdatedEvent.payloadSchemaRef,
    payload: {
      customerProfileId: session.customerProfileId,
      sessionId: session.id,
      zoneId: session.zoneId,
      quotaMinutes: session.quotaMinutes,
      usedMinutes: session.usedMinutes,
      speedTier: session.speedTier,
      reason,
    },
  });
  await appendOutbox(tx, context, {
    id: createUlid(now.getTime()),
    event,
    destination: WIFI_EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/**
 * Designs 6 and 8: recompute every open session of the account for one
 * business date. Usage is accrued first. A session whose business day has
 * closed is ended (`day_closed`) instead. When the quota or the speed tier
 * changed, the row is updated, `wifi_quota.updated` is written and the edge is
 * asked to apply the new tier. Throttle (usage at or over the quota) is a
 * normal result, never an end.
 */
export async function recomputeOpenSessions(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    customerProfileId: string;
    businessDate: string;
    now: Date;
    reason: QuotaReason;
  },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  await withWifiAccountLock(tx, tenantId, input.customerProfileId);
  const sessions = await tx
    .select()
    .from(wifiSessions)
    .where(
      and(
        eq(wifiSessions.tenantId, tenantId),
        eq(wifiSessions.customerProfileId, input.customerProfileId),
        eq(wifiSessions.businessDate, input.businessDate),
        isNull(wifiSessions.endedAt),
      ),
    )
    .for("update");
  if (sessions.length === 0) return;

  const outletCache = new Map<string, typeof outlets.$inferSelect | null>();
  const policyCache = new Map<string, WifiPolicy | null>();
  for (const session of sessions) {
    let outlet = outletCache.get(session.outletId);
    if (outlet === undefined) {
      [outlet = null] = await tx
        .select()
        .from(outlets)
        .where(
          and(eq(outlets.tenantId, tenantId), eq(outlets.id, session.outletId)),
        )
        .limit(1);
      outletCache.set(session.outletId, outlet);
    }
    let policy = policyCache.get(session.policyId);
    if (policy === undefined) {
      const [row] = await tx
        .select()
        .from(wifiPolicies)
        .where(
          and(
            eq(wifiPolicies.tenantId, tenantId),
            eq(wifiPolicies.id, session.policyId),
          ),
        )
        .limit(1);
      policy = row ? policyOfRow(row) : null;
      policyCache.set(session.policyId, policy);
    }
    if (!outlet || !policy) continue;

    const clock = outletBusinessDayClock(outlet);
    const accrued = accrueUsage(session, input.now);

    if (businessDateOf(input.now, clock) !== session.businessDate) {
      const [closed] = await tx
        .update(wifiSessions)
        .set({
          usedMinutes: accrued.usedMinutes,
          accruedAt: accrued.accruedAt,
          endedAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(wifiSessions.tenantId, tenantId),
            eq(wifiSessions.id, session.id),
          ),
        )
        .returning();
      if (closed) await endSessionAtEdge(context, closed, "day_closed");
      continue;
    }

    const { quotaMinutes } = await computeAccountQuota(tx, context, {
      policy,
      outletTimeZone: outlet.timezone,
      customerProfileId: input.customerProfileId,
      businessDate: input.businessDate,
      now: input.now,
    });
    const speedTier = wifiSpeedTier(accrued.usedMinutes, quotaMinutes);
    const changed =
      quotaMinutes !== session.quotaMinutes || speedTier !== session.speedTier;
    const [updated] = await tx
      .update(wifiSessions)
      .set({
        usedMinutes: accrued.usedMinutes,
        accruedAt: accrued.accruedAt,
        quotaMinutes,
        speedTier,
        ...(changed ? { quotaUpdatedAt: input.now } : {}),
        updatedAt: input.now,
      })
      .where(
        and(
          eq(wifiSessions.tenantId, tenantId),
          eq(wifiSessions.id, session.id),
        ),
      )
      .returning();
    if (!updated || !changed) continue;

    await appendQuotaUpdated(
      tx,
      context,
      updated,
      session.speedTier === "full" && speedTier === "base"
        ? "quota_spent"
        : input.reason,
      input.now,
    );
    await applyWifiQuotaToEdge(
      context,
      updated,
      policy,
      await liveControllerDeviceId(tx, tenantId, updated.id),
      businessDayRange(updated.businessDate, clock).end,
    );
  }
}
