# Brief: engineer — tolak DB edge hasil restore/clone yang mundur waktu (legend-a9iby)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/edge-link-restored-db` dari `integ/m1-batch31` (d7a95d0c, sudah memuat e7dad52d). Worktree `.worktrees/edge-link-restored-db`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-a9iby` (P2, tingkat K: offline sync). Detail: `docs/briefs/215b-second-opinion-edge-link-instance-resume.result-architect.md`. Reviewer kedua (`.result-architect2.md`) menyebut bersih, jadi reproduksi dulu.
Klaim: restore/clone DB edge mempertahankan `instance_id`, sehingga `bindPeer` (`apps/api/src/edge/db-link-store.ts`) meloloskannya; di `apps/api/src/edge/link-peer.ts:285-293`, begitu antrean edge menyusul cursor cloud, cursor cloud dianggap ack, dan event baru sesudah restore dengan nomor urut di bawah/sama dengan cursor itu tidak pernah dikirim. `docs/deployment.md` butir 5 mengklaim cloud menolak dengan close 1008, padahal hanya bila instance berbeda.
- Bila terbukti: di `bindPeer`, tolak tanpa menulis apa pun saat cursor hello edge di bawah `acked_out_seq` cloud dikurangi offset (DB edge mundur waktu), dengan kode/pesan yang jelas untuk operator dan langkah pemulihan di runbook. Perbaiki teks `docs/deployment.md` butir 5, termasuk kasus outlet tanpa QR yang dicatat reviewer kedua (P3).
- Bila tidak terbukti: test yang membuktikan, komentar di kartu.

## Kartu
`legend-a9iby`. Di awal: `bd update legend-a9iby --status in_progress`. Saat melapor: `bd update legend-a9iby --status review` dan `bd comment legend-a9iby "<ringkasan>"`.

## Scope
Boleh: `apps/api/src/edge/db-link-store.ts`, `link-peer.ts`, berkas link edge terkait, `docs/deployment.md`, test. Jangan: write-off (legend-drzaf, thread lain), PIN edge, refund, pajak, akses, UI. Migrasi: tanya CTO dulu.

## Bukti selesai
- Test reproduksi (restore DB edge dengan instance sama, event baru sesudah restore) gagal di basis, lalu lulus; test link edge lama tetap lulus.
- `LEGEND_TEST_FILES` daftar eksplisit (path `src/test/...`) lewat `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="..." pnpm test'`, sertakan `src/test/edge-received-events-migration.test.ts`.
- tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh.
- Review K: subagent reviewer Opus + architect paralel. Brief Codex `docs/briefs/234b-second-opinion-edge-link-restored-db.md` (tidak di-commit).

## Laporan
Sekali: terbukti atau tidak, hasil, bukti, file berubah, SHA, risiko tersisa, jumlah subagent dan puncak bersamaan. Jangan menunggu proses global atau loop sleep. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
