// Profit share & dividends (WS-07; PRD v1.7 §3.37 "Bagi Hasil & Dividen",
// §4 P "Alur Distribusi Dividen", §6 I `share_allocations`, `distribution_lines`
// and their supporting tables; SH-03, SH-04).
//
// What the PRD fixes here:
// - A profit entity is a legal entity or a single outlet, because outlets may
//   have different shareholders (§3.37 "Entitas Bagi Hasil").
// - Shareholder lists are versioned and effective-dated; every version must sum
//   to exactly 10,000 bp (100%) and needs approval before it can be used
//   (SH-03, §3.37 "Daftar Pemegang Saham Berversi").
// - The policy holds the basis (net profit of a CLOSED fiscal period), the
//   reserve retained, the distribution frequency and configurable tax
//   withholding (§3.37 "Kebijakan Distribusi").
// - A cycle is calculate → simulate → approve → record payments → automatic
//   journal → per-shareholder statement (§3.37 "Siklus Distribusi", §4 P).
// - Approved distributions are frozen; a correction is an adjustment
//   distribution with a reversing journal (SH-04).
//
// Decisions the PRD leaves open (also in the bead report):
// - Money is whole rupiah and every split is exact (`Idr`, contracts.md
//   D-CORE-2). The reserve and the withholding are rounded half-up to whole
//   rupiah; distributable profit is then split by `allocateIdr` (largest
//   remainder, ties to the earlier line, i.e. the order of the version's
//   allocations). Each line's net is exactly gross − tax, so
//   totalNet = totalGross − totalTax with no hidden remainder.
// - A version row is its approval unit: `share_allocations` (PRD §6 I) stores
//   `version`, `effective_from` and `approved_by` on every row, the contract
//   keeps them once on the version aggregate. Status names below are the
//   approval cycle SH-03 needs (`draft → pending_approval → approved`, plus
//   rejected/cancelled); "effective" and "superseded" are derived from
//   effective dates instead of stored, so no scheduler is required.
// - The version in force on a date is the approved version with the greatest
//   `effectiveFrom` not after that date (`effectiveShareAllocationVersion`).
//   A new version must start strictly after the latest approved one, so a
//   closed period's distribution can never be rewritten retroactively.
// - Tax withheld is the policy's `taxWithholdingBp` applied per line
//   (half-up). Per-shareholder-type rates belong to the tax contract when the
//   owner chooses them; this contract only carries one configurable rate.
// - One regular distribution per (profit entity, closed fiscal period): a
//   duplicate would pay the same profit twice. The PRD is silent, so the safe
//   default wins (`assertNoDuplicateRegularRun`). Adjustments are separate runs.
// - Statements are per line (one shareholder), official only from a closed
//   period (SH-02) and labelled `closed_period`; running numbers are a separate
//   `estimate` type so a client cannot render them as official.
// - Payout accounts and NPWP are encrypted at rest (§6 I `npwp_encrypted`,
//   `bank_account_encrypted`). They travel masked only, like bank accounts in
//   `banking.ts`; the plaintext goes in once through a create/update input.

import { z } from "zod";
import {
  allocateIdr,
  applyBasisPoints,
  basisPointsSchema,
  businessDateSchema,
  idempotencyKeySchema,
  idr,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  subtractIdr,
  sumIdr,
  tenantIdSchema,
  userIdSchema,
} from "../core/index.ts";
import type { BusinessDate, Idr, IsoDateTime, UserId } from "../core/index.ts";
import type { SelfApprovalBasis } from "../access/approval.ts";
import { AccessError } from "../access/errors.ts";
import { storageKeySchema } from "../adapters/safety.ts";
import { maskedAccountNumberSchema } from "./banking.ts";
import { AccountingError } from "./errors.ts";
import {
  distributionLineIdSchema,
  distributionRunIdSchema,
  fiscalPeriodIdSchema,
  journalEntryIdSchema,
  legalEntityIdSchema,
  profitEntityIdSchema,
  shareAllocationIdSchema,
  shareholderDocumentIdSchema,
  shareholderIdSchema,
} from "./ids.ts";
import { periodKeySchema } from "./period-key.ts";

const positiveIdr = idrSchema.refine((value) => value > 0, "Must be > 0");
const nonZeroIdr = idrSchema.refine((value) => value !== 0, "Must not be 0");
const nonNegativeIdr = idrSchema.refine((value) => value >= 0, "Must be >= 0");
const positiveShareBp = basisPointsSchema.refine(
  (value) => value > 0,
  "A shareholder's share must be > 0 bp",
);

// ---- Shareholders (PRD §6 I `shareholders`) --------------------------------

export const shareholderTypeSchema = z.enum(["person", "company"]);
export type ShareholderType = z.infer<typeof shareholderTypeSchema>;

export const shareholderStatusSchema = z.enum(["active", "inactive"]);
export type ShareholderStatus = z.infer<typeof shareholderStatusSchema>;

/** Masked as `****1234`, the same form bank accounts use. */
export const maskedNpwpSchema = z
  .string()
  .regex(/^\*{4}\d{4}$/, "Masked as ****1234");

/** Plaintext NPWP: 15 digits, or 16 when it is the NIK-based form. */
export const npwpInputSchema = z
  .string()
  .trim()
  .regex(/^\d{15,16}$/, "NPWP must be 15 or 16 digits");

/** "123456789012345" → "****2345". */
export function maskNpwp(npwp: string): string {
  if (!/^\d{15,16}$/.test(npwp))
    throw new RangeError("NPWP must be 15 or 16 digits");
  return `****${npwp.slice(-4)}`;
}

/** Where a distribution is paid. The account number itself is never returned. */
export const shareholderPayoutAccountSchema = z.strictObject({
  /** Bank name as shown (BCA, Mandiri, BNI, BJB, …); a list is tenant data. */
  bank: z.string().trim().min(2).max(50),
  accountNumberMasked: maskedAccountNumberSchema,
  accountHolder: z.string().trim().min(1).max(150),
});
export type ShareholderPayoutAccount = z.infer<
  typeof shareholderPayoutAccountSchema
>;

export const shareholderSchema = z.strictObject({
  id: shareholderIdSchema,
  tenantId: tenantIdSchema,
  /** Login that receives the shareholder dashboard; null for a company or an
   * unregistered person. A login sees only its own shareholder rows (SH-01). */
  userId: userIdSchema.nullable(),
  name: z.string().trim().min(1).max(150),
  type: shareholderTypeSchema,
  status: shareholderStatusSchema,
  npwpMasked: maskedNpwpSchema.nullable(),
  payoutAccount: shareholderPayoutAccountSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type Shareholder = z.infer<typeof shareholderSchema>;

const payoutAccountInputSchema = z.strictObject({
  bank: z.string().trim().min(2).max(50),
  /** Digits only; encrypted at rest, never returned. */
  accountNumber: z.string().regex(/^\d{6,20}$/),
  accountHolder: z.string().trim().min(1).max(150),
});

export const createShareholderInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(150),
  type: shareholderTypeSchema,
  userId: userIdSchema.nullable(),
  /** Plaintext once; encrypted at rest (§6 I). */
  npwp: npwpInputSchema.nullable(),
  payoutAccount: payoutAccountInputSchema.nullable(),
});
export const updateShareholderInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(150),
    type: shareholderTypeSchema,
    userId: userIdSchema.nullable(),
    npwp: npwpInputSchema.nullable(),
    payoutAccount: payoutAccountInputSchema.nullable(),
    status: shareholderStatusSchema,
  })
  .partial();

// ---- Profit entities & policy (PRD §6 I `profit_entities`) -----------------

export const profitEntityTypeSchema = z.enum(["legal_entity", "outlet"]);
export type ProfitEntityType = z.infer<typeof profitEntityTypeSchema>;

/** PRD §3.37 "frekuensi distribusi"; any other cadence is tenant data, not code. */
export const distributionFrequencySchema = z.enum([
  "monthly",
  "quarterly",
  "semi_annual",
  "annual",
]);
export type DistributionFrequency = z.infer<typeof distributionFrequencySchema>;

/**
 * PRD §3.37 "Kebijakan Distribusi". `basis` is fixed to the net profit of a
 * closed fiscal period: SH-02 only allows official figures from closed periods.
 */
export const distributionPolicySchema = z.strictObject({
  basis: z.literal("closed_period_net_profit"),
  /** Share of the period's net profit retained as reserve, 0–10,000 bp. */
  reserveBp: basisPointsSchema,
  frequency: distributionFrequencySchema,
  /** PPh final dividend withholding, configurable per PRD §3.37. */
  taxWithholdingBp: basisPointsSchema,
});
export type DistributionPolicy = z.infer<typeof distributionPolicySchema>;

function entityRefIssue(row: {
  type: ProfitEntityType;
  legalEntityId: string | null;
  outletId: string | null;
}): string | null {
  if (row.type === "legal_entity")
    return row.legalEntityId !== null && row.outletId === null
      ? null
      : "A legal-entity profit entity carries legalEntityId only";
  return row.outletId !== null && row.legalEntityId === null
    ? null
    : "An outlet profit entity carries outletId only";
}

export const profitEntitySchema = z
  .strictObject({
    id: profitEntityIdSchema,
    tenantId: tenantIdSchema,
    name: z.string().trim().min(1).max(150),
    type: profitEntityTypeSchema,
    legalEntityId: legalEntityIdSchema.nullable(),
    /** Outlet-owned profit entities carry their outlet (PRD §6 multi-tenant). */
    outletId: outletIdSchema.nullable(),
    policy: distributionPolicySchema,
    isActive: z.boolean(),
  })
  .superRefine((row, ctx) => {
    const issue = entityRefIssue(row);
    if (issue) ctx.addIssue({ code: "custom", path: ["type"], message: issue });
  });
