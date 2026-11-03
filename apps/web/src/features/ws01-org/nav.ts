// Management sidebar entry for outlet settings (bead legend-1mi5). The
// settings hub also links it (ws11-audit/components/settings-hub-page.tsx);
// the entry is hidden without `org.structure.manage`, and the page guard
// re-checks it.
import { Store } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "auditSettings.hub.groups.outlet",
    to: "/kelola/pengaturan/outlet",
    icon: Store,
    order: 97,
    anyPermission: ["org.structure.manage"],
  },
];

export default nav;
