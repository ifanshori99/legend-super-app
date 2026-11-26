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
// `payment.refunded` pays it out of gateway_clearing; a refund the provider
// made on its own (`payment.provider_refunded`) books the same way, so
// gateway_clearing ends at what the gateway kept. A forfeited DP moves
// from customer_deposit to deposit_forfeit_income on reservation.cancelled /
// reservation.no_show (from gateway_clearing when its receipt predates the
// cutover). Gateway and EDC fees post on settlement.
// Gateway switching changes only which clearing amount is filled (PAY-05).

import { z } from "zod";
import type { Idr, OutletId } from "../core/index.ts";
import { eventCatalogByName } from "../events/catalog.ts";
import { postingAccountRoleSchema } from "./coa.ts";
import type { AccountType, PostingAccountRole } from "./coa.ts";
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

/** Amount keys come from `payrollJournalAmounts` (payroll-journal.ts). */
const PAYROLL_JOURNAL_LINES: L[] = [
  ["salary_expense", "debit", "salaryExpenseIdr"],
  ["pph21_borne_expense", "debit", "pph21EmployerBorneIdr"],
  ["service_charge", "debit", "serviceChargeIdr"],
  ["reimbursement_expense", "debit", "reimbursementIdr"],
  ["bpjs_expense", "debit", "bpjsCompanyIdr"],
  // Founder B8: an employee's PPh 21 shortfall is a receivable, not a
  // company cost. New receivable debits; collection from this run's pay
  // credits (it reduces salaries_payable's net, see netIdr).
  ["employee_receivable", "debit", "pph21ReceivableIdr"],
  ["salaries_payable", "credit", "netIdr"],
  ["bpjs_payable", "credit", "bpjsTotalIdr"],
  ["pph21_payable", "credit", "pph21Idr"],
  ["employee_receivable", "credit", "pph21ReceivableCollectedIdr"],
  ["employee_receivable", "credit", "loanRepaymentIdr"],
  // Other deductions that are not custom (today: late) credit salary_expense;
  // custom ones (koperasi dues etc.) have their own role so a tenant can map
  // them to a liability (legend-75kr).
  ["salary_expense", "credit", "lateDeductionsIdr"],
  ["payroll_custom_deduction", "credit", "customDeductionsIdr"],
  // Employer lebih potong (legend-w6vah): the part that returns an earlier
  // gross-up allowance credits salary_expense (6101, where the allowance was
  // booked); the part that returns borne tax credits pph21_borne_expense.
  ["salary_expense", "credit", "pph21EmployerAllowanceRefundIdr"],
  ["pph21_borne_expense", "credit", "pph21EmployerBorneRefundIdr"],
];

/**
 * `payroll.locked#service_charge_expense`: the service charge payout debits
 * salary_expense instead of the service_charge account. Same amount keys as
 * the base rule, so the reversal cross-check still matches.
 */
const PAYROLL_JOURNAL_LINES_SC_EXPENSE: L[] = PAYROLL_JOURNAL_LINES.map(
  (line): L =>
    line[0] === "service_charge" && line[1] === "debit"
      ? ["salary_expense", "debit", line[2]]
      : line,
);

/**
 * Variant of `payroll.locked` for the entity's service_charge mapping: the
 * payout of service charge must never debit revenue. A revenue mapping (PRD
 * F11: service charge kept as income) posts the payout on salary_expense: it is
 * an employee cost. Every other type keeps the base rule, debiting the mapped
 * account: a liability clears, and a legacy expense/asset/equity mapping saved
 * before the type guard is debited where the POS credited it, so it clears
 * too. No mapping (null): base rule (posting fails ACCOUNT_MAPPING_MISSING
 * when the service charge is above zero).
 */
