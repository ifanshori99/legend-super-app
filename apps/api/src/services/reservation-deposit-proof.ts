/**
 * legend-pdi5u: local time is not proof that a DP can no longer be paid. A code
 * the PROVIDER has not answered final for (`payment_intents.provider_final_at`,
 * see `db/schema/payment.ts`) may still take money, so the reservation must not
 * cancel the DP at zero and the old link must not be replaced while one exists.
 */

export type DepositIntentProof = {
  readonly status: string;
  readonly providerRef: string | null;
  readonly providerFinalAt: Date | null;
};

/** Statuses where the money already moved: the intent is settled, not open. */
const MONEY_MOVED = new Set(["paid", "partially_refunded", "refunded"]);

/**
 * True when the intent can still receive money: it was handed to a provider
 * (`providerRef` set), the provider has not answered final, and it has not
 * already been paid or refunded. Pure: reads only the given fields.
 */
export function depositIntentMayStillPay(intent: DepositIntentProof): boolean {
  return (
    intent.providerRef !== null &&
    intent.providerFinalAt === null &&
    !MONEY_MOVED.has(intent.status)
  );
}
