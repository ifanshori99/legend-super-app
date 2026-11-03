import { UserRoundCog } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Switch user lives on the POS and kitchen shells (PRD v1.7 §3 F6).
const nav: AreaNavEntry[] = [
  {
    area: "ops",
    labelKey: "devicePin.pageTitle",
    to: "/pos/ganti-pengguna",
    icon: UserRoundCog,
    order: 90,
  },
  {
    area: "kitchen",
    labelKey: "devicePin.pageTitle",
    to: "/kds/ganti-pengguna",
    icon: UserRoundCog,
    order: 90,
  },
];

export default nav;
