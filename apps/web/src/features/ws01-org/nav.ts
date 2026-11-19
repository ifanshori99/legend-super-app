// Management sidebar entries for outlet settings (bead legend-1mi5) and custom
// domains (bead legend-az8z5). The settings hub also links the outlet entry
// (ws11-audit/components/settings-hub-page.tsx); each entry is hidden without
// `org.structure.manage`, and the page guard re-checks it.
import { Globe, Store } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.outletSettings",
    to: "/kelola/pengaturan/outlet",
    icon: Store,
    order: 97,
    anyPermission: ["org.structure.manage"],
  },
  {
    area: "kelola",
    labelKey: "orgOutlet.navDomain",
    to: "/kelola/pengaturan/domain",
    icon: Globe,
    order: 98,
    anyPermission: ["org.structure.manage"],
  },
];

export default nav;
