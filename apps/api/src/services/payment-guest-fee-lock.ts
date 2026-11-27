// 1272 K2 (design duitku-fee-passthrough §2, §6): a Duitku channel whose
// settlement fee came above the guest service fee collected is locked while
// its `guest_fee_shortfall` reconciliation case is open or waiting for
// approval. A locked channel loses its guest fee rate, so a guest-fee method
// hides it and createIntent refuses it (never a silent fee 0). The supervisor
// fixes the rate, then closes the case through the approval chain; that
// unlocks it. The lock is tenant wide: a rate may sit on the tenant row and
// serve every outlet, and hiding a channel only sends the guest to QRIS.
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { paymentReconciliationCases as cases } from "../db/schema/payment-admin.ts";
import { paymentSettlementLines as lines } from "../db/schema/payment-settlement.ts";
import { paymentIntents } from "../db/schema/payment.ts";
import { withTenant } from "../db/tenant.ts";

/** Duitku's one card code (payment-duitku-wire.ts): card intents carry no channel. */
const CARD_CODE = "VC";

/** Duitku channel codes locked by an open or pending shortfall case. */
export async function lockedGuestFeeChannels(
  context: ScopedTenantContext,
): Promise<ReadonlySet<string>> {
  const rows = await withTenant(db, context, (tx) =>
    tx
      .selectDistinct({
        code: sql<
          string | null
        >`CASE WHEN ${paymentIntents.method} = 'card' THEN ${CARD_CODE} ELSE ${paymentIntents.channelCode} END`,
      })
      .from(cases)
      .innerJoin(
        lines,
        and(
          eq(lines.tenantId, cases.tenantId),
          eq(lines.id, cases.settlementLineId),
        ),
      )
      .innerJoin(
        paymentIntents,
        and(
          eq(paymentIntents.tenantId, lines.tenantId),
          eq(paymentIntents.id, lines.matchedPaymentIntentId),
        ),
      )
      .where(
        and(
          eq(cases.tenantId, context.tenant.tenantId),
          eq(cases.kind, "guest_fee_shortfall"),
          eq(cases.provider, "duitku"),
          inArray(cases.status, ["open", "pending_approval"]),
          isNotNull(cases.settlementLineId),
        ),
      ),
  );
  return new Set(rows.flatMap((row) => (row.code ? [row.code] : [])));
}

/** The integration config without the guest fee rates of locked codes. */
export function withoutLockedGuestFees(
  config: Record<string, unknown>,
  locked: ReadonlySet<string>,
): Record<string, unknown> {
  const raw = config.guestFees;
  if (
    locked.size === 0 ||
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw)
  )
    return config;
  const kept = Object.fromEntries(
    Object.entries(raw).filter(([code]) => !locked.has(code)),
  );
  return { ...config, guestFees: kept };
}
