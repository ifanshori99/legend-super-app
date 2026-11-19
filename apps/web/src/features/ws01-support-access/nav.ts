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
  // Owner decides read_write requests (legend-8r77t); the API enforces 2FA.
  {
    area: "kelola",
    labelKey: "nav.management.supportAccessOwner",
    to: "/kelola/akses-dukungan/permintaan",
    icon: LifeBuoy,
    order: 93,
    anyPermission: ["org.support_access.approve"],
  },
];

export default nav;
