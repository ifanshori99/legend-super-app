// Approval matrix hooks (PRD v1.7 §3.7 "Matriks Approval": who approves what
// and at which threshold; "Penyetuju selalu berbeda dari pemohon") and the POS
// override record (§3.6 "Override Supervisor", AUTH-06).
//
// approval_policies row (§6 B): action_type, threshold_idr, approver_role_id,
// levels, requires_distinct_actor. Reading used by this contract:
// - A row applies when the amount is >= threshold_idr (null = any amount, and
//   an unknown amount always applies: fail closed).
// - Rows of one action form tiers by threshold; the highest applicable tier
//   wins, so a big refund can need more approvers than a small one.
// - Inside a tier, `levels` is the 1-based step a row fills. Several rows at
//   the same level are alternatives ("HR lalu Finance atau Owner" = level 1
//   HR, level 2 Finance or Owner). Levels must be contiguous from 1.
// - requires_distinct_actor is true for every action. One exception (founder
//   decision 2026-11-10, legend-b8y6l): the sole Owner of a tenant may approve
//   (never reject) a shareholder_version request they submitted themselves;
//   see SELF_APPROVABLE_ACTION_TYPES and `selfApproval` below.
// - No policy for an action = approval required but nobody can approve
//   (APPROVAL_POLICY_MISSING). Deny by default; seed policies per tenant.
// The approval request/inbox DTOs belong to WS-01 identity & access contracts
// (bead legend-7sz); this file is the matrix and the decision rules.

import { z } from "zod";
import {
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  ulidIdSchema,
  userIdSchema,
} from "../core/index.ts";
import type { Idr, UserId } from "../core/index.ts";
import { AccessError } from "./errors.ts";
import { approvalPolicyIdSchema, roleIdSchema } from "./ids.ts";
import type { RoleId } from "./ids.ts";
import {
  isAssignmentActive,
  isMfaGuardedSurface,
  scopeCovers,
  type AppSurface,
  type AccessPrincipal,
  type AccessTarget,
  type OrgIndex,
  type RoleGrant,
} from "./scope.ts";

/** Action types an approval policy can govern, with the PRD clause that asks for approval. */
export const APPROVAL_ACTIONS = {
  // §3.7 Matriks Approval list
  void: "§3.7 Matriks Approval; POS-02",
  discount: "§3.7 Matriks Approval; POS-02 (di atas ambang)",
  refund: "§3.7 Matriks Approval; POS-02; ORD-09",
  expense: "§3.7 Matriks Approval",
  purchase_order: "§3.7 Matriks Approval; §3.15 Alur Pengadaan",
  stock_adjustment: "§3.7 Matriks Approval; §3.14 Stok Opname",
  price_change: "§3.7 Matriks Approval",
  payroll: "§3.7 Matriks Approval; §3 Payroll Run (approval dua tingkat)",
  dividend_distribution: "§3.7 Matriks Approval; §3 Siklus Distribusi",
  ai_action:
    "§3.7 Matriks Approval; §2 AI dan MCP (aksi selalu melalui approval)",
  mcp_action: "§3.7 Matriks Approval; §4 Q Agen MCP Mengajukan Aksi",
  // §3.6 Override Supervisor (POS overrides not in the list above)
  cash_drawer_open: "§3.6 Override Supervisor (buka laci tanpa transaksi)",
  price_correction: "§3.6 Override Supervisor (koreksi harga)",
  // Other PRD clauses that route through the matrix / approval inbox
  cash_shift_close: "§3.10 Shift Kasir (approval supervisor)",
  edc_standalone: "§3.13 EDC mode standalone; EDC-04 (PIN supervisor)",
  apology_voucher: "§3.9 Voucher Permintaan Maaf (batas nilai sesuai matriks)",
  unallocated_funds: "PAY-04",
  reconciliation_case: "PAY recon; §3.7 Matriks Approval",
  purchase_request: "§3.15 Alur Pengadaan (Purchase Request → approval)",
  supplier_payment: "§3.15 Alur Pengadaan (Supplier Payment dengan approval)",
  cash_out: "§3.19 Kas & Bank (kas keluar di atas batas; founder Q7)",
  manual_journal: "§3.16 Jurnal Manual & Berulang",
  period_reopen: "§3.16 Tutup Periode; ACC-02",
  payroll_cancel: "PAYR-05",
  shareholder_version: "§3 Daftar Pemegang Saham Berversi; SH-03",
  personal_data_export: "§3 Ekspor; DASH-04",
  attendance_correction: "§3 Koreksi Absensi",
  shift_swap: "§3 Tukar & Ganti Shift; HR-05",
  leave: "§3 Pengajuan & Approval (cuti, izin, lembur)",
  overtime: "§3 Pengajuan & Approval (cuti, izin, lembur)",
  employee_loan: "§3 Kasbon",
  reimbursement: "§3 Reimbursement",
} as const;
export type ApprovalActionType = keyof typeof APPROVAL_ACTIONS;
export const APPROVAL_ACTION_TYPES = Object.keys(
  APPROVAL_ACTIONS,
) as ApprovalActionType[];
export const approvalActionTypeSchema = z.enum(
  APPROVAL_ACTION_TYPES as [ApprovalActionType, ...ApprovalActionType[]],
);

