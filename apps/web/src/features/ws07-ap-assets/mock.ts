// Mock handlers for the AP/AR, fixed-asset and budget screens
// (`VITE_API_MOCK=true`), so every screen works with no API
// (docs/frontend.md "Typed endpoints and mock mode"). They serve the Cafe
// Legend accounting fixtures and run the same contract helpers the real API
// runs: buildAgingReport for the aging view, straightLineSchedule /
// depreciationForPeriod for the register and its runs, budgetVariance for the
// budget report, and disposalResultIdr for the disposal preview. Mutations live
// in a mock store, so the screens are clickable and every store re-seeds on
// resetMocks().
//
// Loaded in Node by tests/ws07-ap-assets.test.mjs, so every import here is a
// bare package import or a relative `.ts` path (no `@/` alias).
import {
  AccountingError,
  assertPostingAllowed,
  budgetSchema,
  buildAgingReport,
  accountMapFor,
  buildJournalLinesFromRule,
  defaultPostingRules,
  resolvePostingRule,
  cafeLegendAccountingFixtures,
  createFixedAsset,
  depreciationForPeriod,
  depreciationRunSchema,
  disposeFixedAsset,
  disposalResultIdr,
  fixedAssetSchema,
  budgetVariance,
  getAgingReport,
  getBudgetVsActual,
  getFixedAsset,
  listBudgets,
  listDepreciationRuns,
  listFixedAssets,
  revalueFixedAsset,
  runDepreciation,
  straightLineSchedule,
  upsertBudgets,
  type Account,
  type Budget,
  type DepreciationRun,
  type FixedAsset,
  type OpenItem,
} from "@starter/shared/accounting";
import type { AnyEndpoint } from "@starter/shared/api";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock, type MockHandler } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import { postMockSystemJournal } from "../ws07-accounting/mock.ts";

const fixtures = cafeLegendAccountingFixtures;
const tenantId = fixtures.tenantId;
const accountById = new Map(
  fixtures.accounts.map((account) => [account.id, account]),
);

type ApAssetsMockState = {
  openItems: OpenItem[];
  assets: FixedAsset[];
  runs: DepreciationRun[];
  budgets: Budget[];
  /** Idempotency and replay: request key → created id. */
  created: Map<string, string>;
};

const state = createMockStore<ApAssetsMockState>(() => ({
  openItems: [...fixtures.openItems],
  assets: [...fixtures.fixedAssets],
  runs: [...fixtures.depreciationRuns],
  budgets: [...fixtures.budgets],
  created: new Map(),
}));

/**
 * Registers a handler and maps the contract's own errors the way the API does:
 * `AccountingError` carries `code` and `status`, but the mock runtime only
 * knows `ApiError`/`CoreError`, so a refusal would surface as INTERNAL_ERROR.
 */
function register<E extends AnyEndpoint>(
  endpoint: E,
  handler: MockHandler<E>,
): void {
  registerMock(endpoint, (context) => {
    try {
      return handler(context);
    } catch (error) {
      if (error instanceof AccountingError)
        throw new ApiError(error.status, error.code, error.message);
      throw error;
    }
  });
}

function notFound(message: string): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}

function invalid(message: string): ApiError {
  return new ApiError(422, "VALIDATION_ERROR", message);
}

function assertEntity(legalEntityId: string): void {
  if (legalEntityId !== fixtures.legalEntity.id)
    throw notFound("Badan usaha tidak ditemukan.");
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * ACC-02: a run, disposal or revaluation posts a journal, so it is refused in a
 * month the fixtures mark closed, like the API. A month with no period row is
 * treated as open (the fixtures list Sep–Nov 2026 only).
 */
function assertOpenMonth(businessDate: string): void {
  const period = fixtures.fiscalPeriods.find(
    (row) => row.period === businessDate.slice(0, 7),
  );
  if (period) assertPostingAllowed(period, businessDate);
}

/** "2026-11" → "2026-11-30" (calendar month end, UTC-safe). */
function lastDayOfPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const day = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return `${period}-${String(day).padStart(2, "0")}`;
}

