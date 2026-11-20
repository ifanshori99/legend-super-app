// Mock handlers for the profit-share back office (`VITE_API_MOCK=true`), so
// both screens work with no API (docs/frontend.md "Typed endpoints and mock
// mode"). They serve the Cafe Legend profit-share fixtures and run the same
// contract rules the API will run: SH-03 refuses a version that does not sum to
// exactly 10,000 bp (the refusal comes from the contract's own
// `transitionShareAllocationVersion`/`shareAllocationVersionSchema`, never from
// a local 100% check), and SH-04 freezes an approved run and offers an
// adjustment run with a reversing journal instead.
//
// Loaded in Node by tests/ws07-profit-share.test.mjs, so every import here is a
// bare package import or a relative `.ts` path (no `@/` alias).
//
// Identity in mock mode: the requester is the fixture's finance user and the
// approver is the owner, because the mock has no session. A real API takes the
// actor from the session (AUTH-06) and refuses an approval by the requester; the
// screens say so next to the approval buttons.
import {
  AccountingError,
  assertAdjustmentMatchesTarget,
  assertAdjustmentTarget,
  assertEffectiveFromAdvances,
  assertNoDuplicateRegularRun,
  assertShareVersionEffective,
  assertShareVersionUsable,
  buildDistributionStatement,
  calculateAdjustmentDistribution,
  calculateDistribution,
  cafeLegendAccountingFixtures,
  createAdjustmentDistribution,
  createDistributionRun,
  createProfitEntity,
  createShareAllocationVersion,
  createShareholder,
  decideDistributionRun,
  decideShareAllocationVersion,
  distributionRunSchema,
  distributionRunSummarySchema,
  effectiveShareAllocationVersion,
  getDistributionRun,
  getDistributionStatement,
  getShareAllocationVersion,
  listDistributionRuns,
  listProfitEntities,
  listShareAllocationVersions,
  listShareholders,
  maskAccountNumber,
  maskNpwp,
  periodBounds,
  profitEntitySchema,
  recordDistributionPayment,
  shareAllocationVersionSchema,
  shareholderSchema,
  submitDistributionRun,
  submitShareAllocationVersion,
  transitionDistributionRun,
  transitionShareAllocationVersion,
  updateProfitEntity,
  updateShareAllocationVersion,
  updateShareholder,
  type AdjustmentCalculation,
  type DistributionCalculation,
  type DistributionLine,
  type DistributionRun,
  type ProfitEntity,
  type ShareAllocationVersion,
  type Shareholder,
} from "@starter/shared/accounting";
import { AccessError } from "@starter/shared/access";
import { idr, type UserId } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { AnyEndpoint } from "@starter/shared/api";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock, type MockHandler } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

const fixtures = cafeLegendAccountingFixtures;
const tenantId = fixtures.tenantId;
const finance = fixtures.users.finance as UserId;
const owner = fixtures.users.owner as UserId;
const profitShare = fixtures.profitShare;

/**
 * Net profit of the closed periods the mock can distribute (mock-only source;
 * the real API reads the P&L of the closed period). The values mirror the
 * fixture runs so a new run for the same period would agree with them.
 */
const NET_PROFIT_BY_PERIOD: Readonly<Record<string, number>> = {
  "2026-09": 180_000_000,
  "2026-10": 165_000_000,
};

type ProfitShareMockState = {
  entities: ProfitEntity[];
  shareholders: Shareholder[];
  versions: ShareAllocationVersion[];
  runs: DistributionRun[];
  /** Idempotency and replay: request key → created id. */
  created: Map<string, string>;
};

const state = createMockStore<ProfitShareMockState>(() => ({
  entities: [...profitShare.entities],
  shareholders: [...profitShare.shareholders],
  versions: [...profitShare.versions],
  runs: [
    profitShare.runs.september,
    profitShare.runs.october,
    profitShare.runs.adjustment,
  ],
  created: new Map(),
}));

