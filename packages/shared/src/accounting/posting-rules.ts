// Posting rules: which journal each domain event or accounting document
// produces (PRD v1.7 §3.19 "Jurnal Otomatis [P0] — Penjualan, pembayaran per
// metode, biaya gateway, HPP, pembelian, produksi, waste, payroll,
// depresiasi, liabilitas poin loyalty, dan distribusi dividen menghasilkan
// jurnal berpasangan otomatis"; §3.20 Liabilitas Poin; PAYR-04; PAY-05).
//
// A rule is data: lines of (posting role, side, amount key). The posting
// service of the owning workstream reduces its event payload to the named
// amounts (`*Idr`, whole rupiah) and calls `buildJournalLinesFromRule`:
// - roles resolve through the legal entity's account mapping (tenant data);
// - a zero amount drops its line; a negative amount books on the other side
//   (signed differences such as rounding or cash over/short);
// - the amounts given must be exactly the rule's keys (no silent leftovers),
//   and the result must balance; anything else fails closed.
//
// One business fact posts once, receipt-first for gateway money: every gateway
// receipt (`payment.paid`: sale, DP or late payment, overpayment included;
// `payment.funds_unallocated`: money on a closed intent or a second payment on
// a settled one) books Dr gateway_clearing / Cr customer_deposit on the day the
// money arrived, so gateway_clearing equals what the gateway received and
// settlement reconciles.
// `order.paid` then moves the intent-backed gateway part and any DP applied
// out of customer_deposit into the sale. `order.refunded` credits
// customer_deposit for the gateway part (owed to the guest until payout) and
// `payment.refunded` pays it out of gateway_clearing. A forfeited DP moves
// from customer_deposit to deposit_forfeit_income on reservation.cancelled /
// reservation.no_show (from gateway_clearing when its receipt predates the
// cutover). Gateway and EDC fees post on settlement.
// Gateway switching changes only which clearing amount is filled (PAY-05).

import { z } from "zod";
import type { Idr, OutletId } from "../core/index.ts";
import { eventCatalogByName } from "../events/catalog.ts";
import { postingAccountRoleSchema } from "./coa.ts";
import type { PostingAccountRole } from "./coa.ts";
import { AccountingError } from "./errors.ts";
import type { AccountId } from "./ids.ts";
import { assertJournalBalanced, journalSourceTypeSchema } from "./journal.ts";
import type { JournalLineInput } from "./journal.ts";

export const amountKeySchema = z
  .string()
  .regex(/^[a-z][A-Za-z0-9]*Idr$/, "Amount keys are camelCase ending in Idr");

export const postingRuleLineSchema = z.strictObject({
  role: postingAccountRoleSchema,
  side: z.enum(["debit", "credit"]),
  amount: amountKeySchema,
});

export const postingRuleSchema = z
  .strictObject({
    /** `<eventName>` or `<eventName>#<variant>`, or `document:<sourceType>`. */
    key: z.string().min(1).max(80),
    /** Catalogued domain event that triggers the rule; null for WS-07's own documents. */
    eventName: z.string().nullable(),
    variant: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .nullable(),
    sourceType: journalSourceTypeSchema,
    description: z.string().min(1).max(255),
    /** PRD clause the rule implements. */
    citation: z.string().min(1),
    lines: z.array(postingRuleLineSchema).min(2),
  })
  .superRefine((rule, ctx) => {
    const expectedKey =
      rule.eventName === null
        ? `document:${rule.sourceType}`
        : rule.variant === null
          ? rule.eventName
          : `${rule.eventName}#${rule.variant}`;
    if (rule.key !== expectedKey)
      ctx.addIssue({
        code: "custom",
        path: ["key"],
        message: `key must be ${expectedKey}`,
      });
    if (rule.eventName !== null && !eventCatalogByName.has(rule.eventName))
      ctx.addIssue({
        code: "custom",
        path: ["eventName"],
        message: `Event ${rule.eventName} is not in the event catalog`,
      });
    if (rule.eventName === null && rule.variant !== null)
      ctx.addIssue({
        code: "custom",
        path: ["variant"],
        message: "Document rules have no variant",
      });
    const sides = new Set(rule.lines.map((line) => line.side));
    if (sides.size !== 2)
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message: "A rule needs debit and credit lines",
      });
  });
