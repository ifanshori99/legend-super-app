// Decorative icon per attendance event type, shared by the Beranda timeline
// and the history rows. The text always names the event, so the icon never
// carries meaning on its own (DESIGN.md §4 "Badge, StatusPill").
import { Coffee, LogIn, LogOut, Play, type LucideIcon } from "lucide-react";
import type { AttendanceType } from "@starter/shared/hris";

export const ATTENDANCE_TYPE_ICONS: Record<AttendanceType, LucideIcon> = {
  in: LogIn,
  out: LogOut,
  break_start: Coffee,
  break_end: Play,
};
