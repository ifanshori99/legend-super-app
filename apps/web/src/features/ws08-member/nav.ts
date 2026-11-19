import { Coins, Gift, Target, Ticket } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Customer bottom navigation (max 5 items incl. the area index): the member
// PWA's daily screens. Points, rewards and vouchers are the three the bar
// keeps next to Beranda; missions, facilities and Wi-Fi sit in the "Lainnya"
// sheet (DESIGN.md v2 §5, bead legend-oibk).
const nav: AreaNavEntry[] = [
  {
    area: "customer",
    labelKey: "nav.customer.memberPoints",
    to: "/member/poin",
    icon: Coins,
    order: 10,
  },
  {
    area: "customer",
    labelKey: "nav.customer.memberRewards",
    to: "/member/reward",
    icon: Gift,
    order: 20,
  },
  {
    area: "customer",
    labelKey: "nav.customer.memberVouchers",
    to: "/member/voucher",
    icon: Ticket,
    order: 30,
  },
  {
    area: "customer",
    labelKey: "nav.customer.memberMissions",
    to: "/member/misi",
    icon: Target,
    order: 40,
  },
];

export default nav;
