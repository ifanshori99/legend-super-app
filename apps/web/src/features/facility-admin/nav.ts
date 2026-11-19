// Menu item for the facility config screens (PRD §3 F25; DESIGN.md v3 §5
// sidebar groups). Collected automatically by lib/areas/nav-registry.ts.
import { ShowerHead } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.facilityAdmin",
    to: "/kelola/fasilitas",
    icon: ShowerHead,
    group: "operations",
    order: 40,
    anyPermission: ["facility.config.manage"],
  },
];

export default nav;
