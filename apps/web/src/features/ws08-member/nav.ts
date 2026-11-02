import { Coins, Gift, Target, Ticket } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Customer bottom navigation (max 5 items incl. the area index): the member
// PWA's four daily screens. Visits and favorites stay one tap away from the
// overview so the bar does not overflow on a 360px phone.
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
    labelKey: "member.nav.missions",
    to: "/member/misi",
    icon: Target,
    order: 30,
  },
  {
    area: "customer",
    labelKey: "member.nav.vouchers",
    to: "/member/voucher",
    icon: Ticket,
    order: 40,
  },
];

export default nav;
