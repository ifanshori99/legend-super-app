// The 18 role templates of PRD v1.7 §3.7 ("Template Role" table). Each
// template is seeded per tenant as a `roles` row with is_template = true
// (§6 B); tenants rename it or build custom roles from the catalog, but the
// template's permission set is fixed by this contract.
//
// The permission sets below are the tech-lead reading of the table's
// "Pekerjaan Utama" (what the role does) and "Batas Akses" (what it must never
// reach). Each "Batas Akses" limit is asserted mechanically in
// tests/access-contract.test.mjs via the permission tags.

import {
  PERMISSION_CODES,
  permissionHasTag,
  type PermissionCode,
  type PermissionTag,
} from "./permissions.ts";

/** Where a role assignment can point (§6 B role_assignments.scope_type). */
export const SCOPE_TYPES = ["tenant", "brand", "outlet", "station"] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export const ROLE_TEMPLATE_KEYS = [
  "super_admin",
  "owner",
  "shareholder",
  "tenant_admin",
  "general_manager",
  "outlet_manager",
  "supervisor",
  "cashier",
  "waiter",
  "barista_cook",
  "facility_attendant",
  "kitchen_lead",
  "purchasing",
  "warehouse",
  "finance",
  "hr",
  "marketing",
  "employee",
] as const;
export type RoleTemplateKey = (typeof ROLE_TEMPLATE_KEYS)[number];

export type RoleTemplate = {
  readonly key: RoleTemplateKey;
  /** Default role name (PRD table). Data, not UI text: tenants may rename it. */
  readonly defaultName: string;
  /** `platform` roles live in the platform panel and are never tenant role assignments. */
  readonly level: "platform" | "tenant";
  readonly allowedScopeTypes: readonly ScopeType[];
  readonly permissions: readonly PermissionCode[];
  /**
   * Extra permissions a tenant may switch on for this template ("kecuali bila
   * diizinkan"). Off by default: they are granted only through a custom role
   * or an explicit tenant setting, never implied by the template.
   */
  readonly optionalPermissions: readonly PermissionCode[];
  /** AUTH-05 / PRD §2 Keamanan and §3.6 Staf — Login Web. */
  readonly mfaRequired: boolean;
  /** "Batas Akses" column, verbatim. */
  readonly prdAccessLimit: string;
};

function catalogWhere(
  predicate: (code: PermissionCode) => boolean,
): PermissionCode[] {
  // Generated templates retain accepted wire aliases for existing clients.
  return PERMISSION_CODES.filter(predicate);
}

function withoutTags(...tags: PermissionTag[]) {
  return (code: PermissionCode) =>
    !tags.some((tag) => permissionHasTag(code, tag));
}

const SELF_SERVICE: PermissionCode[] = catalogWhere((code) =>
  code.startsWith("self."),
);

