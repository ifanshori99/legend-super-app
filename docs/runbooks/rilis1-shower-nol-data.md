# Rilis 1: shower ditutup, data shower wajib nol (1269 F0)

`FACILITY_SHOWER_ENABLED` mati (default) menutup fasilitas bertipe `shower` di semua kanal. Coworking, loker, dan ruang meeting tidak terpengaruh. Selama mati, fasilitas shower juga tidak bisa dibuat, diimpor, atau dihasilkan dari perubahan tipe.

## Syarat rilis pertama

Rilis pertama **wajib nol data shower**. Jalankan **sesudah migrasi dan impor konfigurasi, sebelum outlet dibuka**: sebelum migrasi tabelnya belum ada, dan sebelum impor data belum masuk.

Jalankan sebagai superuser atau role dengan `BYPASSRLS` (role migrator), dalam transaksi baca saja. Pemilik tabel biasa tidak cukup: tabel tenant memakai `FORCE ROW LEVEL SECURITY`, sehingga dengan `row_security = off` query-nya gagal (42501). Jangan menghapus `SET LOCAL row_security = off`; tanpa itu role yang kena RLS bisa membaca 0 baris dan terlihat lolos.

```sql
BEGIN READ ONLY;
SET LOCAL row_security = off;
SELECT count(*) FROM facilities WHERE type = 'shower';
SELECT count(*) FROM access_tickets t JOIN facilities f ON f.id = t.facility_id WHERE f.type = 'shower';
SELECT count(*) FROM facility_products p JOIN facilities f ON f.id = p.facility_id WHERE f.type = 'shower';
SELECT count(*) FROM entitlement_rules r JOIN facilities f ON f.id = r.facility_id WHERE f.type = 'shower';
SELECT count(*) FROM facility_subscription_plans s JOIN facilities f ON f.id = s.facility_id WHERE f.type = 'shower';
ROLLBACK;
```

Semua angka harus 0. Bila tidak 0: berhenti, jangan buka outlet, laporkan ke CTO. Alasannya:

- Langganan shower yang sudah aktif tetap ditagih oleh penyedia sampai dihentikan (jeda dan berhenti tetap boleh).
- Tagihan yang sebagian uangnya sudah masuk tetapi tiket shower-nya belum terbit buntu: `complete` ditolak 403 dan void biasa ditolak karena sudah ada uang masuk (lihat di bawah).

## Bila tetap ada transaksi lama

- Flag shower tidak menambah larangan pada void dan refund, tetapi aturan kasir yang biasa tetap berlaku:
  - Void tagihan terbuka hanya bila belum ada uang masuk (atau hanya poin), tidak ada QRIS yang masih bisa dibayar, dan tidak ada permintaan EDC yang terbuka. Bila sudah ada uang masuk, void ditolak `CONFLICT` ("selesaikan lalu koreksi dengan void/refund tertaut").
  - Tagihan yang sudah selesai dikoreksi dengan void atau refund tertaut, dengan syarat biasanya.
  - Tagihan terbuka yang sudah ada uangnya dan berisi shower tidak punya jalan di kasir. Bawa ke CTO dan finance; jangan nyalakan flag sendiri.
- Menyelesaikan tagihan (`complete`) yang menerbitkan tiket shower tetap ditolak 403 `FACILITY_SHOWER_DISABLED`.
- Edge tidak punya replika fasilitas. Penjualan menu yang memberi hak shower dari edge ditolak saat masuk cloud dengan alasan `shower_closed` dan event-nya terparkir; bawa ke finance (refund penjualan kasir offline belum didukung di rilis 1), jangan nyalakan flag untuk meloloskannya.
