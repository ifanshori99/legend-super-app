# Brief: engineer (Sonnet) — perbaikan kecil akuntansi

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/accounting-small-fixes` dari `milestone/m1` terbaru (4c818489 atau lebih baru). Worktree `.worktrees/accounting-small-fixes`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Berurutan, satu commit per kartu. Sebelum tiap kartu: `bd show` + komentar, cek ulang ke basis (triase 9 Nov memakai grep ringan; sudah ada: komentari kartu dan lewati). Ringkasan: `docs/briefs/245-triage-result.md`.
1. `legend-3r6r` (K): auto-journal membatasi parkir penjualan yang `payment.paid`-nya dead-letter (tidak retry tanpa ujung; eskalasi terlihat).
2. `legend-bqup` (S): serialkan create/update CoA per legal entity (parent konkuren).
3. `legend-pxcs` (S): endpoint baca kebijakan keuangan (jendela pencocokan bank, cash-deposit, dll. sesuai kartu).
4. `legend-dux2` (S): register aset tetap: kode, kategori, ringkasan revaluasi (kontrak shared).

## Kartu
Di awal tiap kartu: `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment`.

## Scope
Boleh: service/route akuntansi, `accounting-auto-journal*.ts` kecuali `accounting-auto-journal-guards.ts` (thread refund mengubahnya), kontrak shared akuntansi, test. Jangan: migrasi (butuh: berhenti untuk kartu itu dan lapor), payment/refund, akses, UI.

## Bukti selesai
- Per kartu: test gagal-dulu, lalu lulus. Test akuntansi terkait tetap lulus.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file; contract root `node --test` bila menyentuh `packages/shared`.
- Typecheck via `heavy` sekali di akhir, eslint, prettier. Jangan `pnpm check` penuh.
- Review (Q48): satu `architect` untuk diff gabungan (ada butir K). Maks 2 subagent bersamaan; test-writer hanya menjalankan file yang ia tulis.
- Brief Codex `docs/briefs/251b-second-opinion-accounting-small-fixes.md` (tidak di-commit).

## Laporan
Sekali di akhir: per kartu (hasil, SHA atau "sudah ada"), bukti, file berubah, risiko, jumlah subagent.
