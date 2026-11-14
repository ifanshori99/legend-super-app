# Brief: engineer (Codex) — test penuh mati SIGTERM ~63 menit (legend-w3qxp)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b fix/full-suite-sigterm .worktrees/full-suite-sigterm milestone/m1`.

## Tujuan
`heavy pnpm test` penuh (1052 file) di merge train batch61 mati SIGTERM tiga kali di sekitar menit 63, tanpa test gagal, baru separuh file. Cari akar masalah dulu, baru perbaiki. Tersangka (cek, jangan asumsikan): batas waktu di wrapper `heavy` atau kuncinya (`~/.claude/scripts/`), timeout turbo/vitest/script `pnpm test` di repo, hook atau ram-guard yang mematikan proses panjang, atau disk penuh (Mac sempat ENOSPC 14 Nov sekitar 07:20). Baca log run yang mati bila ada (tanya lokasinya di laporan bila tidak ketemu).

Jangan jalankan suite penuh sendiri (merge train sedang memakainya). Boleh membuktikan dengan run kecil buatan (mis. perintah `sleep` di bawah `heavy` dengan batas yang sama) atau dengan membaca kode. Bila akar masalah di skrip `~/.claude/scripts/` (di luar repo), jangan ubah: tulis usulan diff di laporan. Bila di repo, perbaiki di cabang ini dan tambahkan test atau bukti.

## Bukti, sebelum melapor
Akar masalah dengan bukti (baris kode atau reproduksi kecil), perbaikan atau usulan, pra-gate AGENTS.md untuk file repo yang diubah. Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/full-suite-sigterm` tanpa force bila ada perubahan. Jangan merge, jangan deploy.