export type PostingRule = z.infer<typeof postingRuleSchema>;

type L = [PostingAccountRole, "debit" | "credit", string];
const rule = (
  trigger:
    | { event: string; variant?: string }
    | { document: z.infer<typeof journalSourceTypeSchema> },
  sourceType: z.infer<typeof journalSourceTypeSchema>,
  description: string,
  citation: string,
  lines: L[],
): PostingRule => {
  const eventName = "event" in trigger ? trigger.event : null;
  const variant = "event" in trigger ? (trigger.variant ?? null) : null;
  return postingRuleSchema.parse({
    key:
      eventName === null
        ? `document:${sourceType}`
        : variant === null
          ? eventName
          : `${eventName}#${variant}`,
    eventName,
    variant,
    sourceType,
    description,
    citation,
    lines: lines.map(([role, side, amount]) => ({ role, side, amount })),
  });
};

const AUTO = "§3.19 Jurnal Otomatis";

/** Default rules (system data; tenants change accounts through mappings, not rules). */
export const defaultPostingRules: readonly PostingRule[] = Object.freeze([
  rule(
    { event: "order.paid" },
    "sale",
    "Penjualan lunas per metode bayar",
    `${AUTO} (penjualan, pembayaran per metode); §3.20 Liabilitas Poin; POS-05`,
    [
      ["cash_on_hand", "debit", "paidCashIdr"],
      // Gateway tender backed by a payment intent: its receipt already sits in
      // customer_deposit (payment.paid). Tender without an intent: straight to
      // gateway_clearing. DP applied to the order also leaves customer_deposit
      // (a DP whose receipt predates the cutover counts as paidGatewayIdr).
      ["customer_deposit", "debit", "paidGatewayIntentIdr"],
      ["customer_deposit", "debit", "paidDepositIdr"],
      ["gateway_clearing", "debit", "paidGatewayIdr"],
      ["edc_clearing", "debit", "paidEdcIdr"],
      ["loyalty_liability", "debit", "paidPointsIdr"],
      ["sales_discount", "debit", "discountIdr"],
      ["sales_revenue", "credit", "grossSalesIdr"],
      ["service_charge", "credit", "serviceChargeIdr"],
      ["tax_payable_pbjt", "credit", "pbjtIdr"],
      ["rounding", "credit", "roundingIdr"],
    ],
  ),
  rule(
    { event: "order.refunded" },
    "refund",
    "Refund penjualan per metode bayar",
    `${AUTO}; ORD-09`,
    [
      ["sales_revenue", "debit", "grossSalesIdr"],
      ["service_charge", "debit", "serviceChargeIdr"],
      ["tax_payable_pbjt", "debit", "pbjtIdr"],
      ["sales_discount", "credit", "discountIdr"],
      ["cash_on_hand", "credit", "refundCashIdr"],
      // Owed to the guest until the gateway pays it out (payment.refunded).
      ["customer_deposit", "credit", "refundGatewayIdr"],
      ["edc_clearing", "credit", "refundEdcIdr"],
      // Points returned to the member restore the liability the sale used
      // (mirror of the order.paid loyalty_liability debit, §3.20).
      ["loyalty_liability", "credit", "refundPointsIdr"],
    ],
  ),
  rule(
    { event: "payment.paid" },
    "customer_deposit",
    "Penerimaan dana payment gateway (uang muka pelanggan)",
    `${AUTO} (pembayaran per metode); §3.13 Orkestrasi Pembayaran`,
    [
      ["gateway_clearing", "debit", "receivedIdr"],
      ["customer_deposit", "credit", "receivedIdr"],
    ],
  ),
  rule(
    { event: "payment.funds_unallocated" },
    "customer_deposit",
    "Dana payment gateway belum teralokasi (bayar ganda atau intent tertutup)",
    `${AUTO} (pembayaran per metode); §3.13 Orkestrasi Pembayaran (PAY-04)`,
    [
      ["gateway_clearing", "debit", "receivedIdr"],
      ["customer_deposit", "credit", "receivedIdr"],
    ],
  ),
  rule(
    { event: "payment.refunded" },
    "refund",
    "Refund dibayarkan kembali lewat payment gateway",
    `${AUTO}; ORD-09; §3.13 Orkestrasi Pembayaran`,
    [
      ["customer_deposit", "debit", "amountIdr"],
      ["gateway_clearing", "credit", "amountIdr"],
    ],
  ),
  rule(
    { event: "reservation.cancelled" },
    "customer_deposit",
    "Uang muka reservasi hangus (batal)",
    `${AUTO}; §3.25 Reservasi (uang muka)`,
    [
      // DP whose receipt is booked leaves customer_deposit; a DP paid before
      // the auto-journal cutover (no receipt) leaves gateway_clearing.
      ["customer_deposit", "debit", "forfeitedIdr"],
      ["gateway_clearing", "debit", "forfeitedGatewayIdr"],
      ["deposit_forfeit_income", "credit", "forfeitedIdr"],
      ["deposit_forfeit_income", "credit", "forfeitedGatewayIdr"],
    ],
  ),
  rule(
    { event: "reservation.no_show" },
    "customer_deposit",
    "Uang muka reservasi hangus (tidak datang)",
    `${AUTO}; §3.25 Reservasi (uang muka)`,
    [
      ["customer_deposit", "debit", "forfeitedIdr"],
      ["gateway_clearing", "debit", "forfeitedGatewayIdr"],
      ["deposit_forfeit_income", "credit", "forfeitedIdr"],
      ["deposit_forfeit_income", "credit", "forfeitedGatewayIdr"],
    ],
  ),
  rule(
    { event: "settlement.reconciled" },
    "gateway_settlement",
    "Settlement payment gateway dan biaya MDR",
    `${AUTO} (biaya gateway); §3.19 Rekonsiliasi Gateway`,
    [
      ["bank", "debit", "netSettledIdr"],
      ["gateway_fee_expense", "debit", "feeIdr"],
      ["gateway_clearing", "credit", "grossIdr"],
    ],
  ),
  rule(
    { event: "edc_transaction.settled" },
    "edc_settlement",
    "Settlement EDC bank dan biaya MDR",
    `${AUTO} (biaya gateway); §3.13 Orkestrasi Pembayaran (EDC)`,
    [
      ["bank", "debit", "netSettledIdr"],
      ["gateway_fee_expense", "debit", "feeIdr"],
      ["edc_clearing", "credit", "grossIdr"],
    ],
  ),
  rule(
    { event: "stock.deducted" },
    "cogs",
    "HPP dari pemotongan stok",
    `${AUTO} (HPP)`,
    [
      ["cogs", "debit", "costIdr"],
      ["inventory", "credit", "costIdr"],
    ],
  ),
  rule(
    { event: "stock.adjusted", variant: "waste" },
    "stock_adjustment",
    "Waste dan spoilage",
    `${AUTO} (waste); INV-01`,
    [
      ["waste_expense", "debit", "costIdr"],
      ["inventory", "credit", "costIdr"],
    ],
  ),
  rule(
    { event: "stock.adjusted", variant: "count" },
    "stock_adjustment",
    "Selisih stok opname (positif = lebih)",
    "§3.16 Stok Opname; INV-03",
    [
      ["inventory", "debit", "differenceIdr"],
      ["inventory_adjustment", "credit", "differenceIdr"],
    ],
  ),
  rule(
    { event: "goods_receipt.recorded" },
    "purchase",
    "Penerimaan barang",
    `${AUTO} (pembelian); INV-05`,
    [
      ["inventory", "debit", "receivedValueIdr"],
      ["grni", "credit", "receivedValueIdr"],
    ],
  ),
  rule(
    { event: "supplier_invoice.recorded" },
    "supplier_invoice",
    "Tagihan supplier",
    `${AUTO} (pembelian); §3.19 Pajak (PPh 23, PPN masukan)`,
    [
      ["grni", "debit", "goodsIdr"],
      ["inventory", "debit", "priceVarianceIdr"],
      ["service_expense", "debit", "servicesIdr"],
      ["ppn_input", "debit", "ppnIdr"],
      ["pph23_payable", "credit", "pph23Idr"],
      ["accounts_payable", "credit", "payableIdr"],
    ],
  ),
  rule(
    { event: "production.completed" },
    "production",
    "Produksi barang setengah jadi",
    `${AUTO} (produksi)`,
    [
      ["inventory_semi_finished", "debit", "outputValueIdr"],
      ["inventory", "credit", "inputValueIdr"],
    ],
  ),
  rule(
    { event: "payroll_run.completed" },
    "payroll",
    "Payroll dikunci",
    `${AUTO} (payroll); §3 Jurnal Payroll; PAYR-04`,
    [
      ["salary_expense", "debit", "grossPayIdr"],
      ["bpjs_expense", "debit", "employerBpjsIdr"],
      ["salaries_payable", "credit", "netPayIdr"],
      ["bpjs_payable", "credit", "totalBpjsIdr"],
      ["pph21_payable", "credit", "pph21Idr"],
    ],
  ),
  rule(
    { event: "points.earned" },
    "loyalty",
    "Poin loyalty diperoleh (pendapatan ditangguhkan)",
    "§3.20 Liabilitas Poin",
    [
      ["sales_revenue", "debit", "pointsValueIdr"],
      ["loyalty_liability", "credit", "pointsValueIdr"],
    ],
  ),
  rule(
    { event: "points.expired" },
    "loyalty",
    "Poin loyalty kedaluwarsa diakui sebagai pendapatan",
    "§3.20 Liabilitas Poin",
    [
      ["loyalty_liability", "debit", "pointsValueIdr"],
      ["loyalty_breakage_revenue", "credit", "pointsValueIdr"],
    ],
  ),
  rule(
    { event: "distribution.completed" },
    "dividend",
    "Pembayaran distribusi bagi hasil",
    `${AUTO} (distribusi dividen); §3.37 Siklus Distribusi`,
    [
      // Gross comes out of retained earnings; only the net leaves the bank and
      // the withheld tax is owed to the tax office until it is remitted.
      ["retained_earnings", "debit", "distributedIdr"],
      ["bank", "credit", "paidNetIdr"],
      ["dividend_tax_payable", "credit", "taxWithheldIdr"],
    ],
  ),
  rule(
    { event: "cashier_shift.closed" },
    "cashier_shift",
    "Selisih kas tutup shift (positif = lebih)",
    "§3.11 POS Kasir (tutup shift); §4 E; U9",
    [
      ["cash_on_hand", "debit", "differenceIdr"],
      ["cash_over_short", "credit", "differenceIdr"],
    ],
  ),
  rule(
    { document: "depreciation" },
    "depreciation",
    "Penyusutan aset tetap bulanan",
    `${AUTO} (depresiasi); §3.19 Aset Tetap`,
    [
      ["depreciation_expense", "debit", "amountIdr"],
      ["accumulated_depreciation", "credit", "amountIdr"],
    ],
  ),
  rule(
    { document: "cash_deposit" },
    "cash_deposit",
    "Setoran kas outlet ke bank",
    "§3.19 Kas & Bank; ACC-05",
    [
      ["bank", "debit", "amountIdr"],
      ["cash_on_hand", "credit", "amountIdr"],
    ],
  ),
  rule(
    { document: "supplier_payment" },
    "supplier_payment",
    "Pembayaran supplier disetujui",
    "§3.18 Purchasing; §4 I; §3.19 Utang & Piutang",
    [
      ["accounts_payable", "debit", "amountIdr"],
      ["bank", "credit", "amountIdr"],
    ],
  ),
  rule(
    { document: "asset_acquisition" },
    "asset_acquisition",
    "Registrasi aset dari pembelian",
    "§3.19 Aset Tetap",
    [
      ["fixed_assets", "debit", "costIdr"],
      ["accounts_payable", "credit", "costIdr"],
    ],
  ),
  rule(
    { document: "asset_disposal" },
    "asset_disposal",
    "Penjualan aset (laba positif / rugi negatif)",
    "§3.19 Aset Tetap",
    [
      ["bank", "debit", "proceedsIdr"],
      ["accumulated_depreciation", "debit", "accumulatedIdr"],
      ["fixed_assets", "credit", "costIdr"],
      ["asset_disposal_result", "credit", "resultIdr"],
    ],
  ),
  rule(
    { document: "asset_revaluation" },
    "asset_revaluation",
    "Revaluasi aset tetap (surplus ke ekuitas, penurunan ke laba rugi)",
    "§3.19 Aset Tetap",
    [
      ["accumulated_depreciation", "debit", "accumulatedIdr"],
      ["fixed_assets", "debit", "costChangeIdr"],
      ["asset_revaluation_loss", "debit", "lossIdr"],
      ["revaluation_surplus", "credit", "surplusIdr"],
    ],
  ),
]);

