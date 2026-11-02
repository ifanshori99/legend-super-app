// Icons of the management home cards. Icon only, never a substitute for text
// (DESIGN.md §4: status and kind always carry a label).
import {
  BellRing,
  ChefHat,
  ClipboardList,
  DoorOpen,
  FileText,
  Files,
  Gauge,
  Inbox,
  PackageMinus,
  PieChart,
  Router,
  ScrollText,
  Star,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { DashboardQueue, DashboardTile } from "@starter/shared/dashboard";

export const QUEUE_ICONS = {
  approvals: Inbox,
  kitchen_queue: ChefHat,
  waiter_calls: BellRing,
  reviews: Star,
  alerts: TriangleAlert,
  critical_stock: PackageMinus,
  devices: Router,
  documents: FileText,
  daily_summary: ClipboardList,
  facility_units: DoorOpen,
} as const satisfies Record<DashboardQueue, LucideIcon>;

export function tileIcon(tile: DashboardTile): LucideIcon {
  if (tile.kind === "queue") return QUEUE_ICONS[tile.queue];
  if (tile.kind === "link")
    // The audit viewer is the only other link in the catalog; a distinct icon
    // keeps the two rows scannable.
    return tile.targetPath.includes("audit") ? ScrollText : Files;
  if (tile.kind === "personal_share") return PieChart;
  return Gauge;
}
