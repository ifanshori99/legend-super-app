// Menu item of the campaign screens in the management area (PRD §5
// "/kelola/*", §3.21 "Kampanye", "Otomasi"). Collected by
// lib/areas/nav-registry.ts.
import { Megaphone } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.campaigns",
    to: "/kelola/kampanye",
    icon: Megaphone,
    order: 56,
    group: "operations",
    anyPermission: ["campaign.manage"],
  },
];

export default nav;