/** The rule for an event (optionally a variant) or a document; fails closed. */
export function resolvePostingRule(
  rules: readonly PostingRule[],
  trigger: { eventName: string; variant?: string } | { sourceType: string },
): PostingRule {
  const key =
    "sourceType" in trigger
      ? `document:${trigger.sourceType}`
      : trigger.variant
        ? `${trigger.eventName}#${trigger.variant}`
        : trigger.eventName;
  const found = rules.find((candidate) => candidate.key === key);
  if (!found)
    throw new AccountingError(
      "POSTING_RULE_MISSING",
      `No posting rule for ${key}`,
    );
  return found;
}

/** The amount keys a rule expects (the source must send exactly these). */
export function postingRuleAmountKeys(rule: PostingRule): string[] {
  return [...new Set(rule.lines.map((line) => line.amount))].sort();
}

/**
 * Builds balanced journal lines from a rule (§3.19 Jurnal Otomatis). Throws
 * POSTING_AMOUNTS_MISMATCH, ACCOUNT_MAPPING_MISSING, JOURNAL_UNBALANCED.
 */
export function buildJournalLinesFromRule(
  rule: PostingRule,
  amounts: Readonly<Record<string, number>>,
  accountMap: ReadonlyMap<PostingAccountRole, AccountId>,
  options: { outletId: OutletId | null; costCenter?: string | null },
): JournalLineInput[] {
  const expected = postingRuleAmountKeys(rule);
  const given = Object.keys(amounts).sort();
  if (expected.join(",") !== given.join(","))
    throw new AccountingError(
      "POSTING_AMOUNTS_MISMATCH",
      `Rule ${rule.key} expects ${expected.join(", ")}`,
    );
  const lines: JournalLineInput[] = [];
  for (const line of rule.lines) {
    const amount = amounts[line.amount];
    if (!Number.isSafeInteger(amount))
      throw new AccountingError(
        "POSTING_AMOUNTS_MISMATCH",
        `${line.amount} must be whole rupiah`,
      );
    if (amount === 0) continue;
    const accountId = accountMap.get(line.role);
    if (!accountId)
      throw new AccountingError(
        "ACCOUNT_MAPPING_MISSING",
        `No account mapped for ${line.role}`,
      );
    const side =
      amount > 0 ? line.side : line.side === "debit" ? "credit" : "debit";
    const absolute = Math.abs(amount) as Idr;
    lines.push({
      accountId,
      debitIdr: (side === "debit" ? absolute : 0) as Idr,
      creditIdr: (side === "credit" ? absolute : 0) as Idr,
      outletId: options.outletId,
      costCenter: options.costCenter ?? null,
    });
  }
  assertJournalBalanced(lines);
  return lines;
}
