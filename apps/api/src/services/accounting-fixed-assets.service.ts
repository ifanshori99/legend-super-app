// Fixed assets (PRD v1.7 §3.19 "Aset Tetap [P0] — Registrasi aset dari
// pembelian, depresiasi otomatis, revaluasi, dan penjualan aset"; §3.19
// Jurnal Otomatis "depresiasi"; §6 F `fixed_assets`, `depreciation_runs`;
// ACC-01/ACC-02; bead legend-hpgo). Contract: assets.ts, posting-rules.ts.
//
// Every journal goes through the accounting posting API
// (accounting-journal.service.ts) inside the same tenant transaction as the
// asset change: balanced, append-only, refused in a closed period (ACC-02),
// emitted as `journal.posted` through the outbox.
//
// Depreciation (straight line, contract `straightLineSchedule`: the schedule
// sums to cost − residual exactly, earlier months take the extra rupiah):
// - The ledger `fixed_asset_depreciations` has one row per asset and schedule
//   period (UNIQUE), so depreciation is idempotent per asset+period.
// - A run for period P posts, per active asset, every scheduled month <= P
//   that is not in the ledger yet (catch-up of a backdated asset lands in the
//   first open run instead of a closed month), in one journal dated the last
//   day of P with one debit/credit pair per outlet (outlet P&L, ACC-03).
// - One run per legal entity and period (UNIQUE); the run is serialized by an
//   advisory lock per entity and locks its assets FOR UPDATE, so a disposal or
//   revaluation of the same asset waits for it (and vice versa).
// - Contract `depreciationForPeriod` charges the disposal month, so a disposal
//   or revaluation first catches the asset up through its own month.
//
// Revaluation uses the elimination method (PRD silent on the method; chosen as
// the one that keeps the contract schedule valid): accumulated depreciation is
// eliminated against cost, cost becomes the new carrying amount, and the new
// base is depreciated over the remaining months from the next period. The
// journal posts through the `document:asset_revaluation` rule; while the
// contract has no such rule it fails closed with POSTING_RULE_MISSING.

import type { TenantId } from "@starter/shared/core";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  AccountingError,
  buildJournalLinesFromRule,
  createFixedAssetInputSchema,
  defaultPostingRules,
  depreciationRunPostedEvent,
  depreciationRunSchema,
  disposalResultIdr,
  disposeFixedAssetInputSchema,
  fixedAssetDerivedFields,
  fixedAssetSchema,
  nextPeriod,
  periodBounds,
  periodOf,
  resolvePostingRule,
  revalueFixedAssetInputSchema,
  runDepreciationInputSchema,
  straightLineSchedule,
  type DepreciationRun,
  type DepreciationScheduleRow,
  type FixedAsset,
  type JournalLineInput,
} from "@starter/shared/accounting";
import {
  assertTrustedScopedContext,
  createUlid,
  type BusinessDate,
  type Idr,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { db } from "../db";
import {
  assetCategories,
  depreciationRuns,
  fixedAssetDepreciations,
  fixedAssetRevaluations,
  fixedAssets,
  type DepreciationRunRow,
  type FixedAssetRow,
} from "../db/schema/accounting-ap-fa.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  postJournalFromRuleInTransaction,
  postJournalInTransaction,
} from "./accounting-journal.service.ts";
import {
  advisoryLock,
  assertOutletReach,
  assertTenantScope,
  auditApFa,
  entityToday,
  idempotentCommand,
  loadAccountMap,
  newId,
  outletVisible,
  type TenantTransaction,
} from "./accounting-ap-fa-shared.ts";
import { requireAssetCategory } from "./accounting-asset-categories.service.ts";
import { requireLegalEntity, requireOutlet } from "./accounting-shared.ts";
import { appendOutbox } from "./core-outbox.ts";

/** Consumers receive accounting events through the cloud sync stream. */
const EVENT_DESTINATION = "cloud-sync";

type ScheduleBasis = Pick<
  FixedAsset,
  | "costIdr"
  | "residualValueIdr"
  | "usefulLifeMonths"
  | "depreciationStartPeriod"
>;

const invalid = (message: string) =>
  new HttpError(422, "VALIDATION_ERROR", message);

// ------------------------------------------------------------ pure rules

/**
 * Scheduled months up to `uptoPeriod` that the ledger has not posted yet.
 * Zero months (base smaller than the life) carry nothing and are skipped.
 */
export function pendingDepreciation(
  basis: ScheduleBasis,
  postedPeriods: ReadonlySet<string>,
  uptoPeriod: string,
): DepreciationScheduleRow[] {
  return straightLineSchedule(basis).filter(
    (row) =>
      row.period <= uptoPeriod &&
      row.amountIdr > 0 &&
      !postedPeriods.has(row.period),
  );
}

export type RevaluationPlan = {
  readonly amounts: {
    accumulatedIdr: number;
    costChangeIdr: number;
    surplusIdr: number;
    lossIdr: number;
  };
  readonly newStartPeriod: string;
  readonly remainingMonths: number;
};

