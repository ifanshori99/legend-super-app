// Text catalog keys of the management home. Tile titles, report names and
// metric names are contract data; everything the page adds is a key in
// `packages/shared/src/i18n/messages/id.ts` (PRD §7 "Katalog teks").
import type { MessageKey } from "@starter/shared/i18n";
import type {
  DashboardQueue,
  DashboardTile,
  ManagementRole,
  ReportPeriodPreset,
} from "@starter/shared/dashboard";

export const ROLE_LABEL_KEYS = {
  gm: "managementHome.role.gm",
  outlet_manager: "managementHome.role.outlet_manager",
  kitchen_lead: "managementHome.role.kitchen_lead",
  purchasing: "managementHome.role.purchasing",
  finance: "managementHome.role.finance",
  hr: "managementHome.role.hr",
  marketing: "managementHome.role.marketing",
} as const satisfies Record<ManagementRole, MessageKey>;

export const ROLE_HINT_KEYS = {
  gm: "managementHome.roleHint.gm",
  outlet_manager: "managementHome.roleHint.outlet_manager",
  kitchen_lead: "managementHome.roleHint.kitchen_lead",
  purchasing: "managementHome.roleHint.purchasing",
  finance: "managementHome.roleHint.finance",
  hr: "managementHome.roleHint.hr",
  marketing: "managementHome.roleHint.marketing",
} as const satisfies Record<ManagementRole, MessageKey>;

export const PERIOD_LABEL_KEYS = {
  today: "managementHome.period.today",
  yesterday: "managementHome.period.yesterday",
  this_week: "managementHome.period.this_week",
  last_week: "managementHome.period.last_week",
  this_month: "managementHome.period.this_month",
  last_month: "managementHome.period.last_month",
  this_quarter: "managementHome.period.this_quarter",
  last_quarter: "managementHome.period.last_quarter",
  this_year: "managementHome.period.this_year",
  year_to_date: "managementHome.period.year_to_date",
  custom: "managementHome.period.custom",
} as const satisfies Record<ReportPeriodPreset, MessageKey>;

export const QUEUE_LABEL_KEYS = {
  approvals: "managementHome.queue.approvals",
  kitchen_queue: "managementHome.queue.kitchen_queue",
  waiter_calls: "managementHome.queue.waiter_calls",
  reviews: "managementHome.queue.reviews",
  alerts: "managementHome.queue.alerts",
  critical_stock: "managementHome.queue.critical_stock",
  devices: "managementHome.queue.devices",
  documents: "managementHome.queue.documents",
  daily_summary: "managementHome.queue.daily_summary",
  facility_units: "managementHome.queue.facility_units",
} as const satisfies Record<DashboardQueue, MessageKey>;

export const QUEUE_HINT_KEYS = {
  approvals: "managementHome.queueHint.approvals",
  kitchen_queue: "managementHome.queueHint.kitchen_queue",
  waiter_calls: "managementHome.queueHint.waiter_calls",
  reviews: "managementHome.queueHint.reviews",
  alerts: "managementHome.queueHint.alerts",
  critical_stock: "managementHome.queueHint.critical_stock",
  devices: "managementHome.queueHint.devices",
  documents: "managementHome.queueHint.documents",
  daily_summary: "managementHome.queueHint.daily_summary",
  facility_units: "managementHome.queueHint.facility_units",
} as const satisfies Record<DashboardQueue, MessageKey>;

/**
 * The kind chip of a card. An approvals-section queue reads "Approval", not
 * "Antrean": it is the inbox, not one role's work list (PRD §3.36).
 */
export function tileKindKey(tile: DashboardTile): MessageKey {
  if (tile.kind === "link") return "managementHome.kind.link";
  if (tile.section === "approvals") return "managementHome.kind.approval";
  if (tile.kind === "queue") return "managementHome.kind.queue";
  return "managementHome.kind.kpi";
}
