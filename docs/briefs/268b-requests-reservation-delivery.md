# Permintaan berkas bersama: reservation-delivery (F8)

1. `apps/web/src/routeTree.gen.ts`: regenerate (4 route baru `_kelola/reports.delivery.{orders,channel-sales,by-menu,settlement}.tsx`). Tidak diedit tangan.
2. `apps/web/src/features/ws11-reports/mock.ts`: tambahkan `...reservationDelivery.reportsByPrefix.delivery` ke `SERVED_REPORTS` (cell delivery_orders/delivery_sales sudah ada di mock-families/reservation-delivery.ts).
3. `apps/api/src/services/metrics-gl-sources.ts` + `metrics-runtime.test.ts`: `delivery_sales` kini dibaca dari baris pesanan delivery (daily reader, bukan GL; tak pernah diposting GL). Keluarkan dari `NON_GL_MONEY_METRICS` hanya bersama pelonggaran tes "every rupiah metric is ledger-mapped or listed as NON_GL" (aturan baru: atau diklaim reader daily). Sampai itu, biarkan terdaftar; tidak mengganggu pembacaan.
4. Belum diklaim di sini: `pax` (metrik POS, keluarga traffic), `menu_sold_qty` (menu-cogs), `payment_fee` (payments-tax). Laporan delivery.by_menu dan delivery.settlement menampilkan metrik itu sesuai pemiliknya.

## Temuan review architect yang menunggu keputusan CTO (finalitas delivery)

`delivery_orders` dan `delivery_sales` memakai `requiresDailyClose: false`, jadi baris menjadi `final` 30 menit setelah hari tutup. Pesanan `received` hingga `picked_up` ikut dihitung. Contoh: pesanan masuk 23:50, ditolak 00:40, baris final tetap menghitungnya. Komisi masih tarif estimasi; angka aktual ada di `delivery_settlement_lines`. Usul: kait finalitas per reader di `metrics-daily.service.ts` (estimate selama masih ada pesanan belum terminal atau belum settle). Berkas bersama, milik thread `ws11-shared`. Sampai itu ada, jangan rilis laporan delivery sebagai angka tertutup.
