# Brief lanjutan G88uh: WS-11 berkas bersama putaran 2 (penyatuan keluarga)

Lanjutan di thread yang sama. Aturan sama dengan brief 260 dan 267. Cabang baru `ws/ws11-shared-2` dari `ws/ws11-shared-1` (18455b7a), worktree baru `.worktrees/ws11-shared-2`. Jangan push, jangan merge ke m1. Tanpa migrasi baru.

## 1. Satukan keluarga yang sudah lapor
Merge `--no-ff` ke cabang ini, berurutan: `ws/ws11-traffic-operations` (e65f2545, F2), `ws/ws11-menu-cogs` (614a36c4, F3), `ws/ws11-payments-tax` (dffbee2c, F4), `ws/ws11-sales` (e37b2c02, F1, membawa migrasi 0181 when 1794260000000), `ws/ws11-dashboards` (88732642, F11). `routeTree.gen.ts`: regenerasi, jangan gabung tangan. Konflik di `metrics-engine.test.ts` / `metrics-runtime.test.ts` (F1 dan F2 sama-sama mengganti contoh "kode tak terklaim" / "split tak didukung"): pakai contoh yang memang tak pernah diklaim keluarga mana pun. Keluarga F5, F8, F10 (thread G45ej) menyusul ke putaran 3.

## 2. Kartu berkas bersama
- `legend-iwsrp` (dari F2-F4): `assertRegistry` menolak dua pembaca yang menulis kode sama; penghapusan baris lama di `metrics-daily.service.ts` dibatasi per dimensi pembaca; cakupan `final` pecahan GL memeriksa baris total final per outlet; rata-rata multi-hari (`avg_serving_time`, `avg_dwell_minutes`) tertimbang volume; `SERVED_REPORTS` di mock memuat traffic dan operations; hapus `menu_gross_margin` dari `NON_GL_MONEY_METRICS`; sumber GL `tax_collected`, `service_charge_collected`, `tax_payable`; pecahan persen `food_cost_pct`; jenis "porsi dari total" untuk `menu_popularity_pct`.
- Pecahan `net_sales` per `payment_method` dan `menu_category` (dibutuhkan `payments.methods`, `menu.category_sales`). Pakai ulang `allocateByWeight` dari F4. Satu pemilik kode per metrik: sales.
- Permintaan F11: parameter `managerRole` di query dasbor management; `availability` + alasan per tile dan per antrean; `outletIds` tunggal di GET diterima sebagai array.
- Mock: sel `sales_target` di `ws11-report-builder/mock-preview.ts`, split `day_of_week` di `mock-day-model.ts`, tiga laporan sales baru masuk `SALES_REPORTS`.
Buat kartu `ws11-shared` per butir bila belum ada, tutup di akhir.

## Bukti dan review
- Satu run gabungan: semua `ms-*.test.ts`, `metrics-engine`, `metrics-runtime`, `reports-run`, `dashboards-api`, `sales-targets`, `ws11-gl-parity`, test migrasi RLS; sebut jumlah file dan tes. Test root ws11 + kontrak lewat `node --test`.
- Test gagal-dulu untuk tiap butir kartu 2.
- `pnpm db:generate` kedua kosong; typecheck shared/api/web lewat `heavy` sekali; eslint + prettier.
- Review tingkat K: satu `architect` untuk diff butir 2 (bukan isi keluarga yang sudah direview).

## Laporan
Sekali di akhir: SHA, konflik dan cara selesai, per butir (hasil, SHA), bukti, kontrak yang berubah untuk G45ej (F5 F8 F10), risiko, jumlah subagent dan puncak bersamaan.