/** approval_requests.source (§6 B). */
export const approvalSourceSchema = z.enum(["user", "ai", "mcp"]);
export type ApprovalSource = z.infer<typeof approvalSourceSchema>;

export const APPROVAL_MAX_LEVELS = 3;

/** One approval_policies row (§6 B). */
export const approvalPolicySchema = z.strictObject({
  id: approvalPolicyIdSchema,
  actionType: approvalActionTypeSchema,
  /** Applies at amounts >= this; null = always. */
  thresholdIdr: idrSchema
    .refine((value) => value >= 0, "thresholdIdr must be >= 0")
    .nullable(),
  approverRoleId: roleIdSchema,
  /** 1-based approval step this row fills. */
  levels: z.number().int().min(1).max(APPROVAL_MAX_LEVELS),
  requiresDistinctActor: z.literal(true),
});
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

/** A tenant's whole matrix; every tier's levels must be contiguous from 1. */
export const approvalMatrixSchema = z
  .array(approvalPolicySchema)
  .superRefine((rows, ctx) => {
    const tiers = new Map<string, Set<number>>();
    for (const row of rows) {
      const key = `${row.actionType}|${row.thresholdIdr ?? "any"}`;
      const levels = tiers.get(key) ?? new Set<number>();
      levels.add(row.levels);
      tiers.set(key, levels);
    }
    for (const [key, levels] of tiers) {
      const max = Math.max(...levels);
      for (let level = 1; level <= max; level++)
        if (!levels.has(level))
          ctx.addIssue({
            code: "custom",
            message: `Approval tier ${key} skips level ${level}`,
          });
    }
    // Supplier payments always need one other person (founder Q27): a
    // threshold may only ADD levels, so a matrix that has supplier_payment rows
    // needs a base tier (threshold null or 0) with a level 1 row.
    const supplierRows = rows.filter(
      (row) => row.actionType === "supplier_payment",
    );
    if (
      supplierRows.length > 0 &&
      !supplierRows.some(
        (row) =>
          row.levels === 1 &&
          (row.thresholdIdr === null || row.thresholdIdr === 0),
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "supplier_payment needs a base tier (threshold null or 0) with a level 1 approver: one person alone may never pay a supplier",
      });
  });

