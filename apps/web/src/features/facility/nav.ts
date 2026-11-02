import { ShowerHead } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Customer bottom nav: "Fasilitas" opens Fasilitas Saya (WS-09). The booking
// entry itself is the facility QR (`/f/[facility]`), per PRD §3 F22 Titik
// Masuk, so it is a card inside the page instead of a nav item. Order 50 puts
// it in the "Lainnya" sheet after the member screens (legend-oibk).
const nav: AreaNavEntry[] = [
  {
    area: "customer",
    labelKey: "nav.customer.facility",
    to: "/member/fasilitas",
    icon: ShowerHead,
    order: 50,
  },
];

export default nav;