export type ProfitEntity = z.infer<typeof profitEntitySchema>;

export const createProfitEntityInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(150),
    type: profitEntityTypeSchema,
    legalEntityId: legalEntityIdSchema.nullable(),
    outletId: outletIdSchema.nullable(),
    policy: distributionPolicySchema,
  })
  .superRefine((row, ctx) => {
    const issue = entityRefIssue(row);
    if (issue) ctx.addIssue({ code: "custom", path: ["type"], message: issue });
  });
export const updateProfitEntityInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(150),
    policy: distributionPolicySchema,
    isActive: z.boolean(),
  })
  .partial();

// ---- Versioned share allocations (PRD §6 I `share_allocations`, SH-03) ------

export const SHARE_ALLOCATION_VERSION_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "cancelled",
] as const;
export const shareAllocationVersionStatusSchema = z.enum(
  SHARE_ALLOCATION_VERSION_STATUSES,
);
export type ShareAllocationVersionStatus = z.infer<
  typeof shareAllocationVersionStatusSchema
>;

/** One `share_allocations` row: a shareholder's share in one version. */
export const shareAllocationSchema = z.strictObject({
  id: shareAllocationIdSchema,
  shareholderId: shareholderIdSchema,
  shareBp: positiveShareBp,
});
export type ShareAllocation = z.infer<typeof shareAllocationSchema>;

export const shareAllocationVersionSchema = z
  .strictObject({
    tenantId: tenantIdSchema,
    profitEntityId: profitEntityIdSchema,
    /** Version 1 is the first list; every change creates version + 1. */
    version: z.number().int().min(1).safe(),
    effectiveFrom: businessDateSchema,
    status: shareAllocationVersionStatusSchema,
    allocations: z.array(shareAllocationSchema).min(1).max(200),
    requestedBy: userIdSchema,
    requestedAt: isoDateTimeSchema,
    decidedBy: userIdSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
    decisionNote: z.string().trim().min(1).max(500).nullable(),
  })
  .superRefine((version, ctx) => {
    const ids = version.allocations.map((row) => row.shareholderId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["allocations"],
        message: "A shareholder appears at most once per version",
      });
    const decided =
      version.status === "approved" || version.status === "rejected";
    if (decided !== (version.decidedBy !== null && version.decidedAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["decidedBy"],
        message: "decidedBy/decidedAt are set exactly when decided",
      });
    if (version.status === "rejected" && version.decisionNote === null)
      ctx.addIssue({
        code: "custom",
        path: ["decisionNote"],
        message: "A rejection needs a note",
      });
    if (!decided && version.decisionNote !== null)
      ctx.addIssue({
        code: "custom",
        path: ["decisionNote"],
        message: "Only a decided version carries a decision note",
      });
    // A sole Owner may approve its own version (legend-b8y6l); a rejection
    // by the requester stays invalid.
    if (
      version.decidedBy !== null &&
      version.decidedBy === version.requestedBy &&
      version.status !== "approved"
    )
      ctx.addIssue({
        code: "custom",
        path: ["decidedBy"],
        message: "Approver must differ from requester (AUTH-06)",
      });
    // SH-03: a version that does not sum to exactly 100% cannot be activated.
    // A draft may be incomplete while the admin edits it; submit/approve refuse.
    if (
      version.status === "pending_approval" ||
      version.status === "approved"
    ) {
      const total = shareAllocationTotalBp(version.allocations);
      if (total !== 10_000)
        ctx.addIssue({
          code: "custom",
          path: ["allocations"],
          message: `Shares must sum to exactly 10,000 bp, got ${total}`,
        });
    }
  });
export type ShareAllocationVersion = z.infer<
  typeof shareAllocationVersionSchema
>;

/** Sum of a version's shares in basis points (10,000 = 100%). */
export function shareAllocationTotalBp(
  allocations: readonly Pick<ShareAllocation, "shareBp">[],
): number {
  return allocations.reduce((total, row) => total + row.shareBp, 0);
}

/**
 * SH-03: the shared check before submit and before approval. A list that is
 * short (9,500 bp) or over (10,250 bp) is rejected with the exact total in the
 * message so the live sum indicator and the server agree.
 */
export function assertShareAllocationsSum(
  allocations: readonly Pick<ShareAllocation, "shareBp">[],
): number {
  const total = shareAllocationTotalBp(allocations);
  if (total !== 10_000)
    throw new AccountingError(
      "SHARE_ALLOCATION_NOT_EXACT_100",
      `Total porsi harus tepat 10.000 bp (100%), saat ini ${total} bp.`,
    );
  return total;
}

/** Duplicate shareholders would double-count; the version schema also refuses. */
export function assertUniqueShareholders(
  allocations: readonly Pick<ShareAllocation, "shareholderId">[],
): void {
  const ids = new Set(allocations.map((row) => row.shareholderId));
  if (ids.size !== allocations.length)
    throw new AccountingError("SHARE_ALLOCATION_DUPLICATE");
}

/**
 * A replacement version starts strictly after the version it replaces, so a
 * distribution already run from a closed period keeps the split it used.
 * PRD §6 I `effective_from`; SH-03 "versi baru" semantics.
 */
export function assertEffectiveFromAdvances(
  latestApprovedEffectiveFrom: BusinessDate | null,
  effectiveFrom: BusinessDate,
): void {
  if (
    latestApprovedEffectiveFrom !== null &&
    effectiveFrom <= latestApprovedEffectiveFrom
  )
    throw new AccountingError("SHARE_VERSION_EFFECTIVE_DATE_ORDER");
}

/** Latest version number of an entity's register, 0 when it has none yet. */
export function latestShareAllocationVersion(
  versions: readonly Pick<
    ShareAllocationVersion,
    "profitEntityId" | "version"
  >[],
  profitEntityId: string,
): number {
  return versions
    .filter((row) => row.profitEntityId === profitEntityId)
    .reduce((max, row) => Math.max(max, row.version), 0);
}

/**
 * The version in force on `asOf`: approved, effective not after that date,
 * greatest `effectiveFrom` (then greatest version, which cannot tie for one
 * entity because the effective dates must advance). Null when none exists.
 */
export function effectiveShareAllocationVersion<
  Version extends Pick<
    ShareAllocationVersion,
    "profitEntityId" | "version" | "effectiveFrom" | "status"
  >,
>(versions: readonly Version[], profitEntityId: string, asOf: BusinessDate) {
  return (
    versions
      .filter(
        (row) =>
          row.profitEntityId === profitEntityId &&
          row.status === "approved" &&
          row.effectiveFrom <= asOf,
      )
      .sort((a, b) =>
        a.effectiveFrom === b.effectiveFrom
          ? b.version - a.version
          : a.effectiveFrom < b.effectiveFrom
            ? 1
            : -1,
      )[0] ?? null
  );
}

/** SH-03: a distribution may only use an approved, effective version. */
export function assertShareVersionUsable(
  version: Pick<ShareAllocationVersion, "status" | "allocations"> | null,
): asserts version is Pick<ShareAllocationVersion, "status" | "allocations"> {
  if (version === null)
    throw new AccountingError("SHARE_VERSION_NOT_EFFECTIVE");
  if (version.status !== "approved")
    throw new AccountingError("SHARE_VERSION_NOT_APPROVED");
  assertShareAllocationsSum(version.allocations);
}

/** SH-03: the version must already be effective on the distribution date. */
export function assertShareVersionEffective(
  version: Pick<ShareAllocationVersion, "effectiveFrom"> | null,
  asOf: BusinessDate,
): void {
  if (version === null || version.effectiveFrom > asOf)
    throw new AccountingError("SHARE_VERSION_NOT_EFFECTIVE");
}

export type ShareAllocationVersionAction =
  | { readonly type: "submit"; readonly actorId: UserId }
  | {
      readonly type: "approve";
      readonly actorId: UserId;
      readonly now: IsoDateTime;
      /** Sole Owner approving their own request (legend-b8y6l); skips the requester check. */
      readonly selfApproval?: SelfApprovalBasis;
    }
  | {
      readonly type: "reject";
      readonly actorId: UserId;
      readonly now: IsoDateTime;
      readonly reason: string;
    }
  | { readonly type: "cancel"; readonly actorId: UserId };

/**
 * Share-register state machine (SH-03). Only the requester edits/submits or
 * cancels; approve/reject need a different person (AUTH-06), except a sole
 * Owner approving (not rejecting) their own request. Submitting and
 * approving both re-check that the shares sum to exactly 100%.
 *
 *   draft ─submit→ pending_approval ─approve→ approved
 *     └─cancel→ cancelled            └─reject→ rejected ─cancel→ cancelled
 */
export function transitionShareAllocationVersion<
  Version extends Pick<
    ShareAllocationVersion,
    "status" | "requestedBy" | "allocations"
  >,
>(
  version: Version,
  action: ShareAllocationVersionAction,
): {
  status: ShareAllocationVersionStatus;
  decidedBy: UserId | null;
  decidedAt: IsoDateTime | null;
  decisionNote: string | null;
} {
  const { status } = version;
  const invalid = () => new AccountingError("INVALID_TRANSITION");
  const isRequester = action.actorId === version.requestedBy;
  switch (action.type) {
    case "submit":
      if (!isRequester || status !== "draft") throw invalid();
      assertUniqueShareholders(version.allocations);
      assertShareAllocationsSum(version.allocations);
      return {
        status: "pending_approval",
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
      };
    case "approve":
      if (status !== "pending_approval") throw invalid();
      if (action.actorId === version.requestedBy && !action.selfApproval)
        throw new AccessError("APPROVER_IS_REQUESTER");
      assertUniqueShareholders(version.allocations);
      assertShareAllocationsSum(version.allocations);
      return {
        status: "approved",
        decidedBy: action.actorId,
        decidedAt: action.now,
        decisionNote: null,
      };
    case "reject":
      if (status !== "pending_approval") throw invalid();
      if (action.actorId === version.requestedBy)
        throw new AccessError("APPROVER_IS_REQUESTER");
      if (action.reason.trim() === "") throw invalid();
      return {
        status: "rejected",
        decidedBy: action.actorId,
        decidedAt: action.now,
        decisionNote: action.reason.trim(),
      };
    case "cancel":
      if (!isRequester) throw invalid();
      if (status !== "draft" && status !== "rejected") throw invalid();
      return {
        status: "cancelled",
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
      };
  }
}

