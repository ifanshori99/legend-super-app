import { UtensilsCrossed } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    group: "operations",
    labelKey: "nav.management.menu",
    to: "/kelola/menu",
    icon: UtensilsCrossed,
    order: 20,
    anyPermission: ["menu.item.view"],
  },
];

export default nav;