/**
 * Elimination-method revaluation (§3.19 "revaluasi"; method: decision).
 * Journal: debit accumulated depreciation (eliminate), debit/credit fixed
 * assets by (new carrying − cost), credit revaluation surplus for an increase
 * or debit revaluation loss for a decrease. Balanced by construction:
 * accumulated + (new − cost) + loss = surplus.
 */
export function revaluationPlan(
  asset: ScheduleBasis & Pick<FixedAsset, "accumulatedDepreciationIdr">,
  revaluedOn: string,
  newCarryingAmountIdr: number,
): RevaluationPlan {
  const newStartPeriod = [
    asset.depreciationStartPeriod,
    nextPeriod(periodOf(revaluedOn)),
  ].sort()[1]!;
  const remainingMonths = straightLineSchedule(asset).filter(
    (row) => row.period >= newStartPeriod,
  ).length;
  if (remainingMonths === 0)
    throw invalid("The asset has no remaining useful life to revalue.");
  if (newCarryingAmountIdr <= asset.residualValueIdr)
    throw invalid(
      "The new carrying amount must stay above the residual value; dispose the asset instead.",
    );
  const carrying = asset.costIdr - asset.accumulatedDepreciationIdr;
  const delta = newCarryingAmountIdr - carrying;
  if (delta === 0 && asset.accumulatedDepreciationIdr === 0)
    throw invalid("The new carrying amount equals the current one.");
  return {
    amounts: {
      accumulatedIdr: asset.accumulatedDepreciationIdr,
      costChangeIdr: newCarryingAmountIdr - asset.costIdr,
      surplusIdr: Math.max(delta, 0),
      lossIdr: Math.max(-delta, 0),
    },
    newStartPeriod,
    remainingMonths,
  };
}

// ------------------------------------------------------------- mapping

/** Read-side fields that are not stored on the asset row. */
export type FixedAssetSummary = Pick<
  FixedAsset,
  | "categoryName"
  | "originalCostIdr"
  | "revaluationSurplusIdr"
  | "revaluationLossIdr"
>;

/** Summary of an asset that has never been revalued and has no category. */
const plainSummary = (row: FixedAssetRow): FixedAssetSummary => ({
  categoryName: null,
  originalCostIdr: row.costIdr,
  revaluationSurplusIdr: 0 as Idr,
  revaluationLossIdr: 0 as Idr,
});

export function toFixedAsset(
  row: FixedAssetRow,
  summary: FixedAssetSummary = plainSummary(row),
): FixedAsset {
  return fixedAssetSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    outletId: row.outletId,
    code: row.code,
    categoryId: row.categoryId,
    categoryName: summary.categoryName,
    name: row.name,
    acquiredOn: row.acquiredOn,
    costIdr: row.costIdr,
    originalCostIdr: summary.originalCostIdr,
    revaluationSurplusIdr: summary.revaluationSurplusIdr,
    revaluationLossIdr: summary.revaluationLossIdr,
    residualValueIdr: row.residualValueIdr,
    usefulLifeMonths: row.usefulLifeMonths,
    method: row.method,
    depreciationStartPeriod: row.depreciationStartPeriod,
    sourceDocumentId: row.sourceDocumentId,
    accumulatedDepreciationIdr: row.accumulatedDepreciationIdr,
    status: row.status,
    disposedOn: row.disposedOn,
    disposalProceedsIdr: row.disposalProceedsIdr,
    ...fixedAssetDerivedFields(row),
  });
}

/**
 * Hydrates asset rows with category name and revaluation summary using two
 * set-based queries for the whole batch (no per-asset lookups).
 *
 * The surplus is not stored: each `fixed_asset_revaluations` row carries a
 * delta = new carrying − (previous cost − previous accumulated); surplus is the
 * sum of positive deltas, loss the sum of |negative| deltas. A revaluation
 * restates `cost_idr` (elimination method), so `originalCostIdr` is the
 * previous cost of the earliest revaluation.
 */
