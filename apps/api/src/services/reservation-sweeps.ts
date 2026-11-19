// Expiry of unpaid DP holds (PRD v1.7 §3 F22 / §3.22 "DP & Kebijakan"; RSV-01
// tables are never held forever, RSV-02; bead legend-t8bz).
//
// A `pending_deposit` reservation holds its tables (tentatively) while the guest
// pays the DP. It is released, i.e. `cancelled` with close reason
// `deposit_not_paid`, holds released, one `reservation.cancelled` event, when:
// - its DP link expired unpaid (any pending intent the guest already opened on
//   the link keeps it payable for that intent's own lifetime), or
// - no link was ever attached (crash / payment-side failure between the booking
//   commit and the link) and the snapshot's payment window passed since the
//   booking (constant fallback `DEPOSIT_ATTACH_GRACE_MINUTES`). The PRD sets
//   no grace; this is the safest default, a guest could not pay longer anyway.
// A DP that WAS paid is confirmed instead, never released (`reconcileDeposit`
// decides both under the row lock). Rows whose gateway code is still inside its
// poll window are left out of the candidate batch (legend-m0kqn).
//
// Runs (a) from the worker relay tick per tenant (worker-main.ts) and (b)
// lazily at the start of every new booking under the outlet hold lock, so a
// stale hold never blocks a guest even when the worker is behind.
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { OutletId, ScopedTenantContext } from "@starter/shared/core";
import { paymentIntents } from "../db/schema/index.ts";
import { reservations } from "../db/schema/reservation.ts";
import { GATEWAY_POLL_WINDOW_MS } from "./payment-poll-window.ts";
import {
  DEPOSIT_ATTACH_GRACE_MINUTES,
  reconcileDeposit,
  type Tx,
} from "./reservation-core.ts";

// legend-lb3c: the H-24 reminder sweep lives with the guest messages.
export { sweepReservationReminders } from "./reservation-guest-notify.ts";

/** Rows examined per call; the next tick continues. */
const SWEEP_BATCH = 100;

export type DepositSweepResult = {
  /** Reservations closed as `cancelled` (deposit_not_paid). */
  readonly released: string[];
  /** Reservations found paid and confirmed by the sweep. */
  readonly confirmed: string[];
};

/**
 * Releases (or confirms) every due `pending_deposit` reservation of the tenant
 * (or of one outlet). Candidates are pre-filtered in SQL with the earliest
 * possible deadline; `reconcileDeposit` makes the real decision per row, which
 * also honours pending intents opened on the link. Rows locked by another
 * writer are skipped (SKIP LOCKED) and retried on the next call.
 */
export async function sweepStaleDepositHolds(
  tx: Tx,
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { outletId?: OutletId; limit?: number } = {},
): Promise<DepositSweepResult> {
  const window = sql`make_interval(mins => coalesce((${reservations.policySnapshot}->>'paymentWindowMinutes')::int, ${DEPOSIT_ATTACH_GRACE_MINUTES}))`;
  const nowSql = sql`${now.toISOString()}::timestamptz`;
  // legend-m0kqn: the cancel decision stays in `reconcileDeposit`
  // (reservation-core.ts). This filter only keeps rows that are certain no-ops
  // (a gateway code still pollable) from filling the LIMIT batch and starving
  // the rows behind them (ORDER BY created_at).
  const gatewayStillPollable = sql`exists (
    select 1 from payment_intents
    where ${paymentIntents.tenantId} = ${reservations.tenantId}
      and (
        ${paymentIntents.paymentLinkId} = ${reservations.depositPaymentLinkId}
        or ${paymentIntents.id} = ${reservations.depositPaymentId}
      )
      and ${paymentIntents.providerRef} is not null
      and ${paymentIntents.providerFinalAt} is null
      and ${paymentIntents.status} not in ('paid', 'partially_refunded', 'refunded')
      and greatest(
        coalesce(${reservations.depositLinkExpiresAt}, ${reservations.createdAt} + ${window}),
        ${paymentIntents.expiresAt}
      ) + make_interval(secs => ${GATEWAY_POLL_WINDOW_MS / 1000}) > ${nowSql}
  ) and not exists (
    select 1 from payment_intents paid_pi
    where paid_pi.tenant_id = ${reservations.tenantId}
      and (
        paid_pi.payment_link_id = ${reservations.depositPaymentLinkId}
        or paid_pi.id = ${reservations.depositPaymentId}
      )
      and paid_pi.status in ('paid', 'partially_refunded')
  )`;
  const filters = [
    eq(reservations.tenantId, context.tenant.tenantId),
    eq(reservations.status, "pending_deposit"),
    sql`not (${gatewayStillPollable})`,
    or(
      // Link attached (or legacy intent): its window passed.
      lte(reservations.depositLinkExpiresAt, now),
      // Never attached: the attach grace passed since booking.
      and(
        isNull(reservations.depositPaymentLinkId),
        isNull(reservations.depositPaymentId),
        sql`${reservations.createdAt} + ${window} <= ${now.toISOString()}::timestamptz`,
      ),
    ),
  ];
  if (options.outletId)
    filters.push(eq(reservations.outletId, options.outletId));
  const due = await tx
    .select()
    .from(reservations)
    .where(and(...filters))
    .orderBy(asc(reservations.createdAt), asc(reservations.id))
    .limit(options.limit ?? SWEEP_BATCH)
    .for("update", { skipLocked: true });
  const released: string[] = [];
  const confirmed: string[] = [];
  for (const row of due) {
    const after = await reconcileDeposit(tx, context, row, now);
    if (after.status === "cancelled") released.push(row.id);
    else if (after.status === "confirmed") confirmed.push(row.id);
  }
  return { released, confirmed };
}
