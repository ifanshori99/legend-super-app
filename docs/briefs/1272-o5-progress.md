# O5 legend-wasr7.9 progress

## Langkah 1 (27 Nov): test gagal-dulu

- Dibuat: apps/web/test/pos-offline-o5.test.ts (guard "pelanggan lain", fetchOpenShiftsOfDay semua halaman, saveOfflineSale).
- Ditambah: test antrean di apps/web/test/pos-offline-queue.test.ts; 2 test API di apps/api/src/test/pos-offline-batch.test.ts (flag other_customer).
- Rancangan wajib rilis (1): event offline dapat `otherCustomerReason` (4-200 huruf, opsional) -> flag baru `other_customer` di jsonb flags (tanpa migrasi) -> alert `offline_sale.review_needed` ke supervisor memuat alasan. Uang tetap masuk laci shift (bukan shift_closed).
- Rancangan wajib rilis (2): fetchOpenShiftsOfDay tanpa businessDate, ikuti nextCursor sampai habis, saring open.
- Belum: implementasi, e2e browser nyata, screenshot, drill.

## Langkah 2 (27 Nov): wajib rilis (1) dan (2) selesai

- (1) shared: `otherCustomerReason` + flag `other_customer`; API ingest memberi flag dan alert ke supervisor dengan alasan; web: guard, dialog "Ini pelanggan lain", antrean membawa alasan. Uang: replay tetap `duplicate`, kas tetap di laci shift terbuka.
- (2) fetchOpenShiftsOfDay: semua halaman, tanpa businessDate.
- Test terarah hijau: o5 (web), queue, o4-detect/review/ui, pos-offline-batch (API 26). Prettier, eslint, text-contract hijau.
- Berikut: typecheck api+web, e2e browser nyata, screenshot, drill.

## Langkah 3 (27 Nov)

- Typecheck api 0 error, web 0 error (heavy). Drill ditulis: docs/qa/1272-o5-drill.md.
- e2e browser nyata TERHENTI (butuh keputusan CTO), lihat laporan: browser harus bicara ke web+API lewat host tenant (`<slug>.legend.test`), padahal build e2e menanam VITE_API_URL=localhost:4101 (lintas situs, cookie SameSite tidak ikut), guard `/pos/kasir` (context.access) diambil per host, token perangkat dan service worker offline di build produksi. Tidak dibuat spec rapuh.

## Keputusan CTO O5 (27 Nov, sesudah laporan 1)

1. e2e browser: config terpisah `playwright.offline.config.ts` meniru produksi (API `http://api.legend.test:4101`, build web `VITE_API_URL=http://api.legend.test:4101`, `COOKIE_DOMAIN=.legend.test`, Chromium `--host-resolver-rules="MAP *.legend.test 127.0.0.1"`, buka `http://<slug>.legend.test:3101/pos/kasir`; seed tenant_domains seperti pos-real). Env tambahan hanya di config e2e. Berhenti dan lapor penyebab persis bila buntu sesudah 1 percobaan nyata.
2. `fetchOpenShiftsOfDay`: filter opsional `status` di API daftar shift + web memakainya + semua halaman.
3. Gagal-dulu API: implementasi API (1) dan (2) dibalik sementara, test dijalankan, dipulihkan.

## Hasil keputusan 2 dan 3

- API: `listPosShifts` query `status` (open|closed, strict zod, opsional). Web kirim `status=open`, tanpa businessDate, semua halaman.
- Gagal-dulu (implementasi API dibalik): pos-offline-batch "O5 (1)" GAGAL (flag/alasan tidak dikenal, skema strict menolak); pos-shift "O5 (2)" GAGAL (`expected 422 to be 200`, status ditolak). Dipulihkan: pos-offline-batch 26 lulus, pos-shift 88 lulus, web o5 6 lulus.
- Catatan: guard DB melarang mengubah business_date shift, jadi test API tidak memundurkan tanggal; "tanpa batas hari" dibuktikan lewat daftar tanpa businessDate + gabungan status=open&businessDate=lain kosong.

## Langkah 4: harness e2e offline (27 Nov)

- Dibuat: `playwright.offline.config.ts`, `e2e-offline/pos-offline.spec.ts`, mode `e2e-offline` di `scripts/test.mjs` (API `api.legend.test:4101`, web `o5-offline.legend.test:3101`, `COOKIE_DOMAIN=.legend.test`, `LEGEND_E2E_SKIP_BUILD=1` untuk iterasi spec).
- Percobaan 1 gagal: API `NODE_ENV=development` crash (pino-pretty worker, `__dirname` di bundle ESM). Dipindah ke `NODE_ENV=test` (tanpa pretty, aturan https produksi tak disentuh). Web tetap production.