async function hydrateAssets(
  tx: TenantTransaction,
  tenantId: TenantId,
  rows: readonly FixedAssetRow[],
): Promise<FixedAsset[]> {
  if (rows.length === 0) return [];
  const categoryIds = [
    ...new Set(
      rows.flatMap((row) => (row.categoryId === null ? [] : [row.categoryId])),
    ),
  ];
  const categories =
    categoryIds.length === 0
      ? []
      : await tx
          .select({ id: assetCategories.id, name: assetCategories.name })
          .from(assetCategories)
          .where(
            and(
              eq(assetCategories.tenantId, tenantId),
              inArray(assetCategories.id, categoryIds),
            ),
          );
  const names = new Map(categories.map((row) => [row.id, row.name]));
  const delta = sql`${fixedAssetRevaluations.newCarryingAmountIdr} - (${fixedAssetRevaluations.previousCostIdr} - ${fixedAssetRevaluations.previousAccumulatedIdr})`;
  const summaries = await tx
    .select({
      fixedAssetId: fixedAssetRevaluations.fixedAssetId,
      originalCost: sql<string>`(array_agg(${fixedAssetRevaluations.previousCostIdr} ORDER BY ${fixedAssetRevaluations.revaluedOn}, ${fixedAssetRevaluations.createdAt}, ${fixedAssetRevaluations.id}))[1]`,
      surplus: sql<string>`coalesce(sum(greatest(${delta}, 0)), 0)`,
      loss: sql<string>`coalesce(sum(greatest(-(${delta}), 0)), 0)`,
    })
    .from(fixedAssetRevaluations)
    .where(
      and(
        eq(fixedAssetRevaluations.tenantId, tenantId),
        inArray(
          fixedAssetRevaluations.fixedAssetId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .groupBy(fixedAssetRevaluations.fixedAssetId);
  const byAsset = new Map(summaries.map((row) => [row.fixedAssetId, row]));
  return rows.map((row) => {
    const revaluation = byAsset.get(row.id);
    return toFixedAsset(row, {
      categoryName:
        row.categoryId === null ? null : (names.get(row.categoryId) ?? null),
      originalCostIdr: (revaluation
        ? Number(revaluation.originalCost)
        : row.costIdr) as Idr,
      revaluationSurplusIdr: Number(revaluation?.surplus ?? 0) as Idr,
      revaluationLossIdr: Number(revaluation?.loss ?? 0) as Idr,
    });
  });
}

/** One hydrated asset (writes return the same shape as reads). */
async function hydrateAsset(
  tx: TenantTransaction,
  tenantId: TenantId,
  row: FixedAssetRow,
): Promise<FixedAsset> {
  const [asset] = await hydrateAssets(tx, tenantId, [row]);
  if (!asset) throw new Error("Fixed asset hydration returned no row.");
  return asset;
}

function toRun(
  row: DepreciationRunRow,
  lines: readonly { fixedAssetId: string; amountIdr: number }[],
): DepreciationRun {
  const byAsset = new Map<string, number>();
  for (const line of lines)
    byAsset.set(
      line.fixedAssetId,
      (byAsset.get(line.fixedAssetId) ?? 0) + line.amountIdr,
    );
  return depreciationRunSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    period: row.period,
    amountIdr: row.amountIdr,
    lines: [...byAsset.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fixedAssetId, amountIdr]) => ({ fixedAssetId, amountIdr })),
    journalEntryId: row.journalEntryId,
    postedBy: row.postedBy,
    postedAt: row.postedAt.toISOString(),
  });
}

// ------------------------------------------------------------- helpers

/**
 * Lock order shared with the run: the entity's depreciation advisory lock
 * first, then the asset row FOR UPDATE. A disposal/revaluation and a run on
 * the same entity therefore serialize instead of deadlocking.
 */
async function lockAsset(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  fixedAssetId: string,
): Promise<FixedAssetRow> {
  const tenantId = context.tenant.tenantId;
  const where = and(
    eq(fixedAssets.tenantId, tenantId),
    eq(fixedAssets.id, fixedAssetId),
  );
  const [peek] = await tx
    .select({
      legalEntityId: fixedAssets.legalEntityId,
      outletId: fixedAssets.outletId,
    })
    .from(fixedAssets)
    .where(where)
    .limit(1);
  // TEN-03: an asset outside the caller's outlets is indistinguishable from
  // a missing one.
  if (!peek || !outletVisible(context, peek.outletId))
    throw new HttpError(404, "NOT_FOUND", "Fixed asset not found.");
  await advisoryLock(tx, `fa-dep:${tenantId}:${peek.legalEntityId}`);
  const [row] = await tx
    .select()
    .from(fixedAssets)
    .where(where)
    .limit(1)
    .for("update");
  if (!row) throw new HttpError(404, "NOT_FOUND", "Fixed asset not found.");
  return row;
}

async function postedPeriodsByAsset(
  tx: TenantTransaction,
  tenantId: TenantId,
  assetIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (assetIds.length === 0) return result;
  const rows = await tx
    .select({
      fixedAssetId: fixedAssetDepreciations.fixedAssetId,
      period: fixedAssetDepreciations.period,
    })
    .from(fixedAssetDepreciations)
    .where(
      and(
        eq(fixedAssetDepreciations.tenantId, tenantId),
        inArray(fixedAssetDepreciations.fixedAssetId, [...assetIds]),
      ),
    );
  for (const row of rows) {
    const periods = result.get(row.fixedAssetId) ?? new Set<string>();
    periods.add(row.period);
    result.set(row.fixedAssetId, periods);
  }
  return result;
}

/**
 * Posts one `document:depreciation` journal: one debit/credit pair per outlet
 * (null outlet = entity-level line), lines in a deterministic order so a
 * replay produces the same request fingerprint.
 */
async function postDepreciationJournal(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  input: {
    legalEntityId: string;
    entryOutletId: string | null;
    entryDate: BusinessDate;
    sourceId: string;
    perOutlet: ReadonlyMap<string | null, number>;
    postedBy: UserId | null;
    idempotencyKey: string;
    description: string;
  },
  now: Date,
): Promise<string> {
  const rule = resolvePostingRule(defaultPostingRules, {
    sourceType: "depreciation",
  });
  const accountMap = await loadAccountMap(
    tx,
    context.tenant.tenantId,
    input.legalEntityId,
  );
  const outlets = [...input.perOutlet.keys()].sort((a, b) =>
    (a ?? "").localeCompare(b ?? ""),
  );
  const lines: JournalLineInput[] = outlets.flatMap((outletId) =>
    buildJournalLinesFromRule(
      rule,
      { amountIdr: input.perOutlet.get(outletId) ?? 0 },
      accountMap,
      { outletId: outletId as OutletId | null },
    ),
  );
  const entry = await postJournalInTransaction(
    tx,
    context,
    {
      legalEntityId: input.legalEntityId,
      outletId: input.entryOutletId,
      entryDate: input.entryDate,
      sourceType: "depreciation",
      sourceId: input.sourceId,
      description: input.description,
      lines,
      postedBy: input.postedBy,
      idempotencyKey: input.idempotencyKey,
    },
    now,
  );
  return entry.id;
}

