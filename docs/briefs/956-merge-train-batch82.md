# 956 Merge train batch82
Peran: merge train (baca ~/.agents/team/roles/merge-train.md). Sonnet 5.5 high. Tidak ke `main`, tidak deploy, tidak force push.
Basis: `origin/milestone/m1` 0c31ff40e (batch81, migrasi ujung 0431). `git fetch` dan ambil tip terbaru tiap cabang sebelum menyusun.
Isi (urut; cek ancestry dan tip terbaru):
1. `ghostex/947-payout-934-followups` aca164ca5 (K uang: payout 934+947; migrasi kerja 0432-0433)
2. `ghostex/a46177dd` a3f7af1a1 (K akses: 946 batas basi edge, tanpa migrasi; basis 935 sudah di m1)
3. `ghostex/ws-01-pengerasan-akses-951` b4f260a98 (K akses: WS-01, migrasi kerja 0473)
4. `ghostex/ba6c8a6b` cdec4ae29 (K uang/migrasi: payroll WS-10, migrasi kerja 0460; menyentuh apps/web ws10-payroll-run)
Tambahan hanya bila sudah tertulis SIAP di `docs/merge-queue.md` saat kamu menyusun: `ghostex/940-qr-va-sisa-p3` (tip terbaru setelah 9vmit) dan `ghostex/952-recon-so-fix` (menggantikan `ghostex/rekonsiliasi-sisa-bank-dan-doit`). Total maks 7. JANGAN `ws/edge-kds-stations`, `ghostex/5ce165c2`, `fix/e2e-m1-858`, cabang pos-panel 936.
Migrasi: nomori ulang berurutan dari 0432 sesuai urutan masuk; registry dan referensi test ikut nomor baru; `db:generate` kosong.
Gate: fast gate memuat test kontrak pemindai (`*-single-path*`, `*-contract*`, `*registry*`), text-contract, `tests/platform-*.test.mjs`, area payout/payroll/edge/device/staff-pins/akses/QR, lalu lint, typecheck, e2e produksi, build, FULL RUN wajib (akses + uang + migrasi) lewat heavy. Cek `ram-guard status` sebelum typecheck dan full run.
e2e mock: 38 gagal sudah ada di m1 (legend-dq4y3, sedang dibetulkan thread 953). Bandingkan daftar gagal dengan baseline `docs/briefs/953-m1-mock-e2e-38.md`; hanya kegagalan baru yang menahan. `pnpm run test:e2e:mock -- <berkas>` tidak memfilter berkas; jangan dipakai untuk run terarah.
Gagal karena koneksi DB (`Connection terminated unexpectedly`, `57P03`): rerun terarah berkas itu, catat.
Setelah mendarat: tutup kartu yang semua AC-nya selesai (cek `bd show`), komentari SHA m1. Hapus worktree dan cabang int, `cleanup-ssd --repo` laporan (apply bila disk < 30 GB, tahan worktree thread yang masih bekerja). Edit `docs/merge-queue.md` di folder utama tanpa commit. PROGRESS batch82 ke m1.
Laporan: SHA m1, cabang masuk, peta nomor migrasi lama -> baru, gate per tahap (durasi), kartu ditutup, angka subagent (total, puncak, pemegang heavy). Lapor sekali di akhir.
