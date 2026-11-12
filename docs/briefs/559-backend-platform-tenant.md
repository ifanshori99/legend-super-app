# 559 Backend platform tenant (UI U5a disetujui)
Peran: engineer (~/.agents/team/roles/engineer.md). UI U5a disetujui founder 12 Nov.
Kartu: legend-co93l (baca Owner tenant + cari akun untuk assign/replace Owner; DTO tenant memuat Owner/assignmentId), legend-utnll (daftar brand, outlet, badan hukum per tenant untuk staf platform, bukan lewat tenant sesi). Baca `bd show` dan UI di origin/ui/backoffice-platform (tenant-detail-page.tsx, panel Owner).
Worktree: `git worktree add .worktrees/platform-tenant-be -b ws/platform-tenant-be origin/milestone/m1`. Migrasi 0397-0399 bila perlu.
Tingkat K (akses lintas tenant, data pribadi): hanya peran platform dengan izin eksplisit; pencarian akun membatasi hasil dan field (tanpa hash/token, email tersamar bila perlu), rate limit, audit tiap pencarian dan pembacaan. Test: user tenant biasa 403/404, staf support read-only tidak bisa assign, tenant lain tidak bocor.
Jangan sentuh UI (apps/web) kecuali tipe di packages/shared. Jangan sentuh payroll, akuntansi, CRM, inventory, HRIS, operations, kasir.
Paralel: Explore, test-writer, implementer per kartu, reviewer akhir. Test gagal-dulu, test terarah lewat `heavy`, tsc api/shared, eslint/prettier, `db:generate` kosong. Commit per kartu, jangan merge. Lapor dengan angka subagent dan yang belum diuji.
