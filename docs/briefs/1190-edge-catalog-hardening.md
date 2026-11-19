# 1190 Edge catalog sync hardening (engineer Sonnet, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore area, satu implementer per kartu dengan berkas terpisah, test-writer untuk fail-first, architect di akhir).
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.
Base: `milestone/m1` (2b23b324f). Cabang: `ws/1190-edge-catalog-hardening`. Tingkat K (protokol sync offline): satu architect effort high. Tanpa migrasi: y9y8y pakai field heartbeat/header, bukan tabel. Bila terpaksa migrasi, pakai 0725 saja dan sebutkan.

## Kartu (`bd show <id>`)
1. `legend-75kly`: hanya 400 cursor-rejected (kode error khusus) yang reset `sync_txid`, bukan semua HTTP_400.
2. `legend-y9y8y`: deteksi restore DB cloud (txid mundur) dengan epoch/generation; rewind edge sudah ada di m1.
3. `legend-ssnf9`: gabung notifikasi katalog basi jadi satu per edge per heartbeat.
4. `legend-n6mkr`: cloud toleran field tak dikenal / negosiasi versi agar rollback tidak membuat heartbeat `catalogStale` ditolak. Tetap strict untuk field yang dipakai.
5. `legend-jcgbk`: test `edge-catalog-sync` dan `catalog-puller` jangan paralel di DB bersama (isolasi per file atau serial).

Berkas utama: `apps/api/src/edge/{catalog-puller,catalog-freshness,master-sync,runtime}.ts`, `apps/api/src/test/edge-catalog-*.test.ts`. Jangan sentuh payment-*, reservation-*, payroll-*, refund*, vitest config global.

## Bukti selesai
Test gagal-dulu per kartu; test edge-catalog-* lama tetap hijau (terarah lewat heavy). Edge dan cloud versi beda (lama/baru) tetap bisa heartbeat. Typecheck api sekali lewat heavy, prettier + eslint. Architect, temuan dibetulkan. Commit, push, tutup kartu. Tunggu job heavy dengan Bash run_in_background satu notifikasi.

## Laporan
SHA, kartu ditutup, subagent total dan puncak, gate, yang belum teruji. Lapor sekali.
