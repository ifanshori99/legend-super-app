import { ClipboardList, Printer, Thermometer } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Ops area entries for food safety, prep labels and the daily prep list
// (PRD v1.7 §3 F41; OPS-02/OPS-03). Sidebar order follows the morning routine:
// log temperatures, print labels, work the prep list.
const nav: AreaNavEntry[] = [
  {
    area: "ops",
    labelKey: "nav.ops.temperature",
    to: "/operasional/suhu",
    icon: Thermometer,
    order: 30,
    anyPermission: ["ops.food_safety.log"],
  },
  {
    area: "ops",
    labelKey: "nav.ops.prepLabels",
    to: "/operasional/label-prep",
    icon: Printer,
    order: 31,
    anyPermission: ["ops.prep.manage"],
  },
  {
    area: "ops",
    labelKey: "nav.ops.prepList",
    to: "/operasional/prep",
    icon: ClipboardList,
    order: 32,
    anyPermission: ["ops.prep.manage"],
  },
];

export default nav;
