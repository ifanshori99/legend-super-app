import { ClipboardList, Trash2 } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Stock opname and waste are pages of the inventory area (PRD §5 "Layar
// Manajemen"). Both only hide the item; the page guard and the API enforce
// the actual inventory permission.
const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "opname.nav.counts",
    to: "/kelola/inventori/opname",
    icon: ClipboardList,
    order: 31,
    anyPermission: ["inventory.stock.view"],
  },
  {
    area: "kelola",
    labelKey: "waste.nav",
    to: "/kelola/inventori/waste",
    icon: Trash2,
    order: 32,
    anyPermission: ["inventory.stock.view"],
  },
];

export default nav;
