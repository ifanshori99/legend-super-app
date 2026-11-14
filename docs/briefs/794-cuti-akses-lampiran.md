# 794 Lampiran cuti: pengaju butuh izin aktif (tingkat K, akses)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Kartu legend-9ujp5 (`bd show legend-9ujp5`, `bd update legend-9ujp5 --claim`).
Basis: worktree dari `origin/ghostex/upload-foto-fasilitas-sungguhan` (b961fdcc7, aturan pemilik 792 sudah ada di sana; lihat `docs/briefs/792-foto-fasilitas-akses-baca.md`). Cabang `fix/leave-attachment-active-permission`.
Masalah: `canReadLeave` meloloskan `leave.userId === actorUserId` tanpa cek izin aktif, jadi karyawan yang izinnya dicabut masih dapat signed URL lampiran cuti. Aturan: pengaju butuh `self.leave.request` aktif, atau `hr.leave.approve` di outlet itu. Samakan pola dengan aturan pemilik 792.
Paralel: Explore (letak canReadLeave dan pola 792), test-writer (test gagal-dulu: izin dicabut ditolak, pengaju aktif boleh, approver outlet lain ditolak), implementer.
Tanpa migrasi. Jangan sentuh area panik, edge, DOIT, payout.
Selesai: test terarah lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck API), satu subagent architect effort xhigh atas diff, temuan nyata dibetulkan, commit, push cabang, komentar SHA di kartu. Laporan: SHA, test, hasil architect, angka subagent (total, puncak, pemegang token heavy). Jangan merge ke m1, jangan deploy.