function findAsset(fixedAssetId: string): FixedAsset {
  const asset = state.get().assets.find((row) => row.id === fixedAssetId);
  if (!asset) throw notFound("Aset tetap tidak ditemukan.");
  return asset;
}

function findBudgetIndex(input: {
  legalEntityId: string;
  outletId: string | null;
  accountId: string;
  period: string;
}): number {
  return state
    .get()
    .budgets.findIndex(
      (row) =>
        row.legalEntityId === input.legalEntityId &&
        row.outletId === input.outletId &&
        row.accountId === input.accountId &&
        row.period === input.period,
    );
}

/** Natural-sign actual: revenue as credit, expense/asset as debit. */
function postedActualIdr(
  period: string,
  accountId: Account["id"],
  outletId: string | null,
): number {
  const account = accountById.get(accountId);
  if (!account) return 0;
  const debitPositive = account.type === "asset" || account.type === "expense";
  let total = 0;
  for (const entry of fixtures.journals) {
    if (entry.entryDate.slice(0, 7) !== period) continue;
    if (outletId !== null && entry.outletId !== outletId) continue;
    for (const line of entry.lines) {
      if (line.accountId !== accountId) continue;
      total += debitPositive
        ? line.debitIdr - line.creditIdr
        : line.creditIdr - line.debitIdr;
    }
  }
  return total;
}

// ---- Aging ----------------------------------------------------------------

register(getAgingReport, ({ query, scenario }) => {
  assertEntity(query.legalEntityId);
  const items =
    scenario === "empty"
      ? []
      : state
          .get()
          .openItems.filter(
            (item) =>
              item.legalEntityId === query.legalEntityId &&
              item.kind === query.kind &&
              (!query.outletId || item.outletId === query.outletId),
          );
  return {
    data: buildAgingReport(
      items,
      query.kind,
      query.asOf,
      fixtures.agingBucketLimits,
    ),
  };
});

// ---- Fixed assets ---------------------------------------------------------

register(listFixedAssets, ({ params, scenario }) => {
  assertEntity(params.legalEntityId);
  if (scenario === "empty") return { data: [] };
  const rows = state
    .get()
    .assets.filter((asset) => asset.legalEntityId === params.legalEntityId)
    .sort(
      (a, b) =>
        b.acquiredOn.localeCompare(a.acquiredOn) ||
        a.name.localeCompare(b.name),
    );
  return { data: rows };
});

register(createFixedAsset, ({ body }) => {
  assertEntity(body.legalEntityId);
  const current = state.get();
  const replayKey = `asset:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) {
    const asset = current.assets.find((row) => row.id === replayed);
    if (asset) return { data: asset };
  }
  const asset = fixedAssetSchema.parse({
    id: newIdempotencyKey(),
    tenantId,
    legalEntityId: body.legalEntityId,
    outletId: body.outletId,
    code:
      body.code ||
      `FA-${String(current.assets.length + 1).padStart(5, "0")}`,
    categoryId: body.categoryId ?? null,
    categoryName: null,
    name: body.name,
    acquiredOn: body.acquiredOn,
    costIdr: body.costIdr,
    originalCostIdr: body.costIdr,
    revaluationSurplusIdr: 0,
    revaluationLossIdr: 0,
    residualValueIdr: body.residualValueIdr,
    usefulLifeMonths: body.usefulLifeMonths,
    method: "straight_line",
    depreciationStartPeriod: body.depreciationStartPeriod,
    sourceDocumentId: body.sourceDocumentId,
    accumulatedDepreciationIdr: 0,
    status: "active",
    disposedOn: null,
    disposalProceedsIdr: null,
  });
  current.assets.unshift(asset);
  current.created.set(replayKey, asset.id);
  return { data: asset };
});

register(getFixedAsset, ({ params, scenario }) => {
  if (scenario === "empty") throw notFound("Aset tetap tidak ditemukan.");
  const asset = findAsset(params.fixedAssetId);
  return { data: { asset, schedule: straightLineSchedule(asset) } };
});

register(disposeFixedAsset, ({ params, body }) => {
  const current = state.get();
  const replayKey = `dispose:${params.fixedAssetId}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) {
    const asset = current.assets.find((row) => row.id === replayed);
    if (asset) return { data: asset };
  }
  const asset = findAsset(params.fixedAssetId);
  // The contract refuses a second disposal and supplies the gain/loss rule.
  disposalResultIdr(asset, body.proceedsIdr);
  if (body.disposedOn < asset.acquiredOn)
    throw invalid("Tanggal pelepasan tidak boleh sebelum tanggal perolehan.");
  assertOpenMonth(body.disposedOn);
  const next = fixedAssetSchema.parse({
    ...asset,
    status: "disposed",
    disposedOn: body.disposedOn,
    disposalProceedsIdr: body.proceedsIdr,
  });
  current.assets = current.assets.map((row) =>
    row.id === next.id ? next : row,
  );
  current.created.set(replayKey, next.id);
  return { data: next };
});

