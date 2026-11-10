# Brief: engineer (Sonnet) — triase kartu siap P0-P2 (baca saja)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`. Tugas ini hanya membaca kode dan mengubah status/komentar kartu: tidak ada perubahan kode, tidak ada commit.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Basis kode: `milestone/m1` 4c818489 (`git show 4c818489:<path>`, `git merge-base --is-ancestor`). Jangan checkout di folder utama.

## Masalah
`bd ready` berisi ~400 kartu. Banyak yang sebenarnya sudah selesai di m1 dan hanya menunggu second opinion Codex (contoh: legend-6p71, legend-6q7o), atau berstatus EXT (butuh akun/kunci founder), atau FE yang menunggu gerbang mockup/UI. CTO butuh daftar kerja nyata yang bisa langsung dimulai.

## Langkah
1. `bd ready --json` (atau `bd ready --limit 500`), ambil P0-P2 non-epic.
2. Kelompokkan, paralel dengan subagent `Explore` (maks 6, satu per area WS), tiap prompt merujuk brief ini:
   - (A) Sudah di m1, hanya menunggu Codex: `bd update <id> --status review` + `bd comment <id> "Triase 9 Nov: fix di m1 <sha/file:baris>; tunggu second-opinion Codex area <area>"`. Jangan menutup kartu.
   - (B) EXT / butuh founder (akun, kunci, kontrak vendor): label `needs-founder` (`bd label add <id> needs-founder`).
   - (C) FE/UI yang menunggu gerbang mockup atau review UI founder: label `gate-ui`.
   - (D) Siap dikerjakan backend/infra sekarang: catat ukuran (S/M/L), tingkat K/S, berkas utama, ketergantungan, dan apakah Sonnet cukup.
3. Tulis `docs/briefs/245-triage-result.md` (folder utama, tidak di-commit): tabel D terurut (P lalu dampak), kelompok yang bisa paralel tanpa bertumpuk berkas, dan jumlah kartu per kelompok A/B/C/D.

## Laporan
Sekali: jumlah per kelompok, 10 kartu D teratas (id, judul singkat, ukuran, K/S, model), kartu yang perlu keputusan founder, jumlah subagent.
