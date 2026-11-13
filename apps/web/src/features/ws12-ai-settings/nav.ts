import { Sparkles } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Management area: tenant AI settings (ChatGPT login, custom model, budget).
// The page guard re-checks the permission; the API authorizes every request.
const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "aiSettings.nav",
    to: "/kelola/pengaturan/ai",
    icon: Sparkles,
    order: 93,
    anyPermission: ["ai.governance.manage"],
  },
];

export default nav;
