import { Inbox } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Kotak Approval (PRD v1.7 §3 F7, F36): one inbox for every module.
const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "approvals.nav",
    to: "/kelola/persetujuan",
    icon: Inbox,
    order: 20,
    anyPermission: ["approval.inbox.view"],
  },
];

export default nav;
