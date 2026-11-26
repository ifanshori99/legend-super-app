// Legend permission catalog (PRD v1.7 §3.7 RBAC: "Custom Role — Admin tenant
// dapat membuat role baru dari katalog izin"; §6 B `permissions.code`, e.g.
// `pos.void.approve`, `payroll.lock`).
//
// Machinery idea reused from 119connect (packages/shared/src/kolaborasi/role.ts):
// one catalog that templates and custom roles are built from, never hand-copied,
// and sensitivity tags on each permission so rules such as "Admin Tenant has no
// finance authority" are checked mechanically. The policy itself is Legend's.
//
// A code is `<module>.<resource>.<action>` (two to four lower_snake segments).
// Adding a code is a contract change (WS-00); renaming one breaks stored roles.

import { z } from "zod";

/**
 * What kind of data or authority a permission touches. Template rules from the
 * PRD §3.7 "Batas Akses" column are expressed against these tags.
 */
export const PERMISSION_TAGS = [
  /** Platform panel only (Super Admin). Never inside a tenant role. */
  "platform",
  /** Manages roles, assignments, approval matrix, audit (who can do what). */
  "access_admin",
  /** Accounting, financial reports, reconciliation, supplier payment, budgets. */
  "finance",
  /** Payroll data or payroll run. */
  "payroll",
  /** Receives or settles customer payments at the counter. */
  "payment",
  /** Sees or changes selling prices. */
  "sell_price",
  /** Customer personal data (contacts, profiles). */
  "customer_pii",
  /** Employee personal data (NIK, NPWP, bank account, salary). */
  "employee_pii",
  /** Exports many rows at once. */
  "bulk_export",
  /** Decides an approval request or a POS override. */
  "approve",
  /** Only the holder's own records (HRIS self-service). */
  "self",
] as const;
export type PermissionTag = (typeof PERMISSION_TAGS)[number];

type Entry = readonly [code: string, tags: readonly PermissionTag[]];

