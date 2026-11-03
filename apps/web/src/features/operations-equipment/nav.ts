import { ClipboardCheck, Wrench } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "ops",
    labelKey: "opsEquipment.nav.equipment",
    to: "/operasional/peralatan",
    icon: Wrench,
    order: 20,
    anyPermission: ["ops.equipment.maintain"],
  },
  {
    area: "ops",
    labelKey: "opsEquipment.nav.handover",
    to: "/operasional/serah-terima",
    icon: ClipboardCheck,
    order: 21,
    anyPermission: ["ops.handover.record"],
  },
];

export default nav;
