import { Truck } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Ojek online delivery ops (PRD §3.23 "Integrasi Ojek Online" / F20, D12):
// store state per platform, incoming orders, commission reconciliation. The
// kelola area already requires dashboard.management.view + MFA; the page guard
// adds one of the two delivery permissions.
const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    group: "operations",
    labelKey: "nav.management.delivery",
    to: "/kelola/delivery",
    icon: Truck,
    order: 40,
    anyPermission: ["delivery.channel.manage", "delivery.order.handle"],
    outletScopedPaths: ["/kelola/delivery"],
  },
];

export default nav;
