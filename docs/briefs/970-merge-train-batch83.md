# 970 Merge train batch83
Peran: merge train (baca ~/.agents/team/roles/merge-train.md). Sonnet 5.5 high. Tidak ke `main`, tidak deploy, tidak force push.
Basis: `origin/milestone/m1` 1c185edc0 (batch82, migrasi ujung 0435). `git fetch` dan ambil tip terbaru tiap cabang sebelum menyusun; lewati yang sudah ancestor m1.
Isi (urut, maks 7):
1. `ghostex/baca-brief-memori-pg` 9203d4648 (S infra legend-3id81: PG test 1536m full/e2e, 1024m terarah). Full run batch ini = bukti memori; bila OOM, catat dan lapor.
2. `ghostex/baca-brief-flaky-created-at` aea2aa3b6 (S test legend-0l3v4)
3. `ghostex/0967e46a` 2be7cfd8d (S mock e2e legend-dq4y3: 36/38 pulih)
4. `ghostex/954-payout-so950-followups` f1a512f44 (K uang/migrasi payout: legend-628t9, e3m8d, lf0oj; migrasi kerja 0440)
5. `ghostex/60a93dca` d26caed3c (K uang/migrasi recon 958: legend-7uqbs, 3wwme; migrasi kerja 0436). Menggantikan `ghostex/rekonsiliasi-sisa-bank-dan-doit` (sudah termuat). JANGAN `ghostex/recon-refund-parsial-provider` (967 masih bekerja).
6. `ghostex/940-qr-va-sisa-p3` fbd0235e7 (K uang/migrasi legend-9vmit; migrasi kerja 0450 + 0450_snapshot.json, nomori lewat `scripts/migration-renumber.mjs`). Test cabang lain yang mengharapkan 409 untuk pilihan metode berbeda harus diubah ke perilaku Q15, bukan dilonggarkan.
7. `ghostex/ebc31074` fa79bcdd2 (K akses legend-ra1k0; tanpa migrasi; 951 sudah di m1)
Batch84 (jangan sekarang): `fix/966-scanner-suggestion`, `ghostex/4badcac8`, `ghostex/1a1b16fe` (955 masih bekerja), `ghostex/964-*` (belum SIAP). JANGAN `ws/edge-kds-stations`, `ghostex/5ce165c2`, `fix/e2e-m1-858`, `ghostex/duitku-fe-ws05`, `ghostex/pos-panel-bayar-sisa-5w6`.
Migrasi: nomori ulang berurutan dari 0436 sesuai urutan masuk; registry dan referensi test ikut nomor baru; `db:generate` kosong; `check-journal` hijau.
Gate: fast gate memuat test kontrak pemindai (`*-single-path*`, `*-contract*`, `*registry*`), text-contract, `tests/platform-*.test.mjs`, area payout/recon/refund/qr-va/ws03-guest-va/qris-hold-so879-a/promo/akses, lalu lint, typecheck, e2e produksi, build, FULL RUN wajib (uang + akses + migrasi). Satu job heavy sekaligus per thread (TEAM #14): full run dan e2e mock BERURUTAN, jangan bersamaan. Cek `ram-guard status` sebelum typecheck dan full run.
e2e mock: baseline batch82 = 40 gagal (38 legend-dq4y3 + legend-0z5k, legend-kmndq flake beban). Setelah 0967e46a masuk, harapan turun; hanya kegagalan baru di luar baseline yang menahan.
Gagal karena koneksi DB (`Connection terminated unexpectedly`, `57P03`, `in recovery mode`): rerun terarah berkas itu, catat jumlahnya (bukti untuk 3id81).
Setelah mendarat: tutup kartu yang semua AC-nya selesai (cek `bd show`), komentari SHA m1. Hapus worktree dan cabang int, `cleanup-ssd --repo` laporan (apply bila disk < 30 GB, tahan worktree thread yang masih bekerja). Edit `docs/merge-queue.md` di folder utama tanpa commit. PROGRESS batch83 ke m1.
Laporan: SHA m1, cabang masuk, peta nomor migrasi lama -> baru, gate per tahap (durasi), kartu ditutup, angka subagent (total, puncak, pemegang heavy). Lapor sekali di akhir.
