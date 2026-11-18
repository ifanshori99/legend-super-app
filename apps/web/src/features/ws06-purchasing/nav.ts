import { ClipboardList } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.purchasing",
    to: "/kelola/pengadaan",
    icon: ClipboardList,
    order: 40,
    anyPermission: [
      "purchasing.request.create",
      "purchasing.order.create",
      "purchasing.order.approve",
    ],
    outletScopedPaths: ["/kelola/pengadaan"],
  },
];

export default nav;
