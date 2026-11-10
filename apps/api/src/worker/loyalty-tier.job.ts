// Loyalty tier sweep (legend-3zd1; docs/design/ws08-member-loyalty.md §M6).
// Every active member is evaluated against the rolling window, one transaction
// per profile, so a tier lost by time passing is applied without a new visit.
// One failure is logged and does not stop the rest. The sweep runs from the
// worker tick after 02:00 Asia/Jakarta, once per tenant per day. A second
// evaluation in the same period writes no history.

import { businessDateOf, type ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger";
import {
  evaluateProfileTier,
  listTierCandidateProfileIds,
} from "../services/loyalty-tier.service.ts";

type Database = Parameters<typeof withTenant>[0];

const TIME_ZONE = "Asia/Jakarta";
/** Calendar day in Asia/Jakarta (cutoff 00:00). */
const DAY_CLOCK = { timeZone: TIME_ZONE, cutoff: "00:00" } as const;
/** The same clock with the 02:00 start: a different day means "before 02:00". */
const START_CLOCK = { timeZone: TIME_ZONE, cutoff: "02:00" } as const;

const BATCH_SIZE = 100;
/** Upper bound of batches per tick; the next tick continues from the cursor. */
const MAX_BATCHES = 100;
/** Ticks that retry only the failed profiles before giving up until tomorrow. */
const MAX_RETRY_TICKS = 3;

export type LoyaltyTierLimits = { batchSize?: number; maxBatches?: number };

export type LoyaltyTierSweepResult = {
  businessDate: string;
  evaluated: number;
  changed: number;
  /** Profiles that threw; the sweep retries only these on the next tick. */
  failed: number;
  failedIds: string[];
  /** Last id of a full batch to continue from; null once the scan is complete. */
  nextAfterId: string | null;
};

/** Asia/Jakarta calendar day, or null before 02:00 that day. */
export function loyaltyTierDay(now: Date): string | null {
  const day = businessDateOf(now, DAY_CLOCK);
  return businessDateOf(now, START_CLOCK) === day ? day : null;
}

/**
 * One tick of work. Scans active members after `options.afterId` (at most
 * `maxBatches` batches), or visits exactly `options.onlyIds` (retry of failures).
 */
export async function runLoyaltyTierEvaluation(
  database: Database,
  context: ScopedTenantContext,
  now: Date,
  options: LoyaltyTierLimits & {
    afterId?: string | null;
    onlyIds?: string[];
  } = {},
): Promise<LoyaltyTierSweepResult> {
  const businessDate = businessDateOf(now, DAY_CLOCK);
  const tenantId = context.tenant.tenantId;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const maxBatches = options.maxBatches ?? MAX_BATCHES;
  let evaluated = 0;
  let changed = 0;
  const failedIds: string[] = [];
  const visit = async (id: string) => {
    try {
      const didChange = await withTenant(database, context, (tx) =>
        evaluateProfileTier(tx, context, id, now),
      );
      evaluated += 1;
      if (didChange) changed += 1;
    } catch (error) {
      failedIds.push(id);
      logger.warn(
        {
          job: "loyalty_tier",
          customerProfileId: id,
          errorName: error instanceof Error ? error.name : "unknown",
          errorCode: (error as { code?: unknown } | null)?.code ?? null,
        },
        "loyalty tier evaluation failed for one profile",
      );
    }
  };
  let nextAfterId: string | null = null;
  if (options.onlyIds) {
    for (const id of options.onlyIds) await visit(id);
  } else {
    let afterId: string | null = options.afterId ?? null;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const cursor: string | null = afterId;
      const ids: string[] = await withTenant(database, context, (tx) =>
        listTierCandidateProfileIds(tx, tenantId, cursor, batchSize),
      );
      for (const id of ids) await visit(id);
      if (ids.length < batchSize) {
        nextAfterId = null;
        break;
      }
      afterId = ids[ids.length - 1]!;
      nextAfterId = afterId;
    }
  }
  return {
    businessDate,
    evaluated,
    changed,
    failed: failedIds.length,
    failedIds,
    nextAfterId,
  };
}

type TenantDayState = {
  day: string;
  /** Where the next scan tick continues; null at the start. */
  cursor: string | null;
  scanned: boolean;
  failedIds: string[];
  retryTicks: number;
  done: boolean;
};

const stateByTenant = new Map<string, TenantDayState>();

/**
 * Worker sweep: once per tenant per Asia/Jakarta day, after 02:00. A tenant
 * larger than one tick's batches continues from a saved cursor on the next
 * tick; the day is done when the scan reaches a short batch. Profiles that
 * failed are retried alone on later ticks, at most `MAX_RETRY_TICKS` times,
 * then left until tomorrow. The evaluation is idempotent, so a retry writes no
 * extra history.
 */
export async function runLoyaltyTierSweep(
  context: ScopedTenantContext,
  now: Date,
  limits: LoyaltyTierLimits = {},
): Promise<LoyaltyTierSweepResult | null> {
  const day = loyaltyTierDay(now);
  if (day === null) return null;
  const tenantId = context.tenant.tenantId;
  let state = stateByTenant.get(tenantId);
  if (state?.day !== day) {
    state = {
      day,
      cursor: null,
      scanned: false,
      failedIds: [],
      retryTicks: 0,
      done: false,
    };
    stateByTenant.set(tenantId, state);
  }
  if (state.done) return null;
  if (!state.scanned) {
    const result = await runLoyaltyTierEvaluation(db, context, now, {
      ...limits,
      afterId: state.cursor,
    });
    state.failedIds.push(...result.failedIds);
    state.cursor = result.nextAfterId;
    if (result.nextAfterId === null) {
      state.scanned = true;
      if (state.failedIds.length === 0) state.done = true;
    }
    return result;
  }
  const result = await runLoyaltyTierEvaluation(db, context, now, {
    ...limits,
    onlyIds: state.failedIds,
  });
  state.failedIds = result.failedIds;
  state.retryTicks += 1;
  if (state.failedIds.length === 0 || state.retryTicks >= MAX_RETRY_TICKS)
    state.done = true;
  return result;
}