register(revalueFixedAsset, ({ params, body }) => {
  const current = state.get();
  const replayKey = `revalue:${params.fixedAssetId}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) {
    const asset = current.assets.find((row) => row.id === replayed);
    if (asset) return { data: asset };
  }
  const asset = findAsset(params.fixedAssetId);
  if (asset.status === "disposed")
    throw new AccountingError("ASSET_ALREADY_DISPOSED");
  assertOpenMonth(body.revaluedOn);
  if (
    body.newCarryingAmountIdr < asset.residualValueIdr ||
    body.newCarryingAmountIdr > asset.costIdr
  )
    throw invalid(
      "Nilai buku baru harus antara nilai residu dan harga perolehan.",
    );
  const depreciableBase = asset.costIdr - asset.residualValueIdr;
  const accumulatedDepreciationIdr = asset.costIdr - body.newCarryingAmountIdr;
  const next = fixedAssetSchema.parse({
    ...asset,
    accumulatedDepreciationIdr,
    status:
      accumulatedDepreciationIdr >= depreciableBase
        ? "fully_depreciated"
        : "active",
  });
  current.assets = current.assets.map((row) =>
    row.id === next.id ? next : row,
  );
  current.created.set(replayKey, next.id);
  return { data: next };
});

// ---- Depreciation runs ----------------------------------------------------

register(listDepreciationRuns, ({ params, scenario }) => {
  assertEntity(params.legalEntityId);
  if (scenario === "empty") return { data: [] };
  const rows = state
    .get()
    .runs.filter((run) => run.legalEntityId === params.legalEntityId)
    .sort(
      (a, b) =>
        b.period.localeCompare(a.period) ||
        b.postedAt.localeCompare(a.postedAt),
    );
  return { data: rows };
});

register(runDepreciation, ({ body }) => {
  assertEntity(body.legalEntityId);
  const current = state.get();
  const replayKey = `run:${body.legalEntityId}:${body.period}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) {
    const run = current.runs.find((row) => row.id === replayed);
    if (run) return { data: run };
  }
  // One depreciation run per entity and period: a rerun returns the booked
  // run instead of depreciating the same month twice. The contract has no
  // "already run" code; the API must decide the same way.
  const existing = current.runs.find(
    (run) =>
      run.legalEntityId === body.legalEntityId && run.period === body.period,
  );
  if (existing) return { data: existing };
  assertOpenMonth(`${body.period}-01`);
  const lines: { fixedAssetId: string; amountIdr: number }[] = [];
  for (const asset of current.assets) {
    if (asset.legalEntityId !== body.legalEntityId) continue;
    if (asset.status === "disposed") continue;
    const amountIdr = depreciationForPeriod(asset, body.period);
    if (amountIdr > 0) lines.push({ fixedAssetId: asset.id, amountIdr });
  }
  const amountIdr = lines.reduce((sum, line) => sum + line.amountIdr, 0);
  const runId = newIdempotencyKey();
  // Book the run's journal in the journals mock so its link opens a real
  // entry (same posting rule as the fixture October run).
  const journal =
    amountIdr > 0
      ? postMockSystemJournal({
          entryDate: lastDayOfPeriod(body.period),
          sourceType: "depreciation",
          sourceId: runId,
          description: `Penyusutan ${body.period}`,
          outletId: null,
          lines: buildJournalLinesFromRule(
            resolvePostingRule(defaultPostingRules, {
              sourceType: "depreciation",
            }),
            { amountIdr },
            accountMapFor(fixtures.accountMappings, body.legalEntityId),
            { outletId: null },
          ),
        })
      : null;
  const run = depreciationRunSchema.parse({
    id: runId,
    tenantId,
    legalEntityId: body.legalEntityId,
    period: body.period,
    amountIdr,
    lines,
    journalEntryId: journal?.id ?? null,
    postedBy: fixtures.users.finance,
    postedAt: nowIso(),
  });
  current.runs.unshift(run);
  const byAsset = new Map(lines.map((line) => [line.fixedAssetId, line]));
  current.assets = current.assets.map((asset) => {
    const line = byAsset.get(asset.id);
    if (!line) return asset;
    const depreciableBase = asset.costIdr - asset.residualValueIdr;
    const accumulatedDepreciationIdr = Math.min(
      depreciableBase,
      asset.accumulatedDepreciationIdr + line.amountIdr,
    );
    return fixedAssetSchema.parse({
      ...asset,
      accumulatedDepreciationIdr,
      status:
        accumulatedDepreciationIdr >= depreciableBase
          ? "fully_depreciated"
          : asset.status,
    });
  });
  current.created.set(replayKey, run.id);
  return { data: run };
});