/**
 * Registers a handler and maps the contract's own errors the way the API does:
 * `AccountingError`/`AccessError` carry `code` and `status`, but the mock runtime only
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
      // AUTH-06: the transitions throw AccessError("APPROVER_IS_REQUESTER")
      // for a self-approval; it must reach the screen as 403, not INTERNAL_ERROR.
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

function invalid(message: string): ApiError {
  return new ApiError(422, "VALIDATION_ERROR", message);
}

function findEntity(profitEntityId: string): ProfitEntity {
  const found = state.get().entities.find((row) => row.id === profitEntityId);
  if (!found) throw notFound("Entitas bagi hasil tidak ditemukan.");
  return found;
}

function findShareholder(shareholderId: string): Shareholder {
  const found = state
    .get()
    .shareholders.find((row) => row.id === shareholderId);
  if (!found) throw notFound("Pemegang saham tidak ditemukan.");
  return found;
}

function findVersion(
  profitEntityId: string,
  version: number,
): ShareAllocationVersion {
  const found = state
    .get()
    .versions.find(
      (row) => row.profitEntityId === profitEntityId && row.version === version,
    );
  if (!found) throw notFound("Versi porsi tidak ditemukan.");
  return found;
}

function findRun(distributionRunId: string): DistributionRun {
  const found = state.get().runs.find((row) => row.id === distributionRunId);
  if (!found) throw notFound("Distribusi tidak ditemukan.");
  return found;
}

/** A register row has no surrogate id: entity + version identify it. */
function versionKey(
  version: Pick<ShareAllocationVersion, "profitEntityId" | "version">,
): string {
  return `${version.profitEntityId}:${version.version}`;
}

function replaceVersion(next: ShareAllocationVersion): void {
  const current = state.get();
  const index = current.versions.findIndex(
    (row) =>
      row.profitEntityId === next.profitEntityId &&
      row.version === next.version,
  );
  if (index === -1) throw notFound("Versi porsi tidak ditemukan.");
  current.versions[index] = next;
}

function replaceRun(next: DistributionRun): void {
  const current = state.get();
  const index = current.runs.findIndex((row) => row.id === next.id);
  if (index === -1) throw notFound("Distribusi tidak ditemukan.");
  current.runs[index] = next;
}

/** Highest version number of an entity's register (0 when it has none). */
function latestVersionNumber(profitEntityId: string): number {
  return state
    .get()
    .versions.filter((row) => row.profitEntityId === profitEntityId)
    .reduce((max, row) => Math.max(max, row.version), 0);
}

/** The latest approved version's effective date, for SH-03's advance rule. */
function latestApprovedEffectiveFrom(
  profitEntityId: string,
): ShareAllocationVersion["effectiveFrom"] | null {
  const approved = state
    .get()
    .versions.filter(
      (row) =>
        row.profitEntityId === profitEntityId && row.status === "approved",
    )
    .sort((a, b) =>
      a.effectiveFrom === b.effectiveFrom
        ? b.version - a.version
        : a.effectiveFrom < b.effectiveFrom
          ? 1
          : -1,
    );
  return approved[0]?.effectiveFrom ?? null;
}

/** A look-alike fiscal period for a run; the real API keys the closed period. */
function periodRow(fiscalPeriodId: string) {
  const found = fixtures.fiscalPeriods.find((row) => row.id === fiscalPeriodId);
  if (!found) throw notFound("Periode fiskal tidak ditemukan.");
  return found;
}

// ---- Profit entities & policy (PRD §3.37 "Entitas Bagi Hasil") ------------

register(listProfitEntities, ({ scenario }) => {
  if (scenario === "empty") return { data: [] };
  return { data: state.get().entities };
});

register(createProfitEntity, ({ body }) => {
  const current = state.get();
  if (
    body.type === "legal_entity" &&
    body.legalEntityId !== fixtures.legalEntity.id
  )
    throw invalid("Badan usaha tidak ditemukan.");
  if (
    body.type === "outlet" &&
    !cafeLegendPlatformFixtures.outlets.some(
      (outlet) => outlet.id === body.outletId,
    )
  )
    throw invalid("Outlet tidak ditemukan.");
  const entity = profitEntitySchema.parse({
    id: newIdempotencyKey(),
    tenantId,
    name: body.name,
    type: body.type,
    legalEntityId: body.legalEntityId,
    outletId: body.outletId,
    policy: body.policy,
    isActive: true,
  });
  current.entities.push(entity);
  return { data: entity };
});

