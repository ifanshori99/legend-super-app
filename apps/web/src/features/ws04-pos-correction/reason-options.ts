// The reasons a cashier can pick, in the order shown, with their catalog keys.
// The values are the contract enums (packages/shared/src/pos/schemas.ts);
// "promo_engine" is left out of the discount list because only the promo
// engine writes it.
import type {
  DiscountReason,
  RefundReason,
  VoidReason,
} from "@starter/shared/pos";
import type { MessageKey } from "@starter/shared/i18n";

type Option<T extends string> = { value: T; labelKey: MessageKey };

export const DISCOUNT_REASON_OPTIONS: readonly Option<DiscountReason>[] = [
  {
    value: "complaint_recovery",
    labelKey: "posCorrection.reason.discount.complaint_recovery",
  },
  {
    value: "manager_goodwill",
    labelKey: "posCorrection.reason.discount.manager_goodwill",
  },
  {
    value: "member_benefit",
    labelKey: "posCorrection.reason.discount.member_benefit",
  },
  { value: "staff_meal", labelKey: "posCorrection.reason.discount.staff_meal" },
  { value: "event", labelKey: "posCorrection.reason.discount.event" },
  {
    value: "price_correction",
    labelKey: "posCorrection.reason.discount.price_correction",
  },
  { value: "other", labelKey: "posCorrection.reason.discount.other" },
];

export const VOID_REASON_OPTIONS: readonly Option<VoidReason>[] = [
  {
    value: "customer_cancelled",
    labelKey: "posCorrection.reason.void.customer_cancelled",
  },
  { value: "wrong_order", labelKey: "posCorrection.reason.void.wrong_order" },
  { value: "sold_out", labelKey: "posCorrection.reason.void.sold_out" },
  {
    value: "duplicate_order",
    labelKey: "posCorrection.reason.void.duplicate_order",
  },
  { value: "price_error", labelKey: "posCorrection.reason.void.price_error" },
  { value: "system_error", labelKey: "posCorrection.reason.void.system_error" },
  { value: "other", labelKey: "posCorrection.reason.void.other" },
];

export const REFUND_REASON_OPTIONS: readonly Option<RefundReason>[] = [
  {
    value: "quality_complaint",
    labelKey: "posCorrection.reason.refund.quality_complaint",
  },
  {
    value: "customer_cancelled",
    labelKey: "posCorrection.reason.refund.customer_cancelled",
  },
  { value: "wrong_order", labelKey: "posCorrection.reason.refund.wrong_order" },
  {
    value: "overpayment",
    labelKey: "posCorrection.reason.refund.overpayment",
  },
  {
    value: "duplicate_payment",
    labelKey: "posCorrection.reason.refund.duplicate_payment",
  },
  {
    value: "event_cancelled",
    labelKey: "posCorrection.reason.refund.event_cancelled",
  },
  {
    value: "manager_goodwill",
    labelKey: "posCorrection.reason.refund.manager_goodwill",
  },
  { value: "other", labelKey: "posCorrection.reason.refund.other" },
];

/** Method code on a tender to its catalog label. */
export const METHOD_LABEL_KEYS: Record<string, MessageKey> = {
  cash: "posCorrection.method.cash",
  qris: "posCorrection.method.qris",
  va: "posCorrection.method.va",
  ewallet: "posCorrection.method.ewallet",
  card: "posCorrection.method.card",
  edc_card: "posCorrection.method.edc_card",
  edc_qris: "posCorrection.method.edc_qris",
  points: "posCorrection.method.points",
};
