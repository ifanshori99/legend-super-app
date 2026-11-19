import { Building2 } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";
import type { MessageKey } from "@starter/shared/i18n";

// Panel Platform tenant list (PRD §3 F1 "Layar Platform"). The area itself is
// reserved for platform admins.
const nav: AreaNavEntry[] = [
  {
    area: "platform",
    labelKey: "nav.platform.tenants" as MessageKey,
    to: "/platform/tenant",
    icon: Building2,
    order: 10,
    // Same permission as the route guard (guard.ts), so health-only viewers
    // are not offered a link that answers 404.
    anyPermission: ["platform.tenant.manage"],
  },
];

export default nav;
