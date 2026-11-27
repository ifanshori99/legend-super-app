// Mock handlers for the Duitku settlement import and the settlement list
// (VITE_API_MOCK=true, C4b). Like the API the template is read strictly and
// the totals are summed here, standing in for the server. Matching is made up
// from the line count.
import { cafeLegendFixtures, idr, type OutletId } from "@starter/shared/core";
import {
  importGatewaySettlementCsv,
  listSettlements,
  SETTLEMENT_TEMPLATE_V1_COLUMNS,
  type SettlementImportView,
  type SettlementListItem,
} from "@starter/shared/payment/admin";
import { ApiError } from "../../lib/api/errors.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";

const outlet = cafeLegendFixtures.outlets[0].id as OutletId;

function sample(
  n: number,
  {
    gross,
    fee,
    ...o
  }: Partial<SettlementListItem> & {
    gross: number;
    fee: number;
  },
): SettlementListItem {
  return {
    id: `00000000-0000-4000-8000-0000000c4b0${n}`,
    outletId: outlet,
    source: "gateway",
    provider: "duitku",
    reference: `STL-2026110${n}`,
    terminalId: null,
    batchNo: null,
    periodStart: `2026-11-0${n}`,
    periodEnd: `2026-11-0${n}`,
    grossIdr: idr(gross),
    feeIdr: idr(fee),
    netIdr: idr(gross - fee),
    lineCount: 12,
    matchedLines: 11,
    mismatchLines: 1,
    unmatchedLines: 0,
    casesCreated: 1,
    createdAt: `2026-11-0${n + 1}T02:15:00.000Z`,
    ...o,
  };
}

const settlements: SettlementListItem[] = [
  sample(2, { gross: 1_845_000, fee: 12_915 }),
  sample(1, {
    gross: 1_320_000,
    fee: 9_240,
    matchedLines: 12,
    mismatchLines: 0,
    casesCreated: 0,
  }),
];

registerMock(listSettlements, ({ query, scenario }) =>
  paginateFixture(
    scenario === "empty"
      ? []
      : settlements.filter((row) => row.outletId === query.outletId),
    query,
    (row) => row.id,
    scenario,
  ),
);

// The second factor is the mock session's (window.__legendMock.failNext
// answers MFA_REQUIRED for the step-up screenshots).
registerMock(importGatewaySettlementCsv, ({ body }) => {
  const rows = body.csv
    .split(/\r?\n/)
    .map((line, index) => ({ cells: line.split(","), row: index + 1 }))
    .filter(({ cells }) => cells.join("").trim() !== "");
  const header = rows[0]?.cells.map((cell) => cell.trim().toLowerCase());
  const columns: readonly string[] = SETTLEMENT_TEMPLATE_V1_COLUMNS;
  if (
    !header ||
    header.length !== columns.length ||
    !columns.every((column) => header.includes(column))
  )
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      `Kolom harus tepat: ${columns.join(", ")}.`,
    );
  const at = (name: string) => header.indexOf(name);
  const errors: { row: number; reason: string }[] = [];
  const lines: { amount: number; fee: number }[] = [];
  for (const { cells, row } of rows.slice(1)) {
    const amount = (cells[at("amount_idr")] ?? "").trim();
    const fee = (cells[at("fee_idr")] ?? "").trim();
    if (cells.length !== columns.length)
      errors.push({ row, reason: "columns" });
    else if (!(cells[at("reference")] ?? "").trim())
      errors.push({ row, reason: "reference" });
    else if (!/^\d+$/.test(amount) || Number(amount) <= 0)
      errors.push({ row, reason: "amount" });
    else if (!/^\d+$/.test(fee) || Number(fee) > Number(amount))
      errors.push({ row, reason: "fee" });
    else lines.push({ amount: Number(amount), fee: Number(fee) });
  }
  if (errors.length > 0)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      `${errors.length} baris tidak dapat dibaca.`,
      undefined,
      { rowErrors: errors.slice(0, 20) },
    );
  if (lines.length === 0)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Berkas tidak berisi baris settlement.",
    );
  const existing = settlements.find(
    (row) => row.reference === body.reference && row.outletId === body.outletId,
  );
  if (existing) return { data: { ...importView(existing), replayed: true } };
  const gross = lines.reduce((sum, line) => sum + line.amount, 0);
  const fee = lines.reduce((sum, line) => sum + line.fee, 0);
  const mismatch = lines.length >= 4 ? 1 : 0;
  const unmatched = lines.length >= 3 ? 1 : 0;
  const created: SettlementListItem = {
    id: `00000000-0000-4000-8000-${String(settlements.length + 1).padStart(12, "0")}`,
    outletId: body.outletId,
    source: "gateway",
    provider: body.provider,
    reference: body.reference,
    terminalId: null,
    batchNo: null,
    periodStart: body.periodStart,
    periodEnd: body.periodEnd,
    grossIdr: idr(gross),
    feeIdr: idr(fee),
    netIdr: idr(gross - fee),
    lineCount: lines.length,
    matchedLines: lines.length - mismatch - unmatched,
    mismatchLines: mismatch,
    unmatchedLines: unmatched,
    casesCreated: mismatch + unmatched,
    createdAt: new Date().toISOString(),
  };
  settlements.unshift(created);
  return { data: { ...importView(created), replayed: false } };
});

function importView(
  row: SettlementListItem,
): Omit<SettlementImportView, "replayed"> {
  return {
    id: row.id,
    outletId: row.outletId,
    source: row.source,
    provider: row.provider,
    reference: row.reference,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    grossIdr: row.grossIdr,
    feeIdr: row.feeIdr,
    netIdr: row.netIdr,
    lineCount: row.lineCount,
    matchedLines: row.matchedLines,
    mismatchLines: row.mismatchLines,
    unmatchedLines: row.unmatchedLines,
    casesCreated: row.casesCreated,
    createdAt: row.createdAt,
  };
}
