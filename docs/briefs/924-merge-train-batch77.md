# 924 Merge train batch77 (rantai payout 911-923)
Peran: merge train (baca ~/.agents/team/roles/merge-train.md). Codex gpt-6.1-sol high. Tidak ke `main`, tidak deploy, tidak force push.
Basis: `origin/milestone/m1` 650ef5c78. Ambil tip terbaru.
Isi: `ghostex/923-payout-deadlock-lock-order` d289f5255 (memuat 915 cbc98a31f, 918 ffd47408f, 920 d06e5a269, 923; 911 sudah di m1). Migrasi sementara 0658-0663 dinomori ulang mulai 0425; periksa rechain snapshot dan `db:generate` kosong. Boleh tambah cabang siap lain dari `docs/merge-queue.md` yang tidak bentrok, total maks 7; jangan `fix/e2e-m1-858`.
Penting: API kini butuh `PAYOUT_GRANTOR_DATABASE_URL` (login `legend_payout_grantor`); pastikan setup test/e2e/dev:prepare dan `.env.example` sudah memuatnya, jangan cetak nilai rahasia.
Gate (Retro 36/37): fast gate WAJIB memuat test kontrak pemindai (`*-single-path*`, `*-contract*`, `*registry*`) dan semua test payout/payroll/finance-exception, lalu lint, typecheck, e2e, build, dan full run lewat heavy. Kegagalan yang menyentuh uang: lapor ke CTO sebelum mendarat.
Setelah mendarat: komentari SHA m1 di legend-i01jp, legend-xp8mc, legend-yd9u2, legend-l2zru, legend-05gpk, legend-ijaxi (jangan tutup ijaxi dan xp8mc). Tutup kartu yang brief 911-923 nyatakan selesai (cek `bd show`). Hapus worktree dan cabang int. Edit `docs/merge-queue.md` di folder utama tanpa commit. PROGRESS batch77 ke m1.
Laporan: SHA m1, cabang masuk, peta migrasi, gate, perbaikan test, kartu ditutup, angka subagent.
