import { BookOpen, Sparkles } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";
import { chatPath, guidePath, type ChatArea } from "./logic";

// Tanya AI + Panduan AI in every area whose people hold `ai.ask` (PRD §3 F38).
// The guide page itself is built by ws12-ai-guide.
const AREAS: readonly ChatArea[] = [
  "kelola",
  "owner",
  "shareholder",
  "karyawan",
  "kitchen",
];

const nav: AreaNavEntry[] = AREAS.flatMap((area) => [
  {
    area,
    labelKey: "aiChat.nav",
    to: chatPath(area),
    icon: Sparkles,
    order: 60,
    anyPermission: ["ai.ask"],
  },
  {
    area,
    labelKey: "aiChat.navGuide",
    to: guidePath(area),
    icon: BookOpen,
    order: 61,
    anyPermission: ["ai.ask"],
  },
]);

export default nav;