## Langkah 5: e2e offline, hasil sesudah percobaan nyata (27 Nov)

Harness TERBUKTI jalan: build web `VITE_API_URL=http://api.legend.test:4101`, API `NODE_ENV=test` (production menolak http non-localhost; development crash pino-pretty di bundle), `COOKIE_DOMAIN=.legend.test`, Chromium `--host-resolver-rules`, tenant_domains diseed, sign-in lewat browser di host tenant, buka shift, `/pos/kasir` tampil dengan menu, bekal offline terambil, `context.setOffline(true)` memunculkan banner "Offline · penjualan disimpan di tablet" (screenshot `docs/review/img/o5-banner-390.png`).
Buntu di langkah jual (penyebab persis):

1. Di viewport 390, klik tile menu "Kopi Susu" (server asli, online maupun offline) TIDAK menambah item: bar tetap "Keranjang kosong", "Lihat keranjang" membuka `?v=keranjang` dengan "Keranjang masih kosong". Penyebab belum diketahui (bukan modifier dialog, bukan soldOut; perlu trace UI/`pick` di `cashier-main-screen.tsx`). Spec o4 mock tidak punya masalah ini.
2. Temuan produk (bukan harness): di 390 saat offline, "Lihat keranjang" (navigasi `?v=keranjang`) menjatuhkan halaman ke layar "Terjadi kesalahan" karena navigasi router butuh jaringan. Tablet lebar (>700 px) tidak memakai tampilan keranjang terpisah, jadi aman; tapi ponsel offline rusak. Perlu keputusan CTO: perbaiki (O3/O4) atau terima.
   Belum dijalankan: bayar/tersimpan/antrean/tutup ditahan/ingest sesudah online/keluar, dan screenshot 390/1280 lainnya. Spec `e2e-offline/pos-offline.spec.ts` berisi skenario lengkap (WIP, di luar suite default). Jalankan: `heavy --browser node scripts/test.mjs e2e-offline` (`LEGEND_E2E_SKIP_BUILD=1` memakai build terakhir).

## Langkah 6: crash keranjang 390 offline diperbaiki, e2e hijau (27 Nov)

- Akar masalah crash "Lihat keranjang" offline (bug rilis, bukan harness): `beforeLoad` root membaca sesi, brand tenant, dan akses lewat server function (`getSessionFn`, `getTenantBrandFn`) di TIAP navigasi klien. Tanpa internet panggilan itu gagal (`TypeError: Failed to fetch`) dan seluruh app jatuh ke "Terjadi kesalahan". Berlaku juga untuk pindah layar apa pun saat offline.
- Fix: `apps/web/src/lib/offline-navigation.ts` (`loadWithOfflineFallback`): bila jaringan hilang dan sudah ada konteks sebelumnya, konteks terakhir dipakai (hanya presentasi; API tetap mengautentikasi tiap request). `__root.tsx` menyimpan konteks terakhir, termasuk yang dibawa hidrasi dari SSR (tanpa itu, halaman pertama tidak punya cadangan). Kesalahan non-jaringan tetap dilempar.
- Test gagal-dulu: `apps/web/test/offline-navigation-context.test.ts` gagal (modul belum ada), lalu 5 test hijau; e2e nyata sebelum fix: "Terjadi kesalahan" di `?v=keranjang` offline; sesudah fix: keranjang terbuka offline.
- Klik "Kopi Susu" tidak menambah item = bukan bug produk: `crypto.randomUUID` hanya ada di secure context, produksi https; origin http e2e bukan secure context. Harness memasang shim `randomUUID` lewat `addInitScript` (hanya di e2e, kode produksi tak disentuh). Flag Chromium `--unsafely-treat-insecure-origin-as-secure` tidak berpengaruh.
- e2e offline HIJAU (`heavy --browser node scripts/test.mjs e2e-offline`, 1 passed, ~1,4 mnt): bayar offline 390 + 1280, tersimpan, antrean, tutup shift ditahan (antrean tidak kosong; endpoint batch diblok sementara), keluar ditahan ("Belum bisa keluar", dari /member karena frame kasir tak punya tombol keluar), ingest sesudah online (2 penjualan, total 27500, tanpa duplikat, 2 order), tutup bebas sesudah antrean kosong. Screenshot `docs/review/img/o5-*.png` (390 dan 1280).
- Typecheck api 0 error, web 0 error (sesudah filter status). Test web 28 hijau (navigasi offline, o5, queue). eslint dan prettier hijau.
- Temuan di luar lingkup (perlu keputusan): navigasi klien OFFLINE ke layar yang chunk-nya belum pernah dimuat (mis. `/pos/shift/tutup` saat offline) gagal: chunk route tidak ada di cache service worker dan guard `cashierShiftGuard` butuh API. Perlu keputusan produk (pramuat chunk saat online, atau layar tutup shift offline). Skenario e2e membuka layar tutup shift saat online dengan endpoint batch diblok.

