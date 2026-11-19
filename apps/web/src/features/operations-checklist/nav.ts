import { ClipboardCheck, ClipboardList } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Ops entries for WS-14 checklists (PRD v1.7 §3 F41 "Checklist Operasional"):
// the phone execution board and the template builder. Any entry only hides the
// link; each page's beforeLoad runs the same permission check.
const nav: AreaNavEntry[] = [
  {
    area: "ops",
    labelKey: "nav.ops.checklist",
    to: "/operasional/checklist",
    icon: ClipboardCheck,
    order: 10,
    anyPermission: ["ops.checklist.complete"],
  },
  {
    area: "ops",
    labelKey: "nav.ops.checklistTemplate",
    to: "/operasional/checklist/template",
    icon: ClipboardList,
    order: 11,
    anyPermission: ["ops.checklist.complete"],
  },
];

export default nav;