register(updateProfitEntity, ({ params, body }) => {
  const current = state.get();
  const index = current.entities.findIndex(
    (row) => row.id === params.profitEntityId,
  );
  if (index === -1) throw notFound("Entitas bagi hasil tidak ditemukan.");
  const before = current.entities[index];
  const next = profitEntitySchema.parse({
    ...before,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.policy !== undefined ? { policy: body.policy } : {}),
    ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
  });
  current.entities[index] = next;
  return { data: next };
});

// ---- Shareholder register (PRD §3.37 "Daftar Pemegang Saham") -------------

register(listShareholders, ({ scenario }) => {
  if (scenario === "empty") return { data: [] };
  return { data: state.get().shareholders };
});

register(createShareholder, ({ body }) => {
  const current = state.get();
  const shareholder = shareholderSchema.parse({
    id: newIdempotencyKey(),
    tenantId,
    userId: body.userId,
    name: body.name,
    type: body.type,
    status: "active",
    npwpMasked: body.npwp === null ? null : maskNpwp(body.npwp),
    payoutAccount:
      body.payoutAccount === null
        ? null
        : {
            bank: body.payoutAccount.bank,
            accountNumberMasked: maskAccountNumber(
              body.payoutAccount.accountNumber,
            ),
            accountHolder: body.payoutAccount.accountHolder,
          },
    createdAt: nowIso(),
  });
  current.shareholders.push(shareholder);
  return { data: shareholder };
});

register(updateShareholder, ({ params, body }) => {
  const current = state.get();
  const index = current.shareholders.findIndex(
    (row) => row.id === params.shareholderId,
  );
  if (index === -1) throw notFound("Pemegang saham tidak ditemukan.");
  const before = current.shareholders[index];
  // NPWP and account numbers are write-only: a new plaintext replaces the
  // masked value, an explicit null clears it, an absent field keeps it.
  const npwpMasked =
    body.npwp === undefined
      ? before.npwpMasked
      : body.npwp === null
        ? null
        : maskNpwp(body.npwp);
  const payoutAccount =
    body.payoutAccount === undefined
      ? before.payoutAccount
      : body.payoutAccount === null
        ? null
        : {
            bank: body.payoutAccount.bank,
            accountNumberMasked: maskAccountNumber(
              body.payoutAccount.accountNumber,
            ),
            accountHolder: body.payoutAccount.accountHolder,
          };
  const next = shareholderSchema.parse({
    ...before,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.type !== undefined ? { type: body.type } : {}),
    ...(body.userId !== undefined ? { userId: body.userId } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
    npwpMasked,
    payoutAccount,
  });
  current.shareholders[index] = next;
  return { data: next };
});

// ---- Share allocation versions (SH-03) ------------------------------------

register(listShareAllocationVersions, ({ params, query, scenario }) => {
  if (scenario === "empty") return { data: [] };
  const rows = state
    .get()
    .versions.filter(
      (row) =>
        row.profitEntityId === params.profitEntityId &&
        (!query.status || row.status === query.status),
    )
    .sort((a, b) => b.version - a.version);
  return { data: rows };
});

register(getShareAllocationVersion, ({ params, scenario }) => {
  if (scenario === "empty") throw notFound("Versi porsi tidak ditemukan.");
  return { data: findVersion(params.profitEntityId, params.version) };
});

/** A row as the admin edited it; ids are preserved for known shareholders. */
function allocationRows(
  inputs: readonly { shareholderId: string; shareBp: number }[],
  existing: readonly { shareholderId: string; id: string }[],
): { id: string; shareholderId: string; shareBp: number }[] {
  const known = new Map(existing.map((row) => [row.shareholderId, row.id]));
  return inputs.map((input) => ({
    id: known.get(input.shareholderId) ?? newIdempotencyKey(),
    shareholderId: input.shareholderId,
    shareBp: input.shareBp,
  }));
}