/**
 * Default refund approval matrix (legend-zi9o, widened for Q63), the single
 * source for new tenants (seedTenantRoleTemplates), the dev tenant and
 * migrations 0140 and 0286. PRD §3.6 "Override Supervisor" and D14: a refund
 * needs the supervisor's PIN or approval, so every refund opens a one-step
 * chain from Rp0. Founder Q63 sets the amount ceiling per role in code
 * (supervisor Rp200.000, outlet manager Rp1.000.000, general manager
 * Rp5.000.000, owner no ceiling), and an approver must hold the exact role the
 * matrix names (APPROVER_ROLE_MISMATCH), so level 1 names every role that can
 * approve a refund, as the cash shift close default does. The floor is 0
 * rather than null: both match an amount of 0 (a null floor is the lowest
 * tier), but 0 states "from Rp0" explicitly. Applied only to a tenant with no
 * refund row and the template roles (migration 0286 also widens a tenant that
 * still has only the old supervisor row); a tenant that configured refunds is
 * never touched. The rows require a distinct actor.
 */
export const DEFAULT_REFUND_APPROVAL_POLICIES: readonly {
  readonly thresholdIdr: number;
  readonly level: number;
  readonly roleTemplateKey:
    "supervisor" | "outlet_manager" | "general_manager" | "owner";
}[] = [
  { thresholdIdr: 0, level: 1, roleTemplateKey: "supervisor" },
  { thresholdIdr: 0, level: 1, roleTemplateKey: "outlet_manager" },
  { thresholdIdr: 0, level: 1, roleTemplateKey: "general_manager" },
  { thresholdIdr: 0, level: 1, roleTemplateKey: "owner" },
];

/**
 * Default cash shift close approval matrix (legend-ccpn), the single source for
 * new tenants (seedTenantRoleTemplates), the dev tenant and the data migration
 * for existing tenants. Founder decision Q28 (2026-11-09) and PRD §3.10: every
 * shift close needs one approval, a PIN at the cashier is enough, and the
 * variance does not change that. So the matrix is one tier, one level, from Rp0
 * (floor 0 rather than null, as for refunds). The level-1 approvers are the
 * templates that hold `shift.cash.approve_close` (supervisor, outlet manager,
 * general manager), because an approver must hold the exact role the matrix
 * names (APPROVER_ROLE_MISMATCH). So the default keeps who could approve a
 * close before and only fixes that every close needs one approval; an outlet
 * with only a manager on duty is not locked out. Applied only to a tenant with
 * no cash_shift_close row and the template roles; a tenant that configured its
 * own matrix is never touched. The rows require a distinct actor.
 */
export const DEFAULT_CASH_SHIFT_CLOSE_APPROVAL_POLICIES: readonly {
  readonly thresholdIdr: number;
  readonly level: number;
  readonly roleTemplateKey: "supervisor" | "outlet_manager" | "general_manager";
}[] = [
  { thresholdIdr: 0, level: 1, roleTemplateKey: "supervisor" },
  { thresholdIdr: 0, level: 1, roleTemplateKey: "outlet_manager" },
  { thresholdIdr: 0, level: 1, roleTemplateKey: "general_manager" },
];

/**
 * Default cash out approval matrix (legend-4qowr, founder Q7 13 Nov 2026), the
 * single source for new tenants (seedTenantRoleTemplates), the dev tenant and
 * the data migration for existing tenants. Whether a cash out waits for
 * approval is decided by the tenant limit and the anti-split sum
 * (`finance_policies`, accounting-cash-limit.service.ts), not by this matrix:
 * the matrix only names who decides once the entry is pending, so one tier,
 * one level, floor 0, for the Finance template (it holds
 * `accounting.cash_bank.approve`). The creator never decides their own entry
 * (distinct actor). Applied only to a tenant with no cash_out row and a
 * Finance template role; a tenant that configured its own matrix is never
 * touched.
 */
export const DEFAULT_CASH_OUT_APPROVAL_POLICIES: readonly {
  readonly thresholdIdr: number;
  readonly level: number;
  readonly roleTemplateKey: "finance";
}[] = [{ thresholdIdr: 0, level: 1, roleTemplateKey: "finance" }];

