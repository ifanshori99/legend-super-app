// Menu item of the report builder in the management area (PRD v1.7 §3 F36).
// Shown to anyone holding a report permission; the page re-checks it.
import { ChartNoAxesCombined } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.reportBuilder",
    to: "/reports/builder",
    icon: ChartNoAxesCombined,
    order: 70,
    anyPermission: [
      "report.aggregate.view",
      "report.operational.view",
      "report.sales.view",
      "report.financial.view",
    ],
  },
];

export default nav;