/** Ledger rows + accumulated/status update for one asset. */
async function applyDepreciation(
  tx: TenantTransaction,
  tenantId: TenantId,
  asset: FixedAssetRow,
  rows: readonly DepreciationScheduleRow[],
  runId: string | null,
  journalEntryId: string,
): Promise<FixedAssetRow> {
  const amount = rows.reduce((sum, row) => sum + row.amountIdr, 0);
  await tx.insert(fixedAssetDepreciations).values(
    rows.map((row) => ({
      tenantId,
      fixedAssetId: asset.id,
      period: row.period,
      amountIdr: row.amountIdr,
      runId,
      journalEntryId,
    })),
  );
  const accumulated = asset.accumulatedDepreciationIdr + amount;
  const base = asset.costIdr - asset.residualValueIdr;
  const [updated] = await tx
    .update(fixedAssets)
    .set({
      accumulatedDepreciationIdr: accumulated as Idr,
      status: accumulated >= base ? "fully_depreciated" : "active",
      updatedAt: new Date(),
    })
    .where(
      and(eq(fixedAssets.tenantId, tenantId), eq(fixedAssets.id, asset.id)),
    )
    .returning();
  if (!updated) throw new Error("Fixed asset vanished under its lock.");
  return updated;
}

/**
 * Catches one locked asset up through `uptoPeriod` (disposal / revaluation
 * month), posting a depreciation journal dated `entryDate` when anything is
 * pending. Returns the (possibly updated) asset row.
 */
async function catchUpAsset(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  asset: FixedAssetRow,
  uptoPeriod: string,
  entryDate: BusinessDate,
  actorId: UserId | null,
  idempotencyKey: string,
  now: Date,
): Promise<FixedAssetRow> {
  const tenantId = context.tenant.tenantId;
  const posted = await postedPeriodsByAsset(tx, tenantId, [asset.id]);
  const postedPeriods = posted.get(asset.id) ?? new Set<string>();
  // A disposal/revaluation dated before a month that already carries
  // depreciation would keep the expense of months the asset went (or was
  // measured) before, and compute the gain/loss on a carrying amount it no
  // longer had. Nothing can be un-posted, so fail closed instead (ACC-01:
  // the ledger is append-only; PRD §3.19 is silent on back-dated disposals —
  // decision in the bead report).
  const lastPosted = [...postedPeriods].sort().at(-1);
  if (lastPosted !== undefined && lastPosted > uptoPeriod)
    throw new HttpError(
      409,
      "CONFLICT",
      `Depreciation has already been posted through ${lastPosted}; date the disposal/revaluation in that month or later.`,
    );
  if (asset.status !== "active") return asset;
  const pending = pendingDepreciation(
    toFixedAsset(asset),
    postedPeriods,
    uptoPeriod,
  );
  if (pending.length === 0) return asset;
  const amount = pending.reduce((sum, row) => sum + row.amountIdr, 0);
  const journalEntryId = await postDepreciationJournal(
    tx,
    context,
    {
      legalEntityId: asset.legalEntityId,
      entryOutletId: asset.outletId,
      entryDate,
      sourceId: asset.id,
      perOutlet: new Map([[asset.outletId, amount]]),
      postedBy: actorId,
      idempotencyKey,
      description: `Penyusutan aset tetap s.d. ${uptoPeriod}`,
    },
    now,
  );
  return applyDepreciation(tx, tenantId, asset, pending, null, journalEntryId);
}

function assertNotFuture(date: string, today: string, what: string): void {
  if (date > today) throw invalid(`${what} cannot be in the future.`);
}

/**
 * The register code of a new asset, under an advisory lock per tenant + entity
 * so concurrent registrations neither collide nor surface a unique violation:
 * a supplied code must be free in the entity (409), an empty one becomes the
 * next `FA-nnnnn` after the highest generated-style code of the entity.
 */
async function resolveAssetCode(
  tx: TenantTransaction,
  tenantId: TenantId,
  legalEntityId: string,
  supplied: string | undefined,
): Promise<string> {
  await advisoryLock(tx, `fa-code:${tenantId}:${legalEntityId}`);
  const inEntity = and(
    eq(fixedAssets.tenantId, tenantId),
    eq(fixedAssets.legalEntityId, legalEntityId),
  );
  if (supplied) {
    const [taken] = await tx
      .select({ id: fixedAssets.id })
      .from(fixedAssets)
      .where(and(inEntity, eq(fixedAssets.code, supplied)))
      .limit(1);
    if (taken)
      throw new HttpError(
        409,
        "CONFLICT",
        `Asset code ${supplied} is already used in this legal entity.`,
      );
    return supplied;
  }
  const [last] = await tx
    .select({
      max: sql<number | null>`max(substring(${fixedAssets.code} from 4)::int)`,
    })
    .from(fixedAssets)
    .where(and(inEntity, sql`${fixedAssets.code} ~ '^FA-[0-9]{1,9}$'`));
  return `FA-${String((last?.max ?? 0) + 1).padStart(5, "0")}`;
}

