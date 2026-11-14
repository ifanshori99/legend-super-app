import {
  BellRing,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  ChefHat,
  ClipboardCheck,
  CookingPot,
  CreditCard,
  FileText,
  MailCheck,
  PackageX,
  Printer,
  RefreshCwOff,
  ReceiptText,
  Scale,
  ShieldAlert,
  Siren,
  Sun,
  Timer,
  TriangleAlert,
  UserRoundMinus,
  type LucideIcon,
} from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import { DEFAULT_TIME_ZONE } from "@starter/shared/core";
import {
  categoryMeta,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from "@starter/shared/notification";

// Presentational metadata for the notification catalog: one icon per category
// (DESIGN.md: status as icon + text) and the staff-facing subset.

export const NOTIFICATION_CATEGORY_ICONS: Record<
  NotificationCategory,
  LucideIcon
> = {
  waiter_call: BellRing,
  order_ready: CookingPot,
  stock_critical: PackageX,
  approval_request: ClipboardCheck,
  printer_offline: Printer,
  edge_sync_conflict: RefreshCwOff,
  cash_variance: Scale,
  emergency: Siren,
  security: ShieldAlert,
  order_status: ReceiptText,
  reservation_confirmation: CalendarCheck,
  reservation_reminder: CalendarClock,
  facility_session: Timer,
  subscription_billing: CreditCard,
  schedule_update: CalendarDays,
  payslip: FileText,
  daily_summary: Sun,
  operational_anomaly: TriangleAlert,
  payment_failover: TriangleAlert,
  kitchen_alert: ChefHat,
  tenant_invitation: MailCheck,
  hr_settlement: UserRoundMinus,
};

export function categoryLabelKey(category: NotificationCategory): MessageKey {
  return `notification.category.${category}`;
}

/**
 * Categories a staff notification center shows. Customer-audience categories
 * belong to the member PWA (PRD §3.15 audiences); the preference contract
 * still accepts every category, so this is only what this screen offers.
 */
export const STAFF_NOTIFICATION_CATEGORIES: readonly NotificationCategory[] =
  NOTIFICATION_CATEGORIES.filter(
    (category) => categoryMeta(category).audience !== "customer",
  );

/** Fixed zone so the server render and the browser render agree (PRD §6). */
const momentFormat = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: DEFAULT_TIME_ZONE,
});

export function formatNotificationTime(iso: string): string {
  return momentFormat.format(new Date(iso));
}
