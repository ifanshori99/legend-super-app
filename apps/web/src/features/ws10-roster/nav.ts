// Menu items of the roster screens (PRD §3 Kelompok D 28, F26). Collected by
// `lib/areas/nav-registry.ts`, so the workstream never edits a shared list.
import { CalendarDays, LayoutTemplate } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.roster",
    to: "/kelola/roster",
    icon: CalendarDays,
    order: 60,
    group: "team",
    anyPermission: ["hr.schedule.manage"],
    outletScopedPaths: ["/kelola/roster"],
  },
  {
    area: "kelola",
    labelKey: "nav.management.rosterTemplates",
    to: "/kelola/roster/template",
    icon: LayoutTemplate,
    order: 70,
    group: "team",
    anyPermission: ["hr.schedule.manage"],
  },
];

export default nav;
