import { Boxes } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.inventory",
    // /kelola/inventori redirects to the stock card on this branch; the items
    // landing screen arrives with legend-qdc and replaces that redirect.
    to: "/kelola/inventori",
    icon: Boxes,
    order: 30,
    anyPermission: ["inventory.stock.view"],
  },
];

export default nav;
