import { CreditCard } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";
import { PAYMENT_ADMIN_PERMISSIONS } from "./lib";

// Management area: gateway routing, EDC terminals, refunds, unallocated funds
// and settlement reconciliation (PRD §3 F13). The page guard re-checks the
// payment permissions; the API authorizes every request.
const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.payments",
    to: "/kelola/pembayaran",
    icon: CreditCard,
    order: 42,
    anyPermission: PAYMENT_ADMIN_PERMISSIONS,
  },
];

export default nav;
