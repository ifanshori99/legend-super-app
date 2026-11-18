// Management sidebar entries of the settings hub and the audit log (PRD v1.7
// §3 F36). The audit entry is hidden without `audit.log.view`; the page guard
// re-checks it.
import { ScrollText, Settings } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "auditSettings.nav.settings",
    to: "/kelola/pengaturan",
    icon: Settings,
    order: 95,
    outletScopedPaths: ["/kelola/pengaturan/open-bill"],
  },
  {
    area: "kelola",
    labelKey: "auditSettings.nav.audit",
    to: "/audit",
    icon: ScrollText,
    order: 96,
    anyPermission: ["audit.log.view"],
  },
];

export default nav;
