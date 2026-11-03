import { Gauge, HeartPulse, Package, ScrollText } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "platform",
    labelKey: "platformOps.nav.paket",
    to: "/platform/paket",
    icon: Package,
    order: 40,
    anyPermission: ["platform.package.manage", "platform.tenant.manage"],
  },
  {
    area: "platform",
    labelKey: "platformOps.nav.kuota",
    to: "/platform/kuota",
    icon: Gauge,
    order: 41,
    anyPermission: ["platform.package.manage", "platform.tenant.manage"],
  },
  {
    area: "platform",
    labelKey: "platformOps.nav.kesehatan",
    to: "/platform/kesehatan",
    icon: HeartPulse,
    order: 42,
    anyPermission: ["platform.health.view"],
  },
  {
    area: "platform",
    labelKey: "platformOps.nav.audit",
    to: "/platform/audit",
    icon: ScrollText,
    order: 43,
    anyPermission: ["platform.health.view", "platform.tenant.manage"],
  },
];

export default nav;
