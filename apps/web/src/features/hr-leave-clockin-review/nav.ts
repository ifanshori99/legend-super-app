// Menu item of the HR leave clock-in review (collected by
// lib/areas/nav-registry). `anyPermission` only hides the item; the page guard
// and the API decide access.
import { CalendarX2 } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "leaveClockinReview.nav.label",
    to: "/kelola/absensi/tinjauan-cuti",
    icon: CalendarX2,
    order: 45,
    group: "team",
    anyPermission: ["hr.attendance.manage"],
    outletScopedPaths: ["/kelola/absensi/tinjauan-cuti"],
  },
];

export default nav;
