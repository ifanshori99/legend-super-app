import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { EmployeeHome } from "@/features/ws10-hris-employee/components/employee-home";

// "/karyawan" — Beranda HRIS karyawan (PRD v1.7 §3 Kelompok D 33 "Beranda":
// jadwal hari ini, tombol absen, pengajuan berjalan, pengumuman). The area
// layout supplies the Customer shell (Hangat), the guard and the PWA manifest.
const t = createTranslator();

export const Route = createFileRoute("/_karyawan/karyawan/")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("area.karyawan.name"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: EmployeeHome,
});
