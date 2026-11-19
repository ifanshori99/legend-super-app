import {
  CalendarCheck,
  Clock,
  ReceiptText,
  ShoppingCart,
  Ticket,
} from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";
import { TICKET_SALE_CONNECTED } from "./ticket/connected";

// Cashier screens inside the operations area (PRD §5: `/pos/*`, §3 F8 shift
// and day close, §3 F11 "Bayar di kasir" code). Payment itself opens from an
// order (`/pos/bayar/$orderId`), so it has no menu item.
// The ticket sale stays off the menu while it has no payment contract: the
// route still exists and says so, but production must not lead to a locked
// screen.
const ticketEntry: AreaNavEntry = {
  area: "ops",
  labelKey: "nav.ops.kasirTicket",
  to: "/pos/tiket",
  icon: Ticket,
  order: 29.5,
  anyPermission: ["pos.sale.create"],
};

const nav: AreaNavEntry[] = [
  {
    area: "ops",
    labelKey: "nav.ops.orderKasir",
    to: "/pos/kasir",
    icon: ShoppingCart,
    order: 29,
    anyPermission: ["pos.sale.create"],
  },
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
  ...(TICKET_SALE_CONNECTED ? [ticketEntry] : []),
];

export default nav;