// ---- Distribution calculation (§3.37 Siklus Distribusi, §4 P) --------------

/**
 * Rounding, explicitly (contracts.md D-CORE-2):
 * - reserve = half-up of net profit × reserveBp;
 * - distributable = net profit − reserve;
 * - each line's gross = `allocateIdr` (largest remainder) over the allocations
 *   sorted by `shareholderId`, so the gross parts sum to distributable exactly
 *   and a tie on the remainder goes to the lowest shareholder id — never to
 *   whatever order the database returned the rows in;
 * - tax = half-up of gross × taxWithholdingBp, net = gross − tax.
 * A caller never rounds: the same code runs in the API, the FE mock and tests.
 */
export const DISTRIBUTION_ROUNDING = {
  reserve: "half_up",
  allocation: "largest_remainder",
  tax: "half_up",
} as const;

export const distributionCalculationLineSchema = z
  .strictObject({
    shareholderId: shareholderIdSchema,
    shareBp: positiveShareBp,
    grossIdr: idrSchema,
    /**
     * Carry (unabsorbed correction shortfall) deducted from this shareholder's
     * share before tax; `grossIdr` is the share after it (founder rule Q83).
     */
    carryDeductedIdr: nonNegativeIdr.default(idr(0)),
    taxWithheldIdr: idrSchema,
    netIdr: idrSchema,
  })
  .superRefine((line, ctx) => {
    if (line.grossIdr - line.taxWithheldIdr !== line.netIdr)
      ctx.addIssue({
        code: "custom",
        path: ["netIdr"],
        message: "netIdr must equal grossIdr − taxWithheldIdr",
      });
    if (line.grossIdr === 0 && line.carryDeductedIdr <= 0)
      ctx.addIssue({
        code: "custom",
        path: ["grossIdr"],
        message: "A zero line exists only when carry absorbed the whole share",
      });
  });
export type DistributionCalculationLine = z.infer<
  typeof distributionCalculationLineSchema
>;

const calculationTotalsShape = {
  totalGrossIdr: idrSchema,
  totalTaxWithheldIdr: idrSchema,
  totalNetIdr: idrSchema,
};

function checkCalculationTotals(
  row: {
    lines: readonly DistributionCalculationLine[];
    totalGrossIdr: Idr;
    totalTaxWithheldIdr: Idr;
    totalNetIdr: Idr;
  },
  ctx: z.RefinementCtx,
): void {
  if (sumIdr(row.lines.map((line) => line.grossIdr)) !== row.totalGrossIdr)
    ctx.addIssue({
      code: "custom",
      path: ["totalGrossIdr"],
      message: "totalGrossIdr must equal the line gross total",
    });
  if (
    sumIdr(row.lines.map((line) => line.taxWithheldIdr)) !==
    row.totalTaxWithheldIdr
  )
    ctx.addIssue({
      code: "custom",
      path: ["totalTaxWithheldIdr"],
      message: "totalTaxWithheldIdr must equal the line tax total",
    });
  if (sumIdr(row.lines.map((line) => line.netIdr)) !== row.totalNetIdr)
    ctx.addIssue({
      code: "custom",
      path: ["totalNetIdr"],
      message: "totalNetIdr must equal the line net total",
    });
}

const calculationBaseShape = {
  profitEntityId: profitEntityIdSchema,
  fiscalPeriodId: fiscalPeriodIdSchema,
  period: periodKeySchema,
  lines: z.array(distributionCalculationLineSchema).min(1).max(200),
  ...calculationTotalsShape,
};

export const distributionCalculationSchema = z
  .strictObject({
    basis: z.literal("closed_period_net_profit"),
    ...calculationBaseShape,
    periodNetProfitIdr: positiveIdr,
    reserveIdr: nonNegativeIdr,
    distributableIdr: positiveIdr,
    /** Total carry deducted from this run's shares, absorbed shareholders included. */
    carryDeductedIdr: nonNegativeIdr.default(idr(0)),
    /** What each shortfall gave up, for the BE to persist with the run. */
    carryDeductions: z
      .array(
        z.strictObject({
          shareholderId: z.string().min(1),
          shortfallId: z.string().min(1),
          amountIdr: positiveIdr,
        }),
      )
      .default([]),
  })
  .superRefine((row, ctx) => {
    checkCalculationTotals(row, ctx);
    if (row.distributableIdr !== row.totalGrossIdr + row.carryDeductedIdr)
      ctx.addIssue({
        code: "custom",
        path: ["distributableIdr"],
        message:
          "distributableIdr must equal the allocated gross total plus carry deducted",
      });
    if (row.periodNetProfitIdr - row.reserveIdr !== row.distributableIdr)
      ctx.addIssue({
        code: "custom",
        path: ["reserveIdr"],
        message: "net profit − reserve must equal distributable profit",
      });
    if (
      row.lines.some(
        (line) =>
          line.grossIdr < 0 ||
          (line.grossIdr === 0 && line.carryDeductedIdr <= 0),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message:
          "A regular distribution line must be > 0, or 0 only when carry absorbed it",
      });
  });
export type DistributionCalculation = z.infer<
  typeof distributionCalculationSchema
>;

export const adjustmentCalculationSchema = z
  .strictObject({
    basis: z.literal("approved_run_adjustment"),
    ...calculationBaseShape,
    adjustsRunId: distributionRunIdSchema,
    reason: z.string().trim().min(1).max(500),
    /** The amount actually allocated: the request, less any unabsorbed rest. */
    adjustmentIdr: nonZeroIdr,
    /** Founder rule Q83: claw-back that no shareholder's paid gross can absorb. */
    unabsorbedIdr: nonNegativeIdr,
    /** Top-up only: carry deducted from the shares (`adjustmentIdr` = gross + carry). */
    carryDeductedIdr: nonNegativeIdr.default(idr(0)),
    carryDeductions: z
      .array(
        z.strictObject({
          shareholderId: z.string().min(1),
          shortfallId: z.string().min(1),
          amountIdr: positiveIdr,
        }),
      )
      .default([]),
  })
  .superRefine((row, ctx) => {
    checkCalculationTotals(row, ctx);
    if (row.adjustmentIdr < 0 && row.carryDeductedIdr > 0)
      ctx.addIssue({
        code: "custom",
        path: ["carryDeductedIdr"],
        message: "Only a positive adjustment deducts carry",
      });
    if (
      sumIdr(row.carryDeductions.map((d) => d.amountIdr)) !==
      row.carryDeductedIdr
    )
      ctx.addIssue({
        code: "custom",
        path: ["carryDeductions"],
        message: "carryDeductions must sum to carryDeductedIdr",
      });
    if (row.unabsorbedIdr > 0 && row.adjustmentIdr > 0)
      ctx.addIssue({
        code: "custom",
        path: ["unabsorbedIdr"],
        message: "Only a claw-back can leave an unabsorbed rest",
      });
    if (row.adjustmentIdr !== row.totalGrossIdr + row.carryDeductedIdr)
      ctx.addIssue({
        code: "custom",
        path: ["adjustmentIdr"],
        message:
          "adjustmentIdr must equal the allocated gross total plus carry deducted",
      });
    if (
      row.lines.some(
        (line) => line.grossIdr === 0 && line.carryDeductedIdr <= 0,
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message: "Every adjustment line must be non-zero or absorbed by carry",
      });
  });
export type AdjustmentCalculation = z.infer<typeof adjustmentCalculationSchema>;

type AllocationWeight = {
  readonly shareholderId: Shareholder["id"];
  readonly shareBp: number;
};

function assertClosedPeriod(periodStatus: "open" | "closed"): void {
  // SH-02 / §3.37: official distribution figures come from closed periods only.
  if (periodStatus !== "closed") throw new AccountingError("PERIOD_NOT_CLOSED");
}

/** What a shareholder still holds of a corrected run (gross and tax withheld). */
export type HeldPaid = { grossIdr: number; taxWithheldIdr: number };

/**
 * An open correction shortfall of one shareholder (founder rule Q83): the part
 * a claw-back could not take back from what the shareholder had been paid.
 */
export type CarryShortfall = { shortfallId: string; amountIdr: number };

/** What a regular run takes from one shortfall of one shareholder. */
export type CarryDeduction = {
  shareholderId: string;
  shortfallId: string;
  amountIdr: Idr;
};

/**
 * Takes `min(share, open)` from the shareholder's open shortfalls, oldest
 * first (founder rule Q83). A deduction never moves to another shareholder.
 */
function deductCarry(
  shareholderId: string,
  share: number,
  open: readonly CarryShortfall[] | undefined,
): { left: number; deductions: CarryDeduction[] } {
  let left = share;
  const deductions: CarryDeduction[] = [];
  for (const shortfall of open ?? []) {
    const taken = Math.min(left, shortfall.amountIdr);
    if (taken <= 0) continue;
    deductions.push({
      shareholderId,
      shortfallId: shortfall.shortfallId,
      amountIdr: idr(taken),
    });
    left -= taken;
  }
  return { left, deductions };
}

