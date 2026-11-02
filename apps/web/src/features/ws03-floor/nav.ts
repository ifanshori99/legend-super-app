import { LayoutGrid } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "ops",
    labelKey: "nav.operations.floor",
    to: "/pos/meja",
    icon: LayoutGrid,
    order: 10,
    anyPermission: ["floor.table.view"],
  },
];

export default nav;
