# 927 Merge train batch78 (test/CI)
Peran: merge train (baca ~/.agents/team/roles/merge-train.md). Codex gpt-6.1-sol high. Tidak ke `main`, tidak deploy, tidak force push.
Basis: `origin/milestone/m1` 7b7cc52df. Ambil tip terbaru.
Isi: `fix/925-ci-grantor-withdraw-flake` 953effb41, `fix/e2e-m1-858-r2` c12914ea6. Tambah cabang SIAP lain dari "Urutan prioritas" di `docs/merge-queue.md` yang tidak bentrok, total maks 7 (utamakan uang/rilis). Jangan `fix/e2e-m1-858` lama.
Gate (Retro 36/37): fast gate memuat test kontrak pemindai (`*-single-path*`, `*-contract*`, `*registry*`) + area yang tersentuh, lalu lint, typecheck, e2e, build, full run lewat heavy. Lint/format sepele dari sumber: betulkan sendiri dalam satu commit chore.
Setelah mendarat: tutup legend-kj50i, legend-61umg, kartu 858 yang dinyatakan selesai (cek `bd show`), komentari SHA m1. Hapus worktree dan cabang int. Edit `docs/merge-queue.md` di folder utama tanpa commit. PROGRESS batch78 ke m1.
Laporan: SHA m1, cabang masuk, migrasi, gate, kartu ditutup, angka subagent.
