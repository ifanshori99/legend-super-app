import { ClipboardList } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Orders not finished yet and parked carts (brief 1268 W5), right after the
// cashier: an unpaid order left on the payment screen is reached from here.
const nav: AreaNavEntry[] = [
  {
    area: "ops",
    labelKey: "nav.ops.openOrders",
    to: "/pos/pesanan",
    icon: ClipboardList,
    order: 29.2,
    anyPermission: [
      "pos.sale.create",
      "pos.payment.accept",
      "pos.void.request",
    ],
  },
];

export default nav;
