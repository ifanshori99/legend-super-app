# Lanjutan G52kh: WS-06 retur supplier dan pembelian sederhana (legend-65mgw)

Keputusan CTO atas laporanmu: kredit ke kas kecil `1102` diterima. Kartu baru dari saranmu: `legend-179bw` (open item AP untuk nota debit), `legend-1afw0` (selisih harga, PPN masukan petty, cutover).

## Tugas berikut
`legend-65mgw` (P3, tingkat K), induk `legend-316`: sumber event untuk aturan jurnal yang baru kamu buat. Penerimaan barang (`legend-o1o4s`) sudah di m1 (9541fd34).
- Retur ke supplier: tabel, service, route; stok berkurang lewat ledger stok yang ada; emit `purchase_return.recorded` dengan `outletId`, `uninvoicedValueIdr`, `invoicedValueIdr`, `ppnIdr`. Pembagian per baris dibulatkan per baris, bukan prorata total.
- Pembelian sederhana: tabel, service, route; `amountIdr`, foto (pola upload yang ada), batas per outlet; emit `petty_purchase.recorded`. Saldo kas kecil per outlet (`legend-4961`) bukan bagian kartu ini.
- Retur aktif hanya sesudah jurnal penerimaan barang mengkredit GRNI. Jurnal `goods_receipt` (`legend-29vw`) belum ada: tahan emitter retur di balik flag atau tulis di laporan bagaimana kamu menjaganya.

## Repo
Cabang baru `ws/supplier-return-petty` dari `ws/purchase-return-posting` (58d79c20). Pakai ulang worktree `.worktrees/purchase-return-posting`: `git switch -c ws/supplier-return-petty` di sana sesudah memastikan status bersih. Jangan buat worktree tambahan. Migrasi: `0208`, `when` 1794287000000, satu migrasi; `prevId` = snapshot 0205.

## Kartu
`ghostex board associate legend-65mgw`, `bd update legend-65mgw --status in_progress`. Selesai: `--status review` + `bd comment`.

## Scope
Boleh: schema/service/route `inventory-return*` dan `petty*`, migrasi 0208, kontrak shared bagian itu, test. Jangan: kas kecil (`legend-4961`), pembayaran supplier, faktur supplier, jurnal penerimaan barang, UI.

## Bukti selesai
- `pnpm db:generate` lalu periksa SQL; generate kedua kosong. Test migrasi RLS.
- Test gagal-dulu: isolasi tenant dan outlet; retur melebihi qty diterima ditolak; stok berkurang tepat sekali; event retur membawa split per baris yang jumlahnya sama dengan total; pembelian sederhana di atas batas ditolak atau butuh persetujuan; kirim ganda dengan kunci idempoten sama hanya sekali; event lalu terjurnal oleh aturanmu (tes ujung ke ujung di API).
- Test terarah (`LEGEND_TEST_FILES`), tsc api dan shared lewat `heavy` sekali, eslint + prettier.
- Review tingkat K: satu subagent `architect`.
- Daftar berkas untuk eslint/prettier: tulis ke berkas sementara lalu `xargs`, jangan ekspansi array zsh di satu baris (memicu kartu izin palsu ke founder).

## Laporan
Sekali di akhir: SHA, migrasi (`when`, prevId), bukti, file berubah, cara menjaga retur sebelum 29vw, risiko, jumlah subagent.
