// Menu item of the guest Wi-Fi portal in the customer area. The portal is
// usually opened from a table QR or the Wi-Fi sticker, but the member shell
// keeps it one tap away too (PRD §3 "Wi-Fi Tamu", §5 "/wifi").
import { Wifi } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "customer",
    labelKey: "nav.customer.wifi",
    to: "/wifi",
    icon: Wifi,
    order: 20,
  },
];

export default nav;
