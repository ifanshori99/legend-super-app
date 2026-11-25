# Rilis 1: shower ditutup, data shower wajib nol (1269 F0)

`FACILITY_SHOWER_ENABLED` mati (default) menutup fasilitas bertipe `shower` di semua kanal. Coworking, loker, dan ruang meeting tidak terpengaruh.

## Syarat rilis pertama

Rilis pertama **wajib nol data shower**. Jalankan di database production dengan role pemilik (baris tenant lain tersembunyi oleh RLS untuk role aplikasi), di dalam transaksi baca saja:

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

Semua angka harus 0. Bila tidak 0: berhenti, jangan deploy, laporkan ke CTO. Alasannya:

- Langganan shower yang sudah aktif tetap ditagih oleh penyedia sampai dihentikan (jeda dan berhenti tetap boleh).
- Tagihan yang uangnya sudah masuk tetapi tiket shower-nya belum terbit tidak bisa diselesaikan (403), dan aturan lama menolak void biasa setelah ada uang masuk; jalannya refund.

## Bila tetap ada transaksi lama

- Void dan refund transaksi lama selalu boleh, tidak dijaga flag.
- Menyelesaikan tagihan (`complete`) yang menerbitkan tiket shower tetap ditolak 403 `FACILITY_SHOWER_DISABLED`.
- Edge tidak punya replika fasilitas. Penjualan menu yang memberi hak shower dari edge ditolak saat masuk cloud dengan alasan `shower_closed` dan event-nya terparkir; selesaikan bersama kasir (refund), jangan nyalakan flag untuk meloloskannya.
