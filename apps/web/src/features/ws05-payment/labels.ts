// Catalog keys for the payable methods, so every screen names them the same
// way and tenants can rename them through text overrides.
import type { MessageKey } from "@starter/shared/i18n";
import type {
  CustomerPaymentIntentMethodCode,
  CustomerPaymentMethod,
  CustomerPaymentMethodCode,
} from "@starter/shared/payment";

/** Methods the picker can show. The API also offers e-wallet and card (1269
 * C2a); their screens come with C2b, so the picker leaves them out. */
export type PickerMethodCode = Exclude<
  CustomerPaymentMethodCode,
  "ewallet" | "card"
>;
export type PickerMethod = CustomerPaymentMethod & { method: PickerMethodCode };

export function pickerMethods(
  methods: readonly CustomerPaymentMethod[],
): PickerMethod[] {
  return methods.filter(
    (option): option is PickerMethod =>
      option.method !== "ewallet" && option.method !== "card",
  );
}

export const PAYMENT_METHOD_LABEL: Record<PickerMethodCode, MessageKey> = {
  qris: "payment.methodQris",
  va: "payment.methodVa",
  bank_transfer: "payment.methodBankTransfer",
};

export const PAYMENT_METHOD_HINT: Record<PickerMethodCode, MessageKey> = {
  qris: "payment.methodQrisHint",
  va: "payment.methodVaHint",
  bank_transfer: "payment.methodBankTransferHint",
};

/**
 * Label key for a payment's method. E-wallet and card payments exist on the
 * API (legend-kt3t1) but have no catalog text yet; their screens belong to
 * legend-6xf7x. Until then this answers null and callers show the channel
 * name (or nothing) instead of a wrong word.
 */
export function paymentMethodLabelKey(
  method: CustomerPaymentIntentMethodCode,
): MessageKey | null {
  return method === "ewallet" || method === "card"
    ? null
    : PAYMENT_METHOD_LABEL[method];
}
