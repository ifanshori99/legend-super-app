// Icons of the management home cards. Icon only, never a substitute for text
// (DESIGN.md §11: an icon sits next to its label). Kept as lookups so a card
// resolves a stable module-level component instead of building one in render.
import {
  BellRing,
  ChefHat,
  ClipboardList,
  DoorOpen,
  FileText,
  Inbox,
  PackageMinus,
  Router,
  Star,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { DashboardQueue } from "@starter/shared/dashboard";

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
