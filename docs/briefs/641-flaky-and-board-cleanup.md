# Brief: engineer — dua test flaky + rapikan kartu yang sudah selesai

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Dua bagian independen: jalankan paralel (subagent).

## Bagian A: test flaky (gerbang penuh belum pernah hijau dalam satu run)
Worktree baru dari `milestone/m1` (a2234853d): `git worktree add .worktrees/flaky-641 -b fix/flaky-641 milestone/m1`, `pnpm worktree:setup`.
- `legend-gcdq0`: panic-relay EM-19 Q94 gagal saat berjalan bersama test lain (batch55 dan batch56), hijau sendirian. Buat tidak bergantung beban (fake timer / tunggu kondisi, bukan jeda waktu). Jangan ubah perilaku produksi tanpa lapor CTO.
- `legend-x778h`: audit-retention gagal saat run penuh, hijau sendirian. Cari akar (data bersama, jam, urutan), perbaiki di test bila akarnya di test.
Bukti: tiap berkas lulus 3x berturut lewat `heavy` (LEGEND_TEST_FILES), juga dijalankan bersamaan berdua. Push cabang, `bd update --status review` + `bd comment`.

## Bagian B: rapikan kartu (hanya bd, tanpa kode)
Sekitar 54 kartu open yang commit-nya sudah ada di `milestone/m1`. Untuk tiap kartu open/in_progress: cek `git log milestone/m1 --grep <id>` dan isi commit. Tutup (`bd close <id> --reason "di m1 <sha>"`) hanya bila pekerjaannya utuh di m1; yang sebagian: `bd comment` apa yang tersisa, biarkan open. Jangan tutup kartu yang hanya ada di cabang belum merge. Lapor: jumlah ditutup, daftar kartu sebagian, dan jumlah `bd ready` sebelum/sesudah.

## Batas
Jangan merge ke m1/main, jangan deploy, jangan `pkill`. Hemat token.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