/**
 * Regular split with carry. Each shareholder's share `S` is the usual largest
 * remainder part; the open shortfalls (oldest first, as the caller orders them)
 * take `min(S, what is open)` and tax runs on the rest. A share absorbed to
 * zero still gets a line (gross 0, tax 0, net 0) whose `carryDeductedIdr` is
 * the share: that is how its open carry shrinks. A deduction never moves to
 * another shareholder.
 */
function buildCalculationLines(
  amountIdr: Idr,
  allocations: readonly AllocationWeight[],
  taxWithholdingBp: number,
  carry?: ReadonlyMap<string, readonly CarryShortfall[]>,
): {
  lines: DistributionCalculationLine[];
  carryDeductions: CarryDeduction[];
} {
  assertUniqueShareholders(allocations);
  assertShareAllocationsSum(allocations);
  const ordered = [...allocations].sort((a, b) =>
    a.shareholderId < b.shareholderId ? -1 : 1,
  );
  const grossParts = allocateIdr(
    amountIdr,
    ordered.map((row) => row.shareBp),
  );
  if (grossParts.some((part) => part === 0))
    throw new AccountingError(
      "NOTHING_TO_DISTRIBUTE",
      "Jumlah terlalu kecil: setiap pemegang saham harus menerima minimal Rp1.",
    );
  const lines: DistributionCalculationLine[] = [];
  const carryDeductions: CarryDeduction[] = [];
  ordered.forEach((row, index) => {
    const share = grossParts[index];
    const { left, deductions } = deductCarry(
      row.shareholderId,
      share,
      carry?.get(row.shareholderId),
    );
    carryDeductions.push(...deductions);
    const grossIdr = idr(left);
    const taxWithheldIdr = applyBasisPoints(
      grossIdr,
      taxWithholdingBp,
      DISTRIBUTION_ROUNDING.tax,
    );
    lines.push(
      distributionCalculationLineSchema.parse({
        shareholderId: row.shareholderId,
        shareBp: row.shareBp,
        grossIdr,
        carryDeductedIdr: idr(share - left),
        taxWithheldIdr,
        netIdr: subtractIdr(grossIdr, taxWithheldIdr),
      }),
    );
  });
  return { lines, carryDeductions };
}

/**
 * Splits `amountIdr` over the allocations (largest remainder, ties to the
 * lowest shareholder id). For a negative amount, `availableGrossIdr` (what each
 * shareholder still holds of the corrected run's paid gross) caps that
 * shareholder's share of the claw-back: the part that does not fit is
 * `unabsorbedIdr` and is never moved to another shareholder (founder rule
 * Q83). A shareholder with nothing left gets no line.
 */
function buildClampedCalculationLines(
  amountIdr: Idr,
  allocations: readonly AllocationWeight[],
  taxWithholdingBp: number,
  held?: ReadonlyMap<string, HeldPaid>,
  carry?: ReadonlyMap<string, readonly CarryShortfall[]>,
): {
  lines: DistributionCalculationLine[];
  unabsorbedIdr: Idr;
  unabsorbedByShareholder: Map<string, Idr>;
  carryDeductions: CarryDeduction[];
} {
  assertUniqueShareholders(allocations);
  assertShareAllocationsSum(allocations);
  // Canonical order: the remainder tie-break must not depend on row order.
  const ordered = [...allocations].sort((a, b) =>
    a.shareholderId < b.shareholderId ? -1 : 1,
  );
  const grossParts = allocateIdr(
    amountIdr,
    ordered.map((row) => row.shareBp),
  );
  // A share too small to receive a whole rupiah would make a zero line; the
  // schema refuses it, so report it as a domain error instead of a parse error.
  if (grossParts.some((part) => part === 0))
    throw new AccountingError(
      "NOTHING_TO_DISTRIBUTE",
      "Jumlah terlalu kecil: setiap pemegang saham harus menerima minimal Rp1.",
    );
  let unabsorbed = 0;
  const unabsorbedByShareholder = new Map<string, Idr>();
  const lines: DistributionCalculationLine[] = [];
  const carryDeductions: CarryDeduction[] = [];
  ordered.forEach((row, index) => {
    let grossIdr = grossParts[index];
    let carryDeductedIdr = 0;
    let taxWithheldIdr: Idr | null = null;
    if (amountIdr > 0 && carry !== undefined) {
      // Top-up: the shareholder's open carry is paid down first (Q83).
      const { left, deductions } = deductCarry(
        row.shareholderId,
        grossIdr,
        carry.get(row.shareholderId),
      );
      carryDeductions.push(...deductions);
      carryDeductedIdr = grossIdr - left;
      grossIdr = idr(left);
    }
    if (amountIdr < 0 && held !== undefined) {
      const holding = held.get(row.shareholderId);
      const available = Math.max(holding?.grossIdr ?? 0, 0);
      if (-grossIdr >= available) {
        const short = -grossIdr - available;
        unabsorbed += short;
        if (short > 0)
          unabsorbedByShareholder.set(row.shareholderId, idr(short));
        grossIdr = idr(-available);
        // Giving back everything also gives back all the tax still held, so
        // rounding on each step never leaves a tax residue behind.
        taxWithheldIdr = idr(-(holding?.taxWithheldIdr ?? 0));
      }
      if (grossIdr === 0) return;
      if (taxWithheldIdr === null && holding !== undefined) {
        // Partial claw-back: give back the tax the shareholder no longer needs
        // to hold on what is left (target after this line minus tax held now),
        // not a per-line rounding. Rounding each step alone could return more
        // tax than was withheld over repeated claw-backs.
        const target = applyBasisPoints(
          idr(holding.grossIdr + grossIdr),
          taxWithholdingBp,
          DISTRIBUTION_ROUNDING.tax,
        );
        // Never positive, never more than held, never more than the gross.
        taxWithheldIdr = idr(
          Math.min(
            0,
            Math.max(
              target - holding.taxWithheldIdr,
              -holding.taxWithheldIdr,
              grossIdr,
            ),
          ),
        );
      }
    }
    taxWithheldIdr ??= applyBasisPoints(
      grossIdr,
      taxWithholdingBp,
      DISTRIBUTION_ROUNDING.tax,
    );
    lines.push(
      distributionCalculationLineSchema.parse({
        shareholderId: row.shareholderId,
        shareBp: row.shareBp,
        grossIdr,
        carryDeductedIdr: idr(carryDeductedIdr),
        taxWithheldIdr,
        netIdr: subtractIdr(grossIdr, taxWithheldIdr),
      }),
    );
  });
  return {
    lines,
    unabsorbedIdr: idr(unabsorbed),
    unabsorbedByShareholder,
    carryDeductions,
  };
}

function totalsOf(lines: readonly DistributionCalculationLine[]) {
  return {
    totalGrossIdr: sumIdr(lines.map((line) => line.grossIdr)),
    totalTaxWithheldIdr: sumIdr(lines.map((line) => line.taxWithheldIdr)),
    totalNetIdr: sumIdr(lines.map((line) => line.netIdr)),
  };
}

/**
 * Regular cycle step 1–2: profit available for distribution and the simulated
 * per-shareholder lines. Returns plain calculation data; the BE persists it as
 * a `distribution_runs` row plus `distribution_lines` (ids assigned there).
 */
export function calculateDistribution(input: {
  profitEntityId: ProfitEntity["id"];
  fiscalPeriodId: DistributionCalculation["fiscalPeriodId"];
  period: DistributionCalculation["period"];
  periodStatus: "open" | "closed";
  /** Net profit of the closed period, from the P&L statement builder. */
  periodNetProfitIdr: Idr;
  policy: DistributionPolicy;
  /** The approved, effective share version's allocations. */
  allocations: readonly AllocationWeight[];
  /**
   * Open correction shortfalls per shareholder, oldest first (founder rule
   * Q83). Each is deducted from that shareholder's share of this run only.
   */
  carry?: ReadonlyMap<string, readonly CarryShortfall[]>;
}): DistributionCalculation & {
  carryDeductedIdr: Idr;
  carryDeductions: CarryDeduction[];
} {
  assertClosedPeriod(input.periodStatus);
  if (input.periodNetProfitIdr <= 0)
    throw new AccountingError("NOTHING_TO_DISTRIBUTE");
  const reserveIdr = applyBasisPoints(
    input.periodNetProfitIdr,
    input.policy.reserveBp,
    DISTRIBUTION_ROUNDING.reserve,
  );
  const distributableIdr = subtractIdr(input.periodNetProfitIdr, reserveIdr);
  if (distributableIdr <= 0) throw new AccountingError("NOTHING_TO_DISTRIBUTE");
  const { lines, carryDeductions } = buildCalculationLines(
    distributableIdr,
    input.allocations,
    input.policy.taxWithholdingBp,
    input.carry,
  );
  const carryDeductedIdr = sumIdr(carryDeductions.map((row) => row.amountIdr));
  return distributionCalculationSchema.parse({
    basis: "closed_period_net_profit",
    profitEntityId: input.profitEntityId,
    fiscalPeriodId: input.fiscalPeriodId,
    period: input.period,
    periodNetProfitIdr: input.periodNetProfitIdr,
    reserveIdr,
    distributableIdr,
    carryDeductedIdr,
    carryDeductions,
    lines,
    ...totalsOf(lines),
  });
}

/**
 * SH-04 correction: an adjustment distribution keeps the split of the run it
 * corrects (the caller passes that run's snapshot allocations), may be negative
 * (claw-back) and still needs a closed fiscal period for its journal.
 */
