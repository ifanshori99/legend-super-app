// legend-vp4ta (brief 1025b, money + permission): finance closes a
// refund_recon_hold. An open hold stops every refund, payout and fund refund of
// its intent; nothing else sets `resolved_at`.
//
// Closing never pays anyone and never sets a stamp by itself:
// - `not_this_intent`: the money the provider returned is not this payment's;
//   the hold is only closed.
// - `counted_against_intent`: it is this payment's. It is recorded as a
//   provider refund (the same recorder the webhook uses, quiet: one row, one
//   `payment.provider_refunded` event, so the books and the refund/payout
//   limits count it) BEFORE the hold closes, in the same transaction. A refund
//   of the same id already recorded counts once (the recorder is idempotent).
// Restrictive on purpose: a hold that cannot be counted (no provider refund id,
// 0 rupiah), a `payment:<ref>` hold that is not already recorded, or one the
// recorder does not write, is refused with 422 and stays open.
import {
  assertTrustedScopedContext,
  createUlid,
  decodeCursor,
  encodeCursor,
  isoDateTimeSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  listRefundReconHolds as listEndpoint,
  refundReconHoldViewSchema,
  resolveRefundReconHold as resolveEndpoint,
} from "@starter/shared/payment/admin";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  paymentEvidence,
  paymentIntents,
  paymentProviderRefunds,
  refundReconHolds,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { idempotentPaymentAdminWrite } from "./payment-admin-idempotency.ts";
import { recordProviderRefundInTx } from "./payment-provider-partial-refund.ts";
import { lockIntentsForFact } from "./payment-refund-fact-time.ts";
import { assertPaymentPermission } from "./payment-support.ts";
import type { Tx } from "./permission-resolver.ts";

type Query = ReturnType<typeof listEndpoint.query.parse>;
type Params = ReturnType<typeof resolveEndpoint.params.parse>;
type Input = ReturnType<typeof resolveEndpoint.body.parse>;

const PROVIDER = "doit";
/** Id prefix of the refund derived from a payment's own `refunded` status. */
const SYNTHETIC_PREFIX = "payment:";

const notFound = () =>
  new HttpError(404, "NOT_FOUND", "Refund hold not found.");
const unprocessable = (message: string) =>
  new HttpError(422, "VALIDATION_ERROR", message);

type HoldRow = typeof refundReconHolds.$inferSelect;

function toView(hold: HoldRow, outletId: string | null) {
  return refundReconHoldViewSchema.parse({
    id: hold.id,
    paymentIntentId: hold.paymentIntentId,
    outletId,
    providerRefundId: hold.providerRefundId,
    amountIdr: hold.amountIdr,
    reason: hold.reason,
    flaggedAt: hold.flaggedAt.toISOString(),
    resolvedAt: hold.resolvedAt ? hold.resolvedAt.toISOString() : null,
    resolution: hold.resolution,
    resolutionNote: hold.resolutionNote,
  });
}

export async function listRefundReconHolds(
  context: ScopedTenantContext,
  actor: string,
  input: Query,
) {
  assertTrustedScopedContext(context);
  const query = listEndpoint.query.parse(input);
  return withTenant(db, context, async (tx) => {
    await assertPaymentPermission(
      tx,
      context,
      actor,
      "payment.reconcile",
      { type: "tenant" },
      new Date(),
    );
    let cursor = sql`TRUE`;
    if (query.cursor) {
      const [flagged, id] = decodeCursor(query.cursor);
      if (typeof flagged !== "string" || typeof id !== "string")
        throw unprocessable("Invalid cursor.");
      cursor = sql`(${refundReconHolds.flaggedAt}, ${refundReconHolds.id}) < (${flagged}::timestamptz, ${id}::uuid)`;
    }
    const rows = await tx
      .select({ hold: refundReconHolds, outletId: paymentIntents.outletId })
      .from(refundReconHolds)
      .leftJoin(
        paymentIntents,
        and(
          eq(paymentIntents.tenantId, refundReconHolds.tenantId),
          eq(paymentIntents.id, refundReconHolds.paymentIntentId),
        ),
      )
      .where(
        and(
          eq(refundReconHolds.tenantId, context.tenant.tenantId),
          query.status === "resolved"
            ? sql`${refundReconHolds.resolvedAt} IS NOT NULL`
            : sql`${refundReconHolds.resolvedAt} IS NULL`,
          cursor,
        ),
      )
      .orderBy(
        sql`${refundReconHolds.flaggedAt} DESC`,
        sql`${refundReconHolds.id} DESC`,
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => toView(row.hold, row.outletId)),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.hold.flaggedAt.toISOString(), last.hold.id])
            : null,
      },
    };
  });
}

/** The provider transaction the held refund names: the intent's own, else the
 * one recorded transaction (evidence) of the intent. Null when in doubt. */
async function providerPaymentRefOf(
  tx: Tx,
  tenantId: string,
  intent: typeof paymentIntents.$inferSelect,
): Promise<string | null> {
  if (intent.provider === PROVIDER && intent.providerRef)
    return intent.providerRef;
  const evidence = await tx
    .select({ providerRef: paymentEvidence.providerRef })
    .from(paymentEvidence)
    .where(
      and(
        eq(paymentEvidence.tenantId, tenantId),
        eq(paymentEvidence.paymentIntentId, intent.id),
        eq(paymentEvidence.provider, PROVIDER),
      ),
    )
    .limit(2);
  return evidence.length === 1 ? (evidence[0]?.providerRef ?? null) : null;
}

