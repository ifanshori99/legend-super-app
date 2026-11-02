import { Coins, Gift, Target, Ticket } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Customer bottom navigation (max 5 items incl. the area index): the member
// PWA's daily screens. Points, rewards and vouchers are the three the bar
// keeps next to Beranda; missions, facilities and Wi-Fi sit in the "Lainnya"
// sheet (DESIGN.md v2 §5, bead legend-oibk).
const nav: AreaNavEntry[] = [
  {
    area: "customer",
    labelKey: "member.nav.points",
    to: "/member/poin",
    icon: Coins,
    order: 10,
  },
  {
    area: "customer",
    labelKey: "member.nav.rewards",
    to: "/member/reward",
    icon: Gift,
    order: 20,
  },
  {
    area: "customer",
    labelKey: "member.nav.vouchers",
    to: "/member/voucher",
    icon: Ticket,
    order: 30,
  },
  {
    area: "customer",
    labelKey: "member.nav.missions",
    to: "/member/misi",
    icon: Target,
    order: 40,
  },
];

export default nav;
