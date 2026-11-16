# 943 Merge train batch81
Peran: merge train (baca ~/.agents/team/roles/merge-train.md). Sonnet 5.5 high. Tidak ke `main`, tidak deploy, tidak force push.
Basis: `origin/milestone/m1` c17c60df7 (batch80). Ambil tip terbaru (`git fetch`) sebelum menyusun.
Isi (urut, semua tanpa migrasi; cek ancestry dan tip terbaru):
1. `ghostex/bf531619` 784facadd (legend-0cnqt outbox ekspor pajak + i18n)
2. `fix/938-loyalty-current-metrics` 7d173a189 (legend-eqdcd active_members)
3. `ghostex/935-foto-penerimaan-stale-edge` 8a661cd90 (K akses: legend-iy5l0 foto, legend-5v7oq purpose/umur, legend-2lgu batas basi edge; deploy API+web bersamaan)
4. `ghostex/160d3d37` 825123713 (legend-xtj5t test 923 saja)
Boleh tambah cabang SIAP lain di `docs/merge-queue.md` (cek ancestry), total maks 7. JANGAN `ws/edge-kds-stations`, `ghostex/5ce165c2`, `fix/e2e-m1-858`.
Gate: fast gate memuat test kontrak pemindai (`*-single-path*`, `*-contract*`, `*registry*`), text-contract, area pajak/loyalty/storage-foto/edge/payout, lalu lint, typecheck, e2e, build, FULL RUN wajib (935 menyentuh akses) lewat heavy. Cek `ram-guard status` sebelum typecheck. Lint/format sepele: betulkan sendiri satu commit chore. Masalah mount Colima: relokasi worktree seperti batch79.
Setelah mendarat: tutup kartu di atas bila semua AC selesai (cek `bd show`; legend-2lgu cek dulu, alert ke cloud ada di legend-uvnll), komentari SHA m1. Hapus worktree dan cabang int, `cleanup-ssd --repo` laporan (apply bila disk < 30 GB, tahan worktree thread lain). Edit `docs/merge-queue.md` di folder utama tanpa commit. PROGRESS batch81 ke m1.
Laporan: SHA m1, cabang masuk, gate per tahap (durasi), kartu ditutup, angka subagent (total, puncak, pemegang heavy).