/**
 * Default supplier payment approval matrix (legend-xxqz3, CTO money decision
 * 17 Nov 2026), the single source for new tenants (seedTenantRoleTemplates),
 * the dev tenant and migration 0587. The most restrictive default: EVERY
 * supplier payment (floor 0, tiered on the cumulative amount of the invoice)
 * needs one approval at level 1 from the Finance or Owner template role, and
 * the row requires a distinct actor, so the requester never approves their own
 * payment (the consumer also refuses a chain the requester took part in).
 * Without any `supplier_payment` row the approval service still fails closed
 * (APPROVAL_POLICY_MISSING). Applied only to a tenant with no supplier_payment
 * row; a tenant that configured its own matrix is never touched, and a
 * template role that does not exist adds no row.
 */
export const DEFAULT_SUPPLIER_PAYMENT_APPROVAL_POLICIES: readonly {
  readonly thresholdIdr: number;
  readonly level: number;
  readonly roleTemplateKey: "finance" | "owner";
}[] = [
  { thresholdIdr: 0, level: 1, roleTemplateKey: "finance" },
  { thresholdIdr: 0, level: 1, roleTemplateKey: "owner" },
];

/**
 * Default shareholder version approval matrix (legend-tm6pp), the single source
 * for new tenants (seedTenantRoleTemplates), the dev tenant and migration 0241.
 * Founder decision Q2 (2026-11-10): once a tenant uses profit share, a share
 * allocation version and a statement-recipient change (both matrix action
 * `shareholder_version`) need one approval from the Owner. Without a policy
 * the approval service fails closed (APPROVAL_POLICY_MISSING), so the default
 * makes the flow usable; the Owner can change the matrix afterwards. One tier,
 * one level, from Rp0 (floor 0 rather than null, as for refunds). Applied only
 * to a tenant with no shareholder_version row and an Owner template role; a
 * tenant that configured its own matrix is never touched. The row requires a
 * distinct actor, so the Owner who submits a version cannot approve it, except
 * a sole Owner (the tenant's only Owner), who may approve their own request.
 */
export const DEFAULT_SHAREHOLDER_VERSION_APPROVAL_POLICIES: readonly {
  readonly thresholdIdr: number;
  readonly level: number;
  readonly roleTemplateKey: "owner";
}[] = [{ thresholdIdr: 0, level: 1, roleTemplateKey: "owner" }];

/**
 * Default reconciliation case approval matrix. Closing a settlement
 * difference (payment_reconciliation_cases) writes off or accepts missing
 * money, so it always needs one approval from the Owner or Finance (founder
 * W8 Q10/Q12). One tier, one level, from Rp0, two rows at the same level: either
 * role is enough. Distinct actor required (whoever submits the case, Owner or
 * Finance, cannot approve it; no sole-owner exception, the action is not
 * self-approvable). Without a policy the approval service fails closed
 * (APPROVAL_POLICY_MISSING) and the case stays open.
 */
export const DEFAULT_RECONCILIATION_CASE_APPROVAL_POLICIES: readonly {
  readonly thresholdIdr: number;
  readonly level: number;
  readonly roleTemplateKey: "owner" | "finance";
}[] = [
  { thresholdIdr: 0, level: 1, roleTemplateKey: "owner" },
  { thresholdIdr: 0, level: 1, roleTemplateKey: "finance" },
];

export type ApprovalStep = {
  readonly level: number;
  /** Any of these roles may decide this level. */
  readonly approverRoleIds: readonly RoleId[];
};

export type ApprovalRequirement =
  | { readonly required: false }
  | {
      readonly required: true;
      readonly thresholdIdr: Idr | null;
      readonly steps: readonly ApprovalStep[];
    };

/**
 * What approval an action needs. `amountIdr` null = no amount known (applies
 * every tier: fail closed). Throws APPROVAL_POLICY_MISSING when the tenant
 * has no policy for the action at all.
 */
