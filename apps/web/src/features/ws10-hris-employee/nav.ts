// Menu items of the employee PWA in the karyawan area (PRD §3 Kelompok D 33
// "Fitur: Absen, jadwal, ..."). The area index is the Beranda; only the two
// attendance screens exist so far, so the bottom nav stays at three items.
import { CalendarClock, Clock } from "lucide-react";
import type { AreaNavEntry } from "@/lib/areas/nav";

const nav: AreaNavEntry[] = [
  {
    area: "karyawan",
    labelKey: "nav.karyawan.attendance",
    to: "/karyawan/absensi",
    icon: Clock,
    order: 10,
    anyPermission: ["self.attendance.clock"],
  },
  {
    area: "karyawan",
    labelKey: "nav.karyawan.history",
    to: "/karyawan/absensi/riwayat",
    icon: CalendarClock,
    order: 20,
    anyPermission: ["self.attendance.clock"],
  },
];

export default nav;
