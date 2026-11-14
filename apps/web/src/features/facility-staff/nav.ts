import { ClipboardList, ShieldAlert, Siren, SprayCan } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Staff facility surfaces (PRD v1.7 §3 F25 "Siklus Kebersihan" +
// "Keselamatan"; the area is "ops", URL prefix /fasilitas per docs/frontend.md
// "Where to put a new screen"). Board and cleaning need the booth permission;
// the incident log needs access-assist and emergencies need emergency-respond.
const nav: AreaNavEntry[] = [
  {
    area: "ops",
    labelKey: "facilityStaff.nav.board",
    to: "/fasilitas",
    icon: ClipboardList,
    order: 20,
    anyPermission: ["facility.booth.operate"],
  },
  {
    area: "ops",
    labelKey: "facilityStaff.nav.cleaning",
    to: "/fasilitas/kebersihan",
    icon: SprayCan,
    order: 21,
    anyPermission: ["facility.booth.operate"],
  },
  {
    area: "ops",
    labelKey: "facilityStaff.nav.incidents",
    to: "/fasilitas/insiden",
    icon: ShieldAlert,
    order: 22,
    anyPermission: ["facility.access.assist"],
  },
  {
    area: "ops",
    labelKey: "facilityStaff.nav.emergency",
    to: "/fasilitas/darurat",
    icon: Siren,
    order: 23,
    anyPermission: ["facility.emergency.respond"],
  },
];

export default nav;
