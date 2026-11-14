# Brief: engineer (Codex) — ringkasan finance exceptions: jumlah nilai diketahui (legend-j4xdb)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri: `git worktree add -b fix/finance-exceptions-known-count .worktrees/finance-exceptions-known-count origin/milestone/m1`.

## Tujuan
Ringkasan finance exceptions memakai `COALESCE(..., 0)` untuk `amountIdr`, jadi Rp0 ambigu bila semua item jenis itu bernilai null. Tambahkan `knownAmountCount` per jenis di respons ringkasan (service, DTO di `packages/shared/src/types/api.ts`), tanpa mengubah nilai yang sudah ada. Hanya laporan baca, tidak mengubah uang. Tanpa migrasi; bila ternyata butuh migrasi atau mengubah aliran uang, berhenti dan laporkan. UI (cabang `ui/payout-finance-exceptions`) belum memakai field ini: jangan ubah UI, cukup catat di laporan.

## Bukti, sebelum melapor
Test API gagal-dulu (semua null, campuran, semua diketahui), test terarah hijau lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck api dan web lewat `heavy` karena shared berubah). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/finance-exceptions-known-count` tanpa force. Jangan merge, jangan deploy.
