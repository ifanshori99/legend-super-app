import { CalendarDays } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Reservation desk inside the operations area (PRD §5: `/pos/*` is served by
// the edge node and stays usable offline). The host stand is its first user:
// schedule, table assignment, waitlist and event packages on one screen.
const nav: AreaNavEntry[] = [
  {
    area: "ops",
    labelKey: "nav.operations.reservations",
    to: "/pos/reservasi",
    icon: CalendarDays,
    order: 20,
    anyPermission: ["reservation.view"],
  },
];

export default nav;
