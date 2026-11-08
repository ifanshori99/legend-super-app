import { CalendarCheck, Clock, ReceiptText } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Cashier screens inside the operations area (PRD §5: `/pos/*`, §3 F8 shift
// and day close, §3 F11 "Bayar di kasir" code). Payment itself opens from an
// order (`/pos/bayar/$orderId`), so it has no menu item.
const nav: AreaNavEntry[] = [
  {
    area: "ops",
    labelKey: "posKasirCommon.nav.code",
    to: "/pos/kode",
    icon: ReceiptText,
    order: 30,
    anyPermission: ["pos.sale.create", "pos.payment.accept"],
  },
  {
    area: "ops",
    labelKey: "posKasirCommon.nav.shift",
    to: "/pos/shift",
    icon: Clock,
    order: 31,
    anyPermission: ["pos.sale.create", "shift.cash.operate"],
  },
  {
    area: "ops",
    labelKey: "posKasirCommon.nav.dayClose",
    to: "/pos/tutup-hari",
    icon: CalendarCheck,
    order: 32,
    anyPermission: ["shift.cash.approve_close"],
  },
];

export default nav;
