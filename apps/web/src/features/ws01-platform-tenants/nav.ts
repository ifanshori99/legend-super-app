import { Building2 } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";
import type { MessageKey } from "@starter/shared/i18n";

// Panel Platform tenant list (PRD §3 F1 "Layar Platform"). The area itself is
// reserved for platform admins.
const nav: AreaNavEntry[] = [
  {
    area: "platform",
    labelKey: "platformTenants.nav.tenants" as MessageKey,
    to: "/platform/tenant",
    icon: Building2,
    order: 10,
  },
];

export default nav;