export function approvalRequirementFor(
  policies: readonly ApprovalPolicy[],
  actionType: ApprovalActionType,
  amountIdr: Idr | number | null,
): ApprovalRequirement {
  if (amountIdr !== null && (!Number.isSafeInteger(amountIdr) || amountIdr < 0))
    throw new RangeError(
      "amountIdr must be a non-negative safe integer or null",
    );
  const rows = policies.filter((row) => row.actionType === actionType);
  if (rows.length === 0) throw new AccessError("APPROVAL_POLICY_MISSING");
  const applicable = rows.filter(
    (row) =>
      row.thresholdIdr === null ||
      amountIdr === null ||
      amountIdr >= row.thresholdIdr,
  );
  if (applicable.length === 0) return { required: false };
  const tier = applicable.reduce<Idr | null>(
    (best, row) =>
      row.thresholdIdr !== null && (best === null || row.thresholdIdr > best)
        ? row.thresholdIdr
        : best,
    null,
  );
  const tierRows = applicable.filter((row) => row.thresholdIdr === tier);
  const levels = [...new Set(tierRows.map((row) => row.levels))].sort(
    (a, b) => a - b,
  );
  return {
    required: true,
    thresholdIdr: tier,
    steps: levels.map((level) => ({
      level,
      approverRoleIds: tierRows
        .filter((row) => row.levels === level)
        .map((row) => row.approverRoleId),
    })),
  };
}

/**
 * Why a requester may approve their own request. Only "sole_owner": the
 * tenant has exactly one Owner and that Owner is the requester. The service
 * computes this in SQL inside the deciding transaction, never from input.
 */
export type SelfApprovalBasis = "sole_owner";

/**
 * Action types whose requester may self-approve when a SelfApprovalBasis
 * holds. Founder decision 2026-11-10 (legend-b8y6l). Reject by the requester
 * is never allowed.
 */
export const SELF_APPROVABLE_ACTION_TYPES: ReadonlySet<string> = new Set([
  "shareholder_version",
]);

export type PriorDecision = {
  readonly level: number;
  readonly approverId: UserId | string;
};

/**
 * Throws AccessError unless `approver` may decide the next level of a request
 * (AUTH-06 and §3.7 distinct actor):
 * - approver ≠ requester (APPROVER_IS_REQUESTER), unless `selfApproval` is
 *   set (sole Owner, legend-b8y6l); that skips only this check;
 * - approver has not decided an earlier level (APPROVER_ALREADY_DECIDED);
 * - `level` is the next open step (APPROVAL_LEVEL_OUT_OF_ORDER);
 * - approver holds an active assignment of one of that step's roles whose
 *   scope covers the request's target (APPROVER_ROLE_MISMATCH);
 * - on back office / dashboard, an approver holding an MFA role decided with
 *   MFA (MFA_REQUIRED, AUTH-05).
 * For `ai` / `mcp` sources, `requestedBy` is the human the agent acts for.
 */
