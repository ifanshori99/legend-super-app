// Menu items of the WS-10 learning back office in the management area (PRD
// §5 "/kelola/*", §3 F32). Collected by lib/areas/nav-registry.ts, so parallel
// WS-10 beads never edit one list.
import { BookOpenText, GraduationCap, Megaphone, Target } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.kpi",
    to: "/kelola/kpi",
    icon: Target,
    order: 15,
    group: "team",
    anyPermission: ["hr.kpi.manage"],
  },
  {
    area: "kelola",
    labelKey: "nav.management.sop",
    to: "/kelola/sop",
    icon: BookOpenText,
    order: 25,
    group: "team",
    anyPermission: ["hr.sop.manage"],
  },
  {
    area: "kelola",
    labelKey: "nav.management.training",
    to: "/kelola/pelatihan",
    icon: GraduationCap,
    order: 35,
    group: "team",
    anyPermission: ["hr.training.manage"],
  },
  {
    area: "kelola",
    labelKey: "nav.management.announcements",
    to: "/kelola/pengumuman",
    icon: Megaphone,
    order: 45,
    group: "team",
    anyPermission: ["hr.announcement.manage"],
  },
];

export default nav;
