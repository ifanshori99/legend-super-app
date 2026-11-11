# Brief: engineer — konfirmasi login WA wajib + "Bukan saya" rapikan akun otomatis (legend-lnbtp)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang `ws/lnbtp-wa-confirm-required` dari `origin/ws/kmndq-wa-login-confirm` (f6fc4d01: UI konfirmasi yang sudah disetujui founder, di atas ws/w8dfz1-wa-masked) di `.worktrees/lnbtp`.

## Kartu
`legend-lnbtp` (`bd show legend-lnbtp`, baca deskripsi + komentar). Awal: `ghostex board associate legend-lnbtp` + `bd update legend-lnbtp --status in_progress`. Lapor: `--status review` + `bd comment`.

## Tujuan
1. Codex P1 (`apps/api/src/routes/identity-auth.routes.ts:103`): `requireConfirm` wajib untuk SEMUA login WA (klien tidak bisa mematikannya; nilai false/absen diperlakukan true atau ditolak sesuai kontrak). Sesi hanya dibuat setelah confirm.
2. "Bukan saya": batalkan tantangan + jangan kirim balasan WA "berhasil"; akun yang dibuat otomatis untuk pengirim pada tantangan itu dirapikan (hapus/nonaktifkan bila belum pernah dipakai; jangan sentuh akun yang sudah ada sebelumnya).
3. Test balapan cancel vs poll/confirm (dua permintaan bersamaan): tidak ada sesi tercipta setelah cancel.
4. Web (f6fc4d01) sudah mengirim `requireConfirm: true`; pastikan e2e mock kmndq tetap lulus.

## Pembagian paralel (giliran pertama, satu giliran)
- 2 `Explore` (alur tantangan login WA + pembuatan akun otomatis; balasan WA keluar) + 1 `test-writer` (gagal-dulu, vitest backend).
- Lalu `implementer` (maks 2). Satu token heavy per thread.
- Review: tingkat K (akses) -> satu subagent `architect` effort xhigh.

## Scope
API identitas/login WA + test. Migrasi bila wajib: nomor sementara 0279. Catatan: 0274/0275 sementara di cabang dasar, snapshot drizzle dibuat merge train.

## Bukti selesai
`LEGEND_TEST_FILES="<src/test/...>" heavy pnpm test` lulus; `NODE_OPTIONS=--max-old-space-size=6144 heavy pnpm --filter @starter/api typecheck` 0; web typecheck 0; gagal-dulu tercatat.

## Batas kerja ulang
typecheck gagal 2x: baca log heavy-fail lengkap, betulkan semua sekaligus; gagal ke-3 lapor. Jangan pkill. Jam dari `date '+%H:%M'`.

## Sebelum melapor
Commit + push. Hapus worktree yang bersih.

## Laporan
Hasil, bukti, sha, temuan architect. Subagent: total, puncak bersamaan, pemegang token heavy.
