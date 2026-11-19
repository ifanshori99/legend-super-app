// Menu items of the attendance screens (collected by lib/areas/nav-registry).
// `anyPermission` only hides the items; the page guard and the API decide
// access.
import { QrCode, ScanFace } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "kelola",
    labelKey: "nav.management.attendanceQrDisplay",
    to: "/kelola/absensi/qr",
    icon: QrCode,
    order: 30,
    group: "team",
    anyPermission: ["hr.attendance.manage"],
    outletScopedPaths: ["/kelola/absensi/qr"],
  },
  {
    area: "kelola",
    labelKey: "nav.management.attendanceSelfieReview",
    to: "/kelola/absensi/selfie",
    icon: ScanFace,
    order: 40,
    group: "team",
    anyPermission: ["hr.attendance.manage"],
    outletScopedPaths: ["/kelola/absensi/selfie"],
  },
];

export default nav;