// Grouped by PRD module; the comment names the PRD section the module comes from.
const entries = [
  // Platform panel (§3.1 F1, Super Admin)
  ["platform.tenant.manage", ["platform"]],
  ["platform.package.manage", ["platform"]],
  ["platform.integration.manage", ["platform"]],
  ["platform.health.view", ["platform"]],
  // Cross-tenant audit list, GET /api/platform/audit-events (legend-bag1).
  ["platform.audit.view", ["platform"]],
  ["platform.support_access.request", ["platform"]],
  ["platform.config_template.manage", ["platform"]],
  // Inspect and skip outbox sequence gaps (legend-jcil); audited, reason required.
  ["platform.event_gap.manage", ["platform"]],

  // Organisation & configuration (§3.1, §3.7, F46)
  ["org.structure.manage", []],
  ["org.settings.manage", []],
  ["org.integration.manage", []],
  ["org.theme.manage", []],
  ["org.config.export", []],
  ["org.config.import", []],
  // owner only (Q37, legend-c9kbk)
  ["org.support_access.approve", ["approve"]],
  ["org.tax_config.manage", []],
  // Covers PUT /api/notifications/policy and the notification template
  // endpoints in notification/endpoints.ts (legend-kz1m). Not wired to a route yet.
  ["org.notification_policy.manage", []],
  ["device.registry.manage", []],
  ["device.registry.revoke", []],

  // Roles, approval matrix, audit (§3.7, §6 B)
  ["access.role.view", ["access_admin"]],
  ["access.role.manage", ["access_admin"]],
  ["access.role.assign", ["access_admin"]],
  ["access.approval_policy.manage", ["access_admin"]],
  ["audit.log.view", ["access_admin"]],
  ["approval.inbox.view", []],
  ["approval.request.decide", ["approve"]],

  // Menu, floor & QR order (§3.8–3.9, F5–F7, F41)
  ["menu.item.view", []],
  ["menu.item.manage", []],
  ["menu.price.view", ["sell_price"]],
  ["menu.price.manage", ["sell_price"]],
  ["menu.availability.toggle", []],
  ["floor.table.view", []],
  ["floor.table.manage", []],
  // Floor operations on a live session (PRD §3.9 Operasi Meja, Keamanan Sesi
  // "dikonfirmasi waiter atau kasir", ORD-10): confirm/close a session, move,
  // merge, move items, table status. Layout editing stays floor.table.manage.
  ["floor.table.operate", []],
  // Founder Q33/Q34: approve turning a running pay-first session into an open
  // bill (supervisor PIN step-up). Not for tenant_admin (no money authority).
  ["floor.session.open_bill", ["approve"]],
  // Change the outlet open-bill policy: bill limit, idle alert, bill-request SLO.
  ["floor.open_bill_policy.manage", []],
  // Who receives a zone's waiter calls: assign and remove zone waiters (ORD-07).
  ["service_request.zone.manage", []],
  ["order.view", []],
  ["order.create", []],
  ["order.recovery.handle", []],
  ["order.apology_voucher.issue", []],

  // POS & cashier shift (§3.10, F8, AUTH-06 overrides)
  ["pos.sale.create", ["sell_price"]],
  ["pos.payment.accept", ["payment"]],
  ["pos.discount.apply", []],
  ["pos.void.request", []],
  ["pos.refund.request", []],
  ["pos.void.approve", ["approve"]],
  ["pos.discount.approve", ["approve"]],
  ["pos.refund.approve", ["approve", "payment"]],
  ["pos.cash_drawer.approve", ["approve"]],
  ["pos.price_correction.approve", ["approve", "sell_price"]],
  ["pos.edc_standalone.approve", ["approve", "payment"]],
  ["shift.cash.operate", ["payment"]],
  ["shift.cash.approve_close", ["approve", "payment"]],
  ["shift.cash.view_all", ["payment"]],
  // Founder Q9 (2026-11-08): the business day is closed by the outlet
  // manager, not by a shift supervisor (POS-05, legend-6c0).
  ["pos.day.close", ["approve", "payment"]],
  // Writes off one lost receipt number so Tutup Hari can proceed (legend-0hzqw,
  // owner only: it removes a gap from the audit trail of numbered receipts).
  ["pos.receipt.writeoff", ["approve"]],
  // 1271 F1: open, cancel and end an edge -> cloud failover window of an
  // outlet (the cloud then sells on the F-series while the edge is down).
  ["pos.failover.manage", ["approve"]],
  ["wifi.voucher.issue", []],

  // Kitchen (§3.11, F9, F40)
  ["kds.ticket.process", []],
  ["kds.expo.operate", []],
  ["kds.station.manage", []],
  ["kds.remake_comp.record", []],

  // Payments (§3.12, F10–F11)
  ["payment.transaction.view", ["payment", "finance"]],
  ["payment.reconcile", ["payment", "finance"]],
  ["payment.edc.manage", ["payment"]],
  // DOIT recurring billing: plans, subscriptions and their invoices (legend-6c6).
  ["payment.recurring.manage", ["payment"]],

  // Inventory, recipes, purchasing (§3.14–3.15, F13–F15)
  ["inventory.stock.view", []],
  ["inventory.stock.receive", []],
  ["inventory.item.manage", []],
  ["inventory.stock.transfer", []],
  ["inventory.opname.count", []],
  ["inventory.waste.record", []],
  ["inventory.production.record", []],
  ["inventory.adjustment.approve", ["approve"]],
  ["inventory.cost.view", ["finance"]],
  ["recipe.manage", []],
  ["recipe.cost.view", ["finance"]],
  ["purchasing.supplier.manage", []],
  ["purchasing.request.create", []],
  ["purchasing.order.create", []],
  ["purchasing.order.approve", ["approve"]],
  ["purchasing.invoice.match", ["finance"]],
  ["purchasing.return.create", []],
  ["purchasing.petty.record", []],
  ["purchasing.petty_policy.manage", ["finance"]],

  // Accounting & finance (§3.16, F16)
  ["accounting.journal.view", ["finance"]],
  ["accounting.journal.post", ["finance"]],
  ["accounting.reconcile", ["finance"]],
  ["accounting.period.close", ["finance"]],
  // Card 1263 (founder no. 19): close over incomplete production batches.
  ["accounting.period.close_override", ["finance", "approve"]],
  ["accounting.period_reopen.approve", ["finance", "approve"]],
  ["accounting.supplier_payment.process", ["finance"]],
  ["accounting.tax_report.manage", ["finance"]],
  ["accounting.asset.manage", ["finance"]],
  ["accounting.budget.manage", ["finance"]],
  ["accounting.expense.request", []],
  ["accounting.expense.approve", ["finance", "approve"]],
  ["accounting.cash_deposit.record", ["finance"]],
  // legend-4961: cash in/out and bank transfers (legal-entity level), and the
  // per-outlet petty cash fund (top-up, return, retry of a parked journal).
  ["accounting.cash_bank.record", ["finance"]],
  // Founder Q7 (13 Nov 2026): approve/reject a cash out above the tenant limit
  // (never its creator) and set that limit.
  ["accounting.cash_bank.approve", ["finance", "approve"]],
  ["accounting.cash_bank.limit.manage", ["finance"]],
  ["accounting.petty_cash.manage", ["finance"]],

  // Profit share & dividends (§3 Kelompok E, F34)
  ["profit_share.own.view", ["self"]],
  ["profit_share.registry.manage", ["finance"]],
  ["profit_share.share_allocation.change", ["finance"]],
  ["profit_share.distribution.approve", ["finance", "approve"]],

  // Loyalty, CRM, promo, reservations, delivery, website (§3 Kelompok C, F17–F21)
  ["crm.customer.view", ["customer_pii"]],
  ["crm.consent.record", []],
  ["crm.segment.manage", ["customer_pii"]],
  // legend-111j: member loyalty program, ledger review, redemption fulfilment,
  // raw customer contacts and the feedback queue.
  ["crm.loyalty.manage", []],
  ["crm.loyalty.review", []],
  ["crm.loyalty.fulfil", []],
  ["crm.customer.pii.read", ["customer_pii"]],
  // legend-7wzy: staff clears a customer's WhatsApp link on this tenant's
  // profile. A destructive action, so it is not implied by the read permission.
  ["crm.customer.identity.unlink", ["customer_pii"]],
  ["crm.feedback.manage", []],
  ["promo.manage", []],
  ["campaign.manage", ["customer_pii"]],
  ["review.respond", []],
  ["reservation.view", []],
  ["reservation.manage", []],
  ["delivery.channel.manage", []],
  ["delivery.order.handle", []],
  ["website.content.manage", []],

  // Facility access, Wi-Fi & WFC (§3 Kelompok C, F22–F23, F38–F39)
  ["facility.booth.operate", []],
  ["facility.access.assist", []],
  // Emergency button (legend-bod): `respond` receives and acknowledges an
  // alert; `resolve` closes the incident in the cloud with a note.
  ["facility.emergency.respond", []],
  ["facility.emergency.resolve", []],
  ["facility.config.manage", []],
  ["wfc.policy.manage", []],

  // HR (§3 Kelompok D, F24–F29)
  ["hr.employee.view", ["employee_pii"]],
  ["hr.employee.manage", ["employee_pii"]],
  ["hr.attendance.manage", []],
  ["hr.attendance_correction.approve", ["approve"]],
  ["hr.schedule.manage", []],
  ["hr.shift_swap.approve", ["approve"]],
  ["hr.leave.approve", ["approve"]],
  ["hr.overtime.approve", ["approve"]],
  ["hr.reimbursement.approve", ["approve"]],
  ["hr.loan.approve", ["approve", "payroll"]],
  ["hr.sop.manage", []],
  ["hr.announcement.manage", []],
  ["hr.training.manage", []],
  ["hr.kpi.manage", []],

  // Payroll (§3 Kelompok D, F28)
  ["payroll.view", ["payroll", "employee_pii"]],
  ["payroll.run", ["payroll", "employee_pii"]],
  ["payroll.approve", ["payroll", "approve"]],
  ["payroll.lock", ["payroll"]],
  ["payroll.cancel.approve", ["payroll", "approve"]],
  // Payroll payout (disbursement): per-PT method and limits, request a batch,
  // approve a batch (a second person, MFA step-up).
  ["payroll.payout.configure", ["payroll"]],
  ["payroll.disburse.request", ["payroll", "employee_pii"]],
  ["payroll.disburse.approve", ["payroll", "approve"]],
  // Resolve a payout GL posting held for finance (legend-3xzop, legend-6qp12):
  // mark its bank fee as already in the opening balance, or release a payable
  // account hold. Owner and Finance only; MFA step-up plus password on each call.
  ["payroll.payout.gl_resolve", ["payroll", "finance"]],

  // HRIS self-service (F30)
  ["self.profile.view", ["self"]],
  ["self.attendance.clock", ["self"]],
  ["self.schedule.view", ["self"]],
  ["self.leave.request", ["self"]],
  ["self.payslip.view", ["self"]],
  ["self.reimbursement.request", ["self"]],
  ["self.loan.request", ["self"]],
  ["self.shift_swap.request", ["self"]],
  ["self.sop.read", ["self"]],

  // Dashboards, reports, export (§3 Kelompok E, F31–F33)
  ["dashboard.owner.view", ["finance"]],
  ["dashboard.shareholder.view", []],
  ["dashboard.management.view", []],
  ["report.operational.view", []],
  ["report.sales.view", ["sell_price"]],
  ["report.financial.view", ["finance"]],
  ["report.aggregate.view", []],
  ["export.data.run", ["bulk_export"]],
  ["export.personal_data.request", ["bulk_export", "customer_pii"]],

  // Tanya AI & MCP (§3 Kelompok E, F35–F37)
  ["ai.ask", []],
  ["ai.action.propose", []],
  ["ai.governance.manage", ["access_admin"]],
  ["mcp.client.manage", ["access_admin"]],

  // Daily operations (§3 Kelompok F, F45)
  ["ops.outbox.replay", []],
  ["ops.checklist.complete", []],
  ["ops.checklist.manage", []],
  ["ops.food_safety.log", []],
  ["ops.prep.manage", []],
  ["ops.equipment.maintain", []],
  ["ops.handover.record", []],
] as const satisfies readonly Entry[];