register(createShareAllocationVersion, ({ params, body }) => {
  const current = state.get();
  const replayKey = `share-version:${params.profitEntityId}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) {
    const found = current.versions.find((row) => versionKey(row) === replayed);
    if (found) return { data: found };
  }
  findEntity(params.profitEntityId);
  // SH-03: a replacement version starts strictly after the approved one it
  // replaces, so a closed period's distribution keeps its split.
  assertEffectiveFromAdvances(
    latestApprovedEffectiveFrom(params.profitEntityId),
    body.effectiveFrom,
  );
  const version = shareAllocationVersionSchema.parse({
    tenantId,
    profitEntityId: params.profitEntityId,
    version: latestVersionNumber(params.profitEntityId) + 1,
    effectiveFrom: body.effectiveFrom,
    status: "draft",
    allocations: allocationRows(body.allocations, []),
    requestedBy: finance,
    requestedAt: nowIso(),
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
  });
  current.versions.push(version);
  current.created.set(replayKey, versionKey(version));
  return { data: version };
});

register(updateShareAllocationVersion, ({ params, body }) => {
  const before = findVersion(params.profitEntityId, params.version);
  // The contract's own state machine: only a draft may be edited.
  if (before.status !== "draft")
    throw new AccountingError(
      "INVALID_TRANSITION",
      "Hanya versi berstatus draf yang dapat diubah.",
    );
  if (body.effectiveFrom !== undefined)
    assertEffectiveFromAdvances(
      latestApprovedEffectiveFrom(params.profitEntityId),
      body.effectiveFrom,
    );
  const next = shareAllocationVersionSchema.parse({
    ...before,
    ...(body.effectiveFrom !== undefined
      ? { effectiveFrom: body.effectiveFrom }
      : {}),
    ...(body.allocations !== undefined
      ? { allocations: allocationRows(body.allocations, before.allocations) }
      : {}),
  });
  replaceVersion(next);
  return { data: next };
});

register(submitShareAllocationVersion, ({ params, body }) => {
  const current = state.get();
  const replayKey = `share-submit:${params.profitEntityId}:${params.version}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) {
    const found = current.versions.find((row) => versionKey(row) === replayed);
    if (found) return { data: found };
  }
  const before = findVersion(params.profitEntityId, params.version);
  // SH-03: the contract re-checks uniqueness and the exact 10,000 bp total.
  const decision = transitionShareAllocationVersion(before, {
    type: "submit",
    actorId: before.requestedBy,
  });
  const next = shareAllocationVersionSchema.parse({ ...before, ...decision });
  replaceVersion(next);
  current.created.set(replayKey, versionKey(next));
  return { data: next };
});

