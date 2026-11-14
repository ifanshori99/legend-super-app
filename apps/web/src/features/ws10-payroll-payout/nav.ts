import { Banknote } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Kelola → Finance, next to the payroll run list. Presentation only; the page
// guard (guard.ts) and the API enforce access.
const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "payrollPayout.nav.title",
    to: "/kelola/payroll/pencairan",
    icon: Banknote,
    group: "finance",
    order: 25,
    anyPermission: [
      "payroll.view",
      "payroll.payout.configure",
      "payroll.disburse.request",
      "payroll.disburse.approve",
    ],
  },
];

export default nav;