const templates: readonly RoleTemplate[] = [
  {
    key: "super_admin",
    defaultName: "Super Admin",
    level: "platform",
    allowedScopeTypes: [],
    permissions: catalogWhere((code) => permissionHasTag(code, "platform")),
    optionalPermissions: [],
    mfaRequired: true,
    prdAccessLimit: "Data tenant hanya melalui support access",
  },
  {
    key: "owner",
    defaultName: "Owner / Direksi",
    level: "tenant",
    allowedScopeTypes: ["tenant", "brand"],
    // Everything in the tenant except platform tools and personal self-service.
    permissions: catalogWhere(withoutTags("platform", "self")),
    optionalPermissions: [],
    mfaRequired: true,
    prdAccessLimit: "Seluruh tenant sesuai cakupan",
  },
  {
    key: "shareholder",
    defaultName: "Shareholder",
    level: "tenant",
    allowedScopeTypes: ["tenant"],
    permissions: [
      "dashboard.shareholder.view",
      "report.aggregate.view",
      "profit_share.own.view",
      "ai.ask",
    ],
    optionalPermissions: [],
    mfaRequired: true,
    prdAccessLimit:
      "Hanya agregat dan data miliknya; tanpa data pribadi pelanggan atau karyawan",
  },
  {
    key: "tenant_admin",
    defaultName: "Admin Tenant",
    level: "tenant",
    allowedScopeTypes: ["tenant"],
    permissions: [
      // Coordinator decision (C10, legend-g6d): the tenant admin manages access
      // from the /kelola area, so it must be able to enter it.
      "dashboard.management.view",
      "org.structure.manage",
      "org.settings.manage",
      "org.integration.manage",
      "org.theme.manage",
      "org.config.export",
      "org.config.import",
      "org.tax_config.manage",
      "org.notification_policy.manage",
      "device.registry.manage",
      "device.registry.revoke",
      "access.role.view",
      "access.role.manage",
      "access.role.assign",
      "access.approval_policy.manage",
      "audit.log.view",
      "menu.item.view",
      "floor.table.view",
      "floor.table.operate",
      "floor.table.manage",
      "service_request.zone.manage",
      "facility.config.manage",
      "wfc.policy.manage",
      "delivery.channel.manage",
      "website.content.manage",
      "crm.consent.record",
      // legend-7wzy: Owner gets it from the catalog; no other template does.
      "crm.customer.identity.unlink",
      "ai.governance.manage",
      "mcp.client.manage",
      "ai.ask",
    ],
    optionalPermissions: [],
    mfaRequired: true,
    prdAccessLimit: "Tidak otomatis memiliki kewenangan keuangan",
  },
  {
    key: "general_manager",
    defaultName: "General Manager",
    level: "tenant",
    allowedScopeTypes: ["tenant", "brand"],
    permissions: [
      "approval.inbox.view",
      "approval.request.decide",
      "menu.item.view",
      "menu.item.manage",
      "menu.price.view",
      "menu.price.manage",
      "menu.availability.toggle",
      "floor.table.view",
      "floor.table.operate",
      "floor.session.open_bill",
      "floor.open_bill_policy.manage",
      "floor.table.manage",
      "service_request.zone.manage",
      "order.view",
      "order.recovery.handle",
      "order.apology_voucher.issue",
      "pos.void.approve",
      "pos.discount.approve",
      "pos.refund.approve",
      "pos.cash_drawer.approve",
      "pos.price_correction.approve",
      "pos.edc_standalone.approve",
      "shift.cash.approve_close",
      "shift.cash.view_all",
      "pos.day.close",
      "kds.station.manage",
      "kds.remake_comp.record",
      "inventory.stock.view",
      "inventory.production.record",
      "inventory.adjustment.approve",
      "inventory.cost.view",
      "recipe.manage",
      "recipe.cost.view",
      "purchasing.request.create",
      "purchasing.petty.record",
      "purchasing.order.approve",
      "accounting.expense.request",
      "reservation.view",
      "reservation.manage",
      "delivery.order.handle",
      "review.respond",
      "facility.booth.operate",
      "facility.emergency.respond",
      "facility.emergency.resolve",
      "hr.employee.view",
      "hr.attendance.manage",
      "hr.attendance_correction.approve",
      "hr.schedule.manage",
      "hr.shift_swap.approve",
      "hr.leave.approve",
      "hr.overtime.approve",
      "hr.kpi.manage",
      "hr.sop.manage",
      "hr.announcement.manage",
      "hr.training.manage",
      "dashboard.management.view",
      "report.operational.view",
      "report.sales.view",
      "export.data.run",
      "ai.ask",
      // legend-111j
      "crm.loyalty.manage",
      "crm.loyalty.review",
      "crm.loyalty.fulfil",
      "crm.customer.pii.read",
      "crm.feedback.manage",
      "ai.action.propose",
      "ops.checklist.complete",
      "ops.food_safety.log",
      "ops.prep.manage",
      "ops.equipment.maintain",
      "ops.handover.record",
    ],
    optionalPermissions: [],
    mfaRequired: true,
    prdAccessLimit: "Tidak mengubah data payroll",
  },
  {
    key: "outlet_manager",
    defaultName: "Outlet Manager",
    level: "tenant",
    allowedScopeTypes: ["outlet"],
    permissions: [
      "approval.inbox.view",
      "approval.request.decide",
      "menu.item.view",
      "menu.price.view",
      "menu.availability.toggle",
      "floor.table.view",
      "floor.table.operate",
      "floor.session.open_bill",
      "floor.open_bill_policy.manage",
      // Runs the outlet floor plan (coordinator decision, legend-2l6k).
      "floor.table.manage",
      "service_request.zone.manage",
      "order.view",
      "order.recovery.handle",
      "order.apology_voucher.issue",
      "pos.void.approve",
      "pos.discount.approve",
      "pos.refund.approve",
      "pos.cash_drawer.approve",
      "pos.price_correction.approve",
      "pos.edc_standalone.approve",
      "shift.cash.approve_close",
      "shift.cash.view_all",
      "pos.day.close",
      "kds.station.manage",
      "kds.remake_comp.record",
      "inventory.stock.view",
      "inventory.production.record",
      "inventory.adjustment.approve",
      "purchasing.request.create",
      "purchasing.petty.record",
      "accounting.expense.request",
      "reservation.view",
      "reservation.manage",
      "crm.consent.record",
      // legend-111j
      "crm.loyalty.manage",
      "crm.loyalty.review",
      "crm.loyalty.fulfil",
      "crm.customer.pii.read",
      "crm.feedback.manage",
      "delivery.order.handle",
      "review.respond",
      "facility.booth.operate",
      "facility.emergency.respond",
      "facility.emergency.resolve",
      "hr.employee.view",
      "hr.attendance.manage",
      "hr.attendance_correction.approve",
      "hr.schedule.manage",
      "hr.shift_swap.approve",
      "hr.leave.approve",
      "hr.overtime.approve",
      "dashboard.management.view",
      "report.operational.view",
      "report.sales.view",
      "ai.ask",
      "ai.action.propose",
      "ops.checklist.complete",
      "ops.checklist.manage",
      "ops.food_safety.log",
      "ops.prep.manage",
      "ops.equipment.maintain",
      "ops.handover.record",
    ],
    optionalPermissions: [],
    mfaRequired: true,
    prdAccessLimit: "Hanya outlet yang ditugaskan",
  },
  {
    key: "supervisor",
    defaultName: "Supervisor / Captain",
    level: "tenant",
    allowedScopeTypes: ["outlet"],
    permissions: [
      // Supervisors need the management shell to reach the HR request queue.
      "dashboard.management.view",
      "approval.inbox.view",
      "approval.request.decide",
      "menu.item.view",
      "menu.availability.toggle",
      "floor.table.view",
      "floor.table.operate",
      "floor.session.open_bill",
      "order.view",
      "order.create",
      "order.recovery.handle",
      "order.apology_voucher.issue",
      "pos.void.approve",
      "pos.discount.approve",
      "pos.refund.approve",
      "pos.cash_drawer.approve",
      "pos.price_correction.approve",
      "pos.edc_standalone.approve",
      "shift.cash.approve_close",
      "kds.expo.operate",
      "kds.remake_comp.record",
      "hr.shift_swap.approve",
      "facility.booth.operate",
      "facility.emergency.respond",
      "facility.access.assist",
      "wifi.voucher.issue",
      "report.operational.view",
      "ops.checklist.complete",
      "ops.handover.record",
      "ai.ask",
      "ai.action.propose",
    ],
    optionalPermissions: [],
    mfaRequired: false,
    prdAccessLimit: "Override dengan PIN; tanpa akses laporan keuangan",
  },
  {
    key: "cashier",
    defaultName: "Kasir",
    level: "tenant",
    allowedScopeTypes: ["outlet"],
    permissions: [
      "menu.item.view",
      "floor.table.view",
      "floor.table.operate",
      "order.view",
      "order.create",
      "pos.sale.create",
      "pos.payment.accept",
      "pos.discount.apply",
      "pos.void.request",
      "pos.refund.request",
      "shift.cash.operate",
      "wifi.voucher.issue",
      // Records a customer consent at the counter (LOY-04); source cashier only.
      "crm.consent.record",
      // legend-111j
      "crm.loyalty.fulfil",
      "ai.ask",
    ],
    optionalPermissions: [],
    mfaRequired: false,
    prdAccessLimit: "Hanya transaksi shift-nya",
  },
  {
    key: "waiter",
    defaultName: "Waiter / Runner",
    level: "tenant",
    allowedScopeTypes: ["outlet"],
    permissions: [
      "menu.item.view",
      "floor.table.view",
      "floor.table.operate",
      "order.view",
      "order.create",
      "kds.expo.operate",
      "ai.ask",
    ],
    optionalPermissions: ["pos.payment.accept"],
    mfaRequired: false,
    prdAccessLimit: "Tanpa akses pembayaran kecuali bila diizinkan",
  },
  {
    key: "barista_cook",
    defaultName: "Barista / Cook",
    level: "tenant",
    allowedScopeTypes: ["station"],
    permissions: ["kds.ticket.process", "kds.remake_comp.record", "ai.ask"],
    optionalPermissions: [],
    mfaRequired: false,
    prdAccessLimit: "Hanya KDS stasiun yang ditugaskan",
  },
  {
    key: "facility_attendant",
    defaultName: "Attendant Fasilitas",
    level: "tenant",
    allowedScopeTypes: ["outlet"],
    permissions: [
      "facility.booth.operate",
      "facility.emergency.respond",
      "facility.access.assist",
      "ops.checklist.complete",
      "ai.ask",
    ],
    optionalPermissions: ["pos.payment.accept"],
    mfaRequired: false,
    prdAccessLimit:
      "Hanya modul Akses Fasilitas pada outlet yang ditugaskan; tanpa akses pembayaran kecuali bila diizinkan",
  },
  {
    key: "kitchen_lead",
    defaultName: "Kitchen Lead",
    level: "tenant",
    allowedScopeTypes: ["outlet"],
    permissions: [
      "menu.item.view",
      "menu.availability.toggle",
      "kds.ticket.process",
      "kds.expo.operate",
      "kds.station.manage",
      "kds.remake_comp.record",
      "recipe.manage",
      "inventory.stock.view",
      "inventory.production.record",
      "inventory.waste.record",
      "purchasing.request.create",
      "purchasing.petty.record",
      "hr.sop.manage",
      // legend-poxk: announcements split off hr.sop.manage; the kitchen lead
      // keeps reading the feed through the self-service read code.
      "self.sop.read",
      "ai.ask",
      "ai.action.propose",
      "ops.checklist.complete",
      "ops.checklist.manage",
      "ops.food_safety.log",
      "ops.prep.manage",
      "ops.equipment.maintain",
      "ops.handover.record",
    ],
    optionalPermissions: [],
    mfaRequired: false,
    prdAccessLimit: "Tanpa akses pembayaran",
  },
  {
    key: "purchasing",
    defaultName: "Purchasing",
    level: "tenant",
    allowedScopeTypes: ["tenant", "brand", "outlet"],
    permissions: [
      "purchasing.supplier.manage",
      "purchasing.request.create",
      "purchasing.order.create",
      "purchasing.invoice.match",
      "purchasing.return.create",
      "purchasing.petty.record",
      "inventory.stock.view",
      "inventory.cost.view",
      "recipe.cost.view",
      "approval.inbox.view",
      "ai.ask",
      "ai.action.propose",
    ],
    optionalPermissions: [],
    // Back-office role reaching finance or customer data (MFA_SENSITIVE_TAGS).
    mfaRequired: true,
    prdAccessLimit: "Tanpa akses payroll",
  },
  {
    key: "warehouse",
    defaultName: "Gudang",
    level: "tenant",
    allowedScopeTypes: ["outlet"],
    permissions: [
      "inventory.stock.view",
      "inventory.stock.receive",
      "inventory.item.manage",
      "purchasing.return.create",
      "inventory.stock.transfer",
      "inventory.opname.count",
      "inventory.waste.record",
      "ai.ask",
      "ai.action.propose",
    ],
    optionalPermissions: [],
    mfaRequired: false,
    prdAccessLimit: "Tanpa akses harga jual dan laporan keuangan",
  },
  {
    key: "finance",
    defaultName: "Finance / Akuntan",
    level: "tenant",
    allowedScopeTypes: ["tenant", "brand"],
    permissions: [
      ...catalogWhere((code) => code.startsWith("accounting.")),
      "payment.transaction.view",
      "payment.reconcile",
      "shift.cash.view_all",
      "purchasing.invoice.match",
      "purchasing.petty_policy.manage",
      "inventory.stock.view",
      "inventory.cost.view",
      "recipe.cost.view",
      "profit_share.registry.manage",
      "profit_share.share_allocation.change",
      "payroll.view",
      "payroll.approve",
      "payroll.lock",
      "payroll.payout.configure",
      "payroll.payout.gl_resolve",
      "payroll.disburse.approve",
      "approval.inbox.view",
      "approval.request.decide",
      "dashboard.management.view",
      "report.financial.view",
      "report.sales.view",
      "report.operational.view",
      "export.data.run",
      "ai.ask",
      "ai.action.propose",
    ],
    optionalPermissions: [],
    mfaRequired: true,
    prdAccessLimit: "Tanpa akses data pribadi pelanggan",
  },
  {
    key: "hr",
    defaultName: "HR",
    level: "tenant",
    allowedScopeTypes: ["tenant", "brand"],
    permissions: [
      ...catalogWhere((code) => code.startsWith("hr.")),
      "payroll.view",
      "payroll.run",
      "payroll.approve",
      "payroll.disburse.request",
      "payroll.disburse.approve",
      "approval.inbox.view",
      "approval.request.decide",
      "dashboard.management.view",
      "ai.ask",
      "ai.action.propose",
    ],
    optionalPermissions: [],
    mfaRequired: true,
    prdAccessLimit: "Tanpa akses keuangan operasional",
  },
  {
    key: "marketing",
    defaultName: "Marketing / CRM",
    level: "tenant",
    allowedScopeTypes: ["tenant", "brand"],
    permissions: [
      // Existing dev/mock screens use this alias; grants normalize it to CRM.
      "loyalty.program.manage",
      "crm.customer.view",
      "crm.consent.record",
      "crm.segment.manage",
      // legend-111j
      "crm.loyalty.review",
      "promo.manage",
      "campaign.manage",
      "review.respond",
      "reservation.view",
      "website.content.manage",
      // Bulk personal-data export only as an approval request (DASH-04).
      "export.personal_data.request",
      "ai.ask",
      "ai.action.propose",
    ],
    optionalPermissions: [],
    // Back-office role reaching finance or customer data (MFA_SENSITIVE_TAGS).
    mfaRequired: true,
    prdAccessLimit:
      "Kontak pelanggan sesuai persetujuan; tanpa ekspor massal tanpa approval",
  },
  {
    key: "employee",
    defaultName: "Karyawan",
    level: "tenant",
    allowedScopeTypes: ["tenant", "outlet"],
    permissions: [...SELF_SERVICE, "ai.ask"],
    optionalPermissions: [],
    mfaRequired: false,
    prdAccessLimit: "Hanya data miliknya",
  },
];

