# Brief: engineer (Codex) — e2e mock koreksi POS merah di milestone (legend-jemae)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b fix/e2e-pos-corrections .worktrees/e2e-pos-corrections origin/milestone/m1`.

## Tujuan
Spec e2e mock koreksi POS `mzg`, `rx0h`, `sgg` gagal 6 test, identik di base b17554cb9 dan di tip batch61 70f90cecd (`nv3y`, `ogx3` lulus). Reproduksi satu spec dulu (`heavy pnpm test:e2e:mock e2e/<spec>`), cari akar masalah (selector usang vs teks UI, mock API yang berubah, atau bug nyata di layar). Bila bug nyata di aplikasi yang menyentuh uang (koreksi/void/refund), JANGAN ubah logika uang: laporkan dengan bukti. Bila test usang, perbaiki test agar mengikuti perilaku yang benar, bukan melonggarkan pemeriksaan.

## Bukti, sebelum melapor
Ketiga spec hijau lewat `heavy` (atau alasan jelas per test yang tetap merah), pra-gate AGENTS.md pada file yang diubah. Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/e2e-pos-corrections` tanpa force. Jangan merge, jangan deploy.
