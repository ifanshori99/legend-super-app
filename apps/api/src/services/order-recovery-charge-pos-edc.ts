// The cashier starts the card sale of a dearer-swap charge on the outlet's
// terminal (legend-f1mmf; contract @starter/shared/pos
// `startPosIssueChargeEdc`). The EDC agent of this edge node drives the
// terminal (pos-edc-request.service.ts); the sale is recorded on the charge
// afterwards by `collect-at-pos` with `edc_card` and the sale id.
//
// Money rules:
// - The amount is the charge's `amount_idr` and the reference the charge id,
//   never a client figure. The agent refuses a second sale for the reference
//   while an earlier one is unresolved or approved.
// - A repeated idempotency key sends the ORIGINAL request again, so the agent
//   replays (or inquires) that one sale: a lost reply never makes a second.
// - One money path at a time: a live QRIS code of the charge's link, a paid
//   intent not yet applied, or an outstanding EDC sale refuses a new sale
//   (409) before the terminal is asked. The cashier needs an open shift on
//   this device, like the collect.
// - 404 for a charge of another tenant, an outlet outside the caller's scope,
//   another outlet than the acting cashier's, or an outlet where the caller
//   may not take payments. No agent here (cloud, agent down): 503
//   EDC_AGENT_NOT_READY, nothing written.

import { and, eq } from "drizzle-orm";
import {
  CoreError,
  idr,
  isOutletInScope,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  EdcError,
  edcPaymentRequestSchema,
  type EdcTransaction,
} from "@starter/shared/edc";
import { db } from "../db/index.ts";
import { edcTransactions } from "../db/schema/edc.ts";
import { withTenant } from "../db/tenant.ts";
import { getEdgeEdcAgent } from "../edge/edc/runtime.ts";
import { lockChargeChain } from "./order-recovery-charge.ts";
import {
  assertNoEdcSaleOutstanding,
  assertNoLiveChargeCode,
} from "./order-recovery-charge-money-path.ts";
import {
  assertCollectable,
  assertNoPaidIntentOnLink,
} from "./order-recovery-charge-pos-nontunai.ts";
import type { CollectChargeAtPosCaller } from "./order-recovery-charge-pos.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";
import { lockCashierShiftForCash } from "./pos-cash-guard.ts";

const PAY = "pos.payment.accept";

export type ChargeEdcCaller = CollectChargeAtPosCaller & {
  /** The acting cashier's outlet on a shared device, else null. */
  readonly actingOutletId: string | null;
};

const notFound = () =>
  new CoreError("NOT_FOUND", "Tagihan selisih tidak ditemukan.");

export async function startPosIssueChargeEdc(
  context: ScopedTenantContext,
  caller: ChargeEdcCaller,
  chargeId: string,
  input: { terminalId: string; idempotencyKey: string },
  now = new Date(),
): Promise<EdcTransaction> {
  const tenantId = context.tenant.tenantId;
  const ask = await withTenant(db, context, async (tx) => {
    const snapshot = await accessSnapshotInTransaction(
      tx,
      context,
      caller.userId,
      now,
    );
    const locked = await lockChargeChain(tx, tenantId, { chargeId });
    if (!locked) throw notFound();
    const { charge } = locked;
    if (
      !isOutletInScope(context.outletScope, charge.outletId) ||
      (caller.actingOutletId !== null &&
        caller.actingOutletId.toLowerCase() !==
          charge.outletId.toLowerCase()) ||
      !snapshot.allows(PAY, { type: "outlet", id: charge.outletId })
    )
      throw notFound();
    const outletId = outletIdSchema.parse(charge.outletId);

    // Same key, same request: the agent replays or inquires that one sale
    // (its fingerprint refuses a key reused for another terminal or charge).
    const [earlier] = await tx
      .select({ amountIdr: edcTransactions.amountIdr })
      .from(edcTransactions)
      .where(
        and(
          eq(edcTransactions.tenantId, tenantId),
          eq(edcTransactions.outletId, outletId),
          eq(edcTransactions.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (earlier)
      return { outletId, chargeId: charge.id, amountIdr: earlier.amountIdr };

    await assertCollectable(tx, tenantId, locked);
    await assertNoPaidIntentOnLink(tx, context, charge.paymentLinkId, false);
    await assertNoLiveChargeCode(tx, tenantId, charge.paymentLinkId);
    await assertNoEdcSaleOutstanding(tx, tenantId, charge);
    await lockCashierShiftForCash(tx, context, {
      outletId,
      cashierId: caller.userId,
      deviceId: caller.deviceId,
      mode: "in",
      at: now,
    });
    return { outletId, chargeId: charge.id, amountIdr: charge.amountIdr };
  });

  const agent = getEdgeEdcAgent();
  if (!agent) throw new EdcError("EDC_AGENT_NOT_READY");
  return agent.requestPayment(
    context,
    caller.userId,
    edcPaymentRequestSchema.parse({
      tenantId,
      outletId: ask.outletId,
      terminalId: input.terminalId,
      reference: ask.chargeId,
      idempotencyKey: input.idempotencyKey,
      amountIdr: idr(ask.amountIdr),
      method: "card",
    }),
  );
}