type CanonicalPermissionCode = (typeof entries)[number][0];
/** The old loyalty spelling remains a wire alias, never a separate grant. */
export type PermissionCode = CanonicalPermissionCode | "loyalty.program.manage";

export function canonicalPermissionCode(
  code: PermissionCode,
): CanonicalPermissionCode {
  return code === "loyalty.program.manage" ? "crm.loyalty.manage" : code;
}

export type PermissionDefinition = {
  readonly code: PermissionCode;
  /** First segment of the code, e.g. `pos`. */
  readonly module: string;
  readonly tags: readonly PermissionTag[];
};

const CODE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;

export const PERMISSION_CATALOG: readonly PermissionDefinition[] =
  Object.freeze(
    entries.map(([code, tags]) =>
      Object.freeze({
        code,
        module: code.split(".")[0] as string,
        tags: Object.freeze([...tags]),
      }),
    ),
  );

/** Known wire codes, including the legacy alias used by existing clients. */
export const PERMISSION_CODES: readonly PermissionCode[] = Object.freeze([
  ...PERMISSION_CATALOG.map((entry) => entry.code),
  "loyalty.program.manage",
]);

const byCode = new Map<string, PermissionDefinition>(
  PERMISSION_CATALOG.map((entry) => [entry.code, entry]),
);

