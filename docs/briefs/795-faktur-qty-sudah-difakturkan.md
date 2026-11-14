# 795 Faktur pemasok: qty sudah difakturkan (2 kartu, tingkat S)
Peran: engineer (Codex, kartu S). Baca ~/.agents/team/roles/engineer.md. Codex tidak menjalankan bd.
Basis: worktree dari `origin/ghostex/layar-input-faktur-pemasok` (882900f6a, form faktur belum di m1). Cabang `fix/supplier-invoice-invoiced-qty`.
Kartu:
1. legend-btcex: API baris PO untuk form faktur mengembalikan qty yang sudah difakturkan per baris (faktur non-batal). Default qty faktur di form = diterima - sudah difakturkan (min 0). Pesan "Qty faktur melebihi penerimaan" menyebut sisa yang masih bisa difakturkan. Validasi server yang menolak qty berlebih tetap ada dan tidak dilonggarkan.
2. legend-rrkvo: `receiving-mock.ts` sekitar :520, faktur matched harus punya `outstandingIdr` = payable - paid supaya lolos `supplierInvoiceSchema`. Verifikasi dulu, lalu betulkan.
Uang: tidak ada pihak dibayar lebih. Test gagal-dulu: faktur kedua untuk PO yang sama mendapat default sisa qty; total qty difakturkan tidak bisa melebihi diterima.
Paralel: subagent per kartu (file terpisah), satu reviewer.
Teks UI baru didaftarkan ke katalog (`node --test tests/text-contract.test.mjs`). Tanpa migrasi.
Selesai: test terarah lewat `heavy`, prettier, eslint, typecheck API dan web lewat `heavy`, commit, push. Laporan: SHA, test, angka subagent (total, puncak, pemegang token heavy). Jangan merge ke m1.