register(decideShareAllocationVersion, ({ params, body }) => {
  const current = state.get();
  const replayKey = `share-decide:${params.profitEntityId}:${params.version}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) {
    const found = current.versions.find((row) => versionKey(row) === replayed);
    if (found) return { data: found };
  }
  const before = findVersion(params.profitEntityId, params.version);
  const decision =
    body.decision === "approve"
      ? transitionShareAllocationVersion(before, {
          type: "approve",
          actorId: owner,
          now: nowIso(),
        })
      : transitionShareAllocationVersion(before, {
          type: "reject",
          actorId: owner,
          now: nowIso(),
          reason: body.note ?? "",
        });
  const next = shareAllocationVersionSchema.parse({ ...before, ...decision });
  replaceVersion(next);
  current.created.set(replayKey, versionKey(next));
  return { data: next };
});

// ---- Distribution runs (SH-04) -------------------------------------------

function runOfCalculation(input: {
  calc: DistributionCalculation | AdjustmentCalculation;
  type: "regular" | "adjustment";
  shareVersion: number;
  adjustsRunId?: string;
  adjustmentReason?: string;
  reversalJournalEntryId?: string;
}): DistributionRun {
  const { calc } = input;
  const adjustment = input.type === "adjustment";
  const regular = calc as DistributionCalculation;
  const correction = calc as AdjustmentCalculation;
  // The id exists before the lines, because each line carries its run's id.
  const id = newIdempotencyKey();
  return distributionRunSchema.parse({
    id,
    tenantId,
    profitEntityId: calc.profitEntityId,
    fiscalPeriodId: calc.fiscalPeriodId,
    period: calc.period,
    type: input.type,
    basis: calc.basis,
    status: "draft",
    shareVersion: input.shareVersion,
    periodNetProfitIdr: adjustment ? null : regular.periodNetProfitIdr,
    reserveIdr: adjustment ? 0 : regular.reserveIdr,
    distributableIdr: adjustment
      ? correction.adjustmentIdr
      : regular.distributableIdr,
    lines: calc.lines.map((line) => ({
      id: newIdempotencyKey(),
      tenantId,
      distributionRunId: id,
      ...line,
      paymentStatus: "pending",
      paymentRef: null,
      paidAt: null,
      statementFileKey: null,
    })),
    totalGrossIdr: calc.totalGrossIdr,
    totalTaxWithheldIdr: calc.totalTaxWithheldIdr,
    totalNetIdr: calc.totalNetIdr,
    requestedBy: finance,
    requestedAt: nowIso(),
    approvedBy: null,
    approvedAt: null,
    paidAt: null,
    adjustsRunId: input.adjustsRunId ?? null,
    adjustmentReason: input.adjustmentReason ?? null,
    reversalJournalEntryId: input.reversalJournalEntryId ?? null,
    unabsorbedIdr: adjustment ? correction.unabsorbedIdr : 0,
    // A positive top-up deducts carry like a regular run; a claw-back never does.
    carryDeductedIdr: adjustment
      ? correction.carryDeductedIdr
      : regular.carryDeductedIdr,
    carryDeductions: adjustment
      ? correction.carryDeductions
      : regular.carryDeductions,
  });
}

register(listDistributionRuns, ({ params, query, scenario }) => {
  const rows = state
    .get()
    .runs.filter((row) => row.profitEntityId === params.profitEntityId)
    .filter((row) => !query.status || row.status === query.status)
    .sort(
      (a, b) =>
        b.requestedAt.localeCompare(a.requestedAt) || a.id.localeCompare(b.id),
    )
    .map((run) =>
      distributionRunSummarySchema.parse({
        id: run.id,
        profitEntityId: run.profitEntityId,
        fiscalPeriodId: run.fiscalPeriodId,
        period: run.period,
        type: run.type,
        status: run.status,
        shareVersion: run.shareVersion,
        distributableIdr: run.distributableIdr,
        totalTaxWithheldIdr: run.totalTaxWithheldIdr,
        totalNetIdr: run.totalNetIdr,
        lineCount: run.lines.length,
        paidLineCount: run.lines.filter((line) => line.paymentStatus === "paid")
          .length,
        requestedBy: run.requestedBy,
        requestedAt: run.requestedAt,
        approvedBy: run.approvedBy,
        approvedAt: run.approvedAt,
        paidAt: run.paidAt,
        needsCorrection: false,
      }),
    );
  return paginateFixture(
    rows,
    { cursor: query.cursor, limit: query.limit },
    (row) => row.id,
    scenario,
  );
});

register(createDistributionRun, ({ params, body }) => {
  const current = state.get();
  const replayKey = `distribution:${params.profitEntityId}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) {
    const found = current.runs.find((row) => row.id === replayed);
    if (found) return { data: found };
  }
  const entity = findEntity(params.profitEntityId);
  const period = periodRow(body.fiscalPeriodId);
  assertNoDuplicateRegularRun(current.runs, {
    profitEntityId: params.profitEntityId,
    fiscalPeriodId: body.fiscalPeriodId,
  });
  // SH-03: only an approved version in force on the period's last day splits a
  // closed period's profit.
  const bounds = periodBounds(period.period);
  const effective = effectiveShareAllocationVersion(
    current.versions,
    params.profitEntityId,
    bounds.end,
  );
  if (!effective)
    throw new AccountingError(
      "SHARE_VERSION_NOT_EFFECTIVE",
      "Belum ada versi porsi yang berlaku pada akhir periode ini.",
    );
  const version: ShareAllocationVersion = effective;
  assertShareVersionUsable(version);
  assertShareVersionEffective(version, bounds.end);
  const netProfitIdr = idr(NET_PROFIT_BY_PERIOD[period.period] ?? 0);
  const calc = calculateDistribution({
    profitEntityId: entity.id,
    fiscalPeriodId: period.id,
    period: period.period,
    periodStatus: period.status,
    periodNetProfitIdr: netProfitIdr,
    policy: entity.policy,
    allocations: version.allocations,
  });
  const draft = runOfCalculation({
    calc,
    type: "regular",
    shareVersion: version.version,
  });
  current.runs.push(draft);
  current.created.set(replayKey, draft.id);
  return { data: draft };
});

