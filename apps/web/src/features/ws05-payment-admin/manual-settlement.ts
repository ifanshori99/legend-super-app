// "Catat refund manual" (card 1259, legend-xd2q): finance paid an approved
// refund by hand outside the provider and records the proof here. Pure (no
// React, no `@/` alias) so the root tests can import it with plain Node ESM.
// Money rule: the server is the checker (state, provider lookup, amount,
// MFA); this only hides the button where it can never apply and turns the
// server's refusal codes into Bahasa Indonesia. Paying twice is the loss to
// avoid: a refund the provider holds is never offered here.
import type { MessageKey } from "@starter/shared/i18n";
import type { PermissionCode } from "@starter/shared/access";
import {
  manualRefundSettlementInputSchema,
  type ManualRefundSettlementChannel,
  type ManualRefundSettlementInput,
  type RefundView,
} from "@starter/shared/payment/admin";

/** Same permission the API route needs (settleRefundManually). */
export const MANUAL_SETTLE_PERMISSION: PermissionCode = "payment.reconcile";

export const MANUAL_SETTLE_CHANNELS: readonly ManualRefundSettlementChannel[] =
  ["bank_transfer", "cash", "ewallet", "provider_dashboard", "other"];

/**
 * Presentation only: an `approved` refund the provider does not hold (no
 * provider reference), for an account with payment.reconcile. The API still
 * refuses REFUND_AT_PROVIDER, payouts in flight, and the requester.
 */
export function canSettleManually(
  refund: RefundView,
  permissions: readonly string[],
): boolean {
  return (
    permissions.includes(MANUAL_SETTLE_PERMISSION) &&
    refund.status === "approved" &&
    refund.providerRef === null
  );
}

export type ManualSettlementForm = {
  /** `YYYY-MM-DDTHH:mm` from a datetime-local field, in the browser's zone. */
  paidAtLocal: string;
  channel: ManualRefundSettlementChannel | "";
  externalReference: string;
  amountIdr: string;
  note: string;
};

export type ManualSettlementField =
  "paidAt" | "channel" | "externalReference" | "amountIdr" | "note";

export type ManualSettlementCheck =
  | { ok: true; body: Omit<ManualRefundSettlementInput, "idempotencyKey"> }
  | { ok: false; field: ManualSettlementField; messageKey: MessageKey };

const FIELD_ERRORS: Record<ManualSettlementField, MessageKey> = {
  paidAt: "paymentAdmin.manualSettle.error.paidAt",
  channel: "paymentAdmin.manualSettle.error.channel",
  externalReference: "paymentAdmin.manualSettle.error.externalReference",
  amountIdr: "paymentAdmin.manualSettle.error.amount",
  note: "paymentAdmin.manualSettle.error.note",
};

/**
 * Checks the form against the shared schema (a sentinel key stands in for the
 * attempt key) and the money rule that the amount equals the refund. The
 * amount is never defaulted silently: finance types what they paid.
 */
export function checkManualSettlement(
  refund: RefundView,
  form: ManualSettlementForm,
  now: Date = new Date(),
): ManualSettlementCheck {
  const paidAt = new Date(form.paidAtLocal);
  if (!form.paidAtLocal || Number.isNaN(paidAt.getTime()))
    return fail("paidAt");
  if (
    paidAt.getTime() < new Date(refund.createdAt).getTime() ||
    paidAt.getTime() > now.getTime()
  )
    return fail("paidAt");
  if (!form.channel) return fail("channel");
  const amount = Number(form.amountIdr.replace(/[.\s]/g, ""));
  if (!Number.isInteger(amount) || amount <= 0) return fail("amountIdr");
  if (amount !== refund.amountIdr)
    return {
      ok: false,
      field: "amountIdr",
      messageKey: "paymentAdmin.manualSettle.error.amountMismatch",
    };
  const parsed = manualRefundSettlementInputSchema.safeParse({
    idempotencyKey: "00000000-0000-4000-8000-000000000000",
    paidAt: paidAt.toISOString(),
    channel: form.channel,
    externalReference: form.externalReference,
    amountIdr: amount,
    note: form.note,
  });
  if (!parsed.success) {
    const path = String(parsed.error.issues[0]?.path[0] ?? "");
    return fail(
      path === "externalReference" || path === "note" ? path : "note",
    );
  }
  const body: Omit<ManualRefundSettlementInput, "idempotencyKey"> = {
    paidAt: parsed.data.paidAt,
    channel: parsed.data.channel,
    externalReference: parsed.data.externalReference,
    amountIdr: parsed.data.amountIdr,
    note: parsed.data.note,
  };
  return { ok: true, body };
}

function fail(field: ManualSettlementField): ManualSettlementCheck {
  return { ok: false, field, messageKey: FIELD_ERRORS[field] };
}

const REFUSAL_KEYS: Record<string, MessageKey> = {
  REFUND_NOT_SETTLEABLE: "paymentAdmin.manualSettle.refusal.notSettleable",
  REFUND_AT_PROVIDER: "paymentAdmin.manualSettle.refusal.atProvider",
  REFUND_PAYOUT_IN_FLIGHT: "paymentAdmin.manualSettle.refusal.payoutInFlight",
  SETTLEMENT_AMOUNT_MISMATCH:
    "paymentAdmin.manualSettle.refusal.amountMismatch",
  REFUND_PROVIDER_PAID: "paymentAdmin.manualSettle.refusal.providerPaid",
  REFUND_PROVIDER_PENDING: "paymentAdmin.manualSettle.refusal.providerPending",
  PROVIDER_REFUND_STATUS_UNKNOWN:
    "paymentAdmin.manualSettle.refusal.providerUnknown",
  REFUND_LOOKUP_STALE: "paymentAdmin.manualSettle.refusal.lookupStale",
  REFUND_CAP_EXCEEDED: "paymentAdmin.manualSettle.refusal.capExceeded",
  PROVIDER_REFUNDED: "paymentAdmin.manualSettle.refusal.providerRefunded",
  APPROVER_IS_REQUESTER: "paymentAdmin.manualSettle.refusal.sameActor",
  MFA_REQUIRED: "paymentAdmin.manualSettle.refusal.mfaRequired",
  REAUTH_REQUIRED: "paymentAdmin.manualSettle.refusal.mfaRequired",
};

/**
 * Catalog key for a refusal code. A 422 VALIDATION_ERROR is the paidAt window
 * (before the refund was asked, or ahead of the server clock). Unknown codes
 * give null: the caller shows the generic "belum berhasil" line.
 */
export function manualSettlementRefusalKey(
  status: number,
  code: string | undefined,
): MessageKey | null {
  if (status === 422 && code === "VALIDATION_ERROR")
    return "paymentAdmin.manualSettle.refusal.paidAtWindow";
  return code ? (REFUSAL_KEYS[code] ?? null) : null;
}
