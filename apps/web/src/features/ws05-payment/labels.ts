// Catalog keys for the payable methods, so every screen names them the same
// way and tenants can rename them through text overrides.
import type { MessageKey } from "@starter/shared/i18n";
import type {
  CustomerPaymentIntentMethodCode,
  CustomerPaymentMethod,
  CustomerPaymentMethodCode,
} from "@starter/shared/payment";

/** Methods the picker can show. E-wallet and card (1269 C2a) are paid on
 * Duitku's page (C2b): they are shown only while the server has them on, and
 * an e-wallet only with at least one app to pick. */
export type PickerMethodCode = CustomerPaymentMethodCode;
export type PickerMethod = CustomerPaymentMethod & { method: PickerMethodCode };

export function pickerMethods(
  methods: readonly CustomerPaymentMethod[],
): PickerMethod[] {
  return methods.filter((option) =>
    option.method === "ewallet"
      ? option.enabled && option.channels.length > 0
      : option.method === "card"
        ? option.enabled
        : true,
  );
}

export const PAYMENT_METHOD_LABEL: Record<PickerMethodCode, MessageKey> = {
  qris: "payment.methodQris",
  va: "payment.methodVa",
  bank_transfer: "payment.methodBankTransfer",
  ewallet: "payment.redirect.method.ewallet",
  card: "payment.redirect.method.card",
};

export const PAYMENT_METHOD_HINT: Record<PickerMethodCode, MessageKey> = {
  qris: "payment.methodQrisHint",
  va: "payment.methodVaHint",
  bank_transfer: "payment.methodBankTransferHint",
  ewallet: "payment.redirect.method.ewalletHint",
  card: "payment.redirect.method.cardHint",
};

/** Label key for a payment's method. */
export function paymentMethodLabelKey(
  method: CustomerPaymentIntentMethodCode,
): MessageKey {
  return PAYMENT_METHOD_LABEL[method];
}