export function calculateAdjustmentDistribution(input: {
  profitEntityId: ProfitEntity["id"];
  fiscalPeriodId: DistributionCalculation["fiscalPeriodId"];
  period: DistributionCalculation["period"];
  periodStatus: "open" | "closed";
  adjustsRunId: AdjustmentCalculation["adjustsRunId"];
  reason: string;
  /** Signed amount to correct; negative claws back an overpayment. */
  adjustmentIdr: Idr;
  taxWithholdingBp: number;
  allocations: readonly AllocationWeight[];
  /**
   * Claw-back only: the paid gross and tax each shareholder still holds (the
   * corrected run plus its live adjustments). Omitted: no cap.
   */
  held?: ReadonlyMap<string, HeldPaid>;
  /**
   * Top-up only (positive amount): open correction shortfalls per shareholder,
   * oldest first. Each is paid down from that shareholder's share before tax.
   * Ignored for a claw-back.
   */
  carry?: ReadonlyMap<string, readonly CarryShortfall[]>;
}): AdjustmentCalculation & {
  /** Claw-back rest per shareholder; sums to `unabsorbedIdr` (Q83 carry). */
  unabsorbedByShareholder: Map<string, Idr>;
  carryDeductedIdr: Idr;
  /** What each shortfall gave up, for the BE to persist with the run. */
  carryDeductions: CarryDeduction[];
} {
  assertClosedPeriod(input.periodStatus);
  if (input.reason.trim() === "")
    throw new AccountingError("ADJUSTMENT_TARGET_INVALID");
  if (input.adjustmentIdr === 0)
    throw new AccountingError("NOTHING_TO_DISTRIBUTE");
  const { lines, unabsorbedIdr, unabsorbedByShareholder, carryDeductions } =
    buildClampedCalculationLines(
      input.adjustmentIdr,
      input.allocations,
      input.taxWithholdingBp,
      input.held,
      input.carry,
    );
  if (lines.length === 0) throw new AccountingError("ADJUSTMENT_EXCEEDS_PAID");
  const carryDeductedIdr = sumIdr(carryDeductions.map((row) => row.amountIdr));
  return {
    ...adjustmentCalculationSchema.parse({
      basis: "approved_run_adjustment",
      profitEntityId: input.profitEntityId,
      fiscalPeriodId: input.fiscalPeriodId,
      period: input.period,
      adjustsRunId: input.adjustsRunId,
      reason: input.reason.trim(),
      adjustmentIdr: idr(
        sumIdr(lines.map((line) => line.grossIdr)) + carryDeductedIdr,
      ),
      unabsorbedIdr,
      carryDeductedIdr,
      carryDeductions,
      lines,
      ...totalsOf(lines),
    }),
    unabsorbedByShareholder,
  };
}

// ---- Distribution runs & lines (PRD §6 I `distribution_runs`, `distribution_lines`, SH-04)

export const DISTRIBUTION_RUN_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "paid",
  "cancelled",
] as const;
export const distributionRunStatusSchema = z.enum(DISTRIBUTION_RUN_STATUSES);
export type DistributionRunStatus = z.infer<typeof distributionRunStatusSchema>;

export const distributionRunTypeSchema = z.enum(["regular", "adjustment"]);
export type DistributionRunType = z.infer<typeof distributionRunTypeSchema>;

export const distributionRunBasisSchema = z.enum([
  "closed_period_net_profit",
  "approved_run_adjustment",
]);
export type DistributionRunBasis = z.infer<typeof distributionRunBasisSchema>;

export const distributionLinePaymentStatusSchema = z.enum(["pending", "paid"]);
export type DistributionLinePaymentStatus = z.infer<
  typeof distributionLinePaymentStatusSchema
>;

const distributionLineBaseShape = {
  shareholderId: shareholderIdSchema,
  shareBp: positiveShareBp,
  grossIdr: idrSchema,
  /** Carry deducted from this shareholder's share on this run (Q83). */
  carryDeductedIdr: nonNegativeIdr.default(idr(0)),
  taxWithheldIdr: idrSchema,
  netIdr: idrSchema,
};

export const distributionLineSchema = z
  .strictObject({
    id: distributionLineIdSchema,
    tenantId: tenantIdSchema,
    distributionRunId: distributionRunIdSchema,
    ...distributionLineBaseShape,
    paymentStatus: distributionLinePaymentStatusSchema,
    paymentRef: z.string().trim().min(1).max(100).nullable(),
    paidAt: isoDateTimeSchema.nullable(),
    /** Statement document key (§6 I `distribution_lines.statement_file_key`). */
    statementFileKey: storageKeySchema.nullable(),
  })
  .superRefine((line, ctx) => {
    if (line.grossIdr - line.taxWithheldIdr !== line.netIdr)
      ctx.addIssue({
        code: "custom",
        path: ["netIdr"],
        message: "netIdr must equal grossIdr − taxWithheldIdr",
      });
    if (line.grossIdr === 0 && line.carryDeductedIdr <= 0)
      ctx.addIssue({
        code: "custom",
        path: ["grossIdr"],
        message: "A zero line exists only when carry absorbed the whole share",
      });
    const paid = line.paymentStatus === "paid";
    if (paid !== (line.paymentRef !== null && line.paidAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["paymentStatus"],
        message: "paymentRef/paidAt are set exactly when paid",
      });
    if (!paid && line.statementFileKey !== null)
      ctx.addIssue({
        code: "custom",
        path: ["statementFileKey"],
        message: "A statement exists only after the line is paid",
      });
  });
export type DistributionLine = z.infer<typeof distributionLineSchema>;

/** Trace of a carry deduction back to the correction run it came from. */
export const distributionCarryDeductionSchema = z.strictObject({
  shareholderId: shareholderIdSchema,
  /** The adjustment run whose unabsorbed rest this deduction pays down. */
  shortfallRunId: distributionRunIdSchema,
  amountIdr: positiveIdr,
});
export type DistributionCarryDeduction = z.infer<
  typeof distributionCarryDeductionSchema
>;

export const distributionRunSchema = z
  .strictObject({
    id: distributionRunIdSchema,
    tenantId: tenantIdSchema,
    profitEntityId: profitEntityIdSchema,
    fiscalPeriodId: fiscalPeriodIdSchema,
    /** Business period of `fiscalPeriodId`, for display and statements. */
    period: periodKeySchema,
    type: distributionRunTypeSchema,
    basis: distributionRunBasisSchema,
    status: distributionRunStatusSchema,
    /** Share version snapshot used for the split (SH-03, SH-04). */
    shareVersion: z.number().int().min(1).safe(),
    /** Net profit of the closed period the run is based on; null on adjustments. */
    periodNetProfitIdr: idrSchema.nullable(),
    reserveIdr: nonNegativeIdr,
    /** Gross amount allocated by this run (signed on adjustments). */
    distributableIdr: nonZeroIdr,
    lines: z.array(distributionLineSchema).min(1).max(200),
    ...calculationTotalsShape,
    requestedBy: userIdSchema,
    requestedAt: isoDateTimeSchema,
    approvedBy: userIdSchema.nullable(),
    approvedAt: isoDateTimeSchema.nullable(),
    /** Set when the last line is paid. */
    paidAt: isoDateTimeSchema.nullable(),
    /** SH-04: the run this adjustment corrects. */
    adjustsRunId: distributionRunIdSchema.nullable(),
    adjustmentReason: z.string().trim().min(1).max(500).nullable(),
    /** Reversing journal posted with an adjustment (SH-04). */
    reversalJournalEntryId: journalEntryIdSchema.nullable(),
    /**
     * Claw-back rest that no shareholder's paid gross could absorb (founder
     * rule Q83): recorded open, never charged to another shareholder.
     */
    unabsorbedIdr: nonNegativeIdr,
    /**
     * Regular run or positive adjustment: carry deducted from shares (founder
     * rule Q83). The run's `distributableIdr` is `totalGrossIdr + carryDeductedIdr`.
     */
    carryDeductedIdr: nonNegativeIdr.default(idr(0)),
    carryDeductions: z.array(distributionCarryDeductionSchema).default([]),
  })
  .superRefine((run, ctx) => {
    const lineIds = new Set<string>();
    for (const line of run.lines) {
      if (line.tenantId !== run.tenantId)
        ctx.addIssue({
          code: "custom",
          path: ["lines"],
          message: "Every line belongs to the run's tenant",
        });
      if (line.distributionRunId !== run.id)
        ctx.addIssue({
          code: "custom",
          path: ["lines"],
          message: "Every line belongs to this run",
        });
      if (lineIds.has(line.shareholderId))
        ctx.addIssue({
          code: "custom",
          path: ["lines"],
          message: "One line per shareholder",
        });
      lineIds.add(line.shareholderId);
    }
    if (sumIdr(run.lines.map((line) => line.grossIdr)) !== run.totalGrossIdr)
      ctx.addIssue({
        code: "custom",
        path: ["totalGrossIdr"],
        message: "totalGrossIdr must equal the line gross total",
      });
    if (
      sumIdr(run.lines.map((line) => line.taxWithheldIdr)) !==
      run.totalTaxWithheldIdr
    )
      ctx.addIssue({
        code: "custom",
        path: ["totalTaxWithheldIdr"],
        message: "totalTaxWithheldIdr must equal the line tax total",
      });
    if (sumIdr(run.lines.map((line) => line.netIdr)) !== run.totalNetIdr)
      ctx.addIssue({
        code: "custom",
        path: ["totalNetIdr"],
        message: "totalNetIdr must equal the line net total",
      });
    if (run.distributableIdr !== run.totalGrossIdr + run.carryDeductedIdr)
      ctx.addIssue({
        code: "custom",
        path: ["distributableIdr"],
        message:
          "distributableIdr must equal the allocated gross total plus carry deducted",
      });
    if (
      sumIdr(run.carryDeductions.map((row) => row.amountIdr)) !==
      run.carryDeductedIdr
    )
      ctx.addIssue({
        code: "custom",
        path: ["carryDeductions"],
        message: "carryDeductions must sum to carryDeductedIdr",
      });
    for (const line of run.lines) {
      const deducted = sumIdr(
        run.carryDeductions
          .filter((row) => row.shareholderId === line.shareholderId)
          .map((row) => row.amountIdr),
      );
      if (deducted !== line.carryDeductedIdr)
        ctx.addIssue({
          code: "custom",
          path: ["lines"],
          message: "A line's carryDeductedIdr must match its carryDeductions",
        });
    }
    if (run.carryDeductedIdr > 0 && run.distributableIdr <= 0)
      ctx.addIssue({
        code: "custom",
        path: ["carryDeductedIdr"],
        message: "Only a regular run or a positive adjustment deducts carry",
      });

    if (
      run.unabsorbedIdr > 0 &&
      (run.type !== "adjustment" || run.distributableIdr > 0)
    )
      ctx.addIssue({
        code: "custom",
        path: ["unabsorbedIdr"],
        message: "Only a claw-back can leave an unabsorbed rest",
      });

    const regular = run.type === "regular";
    if (regular !== (run.basis === "closed_period_net_profit"))
      ctx.addIssue({
        code: "custom",
        path: ["basis"],
        message: "basis must match the run type",
      });
    if (regular) {
      if (run.periodNetProfitIdr === null)
        ctx.addIssue({
          code: "custom",
          path: ["periodNetProfitIdr"],
          message: "A regular run carries the closed period's net profit",
        });
      else if (
        subtractIdr(run.periodNetProfitIdr, run.reserveIdr) !==
        run.distributableIdr
      )
        ctx.addIssue({
          code: "custom",
          path: ["reserveIdr"],
          message: "net profit − reserve must equal distributable profit",
        });
      if (
        run.lines.some(
          (line) =>
            line.grossIdr < 0 ||
            (line.grossIdr === 0 && line.carryDeductedIdr <= 0),
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["lines"],
          message:
            "A regular distribution line must be > 0, or 0 only when carry absorbed it",
        });
      if (run.adjustsRunId !== null || run.adjustmentReason !== null)
        ctx.addIssue({
          code: "custom",
          path: ["adjustsRunId"],
          message: "Only an adjustment references another run",
        });
    } else {
      if (run.periodNetProfitIdr !== null || run.reserveIdr !== 0)
        ctx.addIssue({
          code: "custom",
          path: ["periodNetProfitIdr"],
          message: "An adjustment has no period profit or reserve",
        });
      if (run.adjustsRunId === null || run.adjustmentReason === null)
        ctx.addIssue({
          code: "custom",
          path: ["adjustsRunId"],
          message: "An adjustment names the run it corrects and why",
        });
      if (
        run.lines.some(
          (line) => line.grossIdr === 0 && line.carryDeductedIdr <= 0,
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["lines"],
          message:
            "Every adjustment line must be non-zero or absorbed by carry",
        });
    }

    const paidLines = run.lines.filter(
      (line) => line.paymentStatus === "paid",
    ).length;
    if (run.status === "draft" || run.status === "pending_approval") {
      if (paidLines > 0)
        ctx.addIssue({
          code: "custom",
          path: ["status"],
          message: "Nothing is paid before approval",
        });
    }
    // A zero line settled by the carry on approval is not money paid out
    // (SO 1216 F-P1a): a run withdrawn after approval may keep it.
    if (
      run.status === "cancelled" &&
      run.lines.some((line) => isMoneyPaidLine(line))
    )
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "A cancelled run has no payments",
      });
    const approved = run.status === "approved" || run.status === "paid";
    // A cancelled run keeps its approval when it was withdrawn after it
    // (cancel_approved, SO 1216 F-P1a).
    const approvalSet = run.approvedBy !== null && run.approvedAt !== null;
    if (approved ? !approvalSet : approvalSet && run.status !== "cancelled")
      ctx.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "approvedBy/approvedAt are set exactly when approved",
      });
    if (run.approvedBy !== null && run.approvedBy === run.requestedBy)
      ctx.addIssue({
        code: "custom",
        path: ["approvedBy"],
        message: "Approver must differ from requester (AUTH-06)",
      });
    if (run.status === "approved" && paidLines === run.lines.length)
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "All lines paid means the run is paid",
      });
    if (run.status === "paid" && paidLines !== run.lines.length)
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "A paid run has every line paid",
      });
    if ((run.status === "paid") !== (run.paidAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["paidAt"],
        message: "paidAt is set exactly when the run is paid",
      });
  });
