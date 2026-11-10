# Brief: engineer — dua kartu kecil: void per baris (ekxy2) + cek cuti saat absen (i46od)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Dua worktree terpisah:
- `ws/ekxy2-void-line` dari `origin/fix/codex-419-table-merge` (9e4155aa), di `.worktrees/ekxy2`.
- `ws/i46od-leave-clock` dari `origin/fix/codex-414-hris-attendance` (f0cbea6d), di `.worktrees/i46od`.

## Kartu
`legend-ekxy2`, `legend-i46od`. Di awal: `ghostex board associate <id>` + `bd update <id> --status in_progress`. Saat lapor: `--status review` (atau `bd close <id> --reason "<alasan>"` bila tidak perlu perubahan) + `bd comment`.

## Tujuan
- ekxy2: cek void tingkat item di `moveSessionItemsOperation` (table-session-operations.service.ts ~L1018-1024) membaca baris sebelum lock. Pertama pastikan apakah POS bisa membatalkan satu baris tanpa membatalkan order. Tidak bisa: tutup kartu dengan bukti (file:baris). Bisa: test gagal-dulu, lalu baca status baris dari set terkunci.
- i46od: temuan Codex 414 #1 (lihat `docs/briefs/416-*.md` dan laporan Codex 414 di `docs/` / bd comment legend-whiwv). Pastikan apakah maksudnya clock-in harus menolak/menandai karyawan yang sedang cuti. Tulis kesimpulan + rekomendasi di bd comment. Bila perilaku jelas salah dan perbaikannya kecil (<3 file): test gagal-dulu lalu fix. Bila butuh keputusan produk: jangan ubah kode, tulis pertanyaan untuk CTO dengan pilihan dan rekomendasi.

## Pembagian paralel (giliran pertama, satu giliran)
- 2 `Explore` (satu per kartu).
- Setelah itu bila ada perubahan: 1 `test-writer` + 1 `implementer` per kartu. Hanya satu subagent memegang token heavy (test/typecheck) pada satu waktu.
- Review: `reviewer` sonnet per diff.

## Scope
Hanya file service/test terkait dua kartu ini. Tanpa migrasi. Jangan sentuh modul uang.

## Bukti selesai
`LEGEND_TEST_FILES="<path src/test/...>" heavy pnpm test` lulus, `heavy pnpm --filter @starter/api typecheck` 0, gagal-dulu tercatat.

## Batas kerja ulang
typecheck gagal 2x: baca log heavy-fail lengkap, betulkan semua sekaligus; gagal ke-3 lapor. Jangan pkill. Jam dari `date '+%H:%M'`.

## Sebelum melapor
Commit + push cabang kerja (hanya bila ada perubahan). Hapus worktree yang bersih.

## Laporan
Per kartu: kesimpulan, bukti, sha, temuan review. Subagent: total, puncak bersamaan, siapa memegang token heavy.
