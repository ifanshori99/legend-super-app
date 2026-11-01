import { Network } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Supervisor entry: connectivity, sync backlog, print queue, device alerts
// (PRD v1.7 §3 F5, §4 Alur F). The print queue drawer itself is reusable by
// POS/KDS screens; this screen is where a supervisor reviews the outlet.
const nav: AreaNavEntry[] = [
  {
    area: "ops",
    labelKey: "nav.ops.connectivity",
    to: "/operasional/koneksi",
    icon: Network,
    order: 80,
    anyPermission: ["report.operational.view"],
  },
];

export default nav;