// ------------------------------------------------------------------ reads

export async function listFixedAssets(
  context: ScopedTenantContext,
  legalEntityId: string,
): Promise<{ data: FixedAsset[] }> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await requireLegalEntity(tx, tenantId, legalEntityId);
    const filters = [
      eq(fixedAssets.tenantId, tenantId),
      eq(fixedAssets.legalEntityId, legalEntityId),
    ];
    if (context.outletScope.kind !== "tenant")
      filters.push(
        inArray(fixedAssets.outletId, [...context.outletScope.outletIds]),
      );
    const rows = await tx
      .select()
      .from(fixedAssets)
      .where(and(...filters))
      .orderBy(asc(fixedAssets.acquiredOn), asc(fixedAssets.id));
    return { data: await hydrateAssets(tx, tenantId, rows) };
  });
}

export async function getFixedAsset(
  context: ScopedTenantContext,
  fixedAssetId: string,
): Promise<{ asset: FixedAsset; schedule: DepreciationScheduleRow[] }> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(fixedAssets)
      .where(
        and(
          eq(fixedAssets.tenantId, context.tenant.tenantId),
          eq(fixedAssets.id, fixedAssetId),
        ),
      )
      .limit(1);
    if (!row || !outletVisible(context, row.outletId))
      throw new HttpError(404, "NOT_FOUND", "Fixed asset not found.");
    const asset = await hydrateAsset(tx, context.tenant.tenantId, row);
    return { asset, schedule: straightLineSchedule(asset) };
  });
}

/** Runs are entity-level (one journal for all outlets): tenant scope only. */
export async function listDepreciationRuns(
  context: ScopedTenantContext,
  legalEntityId: string,
): Promise<{ data: DepreciationRun[] }> {
  assertTenantScope(context);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await requireLegalEntity(tx, tenantId, legalEntityId);
    const runs = await tx
      .select()
      .from(depreciationRuns)
      .where(
        and(
          eq(depreciationRuns.tenantId, tenantId),
          eq(depreciationRuns.legalEntityId, legalEntityId),
        ),
      )
      .orderBy(desc(depreciationRuns.period));
    const lines =
      runs.length === 0
        ? []
        : await tx
            .select()
            .from(fixedAssetDepreciations)
            .where(
              and(
                eq(fixedAssetDepreciations.tenantId, tenantId),
                inArray(
                  fixedAssetDepreciations.runId,
                  runs.map((run) => run.id),
                ),
              ),
            );
    return {
      data: runs.map((run) =>
        toRun(
          run,
          lines.filter((line) => line.runId === run.id),
        ),
      ),
    };
  });
}

// ----------------------------------------------------------------- writes

/**
 * Registers an asset (§3.19 "Registrasi aset dari pembelian"). From a
 * purchase (sourceDocumentId set) it posts `document:asset_acquisition`
 * (debit fixed assets / credit accounts payable) dated `acquiredOn`; an asset
 * without a source document (opening balance) posts nothing here — its
 * opening balance is a manual journal (decision, bead report).
 */
