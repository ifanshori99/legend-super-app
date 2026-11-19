// Which web chunk each catalog namespace ships in (legend-nmn9j). The web app
// splits the Indonesian catalog per route area so a screen downloads only the
// text it can show: `core` plus the chunk of the area it is in. A namespace
// that is not listed is core, so the split is always complete and a new
// namespace is safe by default.
//
// Placement rule: a namespace is listed only when every file that reads one of
// its keys is reachable from a single route area (`routes/_<area>`) and none
// from the document shell, `_auth`, or a route outside an area. Namespaces read
// from several areas, from the shell, or built dynamically across areas stay in
// core (kds, supportAccess, approvals, deviceRegistry, devicePin, qrRecovery, aiChat, theme, status, nav, facility, hrisRequests*, payslipPin, payroll*,
// staffAuth, login, qrGlass, qrOrders, edge, common, toast, app, shell,
// errorPage, ...). tests/i18n-area-split.test.mjs pins this contract.
//
// A key that is read outside its chunk's area still works: the web store loads
// the owning chunk on the first miss (apps/web/src/components/i18n.tsx).
// No runtime imports: tests load this file with Node type stripping.

import type { Messages } from "./index.ts";

/** Route areas that own a catalog chunk; equal to AREA_KEYS of the web app. */
export const AREA_CHUNKS = [
  "public",
  "customer",
  "ops",
  "kitchen",
  "kelola",
  "owner",
  "shareholder",
  "karyawan",
  "platform",
] as const;
export type AreaChunk = (typeof AREA_CHUNKS)[number];

export type CatalogChunk = "core" | AreaChunk;

/** Every chunk name, core first. */
export const CATALOG_CHUNKS: readonly CatalogChunk[] = ["core", ...AREA_CHUNKS];

/** Top-level catalog namespace to the area chunk that carries it. */
export const AREA_MANIFEST: Readonly<
  Partial<Record<keyof Messages & string, AreaChunk>>
> = {
  // public
  posReceiptPublic: "public",
  reservationBooking: "public",
  reservationGuest: "public",
  reservationGuestCancel: "public",
  reservationGuestRequest: "public",
  website: "public",
  // customer
  member: "customer",
  facilityBreakfast: "customer",
  payment: "customer",
  qrCart: "customer",
  qrMenu: "customer",
  wifi: "customer",
  // ops
  facilityStaff: "ops",
  opsChecklist: "ops",
  opsEquipment: "ops",
  posKasirTicket: "ops",
  posOrderCart: "ops",
  floor: "ops",
  opsFoodSafety: "ops",
  posCaptainOrder: "ops",
  posCaptainTables: "ops",
  posCorrection: "ops",
  posDisplay: "ops",
  posIssueCharge: "ops",
  posKasirCode: "ops",
  posKasirDayclose: "ops",
  posKasirEdc: "ops",
  posKasirGateway: "ops",
  posKasirPayment: "ops",
  posKasirPoints: "ops",
  posKasirShift: "ops",
  posKasirSupervisor: "ops",
  posKasirVoucher: "ops",
  posOrderCatalog: "ops",
  posOrderDetail: "ops",
  reservation: "ops",
  // kitchen
  channel: "kitchen",
  expo: "kitchen",
  kitchenTicket: "kitchen",
  pickup: "kitchen",
  // kelola
  paymentAdmin: "kelola",
  aiAdmin: "kelola",
  attendanceQr: "kelola",
  auditSettings: "kelola",
  crmCampaigns: "kelola",
  deliveryOps: "kelola",
  employeeMaster: "kelola",
  facilityAdmin: "kelola",
  leaveClockinReview: "kelola",
  lifecycle: "kelola",
  payrollConfig: "kelola",
  reportBuilder: "kelola",
  reportViewer: "kelola",
  roster: "kelola",
  supportAccessOwner: "kelola",
  access: "kelola",
  accounting: "kelola",
  aiAction: "kelola",
  aiAdminUsage: "kelola",
  aiSettingsChatgpt: "kelola",
  aiSettingsCustom: "kelola",
  edcRecon: "kelola",
  financeExceptions: "kelola",
  floorEditor: "kelola",
  crm360: "kelola",
  inventory: "kelola",
  inventoryHpp: "kelola",
  inventoryInvoiceEntry: "kelola",
  inventoryReceiving: "kelola",
  inventoryRecipe: "kelola",
  inventoryStock: "kelola",
  inventorySuppliers: "kelola",
  invfeNav: "kelola",
  invoiceMatchPreview: "kelola",
  kitchenConfig: "kelola",
  learning: "kelola",
  loyalty: "kelola",
  managementHome: "kelola",
  menu: "kelola",
  menuImport: "kelola",
  notification: "kelola",
  openBillPolicy: "kelola",
  opname: "kelola",
  orgDomain: "kelola",
  payrollPayoutSettings: "kelola",
  promo: "kelola",
  purchasing: "kelola",
  tax: "kelola",
  tenantSettings: "kelola",
  // owner
  ownerInsights: "owner",
  // shareholder
  shareholderHome: "shareholder",
  // karyawan
  hris: "karyawan",
  hrisRequestsEmployee: "karyawan",
  hrisRequestsMine: "karyawan",
  payslip: "karyawan",
  payslipPinForgot: "karyawan",
  payslipWaReset: "karyawan",
  // platform
  platformTenants: "platform",
  designV2: "platform",
  platformOps: "platform",
};

/** The chunk that carries a namespace; core when it is not listed. */
export function chunkOfNamespace(namespace: string): CatalogChunk {
  return Object.hasOwn(AREA_MANIFEST, namespace)
    ? (AREA_MANIFEST as Readonly<Record<string, AreaChunk>>)[namespace]!
    : "core";
}

/** The chunk that carries a dotted key such as "access.perm.read". */
export function chunkOfKey(key: string): CatalogChunk {
  const dot = key.indexOf(".");
  return chunkOfNamespace(dot < 0 ? key : key.slice(0, dot));
}
