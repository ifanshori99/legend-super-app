// Menu items of the attendance screens (collected by lib/areas/nav-registry).
// `anyPermission` only hides the items; the page guard and the API decide
// access.
import { QrCode, ScanFace } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "attendanceQr.nav.qrDisplay",
    to: "/kelola/absensi/qr",
    icon: QrCode,
    order: 30,
    group: "team",
    anyPermission: ["hr.attendance.manage"],
  },
  {
    area: "kelola",
    labelKey: "attendanceQr.nav.selfieReview",
    to: "/kelola/absensi/selfie",
    icon: ScanFace,
    order: 40,
    group: "team",
    anyPermission: ["hr.attendance.manage"],
  },
];

export default nav;
