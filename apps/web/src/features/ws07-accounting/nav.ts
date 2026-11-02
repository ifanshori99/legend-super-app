// Menu item of the accounting back office in the management area (PRD §5
// "/kelola/* — Dashboard manajemen", §3.19 Akuntansi & Keuangan). One area
// permission hides the item for visitors without it; the page guard in
// routes/_kelola/kelola.akuntansi.* re-checks each screen.
import { BookOpen } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.accounting",
    to: "/kelola/akuntansi",
    icon: BookOpen,
    order: 40,
    anyPermission: ["accounting.journal.view"],
  },
];

export default nav;
