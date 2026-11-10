# Hasil Codex 130: tax default (G08dj, 9 Nov 16:55)

`ws/tax-default` d82041ee..9a057246. 36/36 test lulus. Race direproduksi di PostgreSQL sementara lewat layanan owner, provisioning, dan engine asli.

- **P1, `apps/api/src/services/tax-provisioning.service.ts:137`**: backfill membaca aturan kosong; owner membuat dan menerbitkan `CUSTOM-PBJT` tenant-wide untuk `food_beverage`; backfill tetap menyisipkan `PBJT-FNB`. Kedua kode lolos unique index; engine menghasilkan `TAX_RULE_AMBIGUOUS`, order POS/QR gagal. Fix: serialkan cek kosong + sisip terhadap penulis konfigurasi owner dengan lock tenant bersama. Tambah test race owner/backfill (test sekarang hanya dua backfill).
