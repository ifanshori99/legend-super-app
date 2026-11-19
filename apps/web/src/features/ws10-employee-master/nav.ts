// Menu items of the employee master in the kelola sidebar (PRD §3 F24, §5
// "Peta situs"): "Karyawan" opens the directory, "Struktur Organisasi" the org
// chart. Group "team" keeps them next to the other people screens (DESIGN.md
// §5 NAV_GROUPS).
import { Network, Users } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.employees",
    to: "/kelola/karyawan",
    icon: Users,
    group: "team",
    order: 10,
    anyPermission: ["hr.employee.view"],
  },
  {
    area: "kelola",
    labelKey: "nav.management.organization",
    to: "/kelola/organisasi",
    icon: Network,
    group: "team",
    order: 50,
    anyPermission: ["hr.employee.view"],
  },
];

export default nav;
