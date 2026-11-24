// Mock handlers for the financial statements and period close screens
// (`VITE_API_MOCK=true`). They serve the Cafe Legend accounting fixtures and
// run the contract's period state machines: version-guarded close, snapshot on
// close, reopen request with a reason, and a different approver (AUTH-06).
//
// Statement payloads are rebuilt from the fixture ledger with the contract
// builders (buildTrialBalance / buildProfitAndLoss / buildBalanceSheet) so
// every figure matches the journals. Cash flow and equity changes have no
// shared builder, so this file derives them the way the API will: cash flow
// from cash-account lines classified by journal source, equity from equity
// accounts plus the P&L's running earnings. Both are server-side mock logic,
// never UI arithmetic.
//
// loaded in Node by tests/ws07-statements.test.mjs, so every import here is a
// bare package import or a relative `.ts` path (no `@/` alias).
//
// Identity in mock mode: the mock has no session, so by default the requester
// (and closer) is the fixture's finance user and the decider the owner. To
// exercise the different-approver rule, set
//   localStorage["legend-mock-accounting-actor"] = "finance" | "owner"
// and every write is made as that one user: approving or rejecting your own
// request is then refused with 403 APPROVER_IS_REQUESTER by the contract's
// `decidePeriodReopen`, exactly as the API refuses it (AUTH-06).
import {
  AccountingError,
  addDays,
  approvePeriodReopen,
  assertPeriodVersion,
  assertReopenRequestable,
  buildBalanceSheet,
  buildProfitAndLoss,
  buildTrialBalance,
  cafeLegendAccountingFixtures,
  cashFlowStatementSchema,
  closeFiscalPeriod,
  closeFiscalPeriodOverride,
  decidePeriodClose,
  decidePeriodReopen,
  drillDownLineSchema,
  equityChangesSchema,
  fiscalPeriodSchema,
  getBalanceSheet,
  getCashFlow,
  getEquityChanges,
  getMultiEntityProfitAndLoss,
  getPeriodSnapshot,
  getProfitAndLoss,
  getStatementDrillDown,
  getTrialBalance,
  listPeriodCloseBlockers,
  listPeriodReopenRequests,
  naturalBalance,
  periodBounds,
  periodCloseSnapshotSchema,
  periodReopenRequestSchema,
  rejectPeriodReopen,
  requestPeriodReopen,
  statementBasisFields,
  type AccountId,
  type CashFlowStatement,
  type DrillDownLine,
  type EquityChanges,
  type FiscalPeriod,
  type JournalSourceType,
  type LedgerLine,
  type PeriodCloseBlocker,
  type PeriodCloseSnapshot,
  type PeriodReopenRequest,
} from "@starter/shared/accounting";
import { AccessError } from "@starter/shared/access";
import type { AnyEndpoint } from "@starter/shared/api";
import type { Idr, UserId } from "@starter/shared/core";
import { ApiError } from "../../lib/api/errors.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock, type MockHandler } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";

const fixtures = cafeLegendAccountingFixtures;

/** Fixture/builder numbers are plain numbers; the schemas carry branded Idr. */
const asIdr = (value: number): Idr => value as Idr;
const accounts = fixtures.accounts;
const tenantId = fixtures.tenantId;
const entityId = fixtures.legalEntity.id;
const finance = fixtures.users.finance as UserId;
const owner = fixtures.users.owner as UserId;

export const MOCK_ACTOR_STORAGE_KEY = "legend-mock-accounting-actor";

/** The single acting user when the override is set (see the header comment). */
function actorOverride(): UserId | null {
  try {
    const value = globalThis.localStorage?.getItem(MOCK_ACTOR_STORAGE_KEY);
    if (value === "finance") return finance;
    if (value === "owner") return owner;
  } catch {
    // Storage blocked (private mode, Node tests): default identities.
  }
  return null;
}
const requester = (): UserId => actorOverride() ?? finance;
const decider = (): UserId => actorOverride() ?? owner;