export const ROLE_TEMPLATES: readonly RoleTemplate[] = Object.freeze(
  templates.map((template) =>
    Object.freeze({
      ...template,
      allowedScopeTypes: Object.freeze([...template.allowedScopeTypes]),
      permissions: Object.freeze([...new Set(template.permissions)]),
      optionalPermissions: Object.freeze([...template.optionalPermissions]),
    }),
  ),
);

const byKey = new Map<string, RoleTemplate>(
  ROLE_TEMPLATES.map((template) => [template.key, template]),
);

export function roleTemplate(key: RoleTemplateKey): RoleTemplate {
  const template = byKey.get(key);
  if (!template) throw new RangeError(`Unknown role template: ${key}`);
  return template;
}

export function isRoleTemplateKey(value: unknown): value is RoleTemplateKey {
  return typeof value === "string" && byKey.has(value);
}

/**
 * Tags that make a custom role require MFA as well (AUTH-05): a custom role
 * that reaches finance, payroll, personal data or access administration is
 * a back-office role in everything but name.
 */
export const MFA_SENSITIVE_TAGS: readonly PermissionTag[] = Object.freeze([
  "platform",
  "access_admin",
  "finance",
  "payroll",
  "customer_pii",
  "employee_pii",
]);

export function permissionsRequireMfa(
  permissions: readonly PermissionCode[],
): boolean {
  return permissions.some((code) =>
    MFA_SENSITIVE_TAGS.some((tag) => permissionHasTag(code, tag)),
  );
}