export async function createFixedAsset(
  context: ScopedTenantContext,
  rawInput: unknown,
  actorId: UserId,
  now = new Date(),
): Promise<FixedAsset> {
  const input = createFixedAssetInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  assertOutletReach(context, input.outletId);
  if (input.residualValueIdr >= input.costIdr)
    throw invalid("Residual value must be below cost.");
  if (input.depreciationStartPeriod < periodOf(input.acquiredOn))
    throw invalid("Depreciation cannot start before the acquisition month.");
  assertNotFuture(input.acquiredOn, entityToday(now), "Acquisition date");
  const { idempotencyKey, ...request } = input;
  return withTenant(db, context, (tx) =>
    idempotentCommand(
      tx,
      context,
      { key: idempotencyKey, operation: "fixed_asset.create", request },
      async () => {
        const tenantId = context.tenant.tenantId;
        await requireLegalEntity(tx, tenantId, input.legalEntityId);
        if (input.outletId !== null)
          await requireOutlet(tx, tenantId, input.outletId);
        const categoryId = input.categoryId ?? null;
        if (categoryId !== null)
          await requireAssetCategory(tx, tenantId, categoryId);
        const code = await resolveAssetCode(
          tx,
          tenantId,
          input.legalEntityId,
          input.code,
        );
        const id = newId();
        let acquisitionJournalEntryId: string | null = null;
        if (input.sourceDocumentId !== null) {
          const entry = await postJournalFromRuleInTransaction(
            tx,
            context,
            {
              eventName: "document:asset_acquisition",
              amounts: { costIdr: input.costIdr },
              legalEntityId: input.legalEntityId,
              outletId: input.outletId,
              entryDate: input.acquiredOn,
              sourceId: id,
              postedBy: actorId,
              idempotencyKey: `fa-acq:${id}`,
            },
            now,
          );
          acquisitionJournalEntryId = entry.id;
        }
        const [row] = await tx
          .insert(fixedAssets)
          .values({
            id,
            tenantId,
            legalEntityId: input.legalEntityId,
            outletId: input.outletId,
            code,
            categoryId,
            name: input.name,
            acquiredOn: input.acquiredOn,
            costIdr: input.costIdr,
            residualValueIdr: input.residualValueIdr,
            usefulLifeMonths: input.usefulLifeMonths,
            method: "straight_line",
            depreciationStartPeriod: input.depreciationStartPeriod,
            sourceDocumentId: input.sourceDocumentId,
            acquisitionJournalEntryId,
            createdBy: actorId,
          })
          .returning();
        if (!row) throw new Error("Fixed asset insert returned no row.");
        const asset = await hydrateAsset(tx, tenantId, row);
        await auditApFa(tx, context, {
          actorId,
          action: "accounting.fixed_asset.created",
          objectType: "fixed_asset",
          objectId: id,
          outletId: input.outletId,
          before: null,
          after: {
            code: asset.code,
            costIdr: asset.costIdr,
            residualValueIdr: asset.residualValueIdr,
            usefulLifeMonths: asset.usefulLifeMonths,
            depreciationStartPeriod: asset.depreciationStartPeriod,
            acquiredOn: asset.acquiredOn,
            journalEntryId: acquisitionJournalEntryId,
          },
        });
        return asset;
      },
    ),
  );
}

/**
 * Disposal / sale (§3.19 "penjualan aset"): catch up depreciation through the
 * disposal month, then post `document:asset_disposal` — debit bank
 * (proceeds) and accumulated depreciation, credit fixed assets (cost), and
 * the gain (credit) or loss (debit) on `asset_disposal_result`. Audited.
 */
export async function disposeFixedAsset(
  context: ScopedTenantContext,
  fixedAssetId: string,
  rawInput: unknown,
  actorId: UserId,
  now = new Date(),
): Promise<FixedAsset> {
  const input = disposeFixedAssetInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  assertNotFuture(input.disposedOn, entityToday(now), "Disposal date");
  const { idempotencyKey, ...rest } = input;
  return withTenant(db, context, (tx) =>
    idempotentCommand(
      tx,
      context,
      {
        key: idempotencyKey,
        operation: "fixed_asset.dispose",
        request: { fixedAssetId, ...rest },
      },
      async () => {
        const tenantId = context.tenant.tenantId;
        let asset = await lockAsset(tx, context, fixedAssetId);
        assertOutletReach(context, asset.outletId);
        if (asset.status === "disposed")
          throw new AccountingError("ASSET_ALREADY_DISPOSED");
        if (input.disposedOn < asset.acquiredOn)
          throw invalid("An asset cannot be disposed before it was acquired.");
        asset = await catchUpAsset(
          tx,
          context,
          asset,
          periodOf(input.disposedOn),
          input.disposedOn,
          actorId,
          `fa-dep-disp:${asset.id}`,
          now,
        );
        const before = toFixedAsset(asset);
        const resultIdr = disposalResultIdr(before, input.proceedsIdr);
        const entry = await postJournalFromRuleInTransaction(
          tx,
          context,
          {
            eventName: "document:asset_disposal",
            amounts: {
              proceedsIdr: input.proceedsIdr,
              accumulatedIdr: before.accumulatedDepreciationIdr,
              costIdr: before.costIdr,
              resultIdr,
            },
            legalEntityId: asset.legalEntityId,
            outletId: asset.outletId,
            entryDate: input.disposedOn,
            sourceId: asset.id,
            postedBy: actorId,
            idempotencyKey: `fa-disp:${asset.id}`,
          },
          now,
        );
        const [row] = await tx
          .update(fixedAssets)
          .set({
            status: "disposed",
            disposedOn: input.disposedOn,
            disposalProceedsIdr: input.proceedsIdr,
            disposalJournalEntryId: entry.id,
            disposalReason: input.reason,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(fixedAssets.tenantId, tenantId),
              eq(fixedAssets.id, asset.id),
            ),
          )
          .returning();
        if (!row) throw new Error("Fixed asset vanished under its lock.");
        await auditApFa(tx, context, {
          actorId,
          action: "accounting.fixed_asset.disposed",
          objectType: "fixed_asset",
          objectId: asset.id,
          outletId: asset.outletId,
          reason: input.reason,
          before: {
            status: before.status,
            costIdr: before.costIdr,
            accumulatedDepreciationIdr: before.accumulatedDepreciationIdr,
          },
          after: {
            status: "disposed",
            disposedOn: input.disposedOn,
            proceedsIdr: input.proceedsIdr,
            resultIdr,
            journalEntryId: entry.id,
          },
        });
        return hydrateAsset(tx, tenantId, row);
      },
    ),
  );
}

