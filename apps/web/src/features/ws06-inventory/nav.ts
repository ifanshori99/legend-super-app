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
    outletScopedPaths: [
      "/kelola/inventori/stok",
      "/kelola/inventori/saldo",
      "/kelola/inventori/lokasi",
      "/kelola/inventori/transfer",
      "/kelola/inventori/opname",
      "/kelola/inventori/waste",
      "/kelola/inventori/kedaluwarsa",
      "/kelola/inventori/produksi",
      "/kelola/inventori/saran",
      "/kelola/inventori/hpp",
      "/kelola/inventori/resep",
    ],
  },
];

export default nav;
