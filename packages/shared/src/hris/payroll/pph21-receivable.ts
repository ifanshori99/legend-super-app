// Employee receivable for PPh 21 the payslip could not withhold (beads
// legend-kn3n part 2, legend-xzid; founder decision B8).
//
// The employee's PPh 21 is capped at the pay left after BPJS and other
// pre-net deductions (`employeeWithholdingCapIdr`, pph21.ts). The company still
// remits the full tax; the part above the cap is NOT a company cost and is NOT
// grossed up. It becomes a receivable from the employee (`pph21ReceivableIdr`
// on the payslip tax) that later payslips collect, up to the pay available.
// What is still open when the employee leaves stays an open receivable for
// finance. Whole rupiah everywhere.

import { idr } from "../../core/index.ts";
import type { Idr } from "../../core/index.ts";

/** The slice of a payslip the receivable balance reads. */
export type Pph21ReceivableSlip = {
  tax: { pph21ReceivableIdr?: Idr | number | undefined };
  lines: readonly { category: string; amountIdr: Idr | number }[];
};

function wholeRupiah(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative whole rupiah amount`);
  return value;
}

/**
 * Open receivable of one employee: the sum of `tax.pph21ReceivableIdr` (absent
 * = 0) minus the sum of `pph21_receivable` deduction lines, across all given
 * payslips and tax years. Refused with a RangeError when collections exceed
 * the receivables raised.
 */
export function pph21ReceivableBalance(
  slips: readonly Pph21ReceivableSlip[],
): Idr {
  let raised = 0;
  let collected = 0;
  slips.forEach((slip, index) => {
    raised += wholeRupiah(
      slip.tax.pph21ReceivableIdr ?? 0,
      `payslip ${index} pph21ReceivableIdr`,
    );
    for (const line of slip.lines)
      if (line.category === "pph21_receivable")
        collected += wholeRupiah(line.amountIdr, `payslip ${index} line`);
  });
  if (collected > raised)
    throw new RangeError(
      "pph21_receivable collections exceed the receivables raised",
    );
  return idr(raised - collected);
}

export type Pph21ReceivableCollection = {
  /** Deducted from this payslip. */
  collectedIdr: Idr;
  /** Still open after this payslip. */
  openAfterIdr: Idr;
};

/**
 * Collection on one payslip: min(open, max(0, room)). Room is the net pay left
 * after BPJS, PPh 21 and other pre-net deductions, with no percentage limit
 * (architect Q3). A receivable raised on the same payslip is never collected
 * on it: pass only the balance from earlier payslips as `openIdr`.
 */
export function planPph21ReceivableCollection(input: {
  openIdr: Idr | number;
  roomIdr: Idr | number;
}): Pph21ReceivableCollection {
  const open = wholeRupiah(input.openIdr, "openIdr");
  if (!Number.isSafeInteger(input.roomIdr))
    throw new RangeError("roomIdr must be a whole rupiah amount");
  const collected = Math.min(open, Math.max(0, input.roomIdr));
  return {
    collectedIdr: idr(collected),
    openAfterIdr: idr(open - collected),
  };
}
