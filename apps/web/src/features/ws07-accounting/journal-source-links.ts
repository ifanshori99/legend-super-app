// Journal source type → web route (bead legend-a5wl, ACC-03 drill-down from
// legend-mzg). Only source types whose screen exists in this app are mapped
// (checked against routeTree.gen.ts in tests/ws07-accounting.test.mjs); the
// rest return null and the journal detail keeps the reference id with "opens
// in its own module".
//
// Each entry also carries the guard of its destination (surface + anyOf, the
// same values the route's beforeLoad passes to evaluateGuard). The registry is
// pure, so it cannot call the guard; the screen passes the gate in
// (useSourceGate in ./guard.ts → evaluateGuard) and a link shows only when the
// visitor would pass the destination's guard. If a route's guard changes,
// change its entry here (the permissions are copied from the route's guard, not
// imported, so this file stays loadable by the Node test runner).
//
// A source id is placed in the path only where it is the id of that screen's
// document. Where the screen is a list (the id may name a different document
// than the list shows, e.g. a payroll journal can carry a loan or
// reimbursement id), the link opens the list and the reference stays visible.
//
// No React and no router import, so tests/ws07-accounting.test.mjs loads this
// file with Node type stripping.

import type { JournalSourceType } from "@starter/shared/accounting";

/** Same shape evaluateGuard takes (lib/areas/guard.ts), minus `kind`. */
export type JournalSourceGuard = {
  surface: "dashboard" | "pos";
  anyOf: readonly string[];
};

export type JournalSourceRoute = {
  /** Route path as in routeTree.gen.ts FileRoutesByTo. */
  to: string;
  /** Path param filled with the source document id; absent for list screens. */
  param?: string;
  guard: JournalSourceGuard;
};

const ACCOUNTING_VIEW: JournalSourceGuard = {
  surface: "dashboard",
  anyOf: ["accounting.journal.view"],
};
const RECEIVING_OR_MATCH: JournalSourceGuard = {
  surface: "dashboard",
  anyOf: ["inventory.stock.receive", "purchasing.invoice.match"],
};
const STOCK_VIEW: JournalSourceGuard = {
  surface: "dashboard",
  anyOf: ["inventory.stock.view"],
};

export const JOURNAL_SOURCE_ROUTES: Partial<
  Record<JournalSourceType, JournalSourceRoute>
> = {
  // Journals
  manual: {
    to: "/kelola/akuntansi/jurnal-manual/$manualJournalId",
    param: "manualJournalId",
    guard: ACCOUNTING_VIEW,
  },
  reversal: {
    to: "/kelola/akuntansi/jurnal/$journalEntryId",
    param: "journalEntryId",
    guard: ACCOUNTING_VIEW,
  },
  recurring: {
    to: "/kelola/akuntansi/jurnal-berulang",
    guard: ACCOUNTING_VIEW,
  },
  // POS: a sale journal's source id is the order id.
  sale: {
    to: "/pos/pesanan/$orderId",
    param: "orderId",
    guard: {
      surface: "pos",
      anyOf: ["pos.sale.create", "pos.payment.accept", "pos.void.request"],
    },
  },
  // Cash, bank and settlement (the gateway settlement card lives on the
  // reconciliation screen).
  cash_deposit: { to: "/kelola/akuntansi/kas-bank", guard: ACCOUNTING_VIEW },
  gateway_settlement: {
    to: "/kelola/akuntansi/rekonsiliasi",
    guard: ACCOUNTING_VIEW,
  },
  // Purchasing and payables
  purchase: { to: "/kelola/pengadaan/penerimaan", guard: RECEIVING_OR_MATCH },
  supplier_invoice: {
    to: "/kelola/pengadaan/faktur",
    guard: { surface: "dashboard", anyOf: ["purchasing.invoice.match"] },
  },
  supplier_payment: {
    to: "/kelola/akuntansi/piutang-utang",
    guard: ACCOUNTING_VIEW,
  },
  purchase_return: { to: "/kelola/pengadaan/retur", guard: RECEIVING_OR_MATCH },
  petty_purchase: {
    to: "/kelola/pengadaan/kecil",
    guard: {
      surface: "dashboard",
      anyOf: [
        "accounting.expense.request",
        "accounting.supplier_payment.process",
      ],
    },
  },
  // Inventory
  stock_adjustment: { to: "/kelola/inventori/opname", guard: STOCK_VIEW },
  production: { to: "/kelola/inventori/produksi", guard: STOCK_VIEW },
  // HRIS (payrollRunGuard: PAYROLL_RUN_READ_PERMISSIONS)
  payroll: {
    to: "/kelola/payroll/run",
    guard: {
      surface: "dashboard",
      anyOf: ["payroll.run", "payroll.approve", "payroll.lock"],
    },
  },
  // Fixed assets and equity
  depreciation: { to: "/kelola/akuntansi/aset-tetap", guard: ACCOUNTING_VIEW },
  asset_acquisition: {
    to: "/kelola/akuntansi/aset-tetap",
    guard: ACCOUNTING_VIEW,
  },
  asset_disposal: {
    to: "/kelola/akuntansi/aset-tetap",
    guard: ACCOUNTING_VIEW,
  },
  asset_revaluation: {
    to: "/kelola/akuntansi/aset-tetap",
    guard: ACCOUNTING_VIEW,
  },
  dividend: {
    to: "/kelola/akuntansi/bagi-hasil/distribusi",
    guard: ACCOUNTING_VIEW,
  },
};

/** Destination guard of a source type, or null when it has no screen. */
export function journalSourceGuard(
  sourceType: JournalSourceType,
): JournalSourceGuard | null {
  return JOURNAL_SOURCE_ROUTES[sourceType]?.guard ?? null;
}

/**
 * Concrete path of a journal's source screen, or null when no screen exists
 * (refund, cogs, loyalty, customer_deposit, cashier_shift, edc_settlement,
 * opening_balance) or the document id is missing for a document route. The id
 * is percent-encoded.
 */
export function journalSourceHref(
  sourceType: JournalSourceType,
  sourceId: string | null,
): string | null {
  const route = JOURNAL_SOURCE_ROUTES[sourceType];
  if (!route) return null;
  if (route.param === undefined) return route.to;
  if (sourceId === null) return null;
  return route.to.replace(`$${route.param}`, encodeURIComponent(sourceId));
}
