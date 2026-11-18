import { HandCoins, Wallet } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Payroll screens sit under Kelola → Finance (DESIGN.md §5 Management sidebar
// groups). The nav gate is presentation only; the page guards (guard.ts,
// decision legend-t3f5) and the API enforce access.
const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "payrollRun.nav.runs",
    to: "/kelola/payroll/run",
    icon: Wallet,
    group: "finance",
    order: 20,
    anyPermission: ["payroll.run", "payroll.approve", "payroll.lock"],
  },
  {
    area: "kelola",
    labelKey: "payrollRun.nav.serviceCharge",
    to: "/kelola/payroll/service-charge",
    icon: HandCoins,
    group: "finance",
    order: 30,
    anyPermission: ["payroll.run", "payroll.approve"],
    outletScopedPaths: ["/kelola/payroll/service-charge"],
  },
];

export default nav;
