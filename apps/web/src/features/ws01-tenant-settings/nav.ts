import { SlidersHorizontal } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Management area: tenant settings (integrations, theme, term dictionary,
// config export/import; PRD v1.7 §3 F4). One sidebar entry; the pages switch
// between each other with a tab strip. `anyPermission` only hides the item,
// the API authorizes every request.
const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "tenantSettings.nav.title",
    to: "/kelola/pengaturan/integrasi",
    icon: SlidersHorizontal,
    order: 90,
    anyPermission: [
      "org.integration.manage",
      "org.theme.manage",
      "org.config.export",
    ],
  },
];

export default nav;
