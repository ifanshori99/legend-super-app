import { LogIn, LogOut } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.onboarding",
    to: "/kelola/onboarding",
    icon: LogIn,
    order: 80,
    group: "team",
    anyPermission: ["hr.employee.manage"],
  },
  {
    area: "kelola",
    labelKey: "nav.management.offboarding",
    to: "/kelola/offboarding",
    icon: LogOut,
    order: 90,
    group: "team",
    anyPermission: ["hr.employee.manage"],
  },
];

export default nav;
