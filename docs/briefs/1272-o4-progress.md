# O4 UI kasir offline: serah terima (legend-wasr7.8, cabang ws/1272-o4)

27 Nov. Mockup disetujui CTO (`design/mockups/pos/offline/`). Commit: `6e1bed8e0` mockup, `f00cf3d09` deteksi + pengaman dobel + teks, `e0cbb0c6f` UI.

## Keputusan CTO O4, status

1. **Menu dari bekal, dine-in/takeaway saja: SELESAI.** `cashier-main-screen.tsx` memetakan `kit.catalogs[service]` lewat `mapCatalog`; `CatalogPane` menerima `offlineCatalog`; `ChannelToggle only=[dine_in, takeaway]`; `CartPane offline` menyembunyikan tahan/kirim item ditahan/meja/ojol/pesanan ditahan.
2. **Deteksi offline + pengaman dobel: SELESAI.** `offline/connectivity.ts`: offline = navigator offline ATAU ping `/api/health` gagal jaringan 2x berturut (tiap 5 detik, timeout 4 detik, `no-cors`, HTTP 4xx/5xx = online); online lagi hanya sesudah ping sukses. `offline/sale-guard.ts`: keranjang yang isinya sama dengan permintaan order cloud yang belum pasti (`usePendingOrder`) ditolak dengan "Pesanan tadi belum pasti, cek sesudah online."; juga ditolak saat kirim berjalan, `?draft=` (order cloud), ojol, kosong. Test: `apps/web/test/pos-offline-o4-detect.test.ts` (11).
3. **Antrean sebagai sheet di layar kasir: SELESAI.** `offline/offline-queue-sheet.tsx`: menunggu, disisihkan + penjelasan laporan konflik, tunai di antrean, "Coba kirim sekarang" (nonaktif saat offline). Tidak ada tombol hapus.
4. **Tunai belum terkirim dari tablet: SELESAI. Tutup paksa supervisor: SELESAI (`e4ae678ce`).** Jalur nyata di `shift-extra-api.ts` (+ `force-close-store.ts` menyimpan persetujuan penyaksi per perangkat); layar supervisor menampilkan tombol "Tutup paksa shift" saat tinjauan biasa belum tersambung; alasan ditulis supervisor (>= 10 huruf). Test: `apps/web/test/pos-force-close-wire.test.ts` (11, gagal-dulu di `2ab16ba04`). Catatan lama: `offline/offline-close-block.tsx` di `/pos/shift/tutup` menahan hitung laci selama antrean ada (jumlah, disisihkan, tunai dari tablet, buka antrean, petunjuk tutup paksa). Sisa: UI tutup paksa supervisor masih `CONTRACT_PENDING` di luar mock (`shift-extra-api.ts` `local(...)`: `fetchForceCloseView`, `submitForcedCount`, `witnessForcedCount`, `forceCloseShift`). Jalur API nyata: hitungan paksa supervisor (`POST .../counts`, caller bukan kasir, izin `shift.cash.approve_close`, `forced=true`) -> override `cash_shift_close` objek `pos_shift_count` dengan PIN penyetuju (bukan pemanggil/kasir, `requestOverride`) -> `POST .../force-close {countId, note >= 10, approvedBy, approvalRequestId, idempotencyKey}`. Server menandai `offline_queue_unverified` dan alert Finance (O3).
5. **Cetak: SELESAI (tanpa cetak).** Cetak tablet butuh job ESC/POS dari cloud, jadi dialog tersimpan menampilkan nomor `L1-000043` + "Cetak ulang sesudah online". **Catat ke O5:** cetak struk penjualan offline sesudah sinkron (nomor `receiptNumber` dari hasil batch).
6. **Dialog keluar: SELESAI.** `offline/sign-out-blocked-dialog.tsx` ("Belum bisa keluar", Tetap di sini / Buka kasir).

## Review K (docs/qa/1272-o4-review.md), 27 Nov: DIBETULKAN (`da86a337a` test gagal-dulu, `0876109d7` fix)
- P1: link "Tutup paksa oleh supervisor" ke `/pos/supervisor/shift/$shiftId` di `OfflineCloseBlock` (shiftId dari `blind-count-screen`), di 409 `OFFLINE_QUEUE_UNVERIFIED` (`OfflineUnverifiedNotice` di `shift-waiting`), dan tiap shift terbuka di tutup hari (`day-close/open-shift-links.tsx`, `fetchOpenShiftsOfDay` lewat `listPosShifts?businessDate`).
- P2 1: `sale-guard` tahan bila satu baris (item, varian, opsi) sama dengan pesanan belum pasti. P2 2: `noPermission` tanpa `pos.payment.accept`. P2 3: ping `mode: "cors"`, status >= 500 = gagal (API sudah CORS untuk trusted origins; test `apps/api/src/test/health-cors.test.ts`).
- P3: tombol tutup paksa juga untuk `COUNT_NOT_SUBMITTED` (`offersForceClose`); saksi lewat `thirdPersons`/`sameUser` (`shift-extra-logic.ts`).
- Test: `apps/web/test/pos-offline-o4-review.test.ts` (5), detect (+4). Pra-gate lulus: prettier, eslint, text-contract + i18n-area-split, typecheck api + web.

## Screenshot (Keputusan CTO 27 Nov, opsi B)
- Mode mock: `e2e/o4-offline.mock.spec.ts` (8 test lulus), 5 adegan x 390/1280 di `docs/review/img/o4-{banner-tanpa-bekal,paksa-hitung,paksa-saksi,paksa-siap,paksa-selesai}-{390,1280}.png`.
- Spec API nyata `e2e/o4-offline-shots.spec.ts` buntu: SSR `/api/me/access` di localhost tidak punya tenant (domain `localhost` ditolak `normalizeHostname`) -> `/pos/kasir` 404. Adegan bayar, tersimpan, antrean, tutup, keluar pindah ke O5 dengan domain tenant tes.

## Lain-lain
- Teks: namespace baru `posKasirOffline` (chunk `ops`), tambahan `posOffline.signOut*` (core).
- Test UI: `apps/web/test/pos-offline-o4-ui.test.ts` (8): simpan masuk antrean dengan nomor L, metode online tidak ditawarkan, tutup shift/keluar ditolak, tampilan disisihkan, banner.
- Pra-gate lulus: prettier, eslint, text-contract + i18n-area-split, typecheck web.

## Sisa
- Screenshot `docs/review/img/o4-*-{390,1280}.png`: BELUM ADA gambar. Spec opt-in sudah ditulis tapi BELUM PERNAH dijalankan: `e2e/o4-offline-shots.spec.ts` (dilewati tanpa `O4_SHOTS=1`). Isinya: menanam tenant, kasir, dua supervisor (PIN penyaksi), dua perangkat, menu dine-in/takeaway, pajak; membuka shift lewat API; ping `/api/health` diblok dengan `page.route`; scene banner, bayar, tersimpan, antrean, tutup, keluar, paksa-hitung, paksa-saksi, paksa-siap, paksa-selesai.
  - Jalankan: `O4_SHOTS=1 heavy --browser pnpm test:e2e` (build produksi + semua spec e2e non-mock). Hasil di `test-results/screenshots/legend-wasr7.8/`; salin ke `docs/review/img/`.
  - Risiko yang belum dicek: pemilih staf aktif / gerbang PIN di `/pos/kasir`, label pecahan uang (`/^Rp\s?100\.000$/`), nama tombol "Sign out", pilihan outlet otomatis, waktu deteksi offline (tunggu sampai 40 detik).
- Belum diuji di browser nyata: alur bayar offline end-to-end (O5 drill).
