// Menu items of the CRM back office in the management area (PRD §5
// "/kelola/*", §3.21 "CRM, Promo & Kampanye"). Collected by
// lib/areas/nav-registry.ts.
//
// Two entries: the Customer 360 hub (list, detail and segment builder share
// /kelola/pelanggan) and the reviews queue at /kelola/ulasan, which needs its
// own entry so the management topbar names the screen instead of "Kelola".
import { MessageSquareText, Users } from "lucide-react";
import type { MessageKey } from "@starter/shared/i18n";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    // Registered in id.ts as `crm360: crm360Messages`.
    labelKey: "crm360.nav" as MessageKey,
    to: "/kelola/pelanggan",
    icon: Users,
    order: 56,
    group: "operations",
    anyPermission: ["crm.customer.view"],
  },
  {
    area: "kelola",
    labelKey: "crm360.navReviews" as MessageKey,
    to: "/kelola/ulasan",
    icon: MessageSquareText,
    order: 57,
    group: "operations",
    anyPermission: ["crm.customer.view", "review.respond"],
  },
];

export default nav;