export function assertApprovalDecisionAllowed(input: {
  readonly requirement: ApprovalRequirement;
  readonly requestedBy: UserId | string;
  readonly priorDecisions: readonly PriorDecision[];
  readonly level: number;
  readonly approver: AccessPrincipal;
  readonly approverRoles: readonly RoleGrant[];
  readonly approverMfaVerified: boolean;
  /** Where the decision is made: POS PIN override ("pos") or the approval inbox ("dashboard"). */
  readonly surface: AppSurface;
  readonly target: AccessTarget;
  readonly org: OrgIndex;
  readonly now: Date;
  /** Set only when the service verified the sole-Owner basis; skips the requester check. */
  readonly selfApproval?: SelfApprovalBasis | null;
  /**
   * The request is self-approvable (legend-b8y6l): an earlier level decided by
   * the requester (a sole Owner's self-approval, checked under lock when it
   * was made) does not block the next level. Skips only that requester check.
   */
  readonly priorSelfApprovalAllowed?: boolean;
}): void {
  const approverId = input.approver.userId.toLowerCase();
  if (
    input.selfApproval == null &&
    approverId === input.requestedBy.toLowerCase()
  )
    throw new AccessError("APPROVER_IS_REQUESTER");
  if (
    input.priorDecisions.some(
      (decision) => decision.approverId.toLowerCase() === approverId,
    )
  )
    throw new AccessError("APPROVER_ALREADY_DECIDED");
  if (!input.requirement.required)
    throw new AccessError("APPROVAL_LEVEL_OUT_OF_ORDER");
  const steps = input.requirement.steps;
  const priorActors = new Set<string>();
  for (const [index, decision] of input.priorDecisions.entries()) {
    const actor = decision.approverId.toLowerCase();
    if (
      steps[index]?.level !== decision.level ||
      (actor === input.requestedBy.toLowerCase() &&
        input.priorSelfApprovalAllowed !== true) ||
      priorActors.has(actor)
    )
      throw new AccessError("APPROVAL_LEVEL_OUT_OF_ORDER");
    priorActors.add(actor);
  }
  const nextLevel = steps[input.priorDecisions.length]?.level;
  if (nextLevel === undefined || input.level !== nextLevel)
    throw new AccessError("APPROVAL_LEVEL_OUT_OF_ORDER");
  const step = steps[input.priorDecisions.length] as ApprovalStep;
  const wanted = new Set(step.approverRoleIds.map((id) => id.toLowerCase()));
  const roles = new Map(
    input.approverRoles.map((role) => [role.id.toLowerCase(), role]),
  );
  const active = input.approver.assignments.filter(
    (row) =>
      row.tenantId.toLowerCase() === input.approver.tenantId.toLowerCase() &&
      row.userId.toLowerCase() === approverId &&
      isAssignmentActive(row, input.now),
  );
  const qualifying = active.filter(
    (row) =>
      wanted.has(row.roleId.toLowerCase()) &&
      roles.has(row.roleId.toLowerCase()) &&
      scopeCovers(row.scope, input.target, input.org),
  );
  if (qualifying.length === 0) throw new AccessError("APPROVER_ROLE_MISMATCH");
  if (
    isMfaGuardedSurface(input.surface) &&
    !input.approverMfaVerified &&
    active.some(
      (row) => roles.get(row.roleId.toLowerCase())?.mfaRequired !== false,
    )
  )
    throw new AccessError("MFA_REQUIRED");
}

/** POS overrides (§3.6 Override Supervisor). */
export const POS_OVERRIDE_ACTIONS = [
  "void",
  "discount",
  "refund",
  "cash_drawer_open",
  "price_correction",
  // §4 E step 5 / POS-03: the supervisor approves the blind-count close.
  "cash_shift_close",
  // EDC-04: a standalone EDC payment (agent down) needs a supervisor PIN.
  "edc_standalone",
] as const satisfies readonly ApprovalActionType[];
export type PosOverrideAction = (typeof POS_OVERRIDE_ACTIONS)[number];

/**
 * AUTH-06: an override always records requester, approver, reason and value,
 * and the approver is never the requester. `method`: supervisor PIN on the
 * device, or approval from the supervisor's phone (§3.6).
 */
export const posOverrideSchema = z
  .strictObject({
    id: ulidIdSchema<"PosOverrideId">(),
    outletId: outletIdSchema,
    action: z.enum(POS_OVERRIDE_ACTIONS),
    requestedBy: userIdSchema,
    approvedBy: userIdSchema,
    method: z.enum(["supervisor_pin", "supervisor_phone"]),
    reasonCode: z.string().min(1).max(50).nullable(),
    reason: z.string().trim().min(3).max(500),
    /** Value affected: voided/refunded amount, discount, corrected difference; 0 for a no-sale drawer open. */
    valueIdr: idrSchema.refine((value) => value >= 0, "valueIdr must be >= 0"),
    approvalRequestId: z.uuid().toLowerCase().nullable(),
    occurredAt: isoDateTimeSchema,
  })
  .refine((row) => row.approvedBy !== row.requestedBy, {
    message: "Approver must differ from requester (AUTH-06)",
    path: ["approvedBy"],
  });
export type PosOverride = z.infer<typeof posOverrideSchema>;
