// Ports the cashier shift / end-of-day services (bead legend-6c0) depend on
// but do not own (AGENT_PLAYBOOK §2 "Missing dependency? Do not block"). Each
// has a default and a setter the API bootstrap or a test installs.
//
// - Receipt gaps (POS-06, legend-93a). The shift report shows the device's
//   missing receipt ordinals per run (prefix) and the day close refuses while
//   any device has a missing ordinal (a lost range, legend-yd0h8, is shown
//   but does not block). legend-6b0ld: the day close also checks every run of
//   the outlet (outlet port below), not only devices active that day.
//   Default: no receipt has been issued yet, so no gap
//   (the order service cannot complete a sale until the numbering bead
//   installs its allocator, see pos-order-ports.ts), and the numbering bead
//   replaces this lookup.
// - Inventory deduction (WS-06, F8 "pemotongan stok akhir hari bila
//   dipilih"). Default: refused, so a day close that asks for it fails closed
//   instead of claiming a deduction nobody made.

import { CoreError, type ScopedTenantContext } from "@starter/shared/core";
import type { Tx } from "./permission-resolver.ts";

// ---- Receipt gaps (POS-06) --------------------------------------------------

/** Gaps of one receipt run (one `receipt_sequences` row) of a device. */
export type PosReceiptGapRun = {
  prefix: string;
  /** Missing ordinals 1..lastNumber of this run, ascending. */
  missing: number[];
  /**
   * legend-0hzqw: ordinals the tenant owner wrote off as permanently lost,
   * ascending. They count as present (not in `missing`) and the day close
   * ignores them; the shift report shows them.
   */
  writtenOff: number[];
  /**
   * legend-yd0h8: run retired as edge_regressed whose high-water
   * (edge_reported_number) is above the cloud lastNumber: ordinals
   * lastNumber+1..edgeReportedNumber the edge reported issuing but the cloud
   * never received. null otherwise.
   */
  lost: { from: number; to: number } | null;
};

/**
 * One entry per run with a missing ordinal, a lost range or a write-off, oldest run first;
 * a gap-free device returns [].
 */
export type PosReceiptGapsPort = (
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: string; deviceId: string },
) => Promise<PosReceiptGapRun[]>;

const noReceiptGaps: PosReceiptGapsPort = async () => [];
let receiptGaps: PosReceiptGapsPort = noReceiptGaps;

export function setPosReceiptGapsPort(next: PosReceiptGapsPort | null): void {
  receiptGaps = next ?? noReceiptGaps;
}

export function posReceiptGapsPort(): PosReceiptGapsPort {
  return receiptGaps;
}

/**
 * legend-6b0ld: every receipt run of the outlet (all devices incl. retired
 * runs, plus the outlet-owned cloud sequence), not only devices with activity
 * on the closing day. One entry per run with a missing ordinal; lost ranges
 * are not part of the result.
 */
export type PosOutletReceiptGapsPort = (
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: string },
) => Promise<{ prefix: string; deviceId: string; missing: number[] }[]>;

const noOutletReceiptGaps: PosOutletReceiptGapsPort = async () => [];
let outletReceiptGaps: PosOutletReceiptGapsPort = noOutletReceiptGaps;

export function setPosOutletReceiptGapsPort(
  next: PosOutletReceiptGapsPort | null,
): void {
  outletReceiptGaps = next ?? noOutletReceiptGaps;
}

export function posOutletReceiptGapsPort(): PosOutletReceiptGapsPort {
  return outletReceiptGaps;
}

// ---- End-of-day inventory deduction (WS-06) --------------------------------

export type PosDayInventoryPort = (
  tx: Tx,
  context: ScopedTenantContext,
  input: { outletId: string; businessDate: string; closedBy: string },
) => Promise<void>;

const refuseInventoryDeduction: PosDayInventoryPort = async () => {
  throw new CoreError(
    "SERVICE_UNAVAILABLE",
    "Pemotongan stok akhir hari belum tersedia.",
  );
};
let inventoryPort: PosDayInventoryPort = refuseInventoryDeduction;

export function setPosDayInventoryPort(next: PosDayInventoryPort | null): void {
  inventoryPort = next ?? refuseInventoryDeduction;
}

export function posDayInventoryPort(): PosDayInventoryPort {
  return inventoryPort;
}