register(getDistributionRun, ({ params, scenario }) => {
  if (scenario === "empty") throw notFound("Distribusi tidak ditemukan.");
  return { data: findRun(params.distributionRunId) };
});

register(submitDistributionRun, ({ params, body }) => {
  const current = state.get();
  const replayKey = `distribution-submit:${params.distributionRunId}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) {
    const found = current.runs.find((row) => row.id === replayed);
    if (found) return { data: found };
  }
  const before = findRun(params.distributionRunId);
  const next = transitionDistributionRun(before, {
    type: "submit",
    actorId: before.requestedBy,
  });
  replaceRun(next);
  current.created.set(replayKey, next.id);
  return { data: next };
});

register(decideDistributionRun, ({ params, body }) => {
  const current = state.get();
  const replayKey = `distribution-decide:${params.distributionRunId}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) {
    const found = current.runs.find((row) => row.id === replayed);
    if (found) return { data: found };
  }
  const before = findRun(params.distributionRunId);
  const next =
    body.decision === "approve"
      ? transitionDistributionRun(before, {
          type: "approve",
          actorId: owner,
          now: nowIso(),
        })
      : transitionDistributionRun(before, {
          type: "reject",
          actorId: owner,
          reason: body.note ?? "",
        });
  replaceRun(next);
  current.created.set(replayKey, next.id);
  return { data: next };
});

register(recordDistributionPayment, ({ params, body }) => {
  const before = findRun(params.distributionRunId);
  const next = transitionDistributionRun(before, {
    type: "record_payment",
    actorId: finance,
    lineId: params.distributionLineId as DistributionLine["id"],
    paymentRef: body.paymentRef,
    paidAt: body.paidAt,
  });
  replaceRun(next);
  return { data: next };
});

register(createAdjustmentDistribution, ({ params, body }) => {
  const current = state.get();
  const replayKey = `distribution-adjustment:${params.distributionRunId}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) {
    const found = current.runs.find((row) => row.id === replayed);
    if (found) return { data: found };
  }
  const original = findRun(params.distributionRunId);
  assertAdjustmentTarget(original);
  const entity = findEntity(original.profitEntityId);
  const period = periodRow(body.fiscalPeriodId);
  const allocations = original.lines.map((line) => ({
    shareholderId: line.shareholderId,
    shareBp: line.shareBp,
  }));
  const calc = calculateAdjustmentDistribution({
    profitEntityId: original.profitEntityId,
    fiscalPeriodId: period.id,
    period: period.period,
    periodStatus: period.status,
    adjustsRunId: original.id,
    reason: body.reason,
    adjustmentIdr: body.adjustmentIdr,
    taxWithholdingBp: entity.policy.taxWithholdingBp,
    allocations,
  });
  assertAdjustmentMatchesTarget(original, {
    profitEntityId: original.profitEntityId,
    shareVersion: original.shareVersion,
    lines: calc.lines,
  });
  const draft = runOfCalculation({
    calc,
    type: "adjustment",
    shareVersion: original.shareVersion,
    adjustsRunId: original.id,
    adjustmentReason: calc.reason,
    // SH-04: the correction posts a reversing journal with the adjustment.
    reversalJournalEntryId: newIdempotencyKey(),
  });
  current.runs.push(draft);
  current.created.set(replayKey, draft.id);
  return { data: draft };
});

register(getDistributionStatement, ({ params, scenario }) => {
  if (scenario === "empty") throw notFound("Pernyataan tidak ditemukan.");
  const run = findRun(params.distributionRunId);
  const line = run.lines.find((row) => row.id === params.distributionLineId);
  if (!line) throw notFound("Baris distribusi tidak ditemukan.");
  return {
    data: buildDistributionStatement({
      run,
      line,
      shareholder: findShareholder(line.shareholderId),
      profitEntity: findEntity(run.profitEntityId),
    }),
  };
});