export async function resolveRefundReconHold(
  context: ScopedTenantContext,
  actor: string,
  params: Params,
  input: Input,
  key: string,
) {
  assertTrustedScopedContext(context);
  const { holdId } = resolveEndpoint.params.parse(params);
  const request = resolveEndpoint.body.parse(input);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    // Lock order: payment intent -> hold. Resolves of two holds of one intent
    // and a webhook recording a refund of it are serialized by the intent.
    const [probe] = await tx
      .select({ paymentIntentId: refundReconHolds.paymentIntentId })
      .from(refundReconHolds)
      .where(
        and(
          eq(refundReconHolds.tenantId, tenantId),
          eq(refundReconHolds.id, holdId),
        ),
      );
    if (!probe) throw notFound();
    const now = new Date();
    const factAt = await lockIntentsForFact(
      tx,
      tenantId,
      [probe.paymentIntentId],
      now,
    );
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.id, probe.paymentIntentId),
        ),
      );
    if (!intent) throw notFound();
    const [hold] = await tx
      .select()
      .from(refundReconHolds)
      .where(
        and(
          eq(refundReconHolds.tenantId, tenantId),
          eq(refundReconHolds.id, holdId),
        ),
      )
      .for("update");
    if (!hold) throw notFound();
    await assertPaymentPermission(
      tx,
      context,
      actor,
      "payment.reconcile",
      { type: "outlet", id: intent.outletId },
      now,
    );
    return idempotentPaymentAdminWrite(
      tx,
      context,
      actor,
      key,
      "resolve-refund-hold",
      { holdId, ...request },
      async () => {
        if (hold.resolvedAt)
          throw new HttpError(409, "CONFLICT", "Hold already resolved.");
        const refundId = hold.providerRefundId;
        const synthetic = refundId?.startsWith(SYNTHETIC_PREFIX) === true;
        if (request.resolution === "not_this_intent") {
          // Our own refund ran while the full refund was recorded: the money
          // may already have gone back, so it is only closed by counting it.
          if (synthetic)
            throw unprocessable(
              "This hold names the payment's own refund; it can only be counted against the intent.",
            );
        } else {
          if (!refundId || hold.amountIdr <= 0)
            throw unprocessable(
              "This hold has no provider refund to count against the intent.",
            );
          const providerPaymentRef = await providerPaymentRefOf(
            tx,
            tenantId,
            intent,
          );
          if (!providerPaymentRef)
            throw unprocessable(
              "The provider transaction of this intent is not known.",
            );
          // Counted first: the limits and the journal see the refund before the
          // hold lets go of the intent. Quiet: this resolve is audited below.
          await recordProviderRefundInTx(
            tx,
            context,
            {
              provider: PROVIDER,
              providerRefundId: refundId,
              providerPaymentRef,
              amountIdr: hold.amountIdr,
              source: "refund_webhook",
              expectedIntentId: intent.id,
              force: true,
              quiet: true,
            },
            factAt,
          );
          // Only a refund that is on record may close the hold: an echo of our
          // own refund, an unbound or a delayed one counted nothing.
          const [counted] = await tx
            .select({ id: paymentProviderRefunds.id })
            .from(paymentProviderRefunds)
            .where(
              and(
                eq(paymentProviderRefunds.tenantId, tenantId),
                eq(paymentProviderRefunds.paymentIntentId, intent.id),
                eq(paymentProviderRefunds.provider, PROVIDER),
                eq(paymentProviderRefunds.providerRefundId, refundId),
              ),
            );
          if (!counted)
            throw unprocessable(
              "This refund could not be recorded against the intent.",
            );
        }
        const [closed] = await tx
          .update(refundReconHolds)
          .set({
            resolvedAt: now,
            resolvedBy: actor,
            resolution: request.resolution,
            resolutionNote: request.note,
          })
          .where(
            and(
              eq(refundReconHolds.tenantId, tenantId),
              eq(refundReconHolds.id, holdId),
              sql`${refundReconHolds.resolvedAt} IS NULL`,
            ),
          )
          .returning();
        if (!closed)
          throw new HttpError(409, "CONFLICT", "Hold already resolved.");
        await recordAudit(
          tx,
          context,
          {
            id: createUlid(now.getTime()),
            tenantId,
            outletId: intent.outletId,
            actorType: "user",
            actorId: actor,
            deviceId: null,
            action: "payment.refund_recon_hold_resolved",
            objectType: "payment_intent",
            objectId: intent.id,
            reason: request.note,
            maskedChanges: {
              before: { holdId, open: true },
              after: {
                holdId,
                open: false,
                resolution: request.resolution,
                providerRefundId: hold.providerRefundId,
                amountIdr: hold.amountIdr,
              },
            },
            ipHash: null,
            sensitiveAccess: false,
            retentionClass: "audit_2y",
            createdAt: isoDateTimeSchema.parse(now.toISOString()),
          },
          ["holdId", "open", "resolution", "providerRefundId", "amountIdr"],
        );
        return toView(closed, intent.outletId);
      },
    );
  });
}
