import { LayoutGrid } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// The floor editor is a management screen, so only staff who may change zones
// and tables see the item (PRD §3 F9 "Denah & Meja"; UI only, the API decides).
const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    group: "operations",
    labelKey: "nav.management.floor",
    to: "/kelola/meja",
    icon: LayoutGrid,
    order: 30,
    anyPermission: ["floor.table.manage"],
  },
];

export default nav;