/** Revaluation (§3.19 "revaluasi"), elimination method; audited. */
export async function revalueFixedAsset(
  context: ScopedTenantContext,
  fixedAssetId: string,
  rawInput: unknown,
  actorId: UserId,
  now = new Date(),
): Promise<FixedAsset> {
  const input = revalueFixedAssetInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  assertNotFuture(input.revaluedOn, entityToday(now), "Revaluation date");
  const { idempotencyKey, ...rest } = input;
  return withTenant(db, context, (tx) =>
    idempotentCommand(
      tx,
      context,
      {
        key: idempotencyKey,
        operation: "fixed_asset.revalue",
        request: { fixedAssetId, ...rest },
      },
      async () => {
        const tenantId = context.tenant.tenantId;
        let asset = await lockAsset(tx, context, fixedAssetId);
        assertOutletReach(context, asset.outletId);
        if (asset.status === "disposed")
          throw new AccountingError("ASSET_ALREADY_DISPOSED");
        if (input.revaluedOn < asset.acquiredOn)
          throw invalid("An asset cannot be revalued before it was acquired.");
        const revaluationId = newId();
        asset = await catchUpAsset(
          tx,
          context,
          asset,
          periodOf(input.revaluedOn),
          input.revaluedOn,
          actorId,
          `fa-dep-reval:${revaluationId}`,
          now,
        );
        const before = toFixedAsset(asset);
        const plan = revaluationPlan(
          before,
          input.revaluedOn,
          input.newCarryingAmountIdr,
        );
        const entry = await postJournalFromRuleInTransaction(
          tx,
          context,
          {
            eventName: "document:asset_revaluation",
            amounts: plan.amounts,
            legalEntityId: asset.legalEntityId,
            outletId: asset.outletId,
            entryDate: input.revaluedOn,
            sourceId: revaluationId,
            postedBy: actorId,
            idempotencyKey: `fa-reval:${revaluationId}`,
          },
          now,
        );
        await tx.insert(fixedAssetRevaluations).values({
          id: revaluationId,
          tenantId,
          fixedAssetId: asset.id,
          revaluedOn: input.revaluedOn,
          previousCostIdr: before.costIdr,
          previousAccumulatedIdr: before.accumulatedDepreciationIdr,
          previousUsefulLifeMonths: before.usefulLifeMonths,
          previousStartPeriod: before.depreciationStartPeriod,
          newCarryingAmountIdr: input.newCarryingAmountIdr as Idr,
          journalEntryId: entry.id,
          reason: input.reason,
          createdBy: actorId,
        });
        const [row] = await tx
          .update(fixedAssets)
          .set({
            costIdr: input.newCarryingAmountIdr as Idr,
            accumulatedDepreciationIdr: 0 as Idr,
            usefulLifeMonths: plan.remainingMonths,
            depreciationStartPeriod: plan.newStartPeriod,
            status: "active",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(fixedAssets.tenantId, tenantId),
              eq(fixedAssets.id, asset.id),
            ),
          )
          .returning();
        if (!row) throw new Error("Fixed asset vanished under its lock.");
        await auditApFa(tx, context, {
          actorId,
          action: "accounting.fixed_asset.revalued",
          objectType: "fixed_asset",
          objectId: asset.id,
          outletId: asset.outletId,
          reason: input.reason,
          before: {
            costIdr: before.costIdr,
            accumulatedDepreciationIdr: before.accumulatedDepreciationIdr,
            usefulLifeMonths: before.usefulLifeMonths,
            depreciationStartPeriod: before.depreciationStartPeriod,
          },
          after: {
            revaluedOn: input.revaluedOn,
            newCarryingAmountIdr: input.newCarryingAmountIdr,
            usefulLifeMonths: plan.remainingMonths,
            depreciationStartPeriod: plan.newStartPeriod,
            journalEntryId: entry.id,
          },
        });
        return hydrateAsset(tx, tenantId, row);
      },
    ),
  );
}

/**
 * Monthly depreciation run (§3.19 "depresiasi otomatis") inside the caller's
 * tenant transaction; the HTTP command and the scheduled job share it.
 * `actorId` null = the scheduled job (system actor).
 */
