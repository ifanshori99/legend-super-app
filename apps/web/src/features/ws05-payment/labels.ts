// Catalog keys for the payable methods, so every screen names them the same
// way and tenants can rename them through text overrides.
import type { MessageKey } from "@starter/shared/i18n";
import type { CustomerPaymentMethodCode } from "@starter/shared/payment";

export const PAYMENT_METHOD_LABEL: Record<
  CustomerPaymentMethodCode,
  MessageKey
> = {
  qris: "payment.methodQris",
  va: "payment.methodVa",
  bank_transfer: "payment.methodBankTransfer",
};

export const PAYMENT_METHOD_HINT: Record<
  CustomerPaymentMethodCode,
  MessageKey
> = {
  qris: "payment.methodQrisHint",
  va: "payment.methodVaHint",
  bank_transfer: "payment.methodBankTransferHint",
};
