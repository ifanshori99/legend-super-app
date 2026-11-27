// Pure rules for the EDC lines of Tutup Hari (X2-UI, legend-wasr7.18). No React
// and no `@/` alias, so tests can import this file with plain Node ESM. The
// figures are the server's (recap.edcSettlement); this file only decides what
// the screen says about them (differences and status are the server's).

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
  /** Receipts minus the bank-confirmed part, computed by the server. */
  differenceIdr: number;
  /** Where the bank file stands for this terminal (server's words). */
  bankStatus: "awaiting" | "matched" | "mismatch" | "no_match";
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
  | "mismatch"
  /** The file is in but hit none of this terminal's sales. */
  | "noMatch";

export type EdcTerminalView = {
  state: EdcTerminalState;
  receiptIdr: number;
  /** null while waiting: "not here yet" is not "Rp 0". */
  settledIdr: number | null;
  /** The server's difference, as given; null while waiting. */
  differenceIdr: number | null;
};

/**
 * What the screen says about a terminal. The server decides the status and
 * computes the difference (bankStatus, differenceIdr); nothing is subtracted
 * here, the only comparison is "is the server's difference zero".
 */
export function edcTerminalView(row: EdcTerminalSettlement): EdcTerminalView {
  const receiptIdr = row.receiptIdr;
  if (row.receiptCount === 0)
    return { state: "none", receiptIdr, settledIdr: null, differenceIdr: null };
  if (row.bankStatus === "awaiting")
    return {
      state: "waiting",
      receiptIdr,
      settledIdr: null,
      differenceIdr: null,
    };
  const state: EdcTerminalState =
    row.bankStatus === "mismatch"
      ? "mismatch"
      : row.bankStatus === "no_match"
        ? "noMatch"
        : row.differenceIdr > 0
          ? "partial"
          : "settled";
  return {
    state,
    receiptIdr,
    settledIdr: row.settledIdr,
    differenceIdr: row.differenceIdr,
  };
}

/**
 * Sales still "perlu dicek" after the bank file reached their terminal. A
 * terminal still waiting says so on its own line, so its flags are not counted
 * here (review P3 7: the plain sum was too wide). null means unknown, never
 * "nothing flagged": no EDC figures, no terminal, or every terminal still
 * waiting for its file (review K P2: do not reassure before the file).
 */
export function flaggedAfterBankFile(
  rows: readonly EdcTerminalSettlement[] | null,
): number | null {
  if (rows === null) return null;
  const reached = rows.filter((row) => row.bankStatus !== "awaiting");
  if (reached.length === 0) return null;
  return reached.reduce((sum, row) => sum + row.flaggedCount, 0);
}

/**
 * Tone of the EDC notice on the day check: calm only when every terminal is
 * settled and nothing is flagged; red when a bank line mismatched or hit
 * nothing; otherwise a warning (waiting, partial, flagged, or no figures).
 */
export function edcNoticeTone(
  rows: readonly EdcTerminalSettlement[] | null,
  flagged: number | null,
): "info" | "warning" | "danger" {
  if (rows === null) return "warning";
  const states = rows.map((row) => edcTerminalView(row).state);
  if (states.some((state) => state === "mismatch" || state === "noMatch"))
    return "danger";
  if (rows.length === 0) return "info";
  return flagged === 0 && states.every((state) => state === "settled")
    ? "info"
    : "warning";
}
