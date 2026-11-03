// Menu item of the facility & WFC report hub in the management area (PRD v1.7
// §3 F25 "Laporan" and "Pengukuran WFC"). It sits in the operations group next
// to the report catalog; the page itself re-checks `report.operational.view`
// because `anyPermission` only hides the item.
import { ChartColumn } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "facilityReport.nav.title",
    to: "/kelola/fasilitas/laporan",
    icon: ChartColumn,
    order: 41,
    group: "operations",
    anyPermission: ["report.operational.view"],
  },
];

export default nav;