// ---- Budgets --------------------------------------------------------------

register(listBudgets, ({ query, scenario }) => {
  assertEntity(query.legalEntityId);
  if (scenario === "empty") return { data: [] };
  const rows = state
    .get()
    .budgets.filter(
      (row) =>
        row.legalEntityId === query.legalEntityId &&
        row.period === query.period &&
        (!query.outletId || row.outletId === query.outletId),
    )
    .sort((a, b) => {
      const left = accountById.get(a.accountId)?.code ?? "";
      const right = accountById.get(b.accountId)?.code ?? "";
      return left.localeCompare(right);
    });
  return { data: rows };
});

register(upsertBudgets, ({ body }) => {
  assertEntity(body.legalEntityId);
  const current = state.get();
  const touched: Budget[] = [];
  for (const row of body.rows) {
    const index = findBudgetIndex({
      legalEntityId: body.legalEntityId,
      outletId: row.outletId,
      accountId: row.accountId,
      period: row.period,
    });
    if (index === -1) {
      const budget = budgetSchema.parse({
        id: newIdempotencyKey(),
        tenantId,
        legalEntityId: body.legalEntityId,
        outletId: row.outletId,
        accountId: row.accountId,
        period: row.period,
        amountIdr: row.amountIdr,
      });
      current.budgets.push(budget);
      touched.push(budget);
      continue;
    }
    const budget = budgetSchema.parse({
      ...current.budgets[index],
      amountIdr: row.amountIdr,
    });
    current.budgets[index] = budget;
    touched.push(budget);
  }
  return { data: touched };
});

register(getBudgetVsActual, ({ query, scenario }) => {
  assertEntity(query.legalEntityId);
  if (scenario === "empty") return { data: [] };
  const budgetRows = state
    .get()
    .budgets.filter(
      (row) =>
        row.legalEntityId === query.legalEntityId &&
        row.period === query.period &&
        (!query.outletId || row.outletId === query.outletId),
    );
  const rows = budgetRows
    .map((budget) => {
      const account = accountById.get(budget.accountId);
      if (!account) return null;
      const actualIdr = postedActualIdr(
        budget.period,
        budget.accountId,
        budget.outletId,
      );
      const variance = budgetVariance(budget.amountIdr, actualIdr);
      return {
        accountId: budget.accountId,
        accountCode: account.code,
        accountName: account.name,
        outletId: budget.outletId,
        budgetIdr: budget.amountIdr,
        actualIdr,
        varianceIdr: variance.varianceIdr,
        varianceBp: variance.varianceBp,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  return { data: rows };
});
