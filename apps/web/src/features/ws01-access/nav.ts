import { ShieldCheck } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.access",
    to: "/kelola/akses",
    icon: ShieldCheck,
    order: 90,
    anyPermission: ["access.role.view", "access.approval_policy.manage"],
  },
];

export default nav;
