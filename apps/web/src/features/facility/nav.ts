import { ShowerHead } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Customer bottom nav: "Fasilitas" opens Fasilitas Saya (WS-09). The booking
// entry itself is the facility QR (`/f/[facility]`), per PRD §3 F22 Titik
// Masuk, so it is a card inside the page instead of a nav item.
const nav: AreaNavEntry[] = [
  {
    area: "customer",
    labelKey: "nav.customer.facility",
    to: "/member/fasilitas",
    icon: ShowerHead,
    order: 20,
  },
];

export default nav;
