import { ShieldCheck } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Self-service security for every MFA role (PRD §3 F6 "Sesi & Perangkat",
// AUTH-05): management, owner (via /kelola), shareholder and Super Admin.
// No permission gates the page itself — it only shows the visitor's own
// factors and sessions.
const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "staffAuth.nav.security",
    to: "/kelola/keamanan",
    icon: ShieldCheck,
    order: 90,
  },
  {
    area: "platform",
    labelKey: "staffAuth.nav.security",
    to: "/platform/keamanan",
    icon: ShieldCheck,
    order: 90,
  },
  {
    area: "shareholder",
    labelKey: "staffAuth.nav.security",
    to: "/shareholder/keamanan",
    icon: ShieldCheck,
    order: 90,
  },
];

export default nav;