export function isPermissionCode(value: unknown): value is PermissionCode {
  return (
    typeof value === "string" &&
    byCode.has(
      value === "loyalty.program.manage" ? "crm.loyalty.manage" : value,
    )
  );
}

export function permissionDefinition(
  code: PermissionCode,
): PermissionDefinition {
  const definition = byCode.get(canonicalPermissionCode(code));
  if (!definition) throw new RangeError(`Unknown permission code: ${code}`);
  return definition;
}

export function permissionHasTag(
  code: PermissionCode,
  tag: PermissionTag,
): boolean {
  return permissionDefinition(code).tags.includes(tag);
}

/** Syntax of a code (any module); use `permissionCodeSchema` for catalog membership. */
export const permissionCodeFormatSchema = z
  .string()
  .regex(CODE_PATTERN, "Permission codes look like module.resource.action");

/** A code that exists in the catalog. */
export const permissionCodeSchema = z
  .string()
  .refine(isPermissionCode, "Unknown permission code")
  .transform((code) => code as PermissionCode);

/** Codes a tenant role may hold: catalog codes without the `platform` tag. */
export const tenantPermissionCodeSchema = permissionCodeSchema.refine(
  (code) => !permissionHasTag(code, "platform"),
  "Platform permissions cannot be part of a tenant role",
);

/** Catalog sanity, run by the contract tests. Throws on the first problem. */
export function assertCatalogWellFormed(): void {
  const seen = new Set<string>();
  for (const { code } of PERMISSION_CATALOG) {
    if (!CODE_PATTERN.test(code))
      throw new Error(`Malformed permission code: ${code}`);
    if (seen.has(code)) throw new Error(`Duplicate permission code: ${code}`);
    seen.add(code);
  }
}
