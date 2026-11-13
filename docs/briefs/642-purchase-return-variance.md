# Brief: engineer — retur pemasok selisih harga + cutover penerimaan lama

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Area uang: aturan "jangan sampai rugi" berlaku (test bukti tidak ada pihak dibayar lebih).

## Repo
Worktree baru dari `origin/ws/purchasing-posting` (9baef7315; ikut batch57, belum di m1): `git worktree add .worktrees/preturn-642 -b fix/purchase-return-variance origin/ws/purchasing-posting`, `pnpm worktree:setup`. Rentang migrasi: **0504-0505**.

## Kartu
1. `legend-5b7uf` (P1) — retur barang yang sudah difaktur dengan selisih harga menyisakan utang. Spesifikasi perbaikan ada di `bd show legend-5b7uf` (nota debit = nilai tagihan + PPN, kolom `price_variance_idr`, field event `returnPriceVarianceIdr`, rule kredit `purchase_price_variance`, pre-check `reservedDebit` ikut nilai tagihan). Aktifkan test GR-11/GR-12 yang sekarang skip di `apps/api/src/test/purchasing-grni-journal.test.ts`; tambah kasus selisih negatif.
2. `legend-7e0q4` — cutover penerimaan sebelum posting aktif. Keputusan founder Q20: faktur/retur atas penerimaan tanpa jurnal DITOLAK sampai keuangan membuat jurnal pembuka. Sediakan jalur jurnal pembuka (cutover) yang membuat penerimaan lama bisa ditagih, dengan test.

Konteks keputusan: `docs/briefs/ws-purchasing-posting-design.md` §9 dan bd memory `founder-q19-22-13-nov`. Flag `SUPPLIER_INVOICE_POSTING_ENABLED` tetap OFF; jangan nyalakan.

## Review
Tingkat K (uang + migrasi): satu subagent `architect`, "architect effort xhigh", atas diff gabungan. Maks 2 ronde; cek ulang fix dengan reviewer sonnet.

## Bukti selesai
Test gagal-dulu (GR-11/12 gagal di base), test terarah lewat `heavy`, typecheck api lewat `heavy` sekali sebelum lapor, prettier + eslint, `db:generate` kosong. Push cabang tanpa force. `bd update --status review` + `bd comment`.

## Batas
Jangan merge, deploy, `pkill`, atau `pnpm test` penuh. Hemat token.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
