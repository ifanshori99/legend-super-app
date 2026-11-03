import { MonitorSmartphone } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Device registry per outlet (PRD v1.7 §3 F5 Registri Perangkat).
const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "deviceRegistry.nav",
    to: "/kelola/perangkat",
    icon: MonitorSmartphone,
    order: 85,
    group: "operations",
    anyPermission: ["device.registry.manage", "device.registry.revoke"],
  },
];

export default nav;
