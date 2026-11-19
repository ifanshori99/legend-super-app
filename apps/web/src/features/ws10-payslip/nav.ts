// Menu items of the employee payslip screens in the karyawan area (PRD §3
// F30 "Slip Gaji", F31 "Kasbon & Reimbursement"; HR-01). The CustomerShell
// keeps five bottom-nav slots; the extra items overflow into "Lainnya", which
// is the expected behaviour on a phone (DESIGN.md §5).
import { HandCoins, ReceiptText, Wallet } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "karyawan",
    labelKey: "nav.karyawan.payslips",
    to: "/karyawan/slip-gaji",
    icon: Wallet,
    order: 30,
    anyPermission: ["self.payslip.view"],
  },
  {
    area: "karyawan",
    labelKey: "nav.karyawan.kasbon",
    to: "/karyawan/kasbon",
    icon: HandCoins,
    order: 40,
    // legend-e3k9: kasbon has its own self-service permission.
    anyPermission: ["self.loan.request"],
  },
  {
    area: "karyawan",
    labelKey: "nav.karyawan.reimbursement",
    to: "/karyawan/reimbursement",
    icon: ReceiptText,
    order: 50,
    anyPermission: ["self.reimbursement.request"],
  },
];

export default nav;
