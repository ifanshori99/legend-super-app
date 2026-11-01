import { Bell } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Management area: the notification center (PRD §3.15 "Notifikasi Hemat
// Biaya"). Visible to anyone who can open the dashboard; the API scopes the
// rows to the session user.
const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.notifications",
    to: "/kelola/notifikasi",
    icon: Bell,
    order: 40,
  },
];

export default nav;
