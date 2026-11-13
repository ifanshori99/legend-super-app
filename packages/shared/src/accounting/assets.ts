// Fixed assets (PRD v1.7 §3.19 "Aset Tetap [P0] — Registrasi aset dari
// pembelian, depresiasi otomatis, revaluasi, dan penjualan aset"; §6 F
// `fixed_assets` (name, acquired_on, cost_idr, useful_life_months, method) and
// `depreciation_runs` (period, amount_idr)).
//
// Straight line is the only method in v1 (the PRD names no other). The
// depreciable base (cost − residual) is split over the useful life with
// `splitIdrEvenly` (largest remainder): every month is whole rupiah, earlier
// months take the extra rupiah, and the schedule sums to the base exactly, so
// no rounding mode is involved.

import { z } from "zod";
import {
  businessDateSchema,
  idempotencyKeySchema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  splitIdrEvenly,
  tenantIdSchema,
  userIdSchema,
  uuidSchema,
} from "../core/index.ts";
import type { Idr } from "../core/index.ts";
import { AccountingError } from "./errors.ts";
import {
  depreciationRunIdSchema,
  fixedAssetIdSchema,
  journalEntryIdSchema,
  legalEntityIdSchema,
} from "./ids.ts";
import { nextPeriod, periodKeySchema } from "./period-key.ts";

const nonNegativeIdr = idrSchema.refine((v) => v >= 0, "Amount must be >= 0");

export const depreciationMethodSchema = z.enum(["straight_line"]);

export const assetCodeSchema = z.string().trim().min(1).max(40);
export const assetCategoryNameSchema = z.string().trim().min(1).max(80);

export const assetCategorySchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  name: assetCategoryNameSchema,
});
export type AssetCategory = z.infer<typeof assetCategorySchema>;

export const createAssetCategoryInputSchema = z.strictObject({
  name: assetCategoryNameSchema,
});

export const fixedAssetSchema = z
  .strictObject({
    id: fixedAssetIdSchema,
    tenantId: tenantIdSchema,
    legalEntityId: legalEntityIdSchema,
    outletId: outletIdSchema.nullable(),
    /** Register number, unique per tenant + legal entity (`FA-00001` when generated). */
    code: assetCodeSchema,
    categoryId: uuidSchema.nullable(),
    categoryName: assetCategoryNameSchema.nullable(),
    name: z.string().trim().min(1).max(150),
    acquiredOn: businessDateSchema,
    /** Current basis; a revaluation restates it (elimination method). */
    costIdr: idrSchema.refine((v) => v > 0, "Cost must be > 0"),
    /** Cost before the first revaluation (= `costIdr` when never revalued). */
    originalCostIdr: idrSchema.refine((v) => v > 0, "Cost must be > 0"),
    /** Sum of upward revaluation deltas, derived from the revaluation history. */
    revaluationSurplusIdr: nonNegativeIdr,
    /** Sum of downward revaluation deltas (absolute), derived the same way. */
    revaluationLossIdr: nonNegativeIdr,
    residualValueIdr: nonNegativeIdr,
    usefulLifeMonths: z.number().int().min(1).max(600),
    method: depreciationMethodSchema,
    /** First month that carries depreciation. */
    depreciationStartPeriod: periodKeySchema,
    /** Source purchase document (supplier invoice) when registered from a purchase. */
    sourceDocumentId: uuidSchema.nullable(),
    accumulatedDepreciationIdr: nonNegativeIdr,
    status: z.enum(["active", "fully_depreciated", "disposed"]),
    disposedOn: businessDateSchema.nullable(),
    disposalProceedsIdr: nonNegativeIdr.nullable(),
    /** Carrying amount: cost − accumulated depreciation (frozen at disposal). */
    bookValueIdr: nonNegativeIdr,
    /**
     * Gain (+) or loss (−) booked at disposal: proceeds − book value. Null
     * until disposed; equals the `resultIdr` the disposal journal carries.
     */
    disposalResultIdr: idrSchema.nullable(),
  })
  .superRefine((asset, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (asset.residualValueIdr >= asset.costIdr)
      issue("residualValueIdr", "Residual value must be below cost");
    if (
      asset.accumulatedDepreciationIdr >
      asset.costIdr - asset.residualValueIdr
    )
      issue("accumulatedDepreciationIdr", "Cannot exceed the depreciable base");
    const disposed = asset.status === "disposed";
    if (
      disposed !==
      (asset.disposedOn !== null && asset.disposalProceedsIdr !== null)
    )
      issue("disposedOn", "disposal fields are set exactly when disposed");
    if (asset.bookValueIdr !== asset.costIdr - asset.accumulatedDepreciationIdr)
      issue("bookValueIdr", "Book value must equal cost − accumulated");
    const expectedResult =
      asset.disposalProceedsIdr === null
        ? null
        : asset.disposalProceedsIdr - asset.bookValueIdr;
    if (asset.disposalResultIdr !== expectedResult)
      issue(
        "disposalResultIdr",
        "Disposal result must equal proceeds − book value, and be null until disposed",
      );
  });