export type DistributionRun = z.infer<typeof distributionRunSchema>;

/** List row: totals and progress without the full line list. */
export const distributionRunSummarySchema = z
  .strictObject({
    id: distributionRunIdSchema,
    profitEntityId: profitEntityIdSchema,
    fiscalPeriodId: fiscalPeriodIdSchema,
    period: periodKeySchema,
    type: distributionRunTypeSchema,
    status: distributionRunStatusSchema,
    shareVersion: z.number().int().min(1).safe(),
    distributableIdr: nonZeroIdr,
    totalTaxWithheldIdr: idrSchema,
    totalNetIdr: idrSchema,
    lineCount: z.number().int().min(1),
    paidLineCount: z.number().int().min(0),
    requestedBy: userIdSchema,
    requestedAt: isoDateTimeSchema,
    approvedBy: userIdSchema.nullable(),
    approvedAt: isoDateTimeSchema.nullable(),
    paidAt: isoDateTimeSchema.nullable(),
    /**
     * SO 1216 F-P1a (computed): a regular approved/paid run whose fiscal
     * period version moved since it was calculated, with no approved or paid
     * adjustment of it at the period's current version.
     */
    needsCorrection: z.boolean(),
  })
  .superRefine((row, ctx) => {
    if (row.paidLineCount > row.lineCount)
      ctx.addIssue({
        code: "custom",
        path: ["paidLineCount"],
        message: "paidLineCount cannot exceed lineCount",
      });
  });
export type DistributionRunSummary = z.infer<
  typeof distributionRunSummarySchema
>;

/** SH-04: approved or paid runs are frozen. Anything but a draft is refused. */
export function assertDistributionEditable(
  run: Pick<DistributionRun, "status">,
): void {
  if (run.status === "approved" || run.status === "paid")
    throw new AccountingError("DISTRIBUTION_IMMUTABLE");
  if (run.status !== "draft") throw new AccountingError("INVALID_TRANSITION");
}

/** SH-04: a correction is a new adjustment run, never an edit of this one. */
export function assertAdjustmentTarget(
  original: Pick<DistributionRun, "status" | "type"> | null,
): void {
  if (original === null) throw new AccountingError("ADJUSTMENT_TARGET_INVALID");
  if (original.status !== "approved" && original.status !== "paid")
    throw new AccountingError("ADJUSTMENT_TARGET_INVALID");
  // One correction tree per regular run: the claw-back room of a shareholder is
  // counted against the regular run, never against another adjustment.
  if (original.type !== "regular")
    throw new AccountingError("ADJUSTMENT_TARGET_INVALID");
}

/**
 * Hard rule (coordinator decision, 1 Nov 2026; PRD silent): one regular run per
 * profit entity and closed period. Corrections are adjustment runs. The BE
 * backs this with a partial unique index on (tenant_id, profit_entity_id,
 * fiscal_period_id) WHERE type = 'regular' AND status <> 'cancelled'.
 */
/**
 * SH-04: an adjustment corrects one run with that run's split: same profit
 * entity, same share version and the same shareholder → share list.
 */
export function assertAdjustmentMatchesTarget(
  original: Pick<DistributionRun, "profitEntityId" | "shareVersion" | "lines">,
  adjustment: {
    profitEntityId: string;
    shareVersion: number;
    lines: readonly Pick<DistributionLine, "shareholderId" | "shareBp">[];
  },
  options: {
    /**
     * A claw-back may leave out a shareholder with nothing left to give back
     * (founder rule Q83): every adjustment line must still match a line of the
     * corrected run, but not every run line needs an adjustment line.
     */
    allowSubset?: boolean;
  } = {},
): void {
  const key = (
    lines: readonly Pick<DistributionLine, "shareholderId" | "shareBp">[],
  ) =>
    lines
      .map((line) => `${line.shareholderId}:${line.shareBp}`)
      .sort()
      .join(",");
  const originalKeys = new Set(original.lines.map(key1));
  const matches = options.allowSubset
    ? adjustment.lines.length > 0 &&
      adjustment.lines.every((line) => originalKeys.has(key1(line)))
    : key(original.lines) === key(adjustment.lines);
  if (
    original.profitEntityId !== adjustment.profitEntityId ||
    original.shareVersion !== adjustment.shareVersion ||
    !matches
  )
    throw new AccountingError(
      "ADJUSTMENT_TARGET_INVALID",
      "Penyesuaian harus memakai entitas dan porsi distribusi yang dikoreksi.",
    );
}

function key1(line: Pick<DistributionLine, "shareholderId" | "shareBp">) {
  return `${line.shareholderId}:${line.shareBp}`;
}

export function assertNoDuplicateRegularRun(
  runs: readonly Pick<
    DistributionRun,
    "id" | "profitEntityId" | "fiscalPeriodId" | "type" | "status"
  >[],
  input: {
    profitEntityId: string;
    fiscalPeriodId: string;
    ignoreRunId?: string;
  },
): void {
  if (
    runs.some(
      (run) =>
        run.type === "regular" &&
        run.status !== "cancelled" &&
        run.profitEntityId === input.profitEntityId &&
        run.fiscalPeriodId === input.fiscalPeriodId &&
        run.id !== input.ignoreRunId,
    )
  )
    throw new AccountingError("DISTRIBUTION_ALREADY_EXISTS");
}

/** Payment reference of a zero line, settled on approve (carry absorbed it). */
export const CARRY_ABSORBED_PAYMENT_REF = "POTONG-KEKURANGAN";

/**
 * A line whose money actually went out: paid, and not a zero line settled
 * by the carry on approval (`CARRY_ABSORBED_PAYMENT_REF`). SO 1216 F-P1a.
 */