## Langkah 7: keputusan CTO poin 6 (27 Nov), tutup shift offline

- (a) Build menulis `pos-precache.json` (plugin `apps/web/vite-pos-precache.ts`): chunk semua rute `pos.*` + seluruh impor (statis dan lazy) + CSS, 236 file, sekitar 2,3 MB. `public/sw.js` menyimpannya saat install dan di tiap refresh shell (sw.js tidak berubah antar deploy, jadi install tidak jalan lagi; nama chunk ber-hash baru terbaca lewat refresh). ASSET_LIMIT 400 jadi 1200.
- (b) Premis berbeda: `cashierShiftGuard` hanya cek izin dari konteks, tanpa jaringan. Yang butuh jaringan: layar `BlindCountScreen` (`useActiveShift`). `offline/close-gate.ts` (`closeScreenMode`): bila bacaan shift gagal di jaringan dan tablet memegang kit shift terbuka (status shift terakhir yang tersimpan lokal), layar tidak jadi error muat, tetapi "butuh internet".
- (c) `offline/close-needs-internet.tsx`: "Tutup shift butuh internet", form hitung kas tidak muncul, hanya tombol "Kembali ke kasir"; menyebut jumlah penjualan offline yang menunggu. Teks di katalog `posKasirOffline.closeNeedsInternet`.
- Test gagal-dulu: `pos-offline-close-gate.test.ts` dan `pos-precache-manifest.test.ts` gagal (modul belum ada), lalu 8 test hijau.
- e2e: langkah baru, navigasi klien offline ke `/pos/shift/tutup` yang belum pernah dimuat, layar "butuh internet", screenshot `o5-tutup-offline-390/1280.png`. HIJAU (1 passed).
- Koreksi harness: service worker dan Cache API hanya ada di secure context, jadi e2e sebelumnya tidak menjalankan service worker sama sekali. Spec kini memakai konteks persisten dengan `channel: "chromium"` (headless baru) dan `--unsafely-treat-insecure-origin-as-secure`; headless shell lama mengabaikan flag itu. `isSecureContext` ditegaskan true. Shim `randomUUID` dibuang (tak perlu lagi).
- Catatan: `tests/panic-push-service-worker.test.mjs` sudah gagal di HEAD sebelum perubahan ini (3 test mencari listener push yang tak ada di sw.js); tidak disentuh.
- Menyentuh konteks sesi root (`__root.tsx` dari langkah 6): review K architect menyusul.

## Langkah 8: perbaikan Review K O5 (27 Nov): 1 P2 + 6 P3, semua selesai

- P2 sign-out: `forgetRootContext()` + `queryClient.clear()` sebelum `router.invalidate()` (`sign-out-button.tsx`); memori konteks pindah ke `lib/offline-navigation.ts` (`rememberRootContext/recallRootContext/forgetRootContext`). Test gagal-dulu: `offline-navigation-context.test.ts` (setelah forget, jaringan putus tidak lagi menampilkan akun lama) dan `tests/push-registration-web.test.mjs` (clear dan forget setelah signOut; mock modul O3 yang hilang ditambah, 2 test lama sudah gagal sebelum ini karena penjaga O3).
- P3-1: hanya `navigator.onLine === false` atau pesan gagal-fetch (Failed to fetch, Load failed, NetworkError) yang dianggap offline; TypeError biasa dilempar. Test gagal-dulu.
- P3-2/3: `sw.js` membuang dulu aset yang bukan milik deploy sekarang (shell + daftar precache); `pos-precache.json` diambil dengan `cache: "no-cache"`. Test baru `tests/pos-sw-precache.test.mjs` (gagal-dulu terbukti).
- P3-4: alert `other_customer` juga ke owner (`alsoOwners`). Test API gagal-dulu: owner tidak ada di penerima, lalu hijau (27 test).
- P3-5: `setOtherReason(null)` di tiga jalur `cart.clear()` (park, parkir lalu pulihkan, kirim ulang park). Tanpa test otomatis (state komponen; web test berjalan di node tanpa render).
- P3-6: `fetchOpenShiftsOfDay` berhenti bila `nextCursor` sama dengan kursor sebelumnya. Test gagal-dulu (loop tak berakhir).
- Pra-gate: prettier, eslint, text-contract, typecheck api+web hijau; test web 40 hijau, API pos-offline-batch 27 hijau, root 33 hijau; e2e offline ulang HIJAU (1 passed).