export type FixedAsset = z.infer<typeof fixedAssetSchema>;

/**
 * Payable of a credit purchase (bead legend-gzeya): the supplier, the document
 * the supplier issued and when it falls due. The server books one payable open
 * item for the asset cost with the acquisition journal, in the same transaction.
 */
export const fixedAssetPayableInputSchema = z.strictObject({
  supplierId: uuidSchema,
  documentNumber: z.string().trim().min(1).max(60),
  documentDate: businessDateSchema,
  dueOn: businessDateSchema,
});
export type FixedAssetPayableInput = z.infer<
  typeof fixedAssetPayableInputSchema
>;

/** Field set without the cross-field rules (object schemas with refinements cannot be `.omit`ted). */
export const createFixedAssetBaseSchema = z.strictObject({
  legalEntityId: legalEntityIdSchema,
  outletId: outletIdSchema.nullable(),
  /** Empty or omitted: the server assigns the next `FA-nnnnn` of the entity. */
  code: z.string().trim().max(40).optional(),
  categoryId: uuidSchema.nullable().optional(),
  name: z.string().trim().min(1).max(150),
  acquiredOn: businessDateSchema,
  costIdr: idrSchema.refine((v) => v > 0, "Cost must be > 0"),
  residualValueIdr: nonNegativeIdr,
  usefulLifeMonths: z.number().int().min(1).max(600),
  depreciationStartPeriod: periodKeySchema,
  sourceDocumentId: uuidSchema.nullable(),
  /** Required exactly when `sourceDocumentId` is set (a purchase on credit). */
  payable: fixedAssetPayableInputSchema.nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const createFixedAssetInputSchema =
  createFixedAssetBaseSchema.superRefine((input, ctx) => {
    const payable = input.payable ?? null;
    if (input.sourceDocumentId !== null && payable === null)
      ctx.addIssue({
        code: "custom",
        path: ["payable"],
        message: "A purchase source document needs the supplier payable.",
      });
    if (input.sourceDocumentId === null && payable !== null)
      ctx.addIssue({
        code: "custom",
        path: ["payable"],
        message: "A payable needs the purchase source document.",
      });
    if (payable !== null && payable.dueOn < payable.documentDate)
      ctx.addIssue({
        code: "custom",
        path: ["payable", "dueOn"],
        message: "Due date cannot be before the document date.",
      });
  });

export type DepreciationScheduleRow = { period: string; amountIdr: Idr };

/** Full straight-line schedule; sums to cost − residual exactly. */
export function straightLineSchedule(
  asset: Pick<
    FixedAsset,
    | "costIdr"
    | "residualValueIdr"
    | "usefulLifeMonths"
    | "depreciationStartPeriod"
  >,
): DepreciationScheduleRow[] {
  const base = (asset.costIdr - asset.residualValueIdr) as Idr;
  const amounts = splitIdrEvenly(base, asset.usefulLifeMonths);
  let period = asset.depreciationStartPeriod;
  return amounts.map((amountIdr) => {
    const row = { period, amountIdr };
    period = nextPeriod(period);
    return row;
  });
}

/** Depreciation of one asset for `period` (0 outside the schedule or once disposed). */
export function depreciationForPeriod(
  asset: Pick<
    FixedAsset,
    | "costIdr"
    | "residualValueIdr"
    | "usefulLifeMonths"
    | "depreciationStartPeriod"
    | "status"
    | "disposedOn"
  >,
  period: string,
): Idr {
  if (
    asset.status === "disposed" &&
    asset.disposedOn !== null &&
    asset.disposedOn.slice(0, 7) < period
  )
    return 0 as Idr;
  const row = straightLineSchedule(asset).find(
    (entry) => entry.period === period,
  );
  return (row?.amountIdr ?? 0) as Idr;
}

/** Derived read-side fields of an asset: book value and disposal result. */
export function fixedAssetDerivedFields(
  asset: Pick<
    FixedAsset,
    "costIdr" | "accumulatedDepreciationIdr" | "disposalProceedsIdr"
  >,
): Pick<FixedAsset, "bookValueIdr" | "disposalResultIdr"> {
  const bookValueIdr = (asset.costIdr -
    asset.accumulatedDepreciationIdr) as Idr;
  return {
    bookValueIdr,
    disposalResultIdr:
      asset.disposalProceedsIdr === null
        ? null
        : ((asset.disposalProceedsIdr - bookValueIdr) as Idr),
  };
}

/** Gain (+) or loss (−) on disposal: proceeds − carrying amount. */
export function disposalResultIdr(
  asset: Pick<FixedAsset, "costIdr" | "accumulatedDepreciationIdr" | "status">,
  proceedsIdr: number,
): Idr {
  if (asset.status === "disposed")
    throw new AccountingError("ASSET_ALREADY_DISPOSED");
  return (proceedsIdr -
    (asset.costIdr - asset.accumulatedDepreciationIdr)) as Idr;
}

export const disposeFixedAssetInputSchema = z.strictObject({
  disposedOn: businessDateSchema,
  proceedsIdr: nonNegativeIdr,
  reason: z.string().trim().min(1).max(200),
  idempotencyKey: idempotencyKeySchema,
});

export const revalueFixedAssetInputSchema = z.strictObject({
  revaluedOn: businessDateSchema,
  newCarryingAmountIdr: nonNegativeIdr,
  reason: z.string().trim().min(1).max(200),
  idempotencyKey: idempotencyKeySchema,
});

export const depreciationRunSchema = z
  .strictObject({
    id: depreciationRunIdSchema,
    tenantId: tenantIdSchema,
    legalEntityId: legalEntityIdSchema,
    period: periodKeySchema,
    amountIdr: nonNegativeIdr,
    lines: z.array(
      z.strictObject({
        fixedAssetId: fixedAssetIdSchema,
        amountIdr: idrSchema.refine((v) => v > 0, "Amount must be > 0"),
      }),
    ),
    journalEntryId: journalEntryIdSchema.nullable(),
    postedBy: userIdSchema.nullable(),
    postedAt: isoDateTimeSchema,
  })
  .superRefine((run, ctx) => {
    const sum = run.lines.reduce((total, line) => total + line.amountIdr, 0);
    if (sum !== run.amountIdr)
      ctx.addIssue({
        code: "custom",
        path: ["amountIdr"],
        message: "Run amount = sum of lines",
      });
    if (run.amountIdr > 0 !== (run.journalEntryId !== null))
      ctx.addIssue({
        code: "custom",
        path: ["journalEntryId"],
        message: "A run with an amount posts exactly one journal",
      });
    const ids = run.lines.map((line) => line.fixedAssetId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message: "One line per asset",
      });
  });
export type DepreciationRun = z.infer<typeof depreciationRunSchema>;

export const runDepreciationInputSchema = z.strictObject({
  legalEntityId: legalEntityIdSchema,
  period: periodKeySchema,
  idempotencyKey: idempotencyKeySchema,
});
