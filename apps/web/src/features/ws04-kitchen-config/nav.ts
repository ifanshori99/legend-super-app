import { ChefHat } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.kitchen",
    to: "/kelola/dapur",
    icon: ChefHat,
    order: 25,
    anyPermission: ["kds.station.manage"],
    outletScopedPaths: ["/kelola/dapur"],
  },
];

export default nav;
