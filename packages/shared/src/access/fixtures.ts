// Cafe Legend RBAC mock data (FE mock mode + contract tests). Tenant, brand and
// outlets come from the core fixtures. Station names are PRD §3.8 "Routing
// Stasiun" (bar kopi, bar nonkopi, dapur panas, dapur dingin, pastry). People,
// the custom role, the time-bound examples and every approval threshold are
// illustrative sample data, not PRD facts or owner decisions.
// Ids are fixed (deterministic) so other domain fixtures can reference them.

import type { z } from "zod";
import { cafeLegendFixtures } from "../core/index.ts";
import type { OutletId } from "../core/index.ts";
import { approvalMatrixSchema } from "./approval.ts";
import type { ApprovalActionType, ApprovalPolicy } from "./approval.ts";
import { stationIdSchema } from "./ids.ts";
import type { RoleId, StationId } from "./ids.ts";
import type { PermissionCode } from "./permissions.ts";
import { ROLE_TEMPLATES, roleTemplate, type RoleTemplateKey } from "./roles.ts";
import { roleSchema } from "./schemas.ts";
import type { Role } from "./schemas.ts";
import { assignmentScopeSchema, roleAssignmentSchema } from "./scope.ts";
import type { OrgIndex, RoleAssignment, RoleGrant } from "./scope.ts";

