# Brief: engineer (Sonnet) — tiga perbaikan kecil pembayaran (legend-deu7r, legend-jf4i, legend-aef1)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/payment-small-fixes` dari `milestone/m1` terbaru (4c818489 atau lebih baru). Worktree `.worktrees/payment-small-fixes`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Kerjakan berurutan, satu commit per kartu. Sebelum mulai tiap kartu: baca `bd show` + komentar dan cek ulang ke m1 (triase 9 Nov memakai grep ringan; bila sudah ada di m1, komentari kartu dan lewati).
1. `legend-deu7r` (K): masking PAN EDC menerima pemisah newline/CRLF/NBSP/'/'/'_' (`cardNumberLike` dan pola di migrasi 0143). Bila pola DB (0143) juga perlu diubah: jangan buat migrasi, berhenti untuk bagian itu dan lapor.
2. `legend-jf4i` (K): daftarkan `expireDueIntents` sebagai job berkala di worker (ikuti pola sweep yang sudah ada di `worker-main.ts`).
3. `legend-aef1` (K): `refundSplit` di `pos-order-corrections.ts` membangun split dari subtotal yang direfund + perubahan diskon hasil recompute.

## Kartu
Di awal tiap kartu: `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment`.

## Scope
Boleh: berkas yang disebut kartu dan test-nya. Jangan: `payment-admin.service.ts` dan `payment-refund.service.ts` (thread refund lain sedang mengubahnya; bila aef1 butuh ke sana, lapor dulu), `payment-failover.service.ts`, migrasi, akses, edge, UI.

## Bukti selesai
- Per kartu: test gagal-dulu, lalu lulus. Test terkait lama tetap lulus.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file.
- tsc lewat `heavy` sekali di akhir (atau per perbaikan bila gagal), eslint, prettier. Jangan `pnpm check` penuh.
- Review (Q48): satu subagent `architect` untuk diff gabungan ketiga kartu. Maks 2 subagent bersamaan (Mac sedang padat).
- Brief Codex `docs/briefs/246b-second-opinion-payment-small-fixes.md` (tidak di-commit).

## Laporan
Sekali di akhir: per kartu (hasil, SHA), bukti, file berubah, risiko, jumlah subagent.