export function isMoneyPaidLine(line: {
  readonly paymentStatus: string;
  readonly grossIdr: number;
  readonly paymentRef: string | null;
}): boolean {
  return (
    line.paymentStatus === "paid" &&
    !(line.grossIdr === 0 && line.paymentRef === CARRY_ABSORBED_PAYMENT_REF)
  );
}

export type DistributionRunAction =
  | { readonly type: "submit"; readonly actorId: UserId }
  | {
      readonly type: "approve";
      readonly actorId: UserId;
      readonly now: IsoDateTime;
    }
  | {
      readonly type: "reject";
      readonly actorId: UserId;
      readonly reason: string;
    }
  | { readonly type: "cancel"; readonly actorId: UserId }
  | {
      readonly type: "cancel_approved";
      readonly actorId: UserId;
      readonly reason: string;
    }
  | {
      readonly type: "record_payment";
      readonly actorId: UserId;
      readonly lineId: DistributionLine["id"];
      readonly paymentRef: string;
      readonly paidAt: IsoDateTime;
    };

/**
 * Distribution state machine (SH-04).
 *
 *   draft ─submit→ pending_approval ─approve→ approved ─all lines paid→ paid
 *     └─cancel→ cancelled          └─reject→ cancelled
 *   approved ─cancel_approved (no line paid, reason)→ cancelled
 *
 * Approve also settles every zero line (carry absorbed the share) with
 * `CARRY_ABSORBED_PAYMENT_REF`; when all lines are zero the run is `paid` then.
 *
 * Amounts are frozen from `approved` on: after approval only payment recording
 * (per line) and statement attachment change a run. Returns a new run object;
 * a rejected distribution is cancelled, and finance calculates a new draft.
 */
export function transitionDistributionRun(
  run: DistributionRun,
  action: DistributionRunAction,
): DistributionRun {
  const invalid = () => new AccountingError("INVALID_TRANSITION");
  const isRequester = action.actorId === run.requestedBy;
  switch (action.type) {
    case "submit":
      assertDistributionEditable(run);
      if (!isRequester || run.status !== "draft") throw invalid();
      return { ...run, status: "pending_approval" };
    case "approve": {
      if (run.status !== "pending_approval") throw invalid();
      if (action.actorId === run.requestedBy)
        throw new AccessError("APPROVER_IS_REQUESTER");
      // A line absorbed to zero by carry has nothing to pay: it is settled
      // on approval. All lines zero: the run is paid at once (no journal).
      const lines = run.lines.map((line) =>
        line.grossIdr === 0
          ? {
              ...line,
              paymentStatus: "paid" as const,
              paymentRef: CARRY_ABSORBED_PAYMENT_REF,
              paidAt: action.now,
            }
          : line,
      );
      const allPaid = lines.every((line) => line.paymentStatus === "paid");
      return {
        ...run,
        lines,
        status: allPaid ? "paid" : "approved",
        approvedBy: action.actorId,
        approvedAt: action.now,
        paidAt: allPaid ? action.now : run.paidAt,
      };
    }
    case "reject":
      if (run.status !== "pending_approval") throw invalid();
      if (action.actorId === run.requestedBy)
        throw new AccessError("APPROVER_IS_REQUESTER");
      if (action.reason.trim() === "") throw invalid();
      return { ...run, status: "cancelled" };
    case "cancel":
      if (!isRequester) throw invalid();
      if (run.status !== "draft" && run.status !== "pending_approval")
        throw invalid();
      return { ...run, status: "cancelled" };
    case "cancel_approved":
      // SO 1216 F-P1a: an approved run with not one line paid may be
      // withdrawn (e.g. stale after a reopen); a cancelled run has no payments.
      if (run.status !== "approved") throw invalid();
      if (action.reason.trim().length < 10) throw invalid();
      if (run.lines.some((line) => isMoneyPaidLine(line))) throw invalid();
      return { ...run, status: "cancelled" };
    case "record_payment": {
      if (run.status !== "approved") throw invalid();
      if (action.paymentRef.trim() === "") throw invalid();
      const target = run.lines.find((line) => line.id === action.lineId);
      if (!target) throw invalid();
      if (target.paymentStatus === "paid")
        throw new AccountingError("DISTRIBUTION_LINE_ALREADY_PAID");
      const lines = run.lines.map((line) =>
        line.id === action.lineId
          ? {
              ...line,
              paymentStatus: "paid" as const,
              paymentRef: action.paymentRef.trim(),
              paidAt: action.paidAt,
            }
          : line,
      );
      const allPaid = lines.every((line) => line.paymentStatus === "paid");
      // The run completes at the latest payment of any line.
      const latestPaidAt = lines.reduce<IsoDateTime>(
        (latest, line) =>
          line.paidAt !== null && Date.parse(line.paidAt) > Date.parse(latest)
            ? line.paidAt
            : latest,
        action.paidAt,
      );
      return {
        ...run,
        lines,
        status: allPaid ? "paid" : run.status,
        paidAt: allPaid ? latestPaidAt : run.paidAt,
      };
    }
  }
}

/**
 * Statement generation is allowed on an approved or paid run and changes only
 * the document key of a paid line (SH-04: amounts stay frozen).
 */
export function attachDistributionStatement(
  run: DistributionRun,
  lineId: DistributionLine["id"],
  statementFileKey: string,
): DistributionRun {
  if (run.status !== "approved" && run.status !== "paid")
    throw new AccountingError("INVALID_TRANSITION");
  const fileKey = storageKeySchema.parse(statementFileKey);
  const target = run.lines.find((line) => line.id === lineId);
  if (!target) throw new AccountingError("INVALID_TRANSITION");
  if (target.paymentStatus !== "paid")
    throw new AccountingError("INVALID_TRANSITION");
  return {
    ...run,
    lines: run.lines.map((line) =>
      line.id === lineId ? { ...line, statementFileKey: fileKey } : line,
    ),
  };
}

// ---- Statements & the shareholder self view (F35, SH-01, SH-02, SH-04) -----

export const distributionStatementSchema = z.strictObject({
  distributionRunId: distributionRunIdSchema,
  distributionLineId: distributionLineIdSchema,
  shareholderId: shareholderIdSchema,
  shareholderName: z.string().trim().min(1).max(150),
  profitEntityId: profitEntityIdSchema,
  profitEntityName: z.string().trim().min(1).max(150),
  /** Official figures come from a closed period only (SH-02). */
  basis: z.literal("closed_period"),
  period: periodKeySchema,
  runType: distributionRunTypeSchema,
  /** SH-04: set on an adjustment statement. */
  adjustsRunId: distributionRunIdSchema.nullable(),
  shareBp: positiveShareBp,
  grossIdr: idrSchema,
  /** Earlier correction shortfall cut from this share before tax (Q83). */
  carryDeductedIdr: nonNegativeIdr.default(idr(0)),
  taxWithheldIdr: idrSchema,
  netIdr: idrSchema,
  paymentStatus: distributionLinePaymentStatusSchema,
  paymentRef: z.string().trim().min(1).max(100).nullable(),
  paidAt: isoDateTimeSchema.nullable(),
  statementFileKey: storageKeySchema.nullable(),
});
export type DistributionStatement = z.infer<typeof distributionStatementSchema>;

/**
 * One shareholder's statement for one paid line (§3.37 "Pernyataan Pribadi").
 * The caller passes only this shareholder's line, which is how SH-01 is kept:
 * no other shareholder's share, dividend or account is in the object.
 */
export function buildDistributionStatement(input: {
  run: DistributionRun;
  line: DistributionLine;
  shareholder: Pick<Shareholder, "id" | "name">;
  profitEntity: Pick<ProfitEntity, "id" | "name">;
}): DistributionStatement {
  const { run, line } = input;
  if (line.distributionRunId !== run.id)
    throw new AccountingError("INVALID_TRANSITION");
  if (line.shareholderId !== input.shareholder.id)
    throw new AccountingError("INVALID_TRANSITION");
  return distributionStatementSchema.parse({
    distributionRunId: run.id,
    distributionLineId: line.id,
    shareholderId: input.shareholder.id,
    shareholderName: input.shareholder.name,
    profitEntityId: input.profitEntity.id,
    profitEntityName: input.profitEntity.name,
    basis: "closed_period",
    period: run.period,
    runType: run.type,
    adjustsRunId: run.adjustsRunId,
    shareBp: line.shareBp,
    grossIdr: line.grossIdr,
    carryDeductedIdr: line.carryDeductedIdr,
    taxWithheldIdr: line.taxWithheldIdr,
    netIdr: line.netIdr,
    paymentStatus: line.paymentStatus,
    paymentRef: line.paymentRef,
    paidAt: line.paidAt,
    statementFileKey: line.statementFileKey,
  });
}

/** A shareholder's holding in force, from the version active on the date. */
export const profitShareHoldingSchema = z.strictObject({
  profitEntityId: profitEntityIdSchema,
  profitEntityName: z.string().trim().min(1).max(150),
  version: z.number().int().min(1).safe(),
  shareBp: positiveShareBp,
  effectiveFrom: businessDateSchema,
});
export type ProfitShareHolding = z.infer<typeof profitShareHoldingSchema>;

/** One past version of this shareholder's share (F35 "riwayat perubahan porsi"). */
export const profitShareHistoryEntrySchema = z.strictObject({
  profitEntityId: profitEntityIdSchema,
  version: z.number().int().min(1).safe(),
  shareBp: positiveShareBp,
  effectiveFrom: businessDateSchema,
  approvedAt: isoDateTimeSchema,
});
export type ProfitShareHistoryEntry = z.infer<
  typeof profitShareHistoryEntrySchema
>;

/**
 * Running numbers are estimates and say so (SH-02). They never mix with
 * statements: a client renders `label: "estimate"` as such.
 */
