// Menu item of the promo admin in the management area (PRD §5 "/kelola/*",
// §3.21 "Promo Engine"). Collected by lib/areas/nav-registry.ts.
//
import { Ticket } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.promo",
    to: "/kelola/promo",
    icon: Ticket,
    order: 55,
    anyPermission: ["promo.manage"],
  },
];

export default nav;
