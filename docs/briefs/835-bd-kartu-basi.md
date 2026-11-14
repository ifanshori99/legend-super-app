# Brief: engineer — bersihkan kartu basi di bd dan susun gelombang berikut

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Tanpa mengubah kode, tanpa worktree baru (disk tipis).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend` (repo utama, hanya baca git + `bd`). Contoh laporan lama: `docs/qa/2026-11-09-bd-stale-cleanup.md`.

## Tujuan
`bd ready` menampilkan ~358 kartu, banyak sudah dikerjakan (contoh: legend-mm029/oi7ub/po3fe/ewmfd/aagpf di 10a196bc1, legend-xzzdq/l5tvy di 0ac8e3b7c, legend-yhia9 di 1275f0123). Untuk tiap kartu non-epic, non-EXT: cek `git log --all --grep <id>` dan apakah commit itu sudah di `origin/milestone/m1` (`git merge-base --is-ancestor`).
- Sudah di m1: `bd close <id> --reason "<sha> di m1"`.
- Ada commit tapi belum di m1: jangan tutup; daftar di laporan dengan cabangnya.
- Tanpa commit: biarkan.

## Pembagian paralel
4 Explore membagi daftar kartu per prefix workstream (WS-01..WS-13 dan bug lepas); satu subagent saja yang menjalankan `bd close`.

## Bukti selesai
- `docs/qa/2026-11-15-bd-stale-cleanup.md`: jumlah ditutup, daftar "commit belum di m1" (id, cabang, sha), dan 3 sampai 5 usulan area gelombang berikut (tiap area 3-6 kartu yang benar-benar belum dikerjakan, file terpisah, tandai yang butuh gerbang founder/mockup). Commit lokal file itu saja.
- Laporan berisi angka subagent.