function fixedId(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const menuStationId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const { tenant, brand, outlets } = cafeLegendFixtures;
const bandung = outlets[0].id;
const bandung2 = outlets[1].id;
const SEEDED_AT = "2026-10-15T02:00:00.000Z";

// Station ids are the menu fixture station ids (bead legend-7art; contract test
// apps/api/src/test/access-fixtures-contract.test.ts): ids 200-203 and 205 of the menu
// fixtures, so station-scoped grants line up with real menu stations.
const stationRows = [
  ["bar_kopi", "Bar Kopi", bandung, 200],
  ["bar_nonkopi", "Bar Nonkopi", bandung, 201],
  ["dapur_panas", "Dapur Panas", bandung, 202],
  ["pastry", "Pastry", bandung, 203],
  ["bar_kopi_2", "Bar Kopi", bandung2, 205],
] as const;
const stations = stationRows.map(([code, name, outletId, menuStationNo]) => ({
  id: stationIdSchema.parse(menuStationId(menuStationNo)),
  code,
  name,
  outletId: outletId as OutletId,
}));
const stationByCode = (code: (typeof stationRows)[number][0]): StationId =>
  stations.find((row) => row.code === code)!.id;

/** Seeded template roles, one per tenant-level template (Super Admin is platform-only). */
const templateRoles: Role[] = ROLE_TEMPLATES.filter(
  (template) => template.level === "tenant",
).map((template, index) =>
  roleSchema.parse({
    id: fixedId("401e0000", index + 1),
    tenantId: tenant.id,
    name: template.defaultName,
    isTemplate: true,
    templateKey: template.key,
    permissions: [...template.permissions],
    mfaRequired: template.mfaRequired,
    allowedScopeTypes: [...template.allowedScopeTypes],
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  }),
);

/** Custom role: a waiter who may also take payment ("kecuali bila diizinkan"). */
const waiterWithPayment = roleSchema.parse({
  id: fixedId("401e0000", 0x100),
  tenantId: tenant.id,
  name: "Waiter + Pembayaran",
  isTemplate: false,
  templateKey: null,
  permissions: [
    ...roleTemplate("waiter").permissions,
    "pos.payment.accept" satisfies PermissionCode,
  ],
  mfaRequired: false,
  allowedScopeTypes: ["outlet"],
  createdAt: "2026-10-20T03:00:00.000Z",
  updatedAt: "2026-10-20T03:00:00.000Z",
});

const roles: Role[] = [...templateRoles, waiterWithPayment];
const roleIdOf = (key: RoleTemplateKey): RoleId =>
  templateRoles.find((role) => role.templateKey === key)!.id;

const people = [
  ["owner", "Raka Pratama"],
  ["shareholder", "Dewi Lestari"],
  ["tenantAdmin", "Bima Santoso"],
  ["generalManager", "Sari Wulandari"],
  ["outletManager", "Andi Kurniawan"],
  ["supervisor", "Yusuf Hidayat"],
  ["cashier", "Nina Marlina"],
  ["waiter", "Fajar Nugraha"],
  ["barista", "Intan Permata"],
  ["cook", "Agus Setiawan"],
  ["facilityAttendant", "Rina Oktaviani"],
  ["kitchenLead", "Hendra Gunawan"],
  ["purchasing", "Maya Anggraini"],
  ["warehouse", "Dedi Supriadi"],
  ["finance", "Lina Hartati"],
  ["hr", "Tono Wibowo"],
  ["marketing", "Citra Ayu"],
  ["employee", "Rudi Hermawan"],
  ["supervisor2", "Eka Saputra"],
] as const;
type PersonKey = (typeof people)[number][0];
const users = Object.fromEntries(
  people.map(([key, displayName], index) => [
    key,
    { id: fixedId("05e40000", index + 1), displayName },
  ]),
) as Record<PersonKey, { id: string; displayName: string }>;

type AssignmentSeed = {
  user: PersonKey;
  role: RoleId;
  scope: z.input<typeof assignmentScopeSchema>;
  validFrom?: string;
  validUntil?: string | null;
  assignedBy?: PersonKey;
};
const tenantScope = { type: "tenant", id: null } as const;
const outletScope = (id: string) => ({ type: "outlet", id }) as const;
const seeds: AssignmentSeed[] = [
  { user: "owner", role: roleIdOf("owner"), scope: tenantScope },
  { user: "shareholder", role: roleIdOf("shareholder"), scope: tenantScope },
  { user: "tenantAdmin", role: roleIdOf("tenant_admin"), scope: tenantScope },
  {
    user: "generalManager",
    role: roleIdOf("general_manager"),
    scope: { type: "brand", id: brand.id },
  },
  {
    user: "outletManager",
    role: roleIdOf("outlet_manager"),
    scope: outletScope(bandung),
  },
  {
    user: "supervisor",
    role: roleIdOf("supervisor"),
    scope: outletScope(bandung),
  },
  {
    user: "supervisor2",
    role: roleIdOf("supervisor"),
    scope: outletScope(bandung),
  },
  { user: "cashier", role: roleIdOf("cashier"), scope: outletScope(bandung) },
  { user: "cashier", role: roleIdOf("employee"), scope: outletScope(bandung) },
  { user: "waiter", role: waiterWithPayment.id, scope: outletScope(bandung) },
  {
    user: "barista",
    role: roleIdOf("barista_cook"),
    scope: { type: "station", id: stationByCode("bar_kopi") },
  },
  {
    user: "cook",
    role: roleIdOf("barista_cook"),
    scope: { type: "station", id: stationByCode("dapur_panas") },
  },
  {
    user: "facilityAttendant",
    role: roleIdOf("facility_attendant"),
    scope: outletScope(bandung),
  },
  {
    user: "kitchenLead",
    role: roleIdOf("kitchen_lead"),
    scope: outletScope(bandung),
  },
  { user: "purchasing", role: roleIdOf("purchasing"), scope: tenantScope },
  {
    user: "warehouse",
    role: roleIdOf("warehouse"),
    scope: outletScope(bandung),
  },
  { user: "finance", role: roleIdOf("finance"), scope: tenantScope },
  { user: "hr", role: roleIdOf("hr"), scope: tenantScope },
  { user: "marketing", role: roleIdOf("marketing"), scope: tenantScope },
  { user: "employee", role: roleIdOf("employee"), scope: outletScope(bandung) },
  // Time-bound examples: an acting outlet manager for the second outlet
  // (ended) and a supervisor posting that has not started yet.
  {
    user: "supervisor",
    role: roleIdOf("outlet_manager"),
    scope: outletScope(bandung2),
    validFrom: "2026-10-01T00:00:00.000Z",
    validUntil: "2026-10-31T17:00:00.000Z",
  },
  {
    user: "supervisor2",
    role: roleIdOf("supervisor"),
    scope: outletScope(bandung2),
    validFrom: "2026-12-01T00:00:00.000Z",
    validUntil: null,
  },
];
const assignments: RoleAssignment[] = seeds.map((seed, index) =>
  roleAssignmentSchema.parse({
    id: fixedId("a5510000", index + 1),
    tenantId: tenant.id,
    userId: users[seed.user].id,
    roleId: seed.role,
    scope: seed.scope,
    validFrom: seed.validFrom ?? SEEDED_AT,
    validUntil: seed.validUntil ?? null,
    assignedBy: users[seed.assignedBy ?? "tenantAdmin"].id,
    assignedAt: SEEDED_AT,
  }),
);

type PolicySeed = [
  action: ApprovalActionType,
  thresholdIdr: number | null,
  approver: RoleTemplateKey,
  level: number,
];
// Illustrative thresholds for FE mock mode; the real matrix is tenant data.
const policySeeds: PolicySeed[] = [
  ["void", null, "supervisor", 1],
  ["discount", 50_000, "supervisor", 1],
  ["discount", 200_000, "outlet_manager", 1],
  ["refund", null, "supervisor", 1],
  ["refund", 500_000, "supervisor", 1],
  ["refund", 500_000, "outlet_manager", 2],
  ["cash_drawer_open", null, "supervisor", 1],
  ["price_correction", null, "supervisor", 1],
  ["expense", 1_000_000, "finance", 1],
  ["purchase_order", 5_000_000, "general_manager", 1],
  ["stock_adjustment", null, "outlet_manager", 1],
  ["price_change", null, "general_manager", 1],
  // §3 Payroll Run: "approval dua tingkat (HR lalu Finance atau Owner)".
  ["payroll", null, "hr", 1],
  ["payroll", null, "finance", 2],
  ["payroll", null, "owner", 2],
  // §3 Siklus Distribusi: "approval Owner atau Direksi".
  ["dividend_distribution", null, "owner", 1],
  ["ai_action", null, "outlet_manager", 1],
  ["mcp_action", null, "outlet_manager", 1],
  ["personal_data_export", null, "owner", 1],
];
const approvalPolicies: ApprovalPolicy[] = approvalMatrixSchema.parse(
  policySeeds.map(([actionType, thresholdIdr, approver, levels], index) => ({
    id: fixedId("a9910000", index + 1),
    actionType,
    thresholdIdr,
    approverRoleId: roleIdOf(approver),
    levels,
    requiresDistinctActor: true,
  })),
);

const org: OrgIndex = {
  brands: [{ id: brand.id }],
  outlets: outlets.map((outlet) => ({
    id: outlet.id,
    brandId: outlet.brandId,
  })),
  stations: stations.map(({ id, outletId }) => ({ id, outletId })),
};

// templateKey lets assertCanGrantRole recognise tenant top authority.
const roleGrants: (RoleGrant & { templateKey: string | null })[] = roles.map(
  ({ id, permissions, mfaRequired, templateKey }) => ({
    id,
    permissions,
    mfaRequired,
    templateKey,
  }),
);

export const cafeLegendAccessFixtures = {
  tenantId: tenant.id,
  brandId: brand.id,
  outletIds: { bandung, bandung2 },
  stations,
  org,
  roles,
  roleGrants,
  users,
  assignments,
  approvalPolicies,
  /** A clock inside the fixtures' validity windows (after the acting role ended). */
  now: new Date("2026-11-01T05:00:00.000Z"),
};
