import { ClipboardCheck, Wrench } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "ops",
    labelKey: "nav.ops.equipment",
    to: "/operasional/peralatan",
    icon: Wrench,
    order: 20,
    anyPermission: ["ops.equipment.maintain"],
  },
  {
    area: "ops",
    labelKey: "nav.ops.equipmentHandover",
    to: "/operasional/serah-terima",
    icon: ClipboardCheck,
    order: 21,
    anyPermission: ["ops.handover.record"],
  },
];

export default nav;
