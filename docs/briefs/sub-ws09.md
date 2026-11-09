# Sub-brief WS-09 (brief 97): fasilitas generik, WFC, Wi-Fi

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ws-09-ws`, cabang `ws/ws-09-ws` (dari `milestone/m1` f77e18d8). Kerja HANYA di worktree ini. Jangan commit (agent yang commit). Jangan push.

PRD: `../../../PRD_Legend_Super_App_v1.7.md` baris 841-890 (§25 Akses Fasilitas + Wi-Fi Tamu & WFC, kriteria FAC-01..15). Detail kartu: `bd show <id>` (jalankan dari `/Users/ifanshori99/Projects/legend super app/legend`).

## Cakupan founder
- Kamar mandi (shower) dan smart lock DITUNDA (legend-3dm8, bzih, 2ke, s20 deferred). Jangan bangun fitur khusus shower/lock. Model fasilitas generik, WFC, dan Wi-Fi tetap masuk rilis.
- Wi-Fi vendor belum dipilih (legend-6ybb EXT). Selalu lewat `WifiProvider` (`packages/shared/src/adapters/providers.ts:265`) dan simulator `FakeWifiProvider` (`adapters/fakes.ts:262`). Jangan hardcode vendor.

## Peta kode (sudah dipetakan)
- Kontrak: `packages/shared/src/facility/{endpoints,inputs,schemas,entitlement,wifi,events}.ts`. Endpoint pakai `defineEndpoint`. Array `facilityEndpoints` di `endpoints.ts` ~460. Pola `expectedUpdatedAt: isoDateTimeSchema` di `operations/endpoints.ts:171`; `idempotencyKeySchema` di `facility/inputs.ts:81`.
- API: `apps/api/src/routes/facility.routes.ts` (gate `operate`/`manage` baris 92-93, `requireMenuPermission`), mount `routes/index.ts:154`. Services `apps/api/src/services/facility-*.ts`. Audit `facility-shared.ts:236` (`auditFacility`). Idempotency generik `operations-idempotency.ts:50,84`. Permission `middleware/permissions.ts:153,313`.
- Worker: `apps/api/src/worker-main.ts:208-215` sudah memanggil `releaseExpiredSlotHolds`.
- DB: `apps/api/src/db/schema/facility.ts`. Migration terakhir 0087.
- Test API: `apps/api/src/test/facility-api.test.ts`, `facility-config-api.test.ts`, `facility-slots-db.test.ts`.
- Web: mock dimuat glob `apps/web/src/lib/mock/transport.ts:12` (`features/*/mock.ts`, `features/*/*-mock.ts`, `lib/mock/handlers/*.ts`). Satu mock per route (guard duplikat).
- Laporan: `packages/shared/src/dashboard/{catalog,metric-catalog,fixtures,dashboards}.ts`; web `features/facility-report/{lib,mock}.ts`, route `apps/web/src/routes/_kelola/reports.facility.*.tsx`.

## Invarian (semua potongan)
- Tidak ada migration baru tanpa lapor dulu ke agent (berhenti, jelaskan kenapa perlu).
- Semua tulis: audit (`auditFacility`), tenant + outlet scoped, tolak lintas outlet (test 403/404 lintas outlet wajib).
- Data pelanggan: hanya milik pelanggan yang login (customer auth). Jangan bocorkan data pelanggan lain atau config staf.
- Tidak ada jenis kelamin di profil (FAC-09).
- Ikuti pola file sekitar. Komentar yang ada jangan dihapus.
- File bersama yang disentuh >1 potongan (`facility/endpoints.ts`, `routes/index.ts`, `facility/index.ts`): edit sekecil mungkin (1-3 baris); bila Edit gagal karena file berubah, baca ulang lalu ulangi.
- Bukti selesai: `pnpm --filter <pkg> exec tsc --noEmit` (atau typecheck paket) + vitest file test milikmu lulus. Jangan jalankan `pnpm check` penuh, jangan jalankan build/Playwright. Jangan `pkill` proses test.
- Laporan akhir: file berubah, perintah test + hasil, sisa/risiko. Ringkas.

## Potongan

### S1 — kontrak + BE baca pelanggan (legend-humf, legend-zjfi, legend-t3dl) [tingkat K]
- Tujuan: (a) `GET /api/facility/catalog?facilityId=` untuk tamu: nama, jam operasional, durasi sesi, produk aktif + harga (day pass WFC, reservasi kursi per jam), add-on aktif, plan langganan aktif. Ini juga menutup humf (produk + harga). (b) `GET /api/facility/entry/:token` resolve token QR pintu/meja ke fasilitas (cek apakah ada kolom token; bila tidak ada, laporkan dan pakai identifier publik yang ada — JANGAN migration tanpa lapor). (c) `GET /api/facility/entitlements/current` saldo hak akses pelanggan + grant yang bisa ditukar (expiresAt, source) memakai `entitlementBalance()` di `packages/shared/src/facility/entitlement.ts`.
- File milik: baru `packages/shared/src/facility/customer.ts` (schema + endpoint), tambah 1 baris spread ke `facilityEndpoints` dan 1 baris export di barrel facility; baru `apps/api/src/services/facility-customer.service.ts`, baru `apps/api/src/routes/facility-customer.routes.ts` (mount 1 baris di `routes/index.ts` atau di bawah facilityRouter tanpa menyentuh route lain), baru `apps/api/src/test/facility-customer-api.test.ts`, baru `apps/web/src/features/facility/customer-mock.ts` (mock 3 endpoint dari fixture).
- Auth: pelanggan login (pola customer auth yang dipakai ticket booking `bookAccessTicket`); catalog dan entry boleh publik tanpa login bila tidak ada data pribadi (FAC-11: halaman pesan dapat diakses tanpa login Wi-Fi). Tanpa config staf (aturan internal, biaya) di respons publik.

### S2 — BE insiden + daftar plan (legend-1cj0)
- Route `raiseFacilityIncident` POST /incidents, `respondFacilityIncident` POST /incidents/:incidentId/respond, `listSubscriptionPlans` GET /subscription-plans sesuai skema kontrak yang SUDAH ada (jangan ubah kontrak). Gate: raise/respond `booth.operate`, list plan publik/pelanggan sesuai pemakaian di web (`features/ws09-wifi`, facility-staff). Idempotency, audit, test vitest termasuk lintas outlet ditolak.
- File milik: `apps/api/src/services/facility-incidents.service.ts`, baru `apps/api/src/routes/facility-incidents.routes.ts` (dipasang ke facilityRouter lewat 1-2 baris di `facility.routes.ts` atau mount di `routes/index.ts`), baru `apps/api/src/test/facility-incidents-api.test.ts`. Service plan: fungsi baru di file baru `apps/api/src/services/facility-plans.service.ts` bila belum ada pembaca.

### S3 — tulis config admin (legend-6jms, legend-nngz, legend-wbwl) [tingkat K]
- 6jms: tambah `expectedUpdatedAt` pada input PATCH/PUT config fasilitas (facility, area, unit, product, addon, entitlement-rule, plan, wifi-policy) dan `idempotencyKey` pada POST create. API: tolak 409 bila `updatedAt` tidak cocok; POST ulang dengan key sama mengembalikan hasil pertama. Perubahan harga/kuota tercatat di audit (nilai lama + baru).
- nngz: endpoint admin create/update yang belum ada (cek: create facility, `updateFacility` PUT /facilities/:facilityId, update unit, dst.) supaya data tidak lagi butuh seeding SQL. Pastikan tiap endpoint admin di kontrak punya route.
- wbwl: `apps/web/src/features/facility/mock.ts` `getFacilityConfig` (~604-621) membaca store admin dari `features/facility-admin/mock.ts:78` (export getter) supaya edit admin (termasuk `putWifiPolicy`) bertahan setelah refetch di mode mock. Admin web mengirim `expectedUpdatedAt`/`idempotencyKey` baru (api/hook facility-admin) dan mock memeriksa konflik.
- File milik: `packages/shared/src/facility/inputs.ts`, bagian admin `facility/endpoints.ts`, `apps/api/src/routes/facility.routes.ts` (kecuali 1-2 baris mount S2), `apps/api/src/services/facility-{config,products,units}.service.ts`, `apps/api/src/test/facility-config-api.test.ts`, `apps/web/src/features/facility-admin/**`, `apps/web/src/features/facility/mock.ts`.

### S4 — antrean + sweeper (legend-ke4z, legend-bj5m)
- ke4z: entri antrean `notified` kedaluwarsa setelah jendela klaim (konfigurasi atau konstanta jelas) lalu antrean maju; `computeWaitEstimate` (`facility-slots.service.ts:150`) memperhitungkan hold yang mulai sebelum turnEnd (unit bebas tapi ada hold → bukan 0). LOW-6 (guest booking) DITUNDA ikut legend-bzih: jangan ubah gate route antrean.
- bj5m: sweeper sudah dipanggil di worker (`worker-main.ts:208-215`). Pastikan sweeper juga mengekspirasi entri `notified` (ke4z) dan "customer resolver wiring": cek `bd show legend-bj5m` dan TODO di service; lengkapi wiring resolver pelanggan untuk notifikasi antrean bila masih stub. Bila ternyata sudah lengkap, laporkan bukti.
- File milik: `apps/api/src/services/facility-slots.service.ts`, `apps/api/src/services/facility-queue.service.ts`, `apps/api/src/worker-main.ts` (blok facility saja), `apps/api/src/test/facility-slots-db.test.ts` atau baru `facility-queue-expiry.test.ts`.

### S6 — laporan fasilitas (legend-wfua, legend-vhgt)
- wfua: definisi laporan baru di katalog: kelebihan waktu (overtime), waktu pembersihan, insiden, pendapatan per produk, utilisasi per unit per jam. Baris metric-catalog bila perlu, fixture run, kode di `FACILITY_REPORT_CODES`, data mock, route `_kelola/reports.facility.<kode>.tsx` meniru route laporan facility yang ada persis (tanpa desain baru).
- vhgt: split `unit` (booth/bilik) di katalog laporan fasilitas (revenue/occupancy/F&B) terpisah dari split `facility`.
- File milik: `packages/shared/src/dashboard/{catalog,metric-catalog,fixtures,dashboards}.ts`, `apps/web/src/features/facility-report/**`, route baru `apps/web/src/routes/_kelola/reports.facility.*.tsx`. Jangan sentuh `routeTree.gen.ts` manual (biar generator; bila test butuh, regen lewat script repo yang ada). Test: test katalog dashboard yang ada (`packages/shared` vitest) + test facility-report web bila ada.

### T1 — test-writer e2e Wi-Fi (legend-emcy)
- Spec Playwright mock baru `e2e/legend-emcy-wifi-policy.mock.spec.ts`: buka konfigurasi fasilitas → tab Wi-Fi (`features/facility-admin/components/wifi-tab.tsx`), ubah jam ramai / minimum spend / kuota, simpan, reload/refetch → nilai bertahan (FAC-14); input tidak valid (jam akhir < jam mulai, angka negatif) ditolak dengan pesan. Contoh pola: `e2e/legend-er32.mock.spec.ts`. Jangan jalankan Playwright (agent menjalankan lewat `heavy` setelah S3 selesai). Hanya file spec baru.

## F1 — fix review Opus (setelah commit 1796b072)
1. `GET /api/facility/subscription-plans` dipakai portal Wi-Fi pelanggan (`apps/web/src/routes/_customer/wifi.tsx`, `features/ws09-wifi/api.ts:47`). Pindahkan ke `facility-customer.routes.ts` sebagai publik (tenant dari host, rate limit, masukkan ke `PUBLIC_RATE_LIMIT_PATHS`), pakai mapper allow-list yang sama dengan plan di catalog (tanpa `providerPlanId`). Hapus versi gate `operate` di `facility-incidents.routes.ts`. Sesuaikan test (`facility-incidents-api.test.ts`, `facility-customer-api.test.ts`).
2. Balapan sweeper vs klaim: `facility-slots.service.ts` `expireStaleQueueNotifications` ambil `lockFacilitySlots(tx, tenantId, facilityId)` per fasilitas sebelum mengekspirasi; DAN update `converted` di `holdFacilitySlot` diberi predikat status (`waiting`/`notified`), 0 baris → tolak klaim (409 klaim kedaluwarsa). Tambah test.
3. Stale write: samakan dengan konvensi repo `CoreError("PRECONDITION_FAILED", ...)` (lihat `inventory.service.ts:529`) menggantikan 409 `FACILITY_CONFIG_STALE`; sesuaikan test dan penanganan pesan di `features/facility-admin` bila memeriksa kode.
4. Web: panggilan raise incident (facility-staff, cari `raiseFacilityIncident` di `apps/web/src/features`) selalu kirim header `Idempotency-Key` (pola mint key yang ada di web).
Bukti: tsc api+web, vitest file terdampak lewat `LEGEND_TEST_FILES=... heavy pnpm test`.