export function payrollLockedVariant(
  serviceChargeAccountType: AccountType | null,
): "service_charge_expense" | undefined {
  return serviceChargeAccountType === "revenue"
    ? "service_charge_expense"
    : undefined;
}

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
      // 1269 E6 (D1): a back-office refund of an edge sale pays its cash part
      // outside the drawer, by bank transfer or from petty cash.
      ["bank", "credit", "refundBankIdr"],
      ["petty_cash", "credit", "refundPettyCashIdr"],
      // Owed to the guest until the gateway pays it out (payment.refunded).
      ["customer_deposit", "credit", "refundGatewayIdr"],
      // legend-2jyr: the gateway part no payment refund pays out later (no
      // intent, receipt never booked) reverses the sale's clearing debit.
      ["gateway_clearing", "credit", "refundGatewayClearingIdr"],
      ["edc_clearing", "credit", "refundEdcIdr"],
      // Points returned to the member restore the liability the sale used
      // (mirror of the order.paid loyalty_liability debit, §3.20).
      ["loyalty_liability", "credit", "refundPointsIdr"],
    ],
  ),
  // legend-xa9bc: a sale with PPN / other tax books each tax type to its own
  // payable account. Same lines as the base rules but the tax line is split;
  // the base rules stay for PBJT-only and pre-cutover sales (all tax in PBJT).
  rule(
    { event: "order.paid", variant: "tax_split" },
    "sale",
    "Penjualan lunas per metode bayar (pajak per jenis)",
    `${AUTO} (penjualan, pembayaran per metode); §3.20 Liabilitas Poin; POS-05`,
    [
      ["cash_on_hand", "debit", "paidCashIdr"],
      ["customer_deposit", "debit", "paidGatewayIntentIdr"],
      ["customer_deposit", "debit", "paidDepositIdr"],
      ["gateway_clearing", "debit", "paidGatewayIdr"],
      ["edc_clearing", "debit", "paidEdcIdr"],
      ["loyalty_liability", "debit", "paidPointsIdr"],
      ["sales_discount", "debit", "discountIdr"],
      ["sales_revenue", "credit", "grossSalesIdr"],
      ["service_charge", "credit", "serviceChargeIdr"],
      ["tax_payable_pbjt", "credit", "pbjtIdr"],
      ["tax_payable_ppn", "credit", "ppnIdr"],
      ["tax_payable_other", "credit", "otherTaxIdr"],
      ["rounding", "credit", "roundingIdr"],
    ],
  ),
  rule(
    { event: "order.refunded", variant: "tax_split" },
    "refund",
    "Refund penjualan per metode bayar (pajak per jenis)",
    `${AUTO}; ORD-09`,
    [
      ["sales_revenue", "debit", "grossSalesIdr"],
      ["service_charge", "debit", "serviceChargeIdr"],
      ["tax_payable_pbjt", "debit", "pbjtIdr"],
      ["tax_payable_ppn", "debit", "ppnIdr"],
      ["tax_payable_other", "debit", "otherTaxIdr"],
      ["sales_discount", "credit", "discountIdr"],
      ["cash_on_hand", "credit", "refundCashIdr"],
      ["bank", "credit", "refundBankIdr"],
      ["petty_cash", "credit", "refundPettyCashIdr"],
      ["customer_deposit", "credit", "refundGatewayIdr"],
      ["gateway_clearing", "credit", "refundGatewayClearingIdr"],
      ["edc_clearing", "credit", "refundEdcIdr"],
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
    { event: "payment.provider_refunded" },
    "refund",
    "Refund yang dikembalikan payment gateway sendiri (parsial, di luar modul refund)",
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
    { event: "stock.deducted", variant: "negative_revaluation" },
    "cogs",
    "Revaluasi HPP: penerimaan ke stok negatif",
    `${AUTO} (HPP); INV-01 kartu stok = GL persediaan`,
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
      ["purchase_price_variance", "debit", "priceVarianceIdr"],
      ["service_expense", "debit", "servicesIdr"],
      ["ppn_input", "debit", "ppnIdr"],
      ["pph23_payable", "credit", "pph23Idr"],
      ["accounts_payable", "credit", "payableIdr"],
    ],
  ),
  // debitNoteIdr = invoicedValueIdr + returnPriceVarianceIdr + ppnIdr (the
  // billed value plus PPN), reduced by the fact builder. returnPriceVarianceIdr
  // is signed (billed minus order price): a negative amount books on the debit
  // side of 5105. returnMovingAvgVarianceIdr is signed the same way: Dr
  // inventory / Cr 5106 inventory_price_variance moves the inventory credit
  // from the order-price valueIdr to the moving-average value (legend-uloj6).
  // valueIdr = uninvoicedValueIdr + invoicedValueIdr (event refine), so the
  // journal balances; a zero amount drops its line.
  rule(
    { event: "purchase_return.recorded" },
    "purchase_return",
    "Retur pembelian",
    `${AUTO} (pembelian); INV-05; §3.18 Retur Pembelian`,
    [
      ["grni", "debit", "uninvoicedValueIdr"],
      ["accounts_payable", "debit", "debitNoteIdr"],
      ["inventory", "credit", "valueIdr"],
      ["purchase_price_variance", "credit", "returnPriceVarianceIdr"],
      ["inventory", "debit", "returnMovingAvgVarianceIdr"],
      ["inventory_price_variance", "credit", "returnMovingAvgVarianceIdr"],
      ["ppn_input", "credit", "ppnIdr"],
    ],
  ),
  rule(
    { event: "petty_purchase.recorded" },
    "petty_purchase",
    "Pembelian sederhana dari kas kecil",
    `${AUTO} (pembelian); §3.18 Pembelian Sederhana`,
    [
      ["petty_purchase_expense", "debit", "amountIdr"],
      ["petty_cash", "credit", "amountIdr"],
    ],
  ),
  // Card 1252 r2: production keeps every item on inventory (1301), so the
  // batch books only the rounding difference between the output card value
  // and the material cost. roundingVarianceIdr is signed: a negative amount
  // flips the sides. Semi-finished goods on 1302 are a later bead.
  rule(
    { event: "production.completed" },
    "production",
    "Selisih pembulatan biaya produksi",
    `${AUTO} (produksi); INV-01 kartu stok = GL persediaan`,
    [
      ["inventory", "debit", "roundingVarianceIdr"],
      ["inventory_price_variance", "credit", "roundingVarianceIdr"],
    ],
  ),
  rule(
    { event: "payroll.locked" },
    "payroll",
    "Payroll dikunci",
    `${AUTO} (payroll); §3 Jurnal Payroll; PAYR-04`,
    PAYROLL_JOURNAL_LINES,
  ),
  rule(
    { event: "payroll.locked", variant: "service_charge_expense" },
    "payroll",
    "Payroll dikunci (service charge dibayarkan sebagai beban gaji)",
    `${AUTO} (payroll); §3 Jurnal Payroll; PAYR-04; PRD F11 service charge`,
    PAYROLL_JOURNAL_LINES_SC_EXPENSE,
  ),
  rule(
    { event: "payroll.reversed" },
    "payroll",
    "Payroll dibatalkan (jurnal balik)",
    `${AUTO} (payroll); §3 Jurnal Payroll; PAYR-05`,
    // Same amounts as the locked totals in the payload, sides swapped. Not
    // posted by the payroll GL consumer: it reverses the locked entry itself
    // (legend-4n3r), so the reversal mirrors what was really posted, after
    // checking the payload amounts against that entry line by line.
    PAYROLL_JOURNAL_LINES.map(([role, side, amount]): L => [
      role,
      side === "debit" ? "credit" : "debit",
      amount,
    ]),
  ),
  rule(
    { event: "payroll.paid" },
    "payroll",
    "Gaji dibayar",
    `${AUTO} (payroll); §3 Jurnal Payroll; PAYR-04`,
    [
      ["salaries_payable", "debit", "netIdr"],
      ["bank", "credit", "bankTransferIdr"],
      ["petty_cash", "credit", "cashIdr"],
    ],
  ),
  // Per-item payout (bead legend-658, design payroll-disbursement.md 6 R9, R10,
  // 8): each group of confirmed items settles the payable once. The source
  // account of a manual bank file is the config's bank account, passed as an
  // account override of the `bank` role; cash credits petty cash.
  rule(
    { event: "payroll.paid", variant: "payout_bank" },
    "payroll",
    "Gaji dibayar per item (transfer bank manual)",
    `${AUTO} (payroll); PAYR-04; payout per item`,
    [
      ["salaries_payable", "debit", "netIdr"],
      ["bank", "credit", "netIdr"],
    ],
  ),
  rule(
    { event: "payroll.paid", variant: "payout_cash" },
    "payroll",
    "Gaji dibayar per item (tunai)",
    `${AUTO} (payroll); PAYR-04; payout per item`,
    [
      ["salaries_payable", "debit", "netIdr"],
      ["petty_cash", "credit", "netIdr"],
    ],
  ),
  // Q15: the bank fee is borne by the company. It is an expense of its own, it
  // never reduces the salary payable or the net pay of anyone (R9).
  rule(
    { event: "payroll.paid", variant: "payout_fee" },
    "payroll",
    "Biaya transfer bank gaji ditanggung perusahaan",
    `${AUTO} (payroll); PAYR-04; Q15 biaya transfer ditanggung PT`,
    [
      ["bank_charges", "debit", "feeIdr"],
      ["bank", "credit", "feeIdr"],
    ],
  ),
  // Funds came back after a succeeded transfer: the payable reopens.
  rule(
    { event: "payroll.paid", variant: "payout_return" },
    "payroll",
    "Dana gaji kembali dari bank (pembayaran dibalik)",
    `${AUTO} (payroll); PAYR-04; payout per item`,
    [
      ["bank", "debit", "netIdr"],
      ["salaries_payable", "credit", "netIdr"],
    ],
  ),
  // A failed attempt turned out paid while the payslip was paid by another
  // attempt (design 7.9): the employee owes the company the second transfer.
  rule(
    { event: "payroll.paid", variant: "payout_overpaid" },
    "payroll",
    "Pembayaran gaji ganda (piutang karyawan)",
    `${AUTO} (payroll); PAYR-04; payout per item; pembayaran ganda`,
    [
      ["employee_receivable", "debit", "netIdr"],
      ["bank", "credit", "netIdr"],
    ],
  ),
  // No variant: events emitted before legend-1coh (no disbursedVia), petty cash.
  rule(
    { event: "employee_loan.disbursed" },
    "payroll",
    "Kasbon karyawan dicairkan (piutang karyawan)",
    `${AUTO} (payroll); §3 Jurnal Payroll`,
    [
      ["employee_receivable", "debit", "principalIdr"],
      // petty_cash (1102 Kas Kecil), not cash_on_hand: 1101 is the POS drawer
      // reconciled by shift close, so crediting it here would double count.
      ["petty_cash", "credit", "principalIdr"],
    ],
  ),
  rule(
    { event: "employee_loan.disbursed", variant: "cash" },
    "payroll",
    "Kasbon karyawan dicairkan tunai (piutang karyawan)",
    `${AUTO} (payroll); §3 Jurnal Payroll`,
    [
      ["employee_receivable", "debit", "principalIdr"],
      // petty_cash, not cash_on_hand: see the base rule above.
      ["petty_cash", "credit", "principalIdr"],
    ],
  ),
  rule(
    { event: "employee_loan.disbursed", variant: "bank" },
    "payroll",
    "Kasbon karyawan dicairkan via bank (piutang karyawan)",
    `${AUTO} (payroll); §3 Jurnal Payroll`,
    [
      ["employee_receivable", "debit", "principalIdr"],
      ["bank", "credit", "principalIdr"],
    ],
  ),
  // Payout `payroll` posts nothing here: the run's journal carries it
  // (reimbursement_expense on payroll.locked). Only a cash payout posts.
  rule(
    { event: "reimbursement.paid", variant: "cash" },
    "payroll",
    "Reimbursement dibayar tunai",
    `${AUTO} (payroll); §3 reimbursement via payroll atau kas`,
    [
      ["reimbursement_expense", "debit", "amountIdr"],
      // petty_cash (1102 Kas Kecil), not cash_on_hand: 1101 is the POS drawer
      // reconciled by shift close, so crediting it here would double count.
      ["petty_cash", "credit", "amountIdr"],
    ],
  ),
  // legend-msqvi (D-msqvi, PSAK 72): points are a material right. Earning
  // defers revenue into loyalty_points_deferral (contra revenue, never
  // sales_revenue: 4101 keeps matching gross POS sales); a reversal, a
  // redemption and a negative manual adjustment move it back. The consumer
  // fills pointsValueIdr from the point_ledger row's signed liability_idr so
  // every journal moves loyalty_liability exactly as the ledger did.
  rule(
    { event: "points.earned" },
    "loyalty",
    "Poin loyalty diperoleh (pendapatan ditangguhkan)",
    "§3.20 Liabilitas Poin; PSAK 72 (hak material)",
    [
      ["loyalty_points_deferral", "debit", "pointsValueIdr"],
      ["loyalty_liability", "credit", "pointsValueIdr"],
    ],
  ),
  rule(
    { event: "points.reversed" },
    "loyalty",
    "Poin loyalty dibatalkan (refund atau void)",
    "§3.20 Liabilitas Poin; PSAK 72 (hak material)",
    [
      ["loyalty_liability", "debit", "pointsValueIdr"],
      ["loyalty_points_deferral", "credit", "pointsValueIdr"],
    ],
  ),
  // Only reward redemptions: points used as tender move loyalty_liability on
  // order.paid (paidPointsIdr), so the consumer ignores any other redeem row.
  rule(
    { event: "points.redeemed" },
    "loyalty",
    "Poin loyalty ditukar reward (pendapatan diakui)",
    "§3.20 Liabilitas Poin; PSAK 72 (hak material)",
    [
      ["loyalty_liability", "debit", "pointsValueIdr"],
      ["loyalty_points_deferral", "credit", "pointsValueIdr"],
    ],
  ),
  // One rule for restore and manual adjustments: pointsValueIdr is signed, a
  // negative amount books on the other side (buildJournalLinesFromRule).
  rule(
    { event: "points.adjusted" },
    "loyalty",
    "Penyesuaian poin loyalty (positif = tambah liabilitas)",
    "§3.20 Liabilitas Poin; PSAK 72 (hak material)",
    [
      ["loyalty_points_deferral", "debit", "pointsValueIdr"],
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
  // legend-89pn: drawer cash that does not pass through a sale. A drop (drawer
  // to safe) is still the outlet's cash and has no rule; a cash movement held
  // for approval is never booked (the consumer ignores it).
  rule(
    { event: "cash_movement.recorded", variant: "cash_out" },
    "cashier_shift",
    "Kas keluar kasir",
    "§3.11 POS Kasir (kas masuk dan keluar dengan alasan); §4 E",
    [
      ["cash_out_expense", "debit", "amountIdr"],
      ["cash_on_hand", "credit", "amountIdr"],
    ],
  ),
  rule(
    { event: "cash_movement.recorded", variant: "cash_in" },
    "cashier_shift",
    "Kas masuk kasir",
    "§3.11 POS Kasir (kas masuk dan keluar dengan alasan); §4 E",
    [
      ["cash_on_hand", "debit", "amountIdr"],
      ["cash_in_clearing", "credit", "amountIdr"],
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
    { document: "petty_cash_topup" },
    "petty_cash_topup",
    "Isi dana kas kecil outlet dari bank",
    "§3.19 Kas & Bank; Kas Kecil",
    [
      ["petty_cash", "debit", "amountIdr"],
      ["bank", "credit", "amountIdr"],
    ],
  ),
  rule(
    { document: "petty_cash_return" },
    "petty_cash_return",
    "Kembalikan dana kas kecil outlet ke bank",
    "§3.19 Kas & Bank; Kas Kecil",
    [
      ["bank", "debit", "amountIdr"],
      ["petty_cash", "credit", "amountIdr"],
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
