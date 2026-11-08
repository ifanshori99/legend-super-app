# Brief: engineer kecil — tes flaky TOTP 422 (legend-0fa6)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md`, lalu ikuti.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/totp-flaky`, cabang `fix/totp-flaky` (dari `main` terbaru, sudah berisi fix fixture tenant c9e0c62). Jangan pindah cabang.

## Tujuan
`enrollAndVerify` di `apps/api/src/test/identity-surface-api*.test.ts` dan `platform-org-api.test.ts` kadang 422 di langkah verifikasi TOTP saat `pnpm check` penuh, lulus saat diulang. Cari akar masalah (batas jendela waktu 30 detik? kode dipakai ulang? state bersama?), betulkan tanpa melemahkan assertion. Detail: `bd show legend-0fa6`.

## Kartu
`legend-0fa6`. Di awal: `ghostex board associate legend-0fa6` dan `bd update legend-0fa6 --status in_progress`. Saat melapor: `bd update legend-0fa6 --status review` dan `bd comment legend-0fa6 "<ringkasan>"`.

## Scope
File test dan helper test. Kode produk hanya bila akar masalah memang di sana (sebut di laporan).

## Bukti selesai
- Jelaskan mekanisme gagal dengan bukti (reproduksi, misalnya pin jam di batas jendela TOTP).
- File test terkait 5x lewat filter vitest + satu `heavy pnpm check` penuh. Jangan ulang suite penuh berkali-kali (jalur heavy dipakai agent lain).
- `pnpm format:check` lulus, `git status` bersih. Commit lokal merujuk legend-0fa6. Jangan push/merge.

## Laporan
Akar masalah, fix, bukti.
