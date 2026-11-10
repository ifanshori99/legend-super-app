# Brief 290f: engineer — kartu baru (CTO membuat id): jurnal loyalti

Level: K (akuntansi, uang). Model: Opus 5.5 (desain uang). Effort: high.
Kartu bd: kartu baru, CTO membuat id. Sampai id ada, pakai nama kerja `loyalty-journal`.
Sumber kebenaran: `docs/design/ws08-member-loyalty.md` §5 (Accounting), §9 (kartu 290f), §6 risiko 2. Sumber aturan bersama: `docs/briefs/290-aturan-bersama.md` (B1, B11). Desain menang; aturan bersama merinci. Bila beda, tulis TBD-verify di laporan.
Kontrak: `packages/shared/src/crm/events.ts` (payload `points.*`).

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`. Kamu memimpin subagent sendiri.

## Status gerbang: TAHAN SEBELUM KODE AKUN
Desain §5: "Needs the accounting second opinion and the founder's accountant (Q7)."
- Jangan menulis jurnal ke produksi sebelum CTO mengonfirmasi jawaban Q7 (akuntan founder).
- Kamu boleh mengerjakan skema, tes, dan konsumer di cabang kerja. Jangan merge dan jangan aktifkan.
- Jika CTO belum mengonfirmasi, berhenti setelah tes gagal-dulu dan lapor.

## Repo dan cabang
- Worktree: `.worktrees/loyalty-journal` dari `milestone/m1`, cabang `ws/loyalty-journal`.
- Jalankan `pnpm worktree:setup` sekali.
- Commit lokal saja. Jangan push, jangan merge.

## Bergantung pada
- 290a (legend-111j): event `points.earned`, `points.reversed`, `points.redeemed`, `points.expired`, `liability_idr` di `point_ledger`, dan source reverse `void` (B1: `order.voided` membalik poin dengan `source_type='void'`).
- 290c (legend-m4p5): event `points.adjusted` (aditif, B11) dengan `kind: 'restore'` dan `reversesEntryId`, untuk jurnal penukaran dan restore pembatalan. Tanpa 290c, kerjakan hanya earn, reverse, expire, dan tandai redeem sebagai menunggu.
- 290e (legend-3zd1) untuk `points.expired` dengan grant nyata. Jika belum merge, pakai fixture.

## Paralel dengan
290c, 290d, 290e. Berkas akun di luar tiga kartu itu.

## Tujuan
1. Konsumer `loyalty-journal` pada event poin, source type `'loyalty'` (CHECK sudah mengizinkan, belum ditulis siapa pun). Pola: `accounting-auto-journal-consumer.ts`. Berjalan dalam transaksi konsumsi, savepoint per event, gagal diparkir.
2. Entri jurnal (§5):
   - `points.earned` / bonus: Dr `loyalty_points_deferral` (role baru, kontra-pendapatan di bawah 4100), Cr `loyalty_liability`, jumlah `liabilityIdr`.
   - `points.reversed`: cermin entri earn. Berlaku juga untuk reverse `source_type='void'` (B1), tanpa aturan khusus.
   - `points.redeemed`: Dr `loyalty_liability`, Cr `sales_discount`. Diskon muncul di pesanan tempat hadiah dipakai, jadi keduanya saling menutup.
   - `points.expired`: Dr `loyalty_liability`, Cr `loyalty_breakage_revenue`.
   - `points.adjusted` `kind: 'restore'`: cermin entri redeem, yaitu Dr `sales_discount`, Cr `loyalty_liability`, jumlah sesuai `reversesEntryId`.
   - `points.adjusted` manual: mengikuti tanda. Poin naik = seperti earn, poin turun = seperti reverse.
3. Role akun `loyalty_points_deferral` baru: role disimpan `varchar` tanpa CHECK (`apps/api/src/db/schema/accounting.ts:140`), daftar role di `packages/shared/src/accounting/coa.ts:190-204`. Tambah role = edit `coa.ts` + akun seed + backfill `account_mappings` lewat `apps/api/src/db/backfill-tenant-defaults.ts`. Tanpa migrasi skema.
4. Idempoten: replay event tidak membuat jurnal kedua (kunci dari event id dan source id).
5. Saldo jurnal seimbang per entri (Dr = Cr).

## Migrasi
- Tidak ada migrasi skema. Desain §8 tidak mencantumkan migrasi jurnal, dan role akun tanpa CHECK (lihat Tujuan 3).
- `pnpm db:generate` harus kosong.

## Potongan untuk subagent
Nama berkas dari tabel D. Cek dengan Explore hanya bila payload `points.*` butuh parser baru, dan lapor ke CTO sebelum menulisnya.
1. `apps/api/src/services/loyalty-journal-consumer.ts` (pola `accounting-auto-journal-*`). Implementer sonnet.
2. `packages/shared/src/accounting/coa.ts` (role dan akun seed). Implementer sonnet. Berkas ini dipegang satu subagent saja.
3. Berkas registri (A.2): `apps/api/src/db/backfill-tenant-defaults.ts` (backfill `account_mappings`). Dipegang SATU subagent, hanya tambah blok dengan komentar `legend-<id kartu>`. Tidak boleh bersamaan dengan `coa.ts` bila ada ketergantungan urutan.
4. test-writer sonnet: `apps/api/src/test/loyalty-journal.test.ts`.

Subagent: implementer sonnet untuk 1-3, test-writer sonnet. Potongan yang sama tidak boleh mengedit berkas yang sama. Jangan ubah konsumer lain.

## Tes gagal-dulu
- Earn 1 000 poin, liability setara dengan `liabilityIdr`. Jurnal seimbang.
- Reverse sebagian: cermin persis sejumlah reversal, bukan lebih.
- Reverse `source_type='void'` (order lunas dibatalkan): cermin earn, seimbang.
- Replay `points.earned` yang sama: satu jurnal.
- Redeem: Dr `loyalty_liability` = Cr `sales_discount`, saldo nol untuk pasangan itu.
- Expire: Dr `loyalty_liability` = Cr `loyalty_breakage_revenue`.
- Restore penukaran batal (`points.adjusted`, `kind: 'restore'`): cermin redeem.
- Source type `'loyalty'` ditulis; entri lain tidak tersentuh.
- Isolasi tenant: jurnal tenant A tidak terbaca tenant B.

Perintah: `LEGEND_TEST_FILES="src/test/loyalty-journal.test.ts" pnpm test` dari root worktree. Output panjang lewat `test-runner` (haiku).

## Kontrak
- Kode error sudah ada di `packages/shared/src/crm/errors.ts`. Jangan ganti nama.
- Tidak ada endpoint baru diduga. Jika laporan jurnal butuh endpoint, lapor dulu. Itu kartu WS-11.
- `events.ts`: tidak ada perubahan payload di kartu ini. `points.adjusted` dan source `void` ditambah oleh 290c dan 290a.

## Gate cabang
- `heavy pnpm --filter @starter/api typecheck`, `heavy pnpm --filter @starter/shared typecheck` (bila shared berubah), `pnpm exec eslint <berkas berubah>`.
- `LEGEND_TEST_FILES="..." pnpm test` untuk tes di atas.
- `pnpm db:generate` kosong.
- `pnpm exec prettier --check <berkas berubah>`.
- Review tingkat K: satu subagent `architect` (Opus, xhigh) untuk diff.
- Second opinion Codex untuk area uang, xhigh: sekali, gabungan dengan area keuangan lain. Kamu tulis brief-nya, CTO yang menjalankan. Wajib sebelum gerbang rilis, tidak menahan kartu berikut.

## Bukti selesai
- Semua tes hijau setelah merah.
- Lint, typecheck, `db:generate` kosong.
- Jawaban Q7 dari CTO dicatat di laporan. Tanpa itu, status: "siap review, belum rilis".
- Commit lokal di `ws/loyalty-journal`. Pesan commit merujuk kartu bd baru dan kriteria LOY-02.
- `docs/PROGRESS.md` diperbarui.

## Laporan
SHA, id kartu bd (dari CTO), status Q7, jumlah subagent dan puncak bersamaan, hasil gate, temuan `architect` dan perbaikannya, role CoA yang ditambah dan cara ditambah, yang belum teruji.
