# 932 Merge train batch80 (KDS stations r2)
Peran: merge train (baca ~/.agents/team/roles/merge-train.md). Codex gpt-6.1-sol high. Tidak ke `main`, tidak deploy, tidak force push.
Basis: `origin/milestone/m1` 70bba542d. Ambil tip terbaru.
Isi: `ws/edge-kds-stations-r2` 91c7f9d8b (legend-i78o6, legend-40nvj; protokol v3 field opsional + resync sekali per revisi). Migrasi sementara 0431 device_scanner_status: nomori dari ujung m1, rechain snapshot, `db:generate` kosong. Boleh tambah cabang SIAP lain di `docs/merge-queue.md` (cek ancestry), total maks 7. JANGAN `ws/edge-kds-stations`, `ghostex/5ce165c2`, `fix/e2e-m1-858`.
Gate (Retro 36/37): fast gate memuat test kontrak pemindai (`*-single-path*`, `*-contract*`, `*registry*`), text-contract, area edge/KDS/catalog/heartbeat, lalu lint, typecheck, e2e, build, full run lewat heavy. Lint/format sepele: betulkan sendiri satu commit chore. Masalah mount Colima: relokasi worktree seperti batch79.
Setelah mendarat: tutup legend-i78o6, legend-40nvj bila semua AC selesai (cek `bd show`), komentari SHA m1. Hapus worktree dan cabang int. Edit `docs/merge-queue.md` di folder utama tanpa commit. PROGRESS batch80 ke m1.
Laporan: SHA m1, cabang masuk, peta migrasi, gate, kartu ditutup, angka subagent.
