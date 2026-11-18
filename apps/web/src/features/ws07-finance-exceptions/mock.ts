// Mock handler of the finance exceptions list (`VITE_API_MOCK=true`). It
// filters like the API: kind, outlet and the business-date window; the payout
// kind has no outlet, so an outlet filter leaves it out. The summary counts
// every matching row and sums only known amounts (a kind with none sends 0).
// `?mock=empty` answers an empty list; `?mock=error` fails through the runtime.
//
// Loaded in Node by tests, so imports are bare packages or relative `.ts`.
import { cafeLegendFixtures } from "@starter/shared/core";
import { registerMock } from "../../lib/mock/registry.ts";
import { listFinanceExceptions } from "./endpoint.ts";
import { addDays, jakartaToday, type FinanceExceptionKind } from "./lib.ts";

type Row = {
  kind: FinanceExceptionKind;
  /** Index into the fixture outlets; null = the whole legal entity. */
  outlet: 0 | 1 | null;
  daysAgo: number;
  time: string;
  refType: string;
  refId: string;
  amountIdr: number | null;
  detail: string | null;
};

const outlets = cafeLegendFixtures.outlets;

// Newest first, like the API. Ids are short on purpose: the screen shortens
// long ids itself, the mock covers both (the last row has a full UUID).
const ROWS: readonly Row[] = [
  {
    kind: "payout_fee_not_posted",
    outlet: null,
    daysAgo: 0,
    time: "14:20",
    refType: "payout_posting",
    refId: "PAY-202611-003",
    amountIdr: 15_000,
    detail: "batch-202611-003",
  },
  {
    kind: "edge_tax_unsnapshotted",
    outlet: 0,
    daysAgo: 0,
    time: "12:42",
    refType: "order",
    refId: "ORD-BDG-1411-082",
    amountIdr: 18_000,
    detail: "tax_missing",
  },
  {
    kind: "edge_void_refused",
    outlet: 0,
    daysAgo: 0,
    time: "12:08",
    refType: "order",
    refId: "ORD-BDG-1411-077",
    amountIdr: 85_000,
    detail: "manual_refund_exists",
  },
  {
    kind: "edge_void_unsupported",
    outlet: 1,
    daysAgo: 0,
    time: "11:15",
    refType: "auto_journal",
    refId: "VOID-BD2-1411-012",
    amountIdr: 250_000,
    detail: null,
  },
  {
    kind: "edge_receipt_skipped",
    outlet: 0,
    daysAgo: 0,
    time: "10:37",
    refType: "receipt_skip",
    refId: "RCT-BDG-1411-061",
    amountIdr: 155_000,
    detail: null,
  },
  {
    kind: "edge_link_dead_letter",
    outlet: 1,
    daysAgo: 0,
    time: "09:22",
    refType: "link_event",
    refId: "LINK-BD2-1411-008",
    amountIdr: null,
    detail: null,
  },
  {
    kind: "edge_tax_unsnapshotted",
    outlet: 1,
    daysAgo: 1,
    time: "18:55",
    refType: "order",
    refId: "ORD-BD2-1311-044",
    amountIdr: 12_000,
    detail: "tax_mismatch",
  },
  {
    kind: "edge_receipt_skipped",
    outlet: 1,
    daysAgo: 1,
    time: "16:05",
    refType: "receipt_skip",
    refId: "RCT-BD2-1311-038",
    amountIdr: null,
    detail: null,
  },
  {
    kind: "edge_link_dead_letter",
    outlet: 0,
    daysAgo: 2,
    time: "13:10",
    refType: "link_event",
    refId: "7c1d5e9a-3b24-4f6e-8a90-12d4c5b6e7f8",
    amountIdr: null,
    detail: null,
  },
];

function dateOf(row: Row, today: string): string {
  return addDays(today, -row.daysAgo);
}

function toItem(row: Row, today: string) {
  return {
    kind: row.kind,
    outletId: row.outlet === null ? null : outlets[row.outlet].id,
    occurredAt: new Date(
      `${dateOf(row, today)}T${row.time}:00+07:00`,
    ).toISOString(),
    refType: row.refType,
    refId: row.refId,
    amountIdr: row.amountIdr,
    detail: row.detail,
  };
}

registerMock(listFinanceExceptions, ({ query, scenario }) => {
  if (scenario === "empty") return { summary: [], items: [], truncated: false };
  const today = jakartaToday();
  const matching = ROWS.filter((row) => {
    const date = dateOf(row, today);
    const outletId = row.outlet === null ? null : outlets[row.outlet].id;
    return (
      date >= query.from &&
      date <= query.to &&
      (query.kind === undefined || row.kind === query.kind) &&
      (query.outletId === undefined || outletId === query.outletId)
    );
  }).map((row) => toItem(row, today));
  const summary = [...new Set(matching.map((item) => item.kind))].map(
    (kind) => {
      const ofKind = matching.filter((item) => item.kind === kind);
      return {
        kind,
        count: ofKind.length,
        knownAmountCount: ofKind.filter((item) => item.amountIdr !== null)
          .length,
        amountIdr: ofKind.reduce((sum, item) => sum + (item.amountIdr ?? 0), 0),
      };
    },
  );
  return {
    summary,
    items: matching,
    truncated: false,
  };
});
