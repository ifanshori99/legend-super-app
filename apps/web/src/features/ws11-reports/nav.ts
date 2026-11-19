// Menu item of the report catalog in the management area (PRD v1.7 §3 F36
// "Laporan"). Individual report screens are reached from the catalog and from
// dashboard drill-down links; each re-checks its own report permission.
import { ChartColumn } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.reports",
    to: "/reports",
    icon: ChartColumn,
    order: 30,
    group: "operations",
    anyPermission: [
      "report.sales.view",
      "report.operational.view",
      "report.financial.view",
    ],
  },
];

export default nav;