export const profitShareEstimateSchema = z.strictObject({
  profitEntityId: profitEntityIdSchema,
  profitEntityName: z.string().trim().min(1).max(150),
  period: periodKeySchema,
  shareBp: positiveShareBp,
  estimatedNetProfitIdr: idrSchema,
  estimatedShareIdr: idrSchema,
  asOf: isoDateTimeSchema,
  label: z.literal("estimate"),
});
export type ProfitShareEstimate = z.infer<typeof profitShareEstimateSchema>;

/** `applyBasisPoints` with the same rounding as a real distribution line. */
export function buildProfitShareEstimate(input: {
  profitEntity: Pick<ProfitEntity, "id" | "name">;
  period: ProfitShareEstimate["period"];
  shareBp: number;
  estimatedNetProfitIdr: Idr;
  asOf: IsoDateTime;
}): ProfitShareEstimate {
  return profitShareEstimateSchema.parse({
    profitEntityId: input.profitEntity.id,
    profitEntityName: input.profitEntity.name,
    period: input.period,
    shareBp: input.shareBp,
    estimatedNetProfitIdr: input.estimatedNetProfitIdr,
    estimatedShareIdr: applyBasisPoints(
      input.estimatedNetProfitIdr,
      input.shareBp,
      DISTRIBUTION_ROUNDING.tax,
    ),
    asOf: input.asOf,
    label: "estimate",
  });
}

/**
 * F35 "Bagi Hasil Pribadi": the caller's own holdings, share history,
 * distribution statements and labelled estimates. The BE passes only rows that
 * belong to this shareholder (SH-01); the schema has no field for anyone else.
 */
export const myProfitShareSchema = z.strictObject({
  shareholderId: shareholderIdSchema,
  shareholderName: z.string().trim().min(1).max(150),
  holdings: z.array(profitShareHoldingSchema),
  shareHistory: z.array(profitShareHistoryEntrySchema),
  distributionHistory: z.array(distributionStatementSchema),
  estimates: z.array(profitShareEstimateSchema),
});
export type MyProfitShare = z.infer<typeof myProfitShareSchema>;

/**
 * Assembles the self view. Holdings/history include a version only when this
 * shareholder is in it, and statements are the caller's lines only.
 */
export function buildMyProfitShare(input: {
  shareholder: Pick<Shareholder, "id" | "name">;
  entities: readonly ProfitEntity[];
  versions: readonly ShareAllocationVersion[];
  statements: readonly DistributionStatement[];
  estimates: readonly ProfitShareEstimate[];
  asOf: BusinessDate;
}): MyProfitShare {
  const mine = input.versions.filter((version) =>
    version.allocations.some(
      (row) => row.shareholderId === input.shareholder.id,
    ),
  );
  const holdings: ProfitShareHolding[] = [];
  for (const entity of input.entities) {
    if (!entity.isActive) continue;
    const version = effectiveShareAllocationVersion(
      input.versions,
      entity.id,
      input.asOf,
    );
    const allocation = version?.allocations.find(
      (row) => row.shareholderId === input.shareholder.id,
    );
    if (!version || !allocation) continue;
    holdings.push(
      profitShareHoldingSchema.parse({
        profitEntityId: entity.id,
        profitEntityName: entity.name,
        version: version.version,
        shareBp: allocation.shareBp,
        effectiveFrom: version.effectiveFrom,
      }),
    );
  }
  const shareHistory = mine
    .filter(
      (version) => version.status === "approved" && version.decidedAt !== null,
    )
    .flatMap((version) => {
      const allocation = version.allocations.find(
        (row) => row.shareholderId === input.shareholder.id,
      );
      if (!allocation) return [];
      return [
        profitShareHistoryEntrySchema.parse({
          profitEntityId: version.profitEntityId,
          version: version.version,
          shareBp: allocation.shareBp,
          effectiveFrom: version.effectiveFrom,
          approvedAt: version.decidedAt,
        }),
      ];
    })
    .sort((a, b) =>
      a.effectiveFrom === b.effectiveFrom
        ? a.version - b.version
        : a.effectiveFrom < b.effectiveFrom
          ? 1
          : -1,
    );
  return myProfitShareSchema.parse({
    shareholderId: input.shareholder.id,
    shareholderName: input.shareholder.name,
    holdings,
    shareHistory,
    distributionHistory: input.statements,
    estimates: input.estimates,
  });
}

// ---- Shareholder documents (PRD §6 I `shareholder_documents`, §3.35) ------

export const shareholderDocumentKindSchema = z.enum([
  "monthly_report",
  "general_meeting_minutes",
  "other",
]);
export type ShareholderDocumentKind = z.infer<
  typeof shareholderDocumentKindSchema
>;

export const shareholderDocumentVisibilitySchema = z.enum([
  "shareholders",
  "management",
]);
export type ShareholderDocumentVisibility = z.infer<
  typeof shareholderDocumentVisibilitySchema
>;

export const shareholderDocumentSchema = z
  .strictObject({
    id: shareholderDocumentIdSchema,
    tenantId: tenantIdSchema,
    profitEntityId: profitEntityIdSchema,
    kind: shareholderDocumentKindSchema,
    title: z.string().trim().min(1).max(200),
    fileKey: storageKeySchema,
    visibility: shareholderDocumentVisibilitySchema,
    publishedAt: isoDateTimeSchema.nullable(),
    publishedBy: userIdSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .superRefine((doc, ctx) => {
    if ((doc.publishedAt !== null) !== (doc.publishedBy !== null))
      ctx.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: "publishedAt/publishedBy are set together",
      });
  });
export type ShareholderDocument = z.infer<typeof shareholderDocumentSchema>;

export const createShareholderDocumentInputSchema = z.strictObject({
  profitEntityId: profitEntityIdSchema,
  kind: shareholderDocumentKindSchema,
  title: z.string().trim().min(1).max(200),
  fileKey: storageKeySchema,
  visibility: shareholderDocumentVisibilitySchema,
});

/**
 * An uploaded, not yet attached PDF. The server picks the key
 * (`shareholder-documents/<uuid>.pdf`); `createShareholderDocument` then
 * attaches it to one document.
 */
export const shareholderDocumentFileSchema = z.strictObject({
  fileKey: storageKeySchema,
  contentType: z.literal("application/pdf"),
  sizeBytes: z.number().int().positive(),
});
export type ShareholderDocumentFile = z.infer<
  typeof shareholderDocumentFileSchema
>;

/** Multipart text field next to the binary field `file`. */
export const uploadShareholderDocumentFileMetadataSchema = z.strictObject({
  profitEntityId: profitEntityIdSchema,
});

/** A shareholder-visible document only after management publishes it. */
export function assertDocumentVisibleToShareholders(
  doc: Pick<ShareholderDocument, "visibility" | "publishedAt">,
): void {
  if (doc.publishedAt === null) throw new AccessError("PERMISSION_DENIED");
  if (doc.visibility !== "shareholders")
    throw new AccessError("PERMISSION_DENIED");
}

// ---- Request inputs (HTTP contract, TEN-02: never a tenantId) -------------

/**
 * A row as the admin edits it. Ids and version are server-assigned; the client
 * never sends `approvedBy`, totals or any computed money.
 */
export const shareAllocationInputSchema = z.strictObject({
  shareholderId: shareholderIdSchema,
  shareBp: positiveShareBp,
});
export type ShareAllocationInput = z.infer<typeof shareAllocationInputSchema>;

export const createShareAllocationVersionInputSchema = z.strictObject({
  effectiveFrom: businessDateSchema,
  allocations: z.array(shareAllocationInputSchema).min(1).max(200),
  idempotencyKey: idempotencyKeySchema,
});
export const updateShareAllocationVersionInputSchema = z
  .strictObject({
    effectiveFrom: businessDateSchema,
    allocations: z.array(shareAllocationInputSchema).min(1).max(200),
  })
  .partial();

const approvalDecisionShape = {
  decision: z.enum(["approve", "reject"]),
  /** Required when rejecting; the screen's confirmation note otherwise. */
  note: z.string().trim().min(1).max(500).nullable(),
  idempotencyKey: idempotencyKeySchema,
};

function rejectNeedsNote(
  input: { decision: "approve" | "reject"; note: string | null },
  ctx: z.RefinementCtx,
): void {
  if (input.decision === "reject" && input.note === null)
    ctx.addIssue({
      code: "custom",
      path: ["note"],
      message: "A rejection needs a note",
    });
}

export const shareVersionDecisionInputSchema = z
  .strictObject(approvalDecisionShape)
  .superRefine(rejectNeedsNote);

export const createDistributionRunInputSchema = z.strictObject({
  /** The closed fiscal period whose net profit is distributed (SH-02). */
  fiscalPeriodId: fiscalPeriodIdSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const createAdjustmentDistributionInputSchema = z.strictObject({
  fiscalPeriodId: fiscalPeriodIdSchema,
  /** Signed correction; negative claws back an overpayment (SH-04). */
  adjustmentIdr: nonZeroIdr,
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: idempotencyKeySchema,
});

export const distributionDecisionInputSchema = z
  .strictObject(approvalDecisionShape)
  .superRefine(rejectNeedsNote);

/** SO 1216 F-P1a: withdraw an approved run with no line paid yet. */
export const cancelApprovedDistributionInputSchema = z.strictObject({
  reason: z.string().trim().min(10).max(500),
  idempotencyKey: idempotencyKeySchema,
});
export type CancelApprovedDistributionInput = z.infer<
  typeof cancelApprovedDistributionInputSchema
>;

export const recordDistributionPaymentInputSchema = z.strictObject({
  paymentRef: z.string().trim().min(1).max(100),
  paidAt: isoDateTimeSchema,
  idempotencyKey: idempotencyKeySchema,
});