/** The cumulative statements start before the fixture's first entry (2026-09). */
const LEDGER_START = "1970-01-01";

type StatementsMockState = {
  periods: FiscalPeriod[];
  requests: PeriodReopenRequest[];
  snapshots: Map<string, PeriodCloseSnapshot>;
  /** Idempotency and replay: request key → created/updated id. */
  created: Map<string, string>;
  /** "period-close-blocked-cleared": periods already refused once. */
  refusedOnce: Set<string>;
};

const state = createMockStore<StatementsMockState>(() => ({
  periods: fixtures.fiscalPeriods.map((row) => ({ ...row })),
  requests: fixtures.periodReopenRequests.map((row) => ({ ...row })),
  snapshots: new Map([
    [fixtures.octoberSnapshot.fiscalPeriodId, fixtures.octoberSnapshot],
  ]),
  created: new Map(),
  refusedOnce: new Set(),
}));

/**
 * Registers a handler and maps the contract's own errors the way the API
 * does: `AccountingError` and `AccessError` carry `code` and `status`, but the
 * mock runtime only knows `ApiError`/`CoreError`, so a refusal would surface
 * as INTERNAL_ERROR.
 */
function register<E extends AnyEndpoint>(
  endpoint: E,
  handler: MockHandler<E>,
): void {
  registerMock(endpoint, (context) => {
    try {
      return handler(context);
    } catch (error) {
      if (error instanceof AccountingError || error instanceof AccessError)
        throw new ApiError(error.status, error.code, error.message);
      throw error;
    }
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function notFound(message: string): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}

function toIdr(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError("Idr overflow");
  return number;
}

function findPeriod(fiscalPeriodId: string): FiscalPeriod {
  const period = state.get().periods.find((row) => row.id === fiscalPeriodId);
  if (!period) throw notFound("Periode fiskal tidak ditemukan.");
  return period;
}

function replacePeriod(next: FiscalPeriod): void {
  const current = state.get();
  const index = current.periods.findIndex((row) => row.id === next.id);
  if (index === -1) throw notFound("Periode fiskal tidak ditemukan.");
  current.periods[index] = fiscalPeriodSchema.parse(next);
}

/** Fiscal periods of one entity, the basis input of every statement. */
function entityPeriods(legalEntityId: string): readonly FiscalPeriod[] {
  return state
    .get()
    .periods.filter((period) => period.legalEntityId === legalEntityId);
}

/** `?mock=empty` serves a ledger with no lines, which every builder turns into zero rows. */
function ledgerLines(scenario: string): readonly LedgerLine[] {
  return scenario === "empty" ? [] : fixtures.ledgerLines;
}

// ---- Trial balance and balance sheet --------------------------------------

register(getTrialBalance, ({ query, scenario }) => ({
  data: buildTrialBalance(
    accounts,
    ledgerLines(scenario),
    query.legalEntityId,
    query.asOf,
    entityPeriods(query.legalEntityId),
  ),
}));

register(getBalanceSheet, ({ query, scenario }) => ({
  data: buildBalanceSheet(accounts, ledgerLines(scenario), {
    legalEntityId: query.legalEntityId,
    asOf: query.asOf,
    periods: entityPeriods(query.legalEntityId),
  }),
}));

// ---- Profit and loss ------------------------------------------------------

register(getProfitAndLoss, ({ query, scenario }) => ({
  data: buildProfitAndLoss(accounts, ledgerLines(scenario), {
    legalEntityId: query.legalEntityId,
    from: query.from,
    to: query.to,
    periods: entityPeriods(query.legalEntityId),
    ...(query.outletId ? { outletId: query.outletId } : {}),
  }),
}));

/**
 * The fixtures hold one legal entity; a tenant with more would get one P&L per
 * entity from the same builder (the contract has no intercompany elimination).
 */
register(getMultiEntityProfitAndLoss, ({ query, scenario }) => {
  const entities = [
    buildProfitAndLoss(accounts, ledgerLines(scenario), {
      legalEntityId: entityId,
      from: query.from,
      to: query.to,
      periods: entityPeriods(entityId),
    }),
  ];
  return {
    data: {
      from: query.from,
      to: query.to,
      basis: entities.every((entity) => entity.basis === "closed_snapshot")
        ? ("closed_snapshot" as const)
        : ("live" as const),
      periodKeys: entities[0]!.periodKeys,
      entities,
      combinedNetProfitIdr:
        entities.length === 1
          ? entities[0]!.netProfitIdr
          : entities.reduce((total, entity) => total + entity.netProfitIdr, 0),
    },
  };
});

// ---- Cash flow (no shared builder; mock plays the API) --------------------

/** Basis fields of the cash flow and equity changes: both are cumulative. */
function basisFields(from: string, to: string) {
  return statementBasisFields(entityPeriods(entityId), {
    from,
    to,
    cumulative: true,
  });
}

type CashFlowActivity = CashFlowStatement["sections"][number]["activity"];

const CASH_FLOW_ACTIVITIES: readonly CashFlowActivity[] = [
  "operating",
  "investing",
  "financing",
];

const INVESTING_SOURCES: ReadonlySet<JournalSourceType> = new Set([
  "asset_acquisition",
  "asset_disposal",
  "asset_revaluation",
]);
const FINANCING_SOURCES: ReadonlySet<JournalSourceType> = new Set([
  "dividend",
  "opening_balance",
]);

const CASH_FLOW_LABELS: Record<
  CashFlowActivity,
  { inflow: string; outflow: string }
> = {
  operating: {
    inflow: "Penerimaan kas operasional",
    outflow: "Pengeluaran kas operasional",
  },
  investing: {
    inflow: "Penerimaan dari aktivitas investasi",
    outflow: "Pengeluaran untuk aktivitas investasi",
  },
  financing: {
    inflow: "Penerimaan dari aktivitas pendanaan",
    outflow: "Pembayaran untuk aktivitas pendanaan",
  },
};

function activityOf(source: JournalSourceType): CashFlowActivity {
  if (INVESTING_SOURCES.has(source)) return "investing";
  if (FINANCING_SOURCES.has(source)) return "financing";
  return "operating";
}

/** Direct cash flow: one inflow/outflow row per activity from cash-account lines. */
function buildCashFlow(
  from: string,
  to: string,
  scenario: string,
): CashFlowStatement {
  if (scenario === "empty")
    return cashFlowStatementSchema.parse({
      legalEntityId: entityId,
      from,
      to,
      ...basisFields(from, to),
      method: "direct",
      sections: CASH_FLOW_ACTIVITIES.map((activity) => ({
        activity,
        rows: [],
        totalIdr: 0,
      })),
      openingCashIdr: 0,
      netChangeIdr: 0,
      closingCashIdr: 0,
    });

  const cashAccountIds = new Set(
    accounts
      .filter((account) => account.reportGroup === "cash_and_equivalents")
      .map((account) => account.id),
  );
  const cashAt = (date: string) =>
    fixtures.ledgerLines.reduce((total, line) => {
      if (
        !cashAccountIds.has(line.accountId as AccountId) ||
        line.entryDate > date
      )
        return total;
      return total + BigInt(line.debitIdr) - BigInt(line.creditIdr);
    }, 0n);

  const inflow: Record<CashFlowActivity, bigint> = {
    operating: 0n,
    investing: 0n,
    financing: 0n,
  };
  const outflow: Record<CashFlowActivity, bigint> = {
    operating: 0n,
    investing: 0n,
    financing: 0n,
  };
  for (const entry of fixtures.journals) {
    if (entry.entryDate < from || entry.entryDate > to) continue;
    const effect = entry.lines.reduce((total, line) => {
      if (!cashAccountIds.has(line.accountId)) return total;
      return total + BigInt(line.debitIdr) - BigInt(line.creditIdr);
    }, 0n);
    // Transfers between cash accounts net to zero and are not a cash flow.
    if (effect === 0n) continue;
    const activity = activityOf(entry.sourceType);
    if (effect > 0n) inflow[activity] += effect;
    else outflow[activity] -= effect;
  }

  const opening = cashAt(addDays(from, -1));
  const closing = cashAt(to);
  return cashFlowStatementSchema.parse({
    legalEntityId: entityId,
    from,
    to,
    ...basisFields(from, to),
    method: "direct",
    sections: CASH_FLOW_ACTIVITIES.map((activity) => {
      const rows = [];
      if (inflow[activity] > 0n)
        rows.push({
          label: CASH_FLOW_LABELS[activity].inflow,
          amountIdr: toIdr(inflow[activity]),
        });
      if (outflow[activity] > 0n)
        rows.push({
          label: CASH_FLOW_LABELS[activity].outflow,
          amountIdr: toIdr(-outflow[activity]),
        });
      return {
        activity,
        rows,
        totalIdr: toIdr(inflow[activity] - outflow[activity]),
      };
    }),
    openingCashIdr: toIdr(opening),
    netChangeIdr: toIdr(closing - opening),
    closingCashIdr: toIdr(closing),
  });
}

register(getCashFlow, ({ query, scenario }) => ({
  data: buildCashFlow(query.from, query.to, scenario),
}));

// ---- Equity changes (no shared builder; mock plays the API) ---------------

/** Equity roll-forward per equity account plus the P&L's running earnings. */
function buildEquityChanges(
  from: string,
  to: string,
  scenario: string,
): EquityChanges {
  if (scenario === "empty")
    return equityChangesSchema.parse({
      legalEntityId: entityId,
      from,
      to,
      ...basisFields(from, to),
      rows: [],
    });

  const opening = buildTrialBalance(
    accounts,
    fixtures.ledgerLines,
    entityId,
    addDays(from, -1),
  );
  const closing = buildTrialBalance(
    accounts,
    fixtures.ledgerLines,
    entityId,
    to,
  );
  const openingByAccount = new Map(
    opening.rows.map((row) => [row.accountId, row]),
  );
  const closingByAccount = new Map(
    closing.rows.map((row) => [row.accountId, row]),
  );

  const rows: EquityChanges["rows"] = [];
  for (const account of accounts) {
    if (account.legalEntityId !== entityId) continue;
    if (account.reportGroup !== "equity") continue;
    const openingRow = openingByAccount.get(account.id);
    const closingRow = closingByAccount.get(account.id);
    const openingIdr = openingRow
      ? naturalBalance(account, openingRow.debitIdr, openingRow.creditIdr)
      : 0;
    const closingIdr = closingRow
      ? naturalBalance(account, closingRow.debitIdr, closingRow.creditIdr)
      : 0;
    if (openingIdr === 0 && closingIdr === 0) continue;
    rows.push({
      accountId: account.id,
      label: account.name,
      openingIdr: asIdr(openingIdr),
      profitIdr: asIdr(0),
      distributionsIdr: asIdr(0),
      otherMovementsIdr: asIdr(closingIdr - openingIdr),
      closingIdr: asIdr(closingIdr),
    });
  }

  const runningEarnings = buildProfitAndLoss(accounts, fixtures.ledgerLines, {
    legalEntityId: entityId,
    from: LEDGER_START,
    to: addDays(from, -1),
  }).netProfitIdr;
  const periodProfit = buildProfitAndLoss(accounts, fixtures.ledgerLines, {
    legalEntityId: entityId,
    from,
    to,
  }).netProfitIdr;
  rows.push({
    accountId: null,
    label: "Laba periode berjalan",
    openingIdr: asIdr(runningEarnings),
    profitIdr: asIdr(periodProfit),
    distributionsIdr: asIdr(0),
    otherMovementsIdr: asIdr(0),
    closingIdr: asIdr(runningEarnings + periodProfit),
  });

  return equityChangesSchema.parse({
    legalEntityId: entityId,
    from,
    to,
    ...basisFields(from, to),
    rows,
  });
}

register(getEquityChanges, ({ query, scenario }) => ({
  data: buildEquityChanges(query.from, query.to, scenario),
}));

// ---- ACC-03: statement row → journal lines --------------------------------

register(getStatementDrillDown, ({ query, scenario }) => {
  const lines: DrillDownLine[] = [];
  for (const entry of fixtures.journals) {
    if (entry.entryDate < query.from || entry.entryDate > query.to) continue;
    for (const line of entry.lines) {
      if (line.accountId !== query.accountId) continue;
      if (query.outletId && line.outletId !== query.outletId) continue;
      lines.push(
        drillDownLineSchema.parse({
          journalEntryId: entry.id,
          journalLineId: line.id,
          entryDate: entry.entryDate,
          description: entry.description,
          outletId: line.outletId,
          debitIdr: line.debitIdr,
          creditIdr: line.creditIdr,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          postedAt: entry.postedAt,
        }),
      );
    }
  }
  lines.sort(
    (left, right) =>
      left.entryDate.localeCompare(right.entryDate) ||
      left.postedAt.localeCompare(right.postedAt) ||
      left.journalLineId.localeCompare(right.journalLineId),
  );
  return paginateFixture(
    lines,
    { cursor: query.cursor, limit: query.limit },
    (line) => line.journalLineId,
    scenario,
  );
});

// ---- Period close and reopen ----------------------------------------------

function snapshotFor(period: FiscalPeriod): PeriodCloseSnapshot {
  const bounds = periodBounds(period.period);
  const trialBalance = buildTrialBalance(
    accounts,
    fixtures.ledgerLines,
    period.legalEntityId,
    bounds.end,
  );
  return periodCloseSnapshotSchema.parse({
    fiscalPeriodId: period.id,
    legalEntityId: period.legalEntityId,
    period: period.period,
    version: Math.max(2, period.version),
    takenAt: period.closedAt ?? nowIso(),
    takenBy: period.closedBy ?? finance,
    balances: trialBalance.rows.map((row) => ({
      accountId: row.accountId,
      debitIdr: row.debitIdr,
      creditIdr: row.creditIdr,
    })),
  });
}

// ---- Close over incomplete batches (card 1263) ----------------------------

/** The business date the blocked scenarios close on (November has ended). */
const STOCK_BLOCK_TODAY = "2026-12-05";
const PERIOD_INVENTORY_GL_BLOCKED_MESSAGE =
  "Masih ada sumber persediaan yang belum terjurnal. Selesaikan dulu, lalu tutup periode.";

const incompleteBatch = (
  sourceId: string,
  itemName: string,
  businessDate: string,
): PeriodCloseBlocker => ({
  sourceType: "production_order",
  sourceId,
  errorCode: "PRODUCTION_INCOMPLETE",
  outletName: "Cafe Legend Bandung",
  businessDate,
  itemName,
});

const INCOMPLETE_BATCHES: PeriodCloseBlocker[] = [
  incompleteBatch("01JD2K8M4N6P0Q2R4S6T8V0W2A", "Roti brioche", "2026-11-27"),
  incompleteBatch("01JD2K8M4N6P0Q2R4S6T8V0W2B", "Saus karamel", "2026-11-28"),
  incompleteBatch(
    "01JD2K8M4N6P0Q2R4S6T8V0W2C",
    "Adonan croissant",
    "2026-11-30",
  ),
];

const OTHER_BLOCKER: PeriodCloseBlocker = {
  sourceType: "stock_count",
  sourceId: "01JD2K8M4N6P0Q2R4S6T8V0W2D",
  errorCode: "ACCOUNT_MAPPING_MISSING",
  outletName: "Cafe Legend Bandung",
  businessDate: null,
  itemName: null,
};

/** Parked sources of a scenario; none outside the blocked scenarios. */
function blockedSourcesFor(scenario: string): PeriodCloseBlocker[] {
  if (
    scenario === "period-close-blocked" ||
    scenario === "period-close-blocked-cleared"
  )
    return INCOMPLETE_BATCHES.map((row) => ({ ...row }));
  if (scenario === "period-close-blocked-other")
    return [
      ...INCOMPLETE_BATCHES.slice(0, 2).map((row) => ({ ...row })),
      { ...OTHER_BLOCKER },
    ];
  return [];
}

const isBlockedScenario = (scenario: string) =>
  scenario.startsWith("period-close-blocked");

register(listPeriodCloseBlockers, ({ params, scenario }) => {
  findPeriod(params.fiscalPeriodId);
  // "cleared": the refusal happened, but nothing is parked any more.
  const sources =
    scenario === "period-close-blocked-cleared"
      ? []
      : blockedSourcesFor(scenario);
  return {
    data: {
      count: sources.length,
      overridable:
        sources.length > 0 &&
        sources.every((row) => row.errorCode === "PRODUCTION_INCOMPLETE"),
      sources,
    },
  };
});

register(closeFiscalPeriodOverride, ({ params, body, scenario }) => {
  const current = state.get();
  const replayKey = `override:${params.fiscalPeriodId}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) return { data: findPeriod(replayed) };

  const period = findPeriod(params.fiscalPeriodId);
  assertPeriodVersion(period, body.expectedVersion);
  const sources = blockedSourcesFor(scenario);
  if (sources.some((row) => row.errorCode !== "PRODUCTION_INCOMPLETE"))
    throw new ApiError(
      422,
      "PERIOD_INVENTORY_GL_BLOCKED",
      PERIOD_INVENTORY_GL_BLOCKED_MESSAGE,
    );
  const shown = new Set(sources.map((row) => row.sourceId));
  if (
    scenario === "period-close-blocked-cleared" ||
    shown.size !== body.sourceIds.length ||
    body.sourceIds.some((id) => !shown.has(id))
  )
    throw new ApiError(
      409,
      "PERIOD_OVERRIDE_SOURCES_CHANGED",
      "Daftar batch yang tertahan berubah. Muat ulang daftar, lalu ulangi.",
    );
  const closed = decidePeriodClose({
    period,
    entityPeriods: current.periods,
    today: STOCK_BLOCK_TODAY,
    actorId: requester(),
    now: nowIso(),
  });
  current.snapshots.set(closed.id, snapshotFor(closed));
  replacePeriod(closed);
  current.created.set(replayKey, closed.id);
  return { data: findPeriod(closed.id) };
});

register(closeFiscalPeriod, ({ params, body, scenario }) => {
  const current = state.get();
  const replayKey = `close:${params.fiscalPeriodId}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) return { data: findPeriod(replayed) };

  const period = findPeriod(params.fiscalPeriodId);
  // ACC-02: a stale screen cannot close a period that changed underneath it.
  assertPeriodVersion(period, body.expectedVersion);
  const closed = decidePeriodClose({
    period,
    entityPeriods: current.periods,
    today: isBlockedScenario(scenario) ? STOCK_BLOCK_TODAY : fixtures.asOf,
    actorId: requester(),
    now: nowIso(),
  });
  // "cleared" refuses once, then the retry closes like a normal period.
  const refuse =
    scenario === "period-close-blocked-cleared"
      ? !current.refusedOnce.has(period.id)
      : blockedSourcesFor(scenario).length > 0;
  if (refuse) {
    current.refusedOnce.add(period.id);
    throw new ApiError(
      422,
      "PERIOD_INVENTORY_GL_BLOCKED",
      PERIOD_INVENTORY_GL_BLOCKED_MESSAGE,
    );
  }
  current.snapshots.set(closed.id, snapshotFor(closed));
  replacePeriod(closed);
  current.created.set(replayKey, closed.id);
  return { data: findPeriod(closed.id) };
});

register(getPeriodSnapshot, ({ params }) => {
  const period = findPeriod(params.fiscalPeriodId);
  const stored = state.get().snapshots.get(period.id);
  // September's close predates the fixture's stored snapshot; rebuild the row
  // the close would have written. An open period keeps its last snapshot
  // (history after a reopen); never closed means no snapshot.
  if (!stored && period.status !== "closed")
    throw new ApiError(
      404,
      "NOT_FOUND",
      "Snapshot hanya tersedia untuk periode yang pernah ditutup.",
    );
  const snapshot = stored ?? snapshotFor(period);
  if (!stored) state.get().snapshots.set(period.id, snapshot);
  // Like the API: the period's current status and version ride along.
  return {
    data: periodCloseSnapshotSchema.parse({
      ...snapshot,
      periodStatus: period.status,
      periodVersion: period.version,
    }),
  };
});

register(requestPeriodReopen, ({ params, body }) => {
  const period = findPeriod(params.fiscalPeriodId);
  assertReopenRequestable(period, body.reason);
  const request = periodReopenRequestSchema.parse({
    id: newIdempotencyKey(),
    tenantId,
    legalEntityId: period.legalEntityId,
    fiscalPeriodId: period.id,
    period: period.period,
    reason: body.reason.trim(),
    status: "pending",
    requestedBy: requester(),
    requestedAt: nowIso(),
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
  });
  state.get().requests.unshift(request);
  return { data: request };
});

register(listPeriodReopenRequests, ({ params, scenario }) => {
  if (scenario === "empty") return { data: [] };
  const rows = state
    .get()
    .requests.filter(
      (request) => request.legalEntityId === params.legalEntityId,
    )
    .sort(
      (left, right) =>
        right.requestedAt.localeCompare(left.requestedAt) ||
        left.id.localeCompare(right.id),
    );
  return { data: rows };
});

register(approvePeriodReopen, ({ params, body }) => {
  const current = state.get();
  const index = current.requests.findIndex(
    (request) => request.id === params.requestId,
  );
  if (index === -1) throw notFound("Permintaan buka ulang tidak ditemukan.");
  const request = current.requests[index]!;
  const period = findPeriod(request.fiscalPeriodId);
  const decidedAt = nowIso();
  const actorId = decider();
  // ACC-02 + AUTH-06: the contract refuses an approval by the requester
  // (APPROVER_IS_REQUESTER), a stale request and an out-of-order reopen.
  const decision = decidePeriodReopen({
    request,
    period,
    entityPeriods: current.periods,
    decision: "approve",
    actorId,
    now: decidedAt,
  });
  if (decision.requestStatus !== "approved" || decision.period === null)
    throw new ApiError(
      409,
      "INVALID_TRANSITION",
      "Permintaan tidak disetujui.",
    );
  const nextRequest = periodReopenRequestSchema.parse({
    ...request,
    status: "approved",
    decidedBy: actorId,
    decidedAt,
    decisionNote: body.note,
  });
  current.requests[index] = nextRequest;
  const nextPeriod = fiscalPeriodSchema.parse(decision.period);
  replacePeriod(nextPeriod);
  return { data: { request: nextRequest, period: nextPeriod } };
});

register(rejectPeriodReopen, ({ params, body }) => {
  const current = state.get();
  const index = current.requests.findIndex(
    (request) => request.id === params.requestId,
  );
  if (index === -1) throw notFound("Permintaan buka ulang tidak ditemukan.");
  const request = current.requests[index]!;
  const period = findPeriod(request.fiscalPeriodId);
  const decidedAt = nowIso();
  const actorId = decider();
  decidePeriodReopen({
    request,
    period,
    entityPeriods: current.periods,
    decision: "reject",
    actorId,
    now: decidedAt,
  });
  const nextRequest = periodReopenRequestSchema.parse({
    ...request,
    status: "rejected",
    decidedBy: actorId,
    decidedAt,
    decisionNote: body.reason,
  });
  current.requests[index] = nextRequest;
  return { data: nextRequest };
});
