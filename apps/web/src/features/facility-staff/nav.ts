import { ClipboardList, ShieldAlert, Siren, SprayCan } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

// Staff facility surfaces (PRD v1.7 §3 F25 "Siklus Kebersihan" +
// "Keselamatan"; the area is "ops", URL prefix /fasilitas per docs/frontend.md
// "Where to put a new screen"). Board and cleaning need the booth permission;
// the incident log needs access-assist and emergencies need emergency-respond.
const nav: AreaNavEntry[] = [
  {
    area: "ops",
    labelKey: "nav.ops.facilityBoard",
    to: "/fasilitas",
    icon: ClipboardList,
    order: 20,
    showerOnly: true,
    anyPermission: ["facility.booth.operate"],
  },
  {
    area: "ops",
    labelKey: "nav.ops.facilityCleaning",
    to: "/fasilitas/kebersihan",
    icon: SprayCan,
    order: 21,
    showerOnly: true,
    anyPermission: ["facility.booth.operate"],
  },
  {
    area: "ops",
    labelKey: "nav.ops.facilityIncidents",
    to: "/fasilitas/insiden",
    icon: ShieldAlert,
    order: 22,
    showerOnly: true,
    anyPermission: ["facility.access.assist"],
  },
  {
    area: "ops",
    labelKey: "nav.ops.facilityEmergency",
    to: "/fasilitas/darurat",
    icon: Siren,
    order: 23,
    anyPermission: ["facility.emergency.respond"],
  },
];

export default nav;
