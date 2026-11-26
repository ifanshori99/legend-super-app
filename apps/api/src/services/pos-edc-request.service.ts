// POS ECR sale on the outlet's own terminal (1269 E7, replaces B-E3). The
// request reaches the EDC agent of THIS process: the edge node's (frozen
// path) or, B2 legend-wasr7.21, the cloud agent driving the outlet's bridge
// tablet (edge/edc/resolver.ts). Never forwarded to another process.
//
// Money rules (the agent enforces them again under the bill lock; this file
// only picks what to ask for):
// - No agent here (standby, agent off or down, no bridge connected to this
//   process) = ECR locked: 503
//   EDC_AGENT_NOT_READY before anything is written. The cashier keys the
//   terminal by hand with a supervisor approval instead (EDC-04).
// - The amount is what the bill still owes, never a client figure (ORD-03).
// - A repeated idempotency key sends the ORIGINAL request again, so the agent
//   replays (or inquires) that one transaction: a lost reply never makes a
//   second sale, even after the bill moved on.
// - The terminal's bank without an adapter (production until legend-vpx) is
//   refused by the agent before any ledger row exists.

import { and, eq } from "drizzle-orm";
import {
  idr,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  EdcError,
  edcPaymentRequestSchema,
  type EdcMethod,
  type EdcTransaction,
} from "@starter/shared/edc";
import { PosError } from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { edcTransactions } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import type { EdcAgent } from "../edge/edc/agent.ts";
import { resolveEdcAgent } from "../edge/edc/resolver.ts";
import {
  assertExpectedVersion,
  readPosOrder,
  remainingIdr,
  tendersOf,
} from "./pos-order-support.ts";

function agentOrLocked(
  context: ScopedTenantContext,
  outletId: OutletId,
): EdcAgent {
  const resolved = resolveEdcAgent(context.tenant.tenantId, outletId);
  if (!resolved) throw new EdcError("EDC_AGENT_NOT_READY");
  return resolved.agent;
}

export async function startPosEdcSale(
  context: ScopedTenantContext,
  actorUserId: UserId,
  outletId: OutletId,
  orderId: string,
  input: {
    terminalId: string;
    method: EdcMethod;
    idempotencyKey: string;
    expectedVersion?: number;
  },
): Promise<EdcTransaction> {
  const agent = agentOrLocked(context, outletId);
  const ask = await withTenant(db, context, async (tx) => {
    const { order, pos } = await readPosOrder(tx, context, outletId, orderId);
    const [earlier] = await tx
      .select({ amountIdr: edcTransactions.amountIdr })
      .from(edcTransactions)
      .where(
        and(
          eq(edcTransactions.tenantId, context.tenant.tenantId),
          eq(edcTransactions.outletId, outletId),
          eq(edcTransactions.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    // Same key, same request: the agent's fingerprint still refuses a key
    // reused for another bill, terminal or method.
    if (earlier)
      return { reference: order.number, amountIdr: earlier.amountIdr };
    assertExpectedVersion(pos, input.expectedVersion ?? null);
    const owed = remainingIdr(order, await tendersOf(tx, context, order.id));
    if (owed <= 0) throw new PosError("ORDER_NOT_PAYABLE");
    return { reference: order.number, amountIdr: owed };
  });
  return agent.requestPayment(
    context,
    actorUserId,
    edcPaymentRequestSchema.parse({
      tenantId: context.tenant.tenantId,
      outletId,
      terminalId: input.terminalId,
      reference: ask.reference,
      idempotencyKey: input.idempotencyKey,
      amountIdr: idr(ask.amountIdr),
      method: input.method,
    }),
  );
}

type Ref = { outletId: OutletId; transactionId: string };

const refOf = (context: ScopedTenantContext, ref: Ref) => ({
  tenantId: context.tenant.tenantId,
  outletId: ref.outletId,
  transactionId: ref.transactionId,
});

export function getPosEdcTransaction(
  context: ScopedTenantContext,
  actorUserId: UserId,
  ref: Ref,
): Promise<EdcTransaction> {
  return agentOrLocked(context, ref.outletId).get(
    context,
    actorUserId,
    refOf(context, ref),
  );
}

export function inquirePosEdcTransaction(
  context: ScopedTenantContext,
  actorUserId: UserId,
  ref: Ref,
): Promise<EdcTransaction> {
  return agentOrLocked(context, ref.outletId).inquire(
    context,
    actorUserId,
    refOf(context, ref),
  );
}

export function cancelPosEdcTransaction(
  context: ScopedTenantContext,
  actorUserId: UserId,
  ref: Ref,
): Promise<EdcTransaction> {
  return agentOrLocked(context, ref.outletId).cancel(
    context,
    actorUserId,
    refOf(context, ref),
  );
}