export async function runDepreciationInTransaction(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  rawInput: unknown,
  actorId: UserId | null,
  now = new Date(),
): Promise<DepreciationRun> {
  const input = runDepreciationInputSchema.parse(rawInput);
  assertTrustedScopedContext(context);
  // One journal for every outlet of the entity: tenant scope only (TEN-03).
  assertTenantScope(context);
  const { end } = periodBounds(input.period);
  if (end >= entityToday(now))
    throw invalid("Depreciation runs only for a month that has ended.");
  const { idempotencyKey, ...request } = input;
  return idempotentCommand(
    tx,
    context,
    { key: idempotencyKey, operation: "depreciation.run", request },
    async () => {
      const tenantId = context.tenant.tenantId;
      await requireLegalEntity(tx, tenantId, input.legalEntityId);
      await advisoryLock(tx, `fa-dep:${tenantId}:${input.legalEntityId}`);
      const [existing] = await tx
        .select({ id: depreciationRuns.id })
        .from(depreciationRuns)
        .where(
          and(
            eq(depreciationRuns.tenantId, tenantId),
            eq(depreciationRuns.legalEntityId, input.legalEntityId),
            eq(depreciationRuns.period, input.period),
          ),
        )
        .limit(1);
      if (existing)
        throw new HttpError(
          409,
          "CONFLICT",
          "Depreciation for this period has already run; later runs catch up any remaining months.",
        );
      const assets = await tx
        .select()
        .from(fixedAssets)
        .where(
          and(
            eq(fixedAssets.tenantId, tenantId),
            eq(fixedAssets.legalEntityId, input.legalEntityId),
            eq(fixedAssets.status, "active"),
            lte(fixedAssets.depreciationStartPeriod, input.period),
          ),
        )
        .orderBy(asc(fixedAssets.id))
        .for("update");
      const posted = await postedPeriodsByAsset(
        tx,
        tenantId,
        assets.map((asset) => asset.id),
      );
      const plan = assets
        .map((asset) => ({
          asset,
          rows: pendingDepreciation(
            toFixedAsset(asset),
            posted.get(asset.id) ?? new Set(),
            input.period,
          ),
        }))
        .filter((item) => item.rows.length > 0);
      const perOutlet = new Map<string | null, number>();
      let total = 0;
      for (const { asset, rows } of plan) {
        const amount = rows.reduce((sum, row) => sum + row.amountIdr, 0);
        perOutlet.set(
          asset.outletId,
          (perOutlet.get(asset.outletId) ?? 0) + amount,
        );
        total += amount;
      }
      const runId = newId();
      const journalEntryId =
        total > 0
          ? await postDepreciationJournal(
              tx,
              context,
              {
                legalEntityId: input.legalEntityId,
                entryOutletId: null,
                entryDate: end,
                sourceId: runId,
                perOutlet,
                postedBy: actorId,
                idempotencyKey: `fa-dep-run:${runId}`,
                description: `Penyusutan aset tetap ${input.period}`,
              },
              now,
            )
          : null;
      const [run] = await tx
        .insert(depreciationRuns)
        .values({
          id: runId,
          tenantId,
          legalEntityId: input.legalEntityId,
          period: input.period,
          amountIdr: total as Idr,
          journalEntryId,
          postedBy: actorId,
          postedAt: now,
        })
        .returning();
      if (!run) throw new Error("Depreciation run insert returned no row.");
      const lines: { fixedAssetId: string; amountIdr: number }[] = [];
      for (const { asset, rows } of plan) {
        await applyDepreciation(
          tx,
          tenantId,
          asset,
          rows,
          runId,
          journalEntryId as string,
        );
        for (const row of rows)
          lines.push({ fixedAssetId: asset.id, amountIdr: row.amountIdr });
      }
      const result = toRun(run, lines);
      const event = depreciationRunPostedEvent.envelopeSchema.parse({
        id: createUlid(now.getTime()),
        tenantId,
        outletId: null,
        name: "depreciation_run.posted",
        version: 1,
        aggregateType: "depreciation_run",
        aggregateId: runId,
        sequence: 1,
        occurredAt: now.toISOString(),
        actor: actorId ? { type: "user", id: actorId } : { type: "system" },
        deviceId: null,
        idempotencyKey: `depreciation_run.posted:${runId}`,
        payloadSchemaRef: depreciationRunPostedEvent.payloadSchemaRef,
        payload: {
          depreciationRunId: runId,
          legalEntityId: input.legalEntityId,
          period: input.period,
          amountIdr: total,
          journalEntryId,
        },
      });
      await appendOutbox(tx, context, {
        id: createUlid(now.getTime()),
        event,
        destination: EVENT_DESTINATION,
        direction: null,
        peerId: null,
      });
      await auditApFa(tx, context, {
        actorId,
        action: "accounting.depreciation_run.posted",
        objectType: "depreciation_run",
        objectId: runId,
        before: null,
        after: {
          period: input.period,
          amountIdr: total,
          count: result.lines.length,
          journalEntryId,
        },
      });
      return result;
    },
  );
}

export async function runDepreciation(
  context: ScopedTenantContext,
  rawInput: unknown,
  actorId: UserId,
  now = new Date(),
): Promise<DepreciationRun> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, (tx) =>
    runDepreciationInTransaction(tx, context, rawInput, actorId, now),
  );
}

/** Whether a run already exists (the scheduled job skips those periods). */
export async function depreciationRunExists(
  tx: TenantTransaction,
  tenantId: TenantId,
  legalEntityId: string,
  period: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql`1` })
    .from(depreciationRuns)
    .where(
      and(
        eq(depreciationRuns.tenantId, tenantId),
        eq(depreciationRuns.legalEntityId, legalEntityId),
        eq(depreciationRuns.period, period),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Whether any active asset of the entity has depreciation due up to `period`. */
export async function hasDueAssets(
  tx: TenantTransaction,
  tenantId: TenantId,
  legalEntityId: string,
  period: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql`1` })
    .from(fixedAssets)
    .where(
      and(
        eq(fixedAssets.tenantId, tenantId),
        eq(fixedAssets.legalEntityId, legalEntityId),
        eq(fixedAssets.status, "active"),
        lte(fixedAssets.depreciationStartPeriod, period),
      ),
    )
    .limit(1);
  return row !== undefined;
}
