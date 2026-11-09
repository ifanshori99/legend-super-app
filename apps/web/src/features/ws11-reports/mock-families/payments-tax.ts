// Payments and tax families of the report viewer mock: tax, fees and
// settlement, all shares of net sales.
import type { Atoms } from "../mock-day-model.ts";
import { count, idr, type Cell, type DerivedSpec } from "./cells.ts";

export const derived = {
  tax: { from: "net", ratio: 0.1 },
  service: { from: "net", ratio: 0.05 },
  fee: { from: "net", ratio: 0.007 },
  edc: { from: "net", ratio: 0.15 },
  gateway: { from: "net", ratio: 0.55 },
  cashVariance: { from: "net", ratio: 25_000 / 7_420_000 },
  failedPayments: { from: "tx", ratio: 0.03 },
  pendingSettlement: { from: "net", snapshot: 2_915_000 },
} as const satisfies Record<string, DerivedSpec>;

type Figures = Atoms & Record<keyof typeof derived, number>;

export function cellFor(metricCode: string, atoms: Figures): Cell | undefined {
  switch (metricCode) {
    case "tax_collected":
    case "tax_payable":
      return idr(atoms.tax);
    case "service_charge_collected":
      return idr(atoms.service);
    case "payment_fee":
      return idr(atoms.fee);
    case "edc_settlement":
      return idr(atoms.edc);
    case "gateway_settlement":
      return idr(atoms.gateway);
    case "cash_variance":
      return idr(atoms.cashVariance);
    case "failed_payment_count":
      return count(atoms.failedPayments);
    case "pending_settlement":
      return idr(atoms.pendingSettlement);
    default:
      return undefined;
  }
}

/** Report codes served here, by code prefix. */
export const reportsByPrefix = {
  payments: [
    "payments.cash_variance",
    "payments.edc_settlement",
    "payments.failed",
    "payments.fees",
    "payments.gateway_settlement",
    "payments.methods",
  ],
  tax: ["tax.by_rule", "tax.pbjt", "tax.receivable", "tax.service_charge"],
} as const;

/** Metrics the API answers `unavailable` (metric registry): the mock shows no number. */
export const unavailableMetrics: ReadonlySet<string> = new Set([
  "edc_settlement",
  "gateway_settlement",
  "pending_settlement",
]);

/**
 * Splits the API refuses with `dimension_not_supported`: a ledger balance is a
 * tenant figure (tax_payable by outlet), and the channel fee has no channel
 * split (payment_fee by channel, delivery.settlement).
 */
export const unsupportedSplits: Readonly<Record<string, readonly string[]>> = {
  tax_payable: ["outlet"],
  payment_fee: ["channel"],
};
