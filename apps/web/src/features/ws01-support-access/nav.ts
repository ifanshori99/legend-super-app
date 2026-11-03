import { LifeBuoy } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Super Admin opens and ends sessions (PRD §3 F4); the tenant admin reads the
// history (TEN-04: "terlihat oleh admin tenant"), gated by the audit view.
const nav: AreaNavEntry[] = [
  {
    area: "platform",
    labelKey: "supportAccess.nav",
    to: "/platform/akses-dukungan",
    icon: LifeBuoy,
    order: 60,
    anyPermission: ["platform.support_access.request"],
  },
  {
    area: "kelola",
    labelKey: "supportAccess.nav",
    to: "/kelola/akses-dukungan",
    icon: LifeBuoy,
    order: 92,
    anyPermission: ["audit.log.view"],
  },
];

export default nav;
