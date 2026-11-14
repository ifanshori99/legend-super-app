// QRIS hold check (design legend-yhia9 D-03/D-04). Runs from the worker relay
// tick per tenant, on cloud and on edge. For every active hold that is due it
// reads the provider once (`checkQrisHold`): the hold closes only on provider
// proof at or after `expires_at` + 60 s, never on the local clock. Schedule
// (`next_check_at`): right after the cashier cancels, at `expires_at` + 60 s,
// every 2 minutes for 30 minutes, then every 10 minutes. A failing hold never
// stops the others.

import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/index.ts";
import { posQrisHolds } from "../db/schema/pos-qris-hold.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger";
import {
  HOLD_CLOSE_MARGIN_MS,
  checkQrisHold,
} from "../services/pos-qris-hold.ts";

/** Minimum time between two runs for one tenant. */
export const POS_QRIS_HOLD_CHECK_INTERVAL_MS = 30_000;
const BATCH_LIMIT = 100;

const lastRunByTenant = new Map<string, number>();

export type PosQrisHoldCheckResult = { checked: number; closed: number };

export async function runPosQrisHoldCheckJob(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { force?: boolean } = {},
): Promise<PosQrisHoldCheckResult | null> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const last = lastRunByTenant.get(tenantId);
  if (
    !options.force &&
    last !== undefined &&
    now.getTime() - last < POS_QRIS_HOLD_CHECK_INTERVAL_MS
  )
    return null;
  lastRunByTenant.set(tenantId, now.getTime());
  const nowAt = sql`${now.toISOString()}::timestamptz`;
  const due = await withTenant(db, context, async (tx) =>
    tx
      .select({ id: posQrisHolds.id })
      .from(posQrisHolds)
      .innerJoin(
        paymentIntents,
        and(
          eq(paymentIntents.tenantId, posQrisHolds.tenantId),
          eq(paymentIntents.id, posQrisHolds.paymentIntentId),
        ),
      )
      .where(
        and(
          eq(posQrisHolds.tenantId, tenantId),
          inArray(posQrisHolds.state, ["open", "cancelling"]),
          // A hold never scheduled yet is first looked at `expires_at` + 60 s.
          options.force
            ? undefined
            : or(
                and(
                  isNull(posQrisHolds.nextCheckAt),
                  sql`${paymentIntents.expiresAt} + ${`${HOLD_CLOSE_MARGIN_MS} milliseconds`}::interval <= ${nowAt}`,
                ),
                lte(posQrisHolds.nextCheckAt, now),
              ),
        ),
      )
      .orderBy(sql`${posQrisHolds.nextCheckAt} asc nulls first`)
      .limit(BATCH_LIMIT),
  );
  const result: PosQrisHoldCheckResult = { checked: 0, closed: 0 };
  for (const row of due) {
    try {
      const state = await checkQrisHold(context, row.id, now);
      result.checked += 1;
      if (state === "closed") result.closed += 1;
    } catch (error) {
      logger.warn(
        {
          job: "pos_qris_hold_check",
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "QRIS hold check failed",
      );
    }
  }
  return result;
}
