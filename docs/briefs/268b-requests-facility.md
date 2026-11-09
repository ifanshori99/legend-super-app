# Permintaan berkas bersama: keluarga facility (F10, legend-60tsm)

Keluarga facility hanya mengubah `metric-sources/facility.ts`, `ms-facility.test.ts` dan mock keluarganya. Butir di bawah butuh berkas milik thread lain (`packages/shared/src/dashboard/*`, `packages/shared/src/metrics/*`, `metrics-query.service.ts`, `metric-sources/index.ts`, `types.ts`). Sampai ada, 15 dari 19 metrik fasilitas dijawab `unavailable` / `source_not_built`; hanya `shower_sessions`, `facility_overtime_sessions`, `facility_overtime_seconds` dan `facility_incident_count` berangka (semuanya jumlah, aman dijumlahkan antar hari).

## 1. Persen dan rata-rata berbobot (katalog + mesin)

Mesin merata-ratakan nilai harian tersimpan tanpa bobot (`aggregation: average`). Itu salah untuk persen "menit terpakai / menit tersedia" dan untuk rata-rata waktu respons. Reader tidak boleh menyimpan persen harian.

Minta: kode pembilang dan penyebut bertipe jumlah di katalog, lalu metrik asli menjadi `derived` (rasio, tidak disimpan):

| Metrik                               | Pembilang                                                   | Penyebut                                   | Skala |
| ------------------------------------ | ----------------------------------------------------------- | ------------------------------------------ | ----- |
| `shower_occupancy_pct`               | `shower_used_minutes` (count, dimensi outlet/facility/unit) | `shower_available_minutes`                 | 100   |
| `unit_utilization_pct`               | `unit_used_minutes` (outlet/facility/unit/hour)             | `unit_available_minutes`                   | 100   |
| `facility_incident_response_seconds` | `facility_incident_response_total_seconds` (seconds)        | `facility_incident_answered_count` (count) | 1     |

Satuan `derived` perlu mengizinkan hasil `seconds` (bukan hanya percent atau rasio uang). Begitu kode ini ada, reader facility menulis dua jumlah per hari (menit terpakai dari tiket `in_use`/`completed` yang dipotong jam buka, menit tersedia dari jam operasi fasilitas) dan mengganti sumber `unavailable`.

Catatan data: `facility_units` hanya punya `created_at` dan `updated_at` ("cap konfigurasi"), tidak ada kolom arsip atau pensiun. Menit tersedia perlu siklus hidup unit (kolom `retired_at` atau status `retired`) agar unit yang belum dibuat atau sudah dipensiunkan tidak ikut dihitung. Itu migrasi skema, bukan wewenang kartu ini.

## 2. Harga tiket dan pendapatan

`access_tickets` tidak menyimpan harga, dan alur pembayaran yang mengisi `payment_intents.access_ticket_id` belum ada. Tabel langganan juga belum ada (`payment_intents.subscription_invoice_id` tanpa tabel). Dibutuhkan: snapshot harga dan produk pada tiket (atau tautan ke pesanan POS), tabel langganan dengan tagihan per fasilitas. Setelah ada: `shower_revenue`, `facility_product_revenue`, `facility_product_sales`, `active_subscriptions` bisa berangka. Dua kode uang itu tetap di `NON_GL_MONEY_METRICS` sampai pendapatan fasilitas diposting buku besar atau dibaca dari baris operasional dengan alasan tertulis.

## 3. Pembersihan unit

Tidak ada tabel tugas pembersihan (hanya jendela rencana `cleaning_ends_at`). `facility_cleaning_count` dan `facility_cleaning_seconds` butuh tabel `facility_cleaning_tasks` (mulai, selesai, unit) dan, untuk rata-rata, pasangan jumlah + total detik seperti butir 1.

## 4. Wi-Fi

`wifi_device_grants` adalah ledger lokal edge: kosong di cloud dan dihapus 30 hari setelah berakhir. `wifi_sessions` dan `wifi_quota_used` butuh tabel `wifi_sessions` (sinkron ke cloud, dengan zona atau fasilitas) dan pencatatan kuota terpakai.

## 5. Konversi shower ke F&B

Tidak ada tautan pesanan ke tiket akses. `shower_sessions_with_fnb` dan `shower_fnb_conversion_pct` butuh kolom `access_ticket_id` pada pesanan POS (atau tabel penghubung).

## 6. RevPASH dan okupansi kursi

Model kursi zona WFC belum didefinisikan (pax atau kapasitas meja, pendapatan zona dari GL atau pesanan, jam buka zona). `revpash` dan `seat_occupancy_pct` butuh keputusan produk lebih dulu, lalu pasangan pembilang/penyebut seperti butir 1.

## 7. Mock web

`facility-report/mock.ts` dan `mock-families/facility.ts` kini meniru API: 15 metrik `unavailable` / `source_not_built` (availability + nilai null, laporan yang semua metriknya tidak tersedia tanpa baris), angka hanya untuk `shower_sessions`, `facility_overtime_sessions`, `facility_overtime_seconds`, `facility_incident_count`. Sisa selisih: enam run papan pemilik (facility.revenue, occupancy, revpash, dan variannya per zona) dilayani `ownerDashboardBoardRuns` di `packages/shared/src/dashboard/fixtures.ts` dan masih menampilkan angka untuk `shower_revenue`, `shower_occupancy_pct`, `revpash`, `seat_occupancy_pct`. Fixture itu milik thread `ws11-shared`: minta availability `unavailable` untuk kode-kode itu agar papan pemilik ikut meniru API.
