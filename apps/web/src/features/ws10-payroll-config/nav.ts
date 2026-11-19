import { Wallet } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Management area: payroll configuration (PRD v1.7 §3 F30, PAYR-02). One entry
// for policies, components, statutory version tables and THR schedules; the
// tabs are a validated search param on the same route.
const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    group: "finance",
    labelKey: "nav.management.payrollConfig",
    to: "/kelola/payroll/pengaturan",
    icon: Wallet,
    order: 10,
    anyPermission: ["payroll.view"],
  },
];

export default nav;
