import { FileSpreadsheet, ReceiptText } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Management area: tax & service-charge configuration (PRD §3.14) and the
// monthly PBJT recap. Two entries because two roles own them: the tenant admin
// configures (org.tax_config.manage); finance reports (accounting.tax_report
// .manage). `anyPermission` hides an item, the API authorizes every request.
const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    group: "finance",
    labelKey: "nav.management.tax",
    to: "/kelola/pajak",
    icon: ReceiptText,
    order: 35,
    anyPermission: ["org.tax_config.manage"],
    outletScopedPaths: ["/kelola/pajak/service-charge"],
  },
  {
    area: "kelola",
    group: "finance",
    labelKey: "nav.management.taxReport",
    to: "/kelola/pajak/laporan",
    icon: FileSpreadsheet,
    order: 36,
    anyPermission: ["accounting.tax_report.manage"],
    outletScopedPaths: ["/kelola/pajak/laporan"],
  },
];

export default nav;
