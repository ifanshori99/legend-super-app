# 804 Cuti: create dan upload lampiran cek izin di outlet cuti (tingkat K, akses)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Kartu legend-bkd76 (`bd show legend-bkd76`, `bd update legend-bkd76 --claim`).
Basis: worktree dari `origin/fix/leave-attachment-active-permission` (f161bcca7). Cabang `fix/leave-create-outlet-permission`.
Masalah: create cuti dan upload lampiran cuti hanya cek `self.leave.request` di outlet mana pun, bukan outlet cuti. Sesudah 794, pengaju dengan izin hanya di outlet lain bisa mengajukan cuti + lampiran tetapi `attachmentUrl` null, bahkan di respons create pertama. Samakan: create dan upload butuh `self.leave.request` aktif di outlet cuti itu (aturan sama dengan `canReadLeave` dan `presentRequest`).
Paralel: Explore (jalur create, upload, replay offline mobile), test-writer (gagal-dulu: izin hanya di outlet lain ditolak dengan 403 jelas; izin di outlet cuti boleh dan respons create memuat link), implementer.
Tanpa migrasi. Jangan sentuh panik, edge, DOIT, payout, storage scanner.
Selesai: test terarah lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck API), satu subagent architect effort xhigh atas diff, commit, push, komentar SHA di kartu. Laporan: SHA, test, hasil architect, angka subagent (total, puncak, pemegang token heavy). Jangan merge ke m1.
