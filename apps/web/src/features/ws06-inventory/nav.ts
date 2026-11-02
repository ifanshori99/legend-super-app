import { Boxes } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.inventory",
    to: "/kelola/inventori",
    icon: Boxes,
    order: 30,
    anyPermission: ["inventory.stock.view"],
  },
];

export default nav;
