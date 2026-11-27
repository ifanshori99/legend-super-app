// Mock handler for the EDC settlement CSV upload (VITE_API_MOCK=true). It reads
// the file like the API's rules in spirit only: header line, one line per
// transaction, a line with a non-numeric amount is unreadable and nothing is
// imported. Counts are made up from the line numbers, never from money.
import { importEdcSettlementCsv } from "@starter/shared/payment/admin";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";

registerMock(importEdcSettlementCsv, ({ body }) => {
  const lines = body.csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const data = lines.slice(1);
  if (data.length === 0)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Berkas tidak memuat baris transaksi.",
    );
  // Readable: at least TID, RRN and an amount that is whole digits.
  const readable = (line: string) => {
    const cells = line.split(/[,;]/).map((cell) => cell.trim());
    return cells.length >= 3 && /^\d+$/.test(cells[cells.length - 1] ?? "");
  };
  const bad = data
    .map((line, index) => ({ line, row: index + 2 }))
    .filter(({ line }) => !readable(line))
    .map(({ row }) => row);
  if (bad.length > 0)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      `Baris ${bad.slice(0, 20).join(", ")} tidak dapat dibaca (TID, RRN atau nominal tidak valid). Tidak ada baris yang diimpor.`,
    );
  const rowCount = data.length;
  const mismatch = rowCount >= 4 ? 1 : 0;
  const unmatched = rowCount >= 3 ? 1 : 0;
  const matched = rowCount - mismatch - unmatched;
  return {
    id: "00000000-0000-4000-8000-0000000000c1",
    outletId: body.outletId,
    bank: body.bank,
    fileName: body.fileName,
    fileHash: "0".repeat(64),
    rowCount,
    matched,
    cleared: Math.max(0, matched - 1),
    mismatch,
    unmatched,
    duplicate: 0,
    replayed: false,
    createdAt: new Date().toISOString(),
  };
});
