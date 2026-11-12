// Menu item of the supervisor request queue (collected by lib/areas/nav-registry).
// `anyPermission` only hides the item; the page guard and the API decide access.
import { Inbox } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "hrisRequestsQueue.nav.label",
    to: "/kelola/pengajuan",
    icon: Inbox,
    order: 44,
    group: "team",
    anyPermission: [
      "hr.schedule.manage",
      "hr.leave.approve",
      "hr.overtime.approve",
    ],
  },
];

export default nav;
