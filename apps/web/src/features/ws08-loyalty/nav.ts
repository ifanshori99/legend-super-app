// Menu item of the loyalty back office in the management area (PRD §5
// "/kelola/*", §3.20). Collected by lib/areas/nav-registry.ts.
import { BadgePercent } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.loyalty",
    to: "/kelola/loyalty",
    icon: BadgePercent,
    order: 50,
    anyPermission: ["loyalty.program.manage"],
  },
];

export default nav;
