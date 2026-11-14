# 813 EDC-01: kunci tagihan selama permintaan ECR belum final (engineer, tingkat K uang)

## Peran
engineer (baca ~/.agents/team/roles/engineer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/ws/criteria-pay-edc` (bcdef184a, berisi reproduksi). Cabang akhir `fix/edc-bill-lock` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-ig2sl`. Di awal `bd update legend-ig2sl --status in_progress`; saat lapor `--status review` + `bd comment`.

## Masalah
Kriteria EDC-01 (docs/PRD.md:709): nominal EDC selalu sama dengan tagihan POS; kasir tidak dapat mengubah nominal setelah permintaan dikirim. Terbukti: saat permintaan ECR berstatus dispatched/pending/unknown, diskon masih diterima; tagihan tersimpan berubah Rp55.000 -> Rp54.450 sementara EDC menagih Rp55.000. Dua reproduksi `it.fails` di `apps/api/src/test/pos-edc-tender.test.ts:541`.

## Keputusan CTO
Selama ada permintaan EDC yang belum final (dispatched, pending, unknown) pada order/tagihan itu, SEMUA perubahan yang mengubah total ditolak 409 dengan kode jelas (diskon, void item, tambah/ubah item, service charge, promo, voucher, split). Baru terbuka lagi setelah status final lewat inquiry (declined/cancelled/failed) atau pelunasan. Jangan membuka kunci karena timeout saja (harus inquiry dulu, EDC-03). Bila ragu, pilih yang menolak perubahan.

## Scope
- Boleh: service POS order/tender/diskon yang mengubah total, service EDC tender, test.
- Jangan: migrasi (bila ternyata perlu kolom baru: berhenti dan lapor, nomor 0379), edge sync, DOIT/payout, panik, pemindai.

## Paralel
- Explore x2: (a) semua jalur yang mengubah total tagihan, (b) status permintaan ECR dan transisinya.
- test-writer: ubah dua `it.fails` jadi `it`, tambah satu test per jalur pengubah total; jalankan di basis (harus merah).
- implementer: satu guard bersama dipanggil dari tiap jalur (file tidak bertumpuk).
- Pemegang token heavy: test-runner.

## Bukti selesai
- Test terarah semua file pos-edc-*, edc-*, pos-order-*, pos-discount/void yang tersentuh, lewat `heavy`; gagal-dulu tercatat.
- Aturan founder jangan sampai rugi: test bahwa nominal EDC = tagihan di semua jalur, dan pelanggan tidak ditagih lebih / outlet tidak kurang.
- Pra-gate AGENTS.md (prettier, eslint, `heavy pnpm --filter @starter/api typecheck`).
- Satu subagent architect effort xhigh atas diff; temuan nyata dibetulkan.

## Laporan
SHA, cabang akhir, daftar jalur yang dikunci, test, hasil architect, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
