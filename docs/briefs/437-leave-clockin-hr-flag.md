# Brief: engineer — absen masuk saat cuti disetujui: izinkan + tandai HR (legend-9y6ri)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang `ws/9y6ri-leave-clockin-flag` dari `origin/milestone/m1` terbaru di `.worktrees/9y6ri`. Bila `origin/fix/codex-414-hris-attendance` (f0cbea6d) belum ada di m1, basiskan dari cabang itu (berisi perbaikan absensi terbaru).

## Kartu
`legend-9y6ri` (`bd show legend-9y6ri`). Awal: `ghostex board associate legend-9y6ri` + `bd update legend-9y6ri --status in_progress`. Lapor: `--status review` + `bd comment`.

## Tujuan (keputusan founder W8 Q21)
Karyawan dengan cuti disetujui di hari itu tetap boleh clock-in. Absensi itu ditandai untuk ditinjau HR (alasan jelas, terlihat di daftar tinjauan HR yang sudah ada; bila belum ada tempat, tambahkan di respons API daftar absensi HR). Cuti TIDAK otomatis dibatalkan; saldo cuti dan payroll tidak berubah sampai HR memutuskan. Aturan "jangan sampai rugi": test membuktikan tidak ada bayaran ganda (cuti berbayar + hadir) tanpa keputusan HR. Aksi HR: tetap cuti / batalkan cuti (kembalikan saldo) — pakai pola persetujuan yang sudah ada; bila butuh layar baru, berhenti setelah API dan tulis usulan UI.

## Pembagian paralel (giliran pertama, satu giliran)
- 2 `Explore` (alur clock-in + validasi cuti; payroll/saldo cuti dan tinjauan HR) + 1 `test-writer` (gagal-dulu, vitest backend).
- Lalu `implementer` (maks 2). Satu token heavy per thread.
- Review: tingkat K (gaji) -> satu subagent `architect` effort xhigh.

## Scope
Absensi, cuti, flag HR, test. Migrasi bila wajib: nomor sementara 0276.

## Bukti selesai
`LEGEND_TEST_FILES="<src/test/...>" heavy pnpm test` lulus; `NODE_OPTIONS=--max-old-space-size=6144 heavy pnpm --filter @starter/api typecheck` 0; gagal-dulu tercatat.

## Batas kerja ulang
typecheck gagal 2x: baca log heavy-fail lengkap, betulkan semua sekaligus; gagal ke-3 lapor. Jangan pkill. Jam dari `date '+%H:%M'`.

## Sebelum melapor
Commit + push. Hapus worktree yang bersih.

## Laporan
Hasil, bukti, sha, temuan architect, usulan UI (bila ada). Subagent: total, puncak bersamaan, pemegang token heavy.
