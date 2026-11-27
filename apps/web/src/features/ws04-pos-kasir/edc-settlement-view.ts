// Pure rules for the EDC lines of Tutup Hari (X2-UI, legend-wasr7.18). No React
// and no `@/` alias, so tests can import this file with plain Node ESM. The
// figures are the server's (recap.edcSettlement); this file only decides what
// the screen says about them.

/** One terminal of the day, as the server counts it (EndOfDayEdcTerminalRow). */
export type EdcTerminalSettlement = {
  terminalId: string;
  terminalCode: string;
  bank: "bca" | "mandiri" | "bni" | "bjb";
  /** Captured EDC tenders of the day's completed sales on this terminal. */
  receiptIdr: number;
  receiptCount: number;
  /** Of those: confirmed by a matched bank settlement line. */
  settledIdr: number;
  settledCount: number;
  /** Of those: still "perlu dicek". */
  flaggedCount: number;
  /** Bank lines naming one of these sales with another amount or terminal. */
  mismatchCount: number;
};

export type EdcTerminalState =
  /** No EDC sale on this terminal: nothing to settle. */
  | "none"
  /** The bank file has not reached any sale of this terminal yet. */
  | "waiting"
  /** The bank confirmed every sale. */
  | "settled"
  /** The bank confirmed some sales; the rest is still open. */
  | "partial"
  /** A bank line named a sale with another amount or terminal. */
  | "mismatch";

export type EdcTerminalView = {
  state: EdcTerminalState;
  receiptIdr: number;
  /** null while waiting: "not here yet" is not "Rp 0". */
  settledIdr: number | null;
  /**
   * Receipts minus the bank-confirmed part, both server figures (the server
   * has no difference field yet); null while waiting.
   */
  differenceIdr: number | null;
};

export function edcTerminalView(row: EdcTerminalSettlement): EdcTerminalView {
  if (row.receiptCount === 0)
    return {
      state: "none",
      receiptIdr: row.receiptIdr,
      settledIdr: null,
      differenceIdr: null,
    };
  // Neither a confirmed sale nor a mismatching line: the file has not reached
  // this terminal (settledIdr 0 here means "no file", not "the bank paid 0").
  if (row.settledCount === 0 && row.mismatchCount === 0)
    return {
      state: "waiting",
      receiptIdr: row.receiptIdr,
      settledIdr: null,
      differenceIdr: null,
    };
  const differenceIdr = row.receiptIdr - row.settledIdr;
  return {
    state:
      row.mismatchCount > 0
        ? "mismatch"
        : differenceIdr > 0
          ? "partial"
          : "settled",
    receiptIdr: row.receiptIdr,
    settledIdr: row.settledIdr,
    differenceIdr,
  };
}

/**
 * Sales still "perlu dicek" after the bank file reached their terminal. A
 * terminal still waiting says so on its own line, so its flags are not counted
 * here (review P3 7: the plain sum was too wide). null: no EDC figures.
 */
export function flaggedAfterBankFile(
  rows: readonly EdcTerminalSettlement[] | null,
): number | null {
  if (rows === null) return null;
  return rows.reduce(
    (sum, row) =>
      edcTerminalView(row).state === "waiting" ? sum : sum + row.flaggedCount,
    0,
  );
}
