# Second opinion edge catalog 1199 (int/batch99 @ ea2aec38b, 20 Nov)

Architect konteks segar (pengganti Codex). Baca kode saja, tanpa test.

**Verdict: TIDAK** (tanpa P0/P1; dua P2 uang wajib sebelum gerbang rilis).

## P2-A stacking policy diam-diam diabaikan sesudah dump/restore

`docs/deployment.md:416` restamp 14 tabel tanpa `promo_settings`. Cloud kirim stamp lama tinggi (`edge-catalog-sync.ts:773-781`), edge hanya terima stamp lebih baru (`edge-catalog-apply.ts:948-955`). Perubahan kebijakan sesudah restore tidak pernah sampai -> diskon offline lebih longgar.

## P2-B promo yang hilang di cloud restore tetap diskon sampai deaktivasi terkonfirmasi, tanpa batas waktu

Cloud menahan field konfirmasi selama ada baris future-stamped (`edge-catalog-sync.ts:1097-1109`). Usul: `catalog-puller.ts:804-805` beri promotions `PROMO_INVALIDATED_AT` selama marker `catalog:replay:promotions` ada, sehingga promo fail closed sampai deaktivasi (`catalog-puller.ts:965-985`) commit.

## P3

- `catalog-puller.ts:969`: jumlah baris dinonaktifkan dibuang; log per stream tanpa PII.
- `edge-catalog-restore-membership.ts:38-40`: komentar salah (voucher nilai tanpa promotion, `crm-promo-engine.ts:1453-1456`); aman karena edge menolak kode (`promo-gate.ts:52-55`).
- `catalog-receipt-floor.ts:36`: floor dibanding `received_at` jam dinding edge; jam mundur melemahkan perlindungan (dibatasi stamp guard).
- `docs/deployment.md:416`: double backtick rusak.

Belum diperiksa: freshness `runtime.ts` + penutupan override sesudah rewind, `catalog-gate.ts` penuh, urutan link event sesudah restore.

## Keputusan CTO 20 Nov

- P2-A: tambah `promo_settings` ke daftar restamp + test/cek bahwa daftar restamp mencakup SEMUA tabel katalog bersync_txid (supaya tidak terulang).
- P2-B: fail closed. Selama marker replay promotions ada, edge tidak memberi promo otomatis sampai deaktivasi commit. Biaya (cloud lama tanpa field -> promo tetap off sesudah rewind) DITERIMA: pelanggan bayar harga normal, outlet tidak rugi; cloud dan edge dirilis bersama.
- P3 log jumlah, komentar, backtick: kerjakan. Receipt floor jam dinding: bead terpisah.
