# Decisions

Technical decisions the PRD leaves open. Newest first. Each entry names its
bead so the code comments and tests can be traced back.

## 2026-11-10: Laporan harian tanpa pesanan latihan (legend-fbxzw)

Konteks: rekap akhir hari (`computeRecap`, `pos-day.service.ts`) masih
menjumlahkan pesanan latihan, tidak sejalan dengan kas shift (legend-0v3b3) dan
laporan WS-11. Tingkat S.

Keputusan: rekap mengecualikan pesanan latihan dari SEMUA bagiannya (himpunan
penjualan, tender captured per metode, void, refund) lewat `reportablePosOrders()`.
Bila hanya tender yang dikecualikan, pemeriksaan keseimbangan (tender sama
dengan total penjualan) melempar CONFLICT, jadi keempatnya harus sama.
Lanjutan (keputusan CTO, Q63: latihan tidak boleh memengaruhi operasi nyata):

1. **Pesanan latihan yang menggantung tidak menahan tutup hari.** Pemeriksaan
   "masih ada pesanan yang belum selesai" di `closePosDay` memakai
   `reportablePosOrders()`. Pesanan nyata yang belum selesai tetap menahan.
2. **Bagian shift dan kas rekap tidak difilter latihan, dengan bukti.** Shift
   khusus latihan memang bisa ada: `pos_shifts` tidak punya penanda latihan
   (`db/schema/pos-shift.ts:49-75`), buka shift tidak memeriksa mode latihan
   (`pos-shift.service.ts:161-249`), dan `setDeviceTrainingMode`
   (`device.service.ts:507-556`) tidak melihat shift terbuka, jadi mode bisa
   dialihkan di tengah shift dan satu shift berisi pesanan nyata dan latihan
   (`pos_orders.shift_id` tidak dicek terhadap `is_training`,
   `pos-order.service.ts:719-744`). `cash_movements` (`pos-shift.ts:341-375`)
   tidak punya penanda latihan dan tidak punya `device_id`. Baris shift, selisih,
   dan kas kedaluwarsa adalah keadaan laci uang sungguhan: kasir menghitung dan
   memindahkan uang fisik. Selisih itu sudah dihitung tanpa tunai latihan
   (legend-0v3b3) dan dijurnal saat tutup shift
   (`cashier_shift.closed`). Menyembunyikan shift dari rekap akan membuat rekap
   tidak sejalan dengan buku besar dan bisa menyembunyikan kas nyata pada shift
   campuran, jadi bagian ini dibiarkan. Bila founder ingin shift latihan murni
   disembunyikan, perlu penanda latihan pada `pos_shifts` (migrasi) lebih dulu.

## 2026-11-10: Pesanan latihan: kas shift dan stok (legend-0v3b3, legend-13avp)

Konteks: lanjutan legend-gkc6b. Review architect menemukan tutup shift masih
menghitung tender tunai pesanan latihan ke kas yang diharapkan, dan founder
(Q63) memutuskan pesanan latihan tidak memotong stok. Tingkat K (uang).

1. **Kas shift (legend-0v3b3).** `computeShiftAggregates` mengecualikan tender
   tunai, refund tunai, dan void tunai milik pesanan latihan lewat `LEFT JOIN
   pos_orders` dan `is_training = false`. Baris tanpa pasangan `pos_orders`
   (QR bayar-dulu) tetap dihitung. Alasan: uang latihan tidak pernah masuk laci,
   jadi shift campuran tidak boleh mencatat selisih palsu. Satu fungsi ini juga
   dipakai hitung buta, penjaga kas, dan tutup paksa, jadi semuanya ikut benar.
   Laporan harian (`pos-day.service.ts`) hanya tampilan dan tidak diubah.
2. **Stok (legend-13avp).** Konsumen `recipe-deduction` melewati pesanan
   latihan: `order.paid` dan `order_issue.recorded` (remake, comp) tidak
   membuat baris `recipe_deductions`, `stock_ledger`, maupun `stock.moved`;
   `order.voided` pesanan latihan tanpa deduksi tidak meninggalkan tombstone.
   Pemeriksaan di konsumen (bukan penerbit) dengan alasan yang sama seperti
   legend-gkc6b.
3. **Data lama.** Void pesanan latihan yang sudah punya deduksi tetap
   membalik. Deduksi `pending` milik pesanan latihan dilewati saat `day.closed`
   dan tetap `pending`. Deduksi latihan yang sudah `posted` tidak dikoreksi.

## 2026-11-10: Pesanan latihan tidak boleh menjurnal (legend-gkc6b)

Konteks: `accounting-auto-journal` dan jembatan stok ke buku besar
(`inventory-gl-consumer`) tidak memeriksa `pos_orders.is_training`. Event
`order.paid` terbit untuk tiap penjualan, jadi penjualan Mode Latihan masuk
buku besar sebagai pendapatan dan HPP, sedangkan laporan WS-11 sudah
mengecualikannya (legend-fr62g). Selisihnya muncul sebagai baris "Penyesuaian
buku besar". Tingkat K (uang), ditinjau satu architect.

Keputusan: pemeriksaan ada di sisi konsumen, bukan di sisi penerbit event.

1. **Satu titik per konsumen.** `isTrainingOrder` (`services/device-training.ts`)
   dipanggil di `postAutoJournal` untuk `order.paid`, `order.refunded`,
   `order.voided`, dan di `postStockSourceToGl` untuk sumber `order`. Hasilnya
   `ignored`: tidak ada jurnal, tidak ada baris parkir.
2. **Alasan di konsumen.** Penerbit ada banyak (POS, QR, delivery, koreksi) dan
   payload event tidak membawa penanda latihan. Penerbit baru yang lupa
   menandai akan lolos. Konsumen membaca `is_training` dari `pos_orders` per
   orderId, jadi semua penerbit, pengiriman ulang, dan sweep ikut tertutup
   (sweep dan pengiriman pertama lewat fungsi yang sama). Tanpa kolom atau
   migrasi baru.
3. **Void dan refund ikut diabaikan, kecuali jurnal penjualannya sudah ada.**
   Tanpa pengabaian, keduanya diparkir `AUTO_JOURNAL_SALE_MISSING` selamanya
   karena jurnal penjualannya memang tidak ada. Bila jurnal `aj:sale:<id>` dari
   sebelum aturan ini sudah ada, void dan refund tetap membaliknya (juga
   `return` stok yang sumbernya sudah terposting), supaya buku tidak setengah
   terbalik. Sumber stok latihan yang dulu terblokir dilepas dari
   `inventory_gl_blocked`, supaya sweep tidak mengulanginya terus.
4. **Tidak ada baris `pos_orders`** (QR bayar-dulu, id tidak dikenal) bukan
   latihan: tetap menjurnal seperti biasa. Pesanan QR tidak punya mode latihan.
5. **Tidak diubah:** pemotongan stok `recipe-deduction` untuk pesanan latihan
   (PRD dan kode tidak punya aturan; hanya jurnal HPP-nya yang ditutup),
   `payment.*` (uang gateway sungguhan, bukan pesanan), settlement (berbasis
   bank). `cashier_shift.closed` tidak diperiksa di sini, tetapi
   `computeShiftAggregates` (`pos-shift-support.ts`) menghitung tender tunai
   pesanan latihan ke kas yang diharapkan, sehingga satu shift campuran bisa
   mencatat selisih kas palsu. Dilaporkan sebagai kartu terpisah.
6. **Data lama:** jurnal latihan yang sudah terbentuk sebelum perbaikan ini
   tidak dihapus atau dikoreksi otomatis; perlu keputusan finance.

## 2026-11-10: Audit retention purge with a dedicated maintenance identity (legend-usyi)

Context: `app.purge_expired_audit_logs(tenant)` (migration 0008) existed but
nothing scheduled it, and it only ran as the table owner. Audit rows are
append-only; only the owner may delete, and only rows 2 years or older
(PRD 2: "audit log ... 2 tahun"). Reviewed with an architect consult.

1. **Dedicated identity.** Group role `legend_maintenance` (NOLOGIN, NOBYPASSRLS,
   no table or sequence grant) plus login `legend_maint_<16hex>`, member only of
   that group, never of `legend_app`, owning nothing. Not a superuser, not a
   user identity. It reaches `audit_logs` only through two SECURITY DEFINER
   functions: `app.audit_retention_due_tenants()` and
   `app.purge_audit_retention_batch(tenant, batch)`.
2. **Passing FORCE RLS and the owner-only guard.** The functions are owned by the
   `audit_logs` owner, so `current_user` inside them is the owner and the
   existing guard trigger accepts the DELETE. The guard is unchanged: it still
   refuses rows younger than 2 years. Each function also sets
   `app.tenant_id` and filters on `tenant_id`, so it stays correct if the owner
   ever loses BYPASSRLS. Hardening: `search_path = pg_catalog, pg_temp`,
   schema-qualified names, no dynamic SQL, `REVOKE ALL FROM PUBLIC`, EXECUTE only
   to `legend_maintenance`. The old `purge_expired_audit_logs` is dropped.
3. **Per tenant, bounded batches.** Tenants with expired rows are listed (all
   statuses, so archived tenants are purged too). Each batch deletes at most
   1000 rows (`FOR UPDATE SKIP LOCKED`), one transaction per call; about 200
   batches per tenant and a 20 minute budget per run, the rest waits for the
   next day. A rerun deletes nothing and writes nothing.
4. **Trail.** Each batch that deletes rows inserts one `audit.retention_purged`
   row in the same transaction (actor type `system`; deleted count, cutoff,
   class). No ids, actors or content of deleted rows. A delete cannot land
   without its summary. The summary expires after its own 2 years.
5. **Scheduling and concurrency.** pg-boss queue `audit-retention-purge`, policy
   `exclusive`, cron `30 2 * * *` Asia/Jakarta, cloud worker only. `SKIP LOCKED`
   keeps two overlapping runs from double deleting, so no advisory lock.
6. **Config.** `MAINTENANCE_DATABASE_URL` in `worker.env` only (same host and
   database as the migration URL, different user from app and worker). Required
   at production start on the cloud worker; `verifyMaintenanceConnection`
   refuses a login that is in `legend_app`, has elevated attributes, owns an
   RLS table or is not in `legend_maintenance`.
7. **Not done.** Edge databases are not purged (follow-up bead). The only
   retention class is `audit_2y`; a class-to-days map is not introduced because
   the CHECK constraint allows one class.

## 2026-11-10: WS-12 provider AI per tenant (legend-dwrr)

Konteks: provider AI saat ini satu untuk seluruh platform (`AI_PROVIDER`,
`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` di `config/env.ts`, dibangun sekali
oleh `lib/ai/provider-factory.ts`). Semua panggilan model lewat `aiComplete`
(`services/ai-gateway.service.ts`) dengan `AccessSnapshot` yang membawa
tenant, jadi resolusi per tenant cukup diganti di satu titik. Tingkat K
(rahasia, akses): review architect, second-opinion Codex sebelum rilis.

1. **Tabel baru `ai_provider_configs`** di file baru
   `apps/api/src/db/schema/ai-provider.ts` (bukan di `ai.ts`, supaya tidak
   bertabrakan dengan cabang WS-12 lain). Satu baris per tenant:
   - `id` uuid PK `defaultRandom()`;
   - `tenant_id` `tenantIdColumn(() => tenants.id).notNull()`, `uniqueIndex`
     `ai_provider_configs_tenant_key` (satu config per tenant);
   - `connection_type` varchar(20) `$type<AiConnectionType>()` NOT NULL
     default `'api_key'`, CHECK `IN ('api_key','chatgpt_oauth')`.
     `chatgpt_oauth` hanya dicadangkan: service menolaknya, OAuth tidak dibangun;
   - `base_url` varchar(500) NOT NULL (sudah dinormalisasi, tanpa `/` akhir);
   - `default_model` varchar(200) NOT NULL;
   - `api_key_encrypted` text NULL (amplop `sealSecret`, base64);
   - `api_key_key_version` smallint NULL (byte versi amplop, untuk rotasi);
   - `api_key_last4` varchar(4) NULL;
   - `api_key_set_at` timestamptz NULL, `api_key_set_by` text NULL (user id);
   - `last_test_status` varchar(10) NULL, CHECK `IN ('ok','failed')`;
   - `last_tested_at` timestamptz NULL;
   - `last_test_error_code` varchar(40) NULL: **kode** dari katalog tetap
     (butir 9), bukan teks galat provider. Pesan untuk UI diambil dari katalog;
   - `created_at`, `updated_at` (`$onUpdate`).
   CHECK `ai_provider_configs_key_check`: `connection_type <> 'api_key' OR
   (api_key_encrypted IS NOT NULL AND api_key_key_version IS NOT NULL AND
   api_key_last4 IS NOT NULL)`. CHECK `ai_provider_configs_test_check`:
   `last_test_status IS NULL OR last_tested_at IS NOT NULL`.
2. **RLS** di `apps/api/src/db/schema/ai-provider.custom.sql`:
   `SELECT app.enforce_tenant_rls('public.ai_provider_configs'::regclass);`.
   Baris tingkat tenant, tanpa `outlet_id`, jadi tanpa outlet RLS. Tanpa
   SECURITY DEFINER: semua pembaca punya tenant dari `withTenant`.
3. **Migrasi** `apps/api/drizzle/0188_ai_provider_configs.sql`, satu migrasi:
   DDL hasil drizzle lalu isi `.custom.sql` di bawahnya (pola 0184). Journal
   `idx` 188, `when` 1794267000000, plus `meta/0188_snapshot.json`.
4. **Enkripsi: pakai `lib/secrets.ts`**, tanpa helper baru. AES-256-GCM dengan
   `DATA_ENCRYPTION_KEY` (wajib di production). AAD
   `ai_provider_config:<tenantId>:<rowId>`, jadi blob yang disalin ke baris
   atau tenant lain gagal dibuka. Id baris dibuat di service (`randomUUID()`)
   sebelum seal, untuk insert pertama. Versi: tambahkan ke `lib/secrets.ts`
   ekspor `sealedVersion(sealed)` dan `currentSealVersion()` (logika yang sama
   dengan `platform-integration.service.ts`; file itu tidak disentuh di cabang
   ini). Rotasi: `rotateAiProviderKeys()` di service membuka lalu menyegel ulang
   setiap baris yang `api_key_key_version` berbeda dari versi sekarang, pola
   `rotateIntegrationCredentials`. Dipasang di tempat yang sama dengan
   pemanggil `rotateIntegrationCredentials`.
   `api_key_last4` = 4 karakter terakhir kunci yang sudah di-trim. Kunci minimal
   16 karakter, jadi 4 karakter tidak membuka bagian berarti.
5. **Izin: pakai `ai.governance.manage`**, tanpa kode baru (kode baru =
   perubahan kontrak WS-00). Kode ini dipegang `tenant_admin` dan owner, bertag
   `access_admin`. Tidak ada rute Panel Platform di cabang ini (lihat
   pertanyaan founder).
6. **Kontrak** di file baru `packages/shared/src/ai/provider.ts`, diekspor dari
   `packages/shared/src/ai/index.ts`:
   - `AI_CONNECTION_TYPES = ["api_key","chatgpt_oauth"]`,
     `aiConnectionTypeSchema`, `AiConnectionType`;
   - `AI_PROVIDER_TEST_ERROR_CODES = ["URL_BLOCKED","REDIRECT_REFUSED",
     "TIMEOUT","AUTH_FAILED","NOT_FOUND","REQUEST_REJECTED","RATE_LIMITED",
     "PROVIDER_ERROR","NETWORK_ERROR","BAD_RESPONSE","KEY_UNREADABLE"]`,
     `aiProviderTestErrorCodeSchema`, plus `aiProviderTestErrorMessages`
     (teks Indonesia tetap, aman ditampilkan);
   - `aiProviderConfigSchema` (strict): `connectionType`, `baseUrl`,
     `defaultModel`, `hasKey: boolean`, `keyLast4: string(4) | null`,
     `keySetAt: isoDateTime | null`, `lastTest: { status: "ok"|"failed",
     testedAt, errorCode: code | null } | null`, `updatedAt`. **Tidak ada
     field kunci** di skema baca mana pun;
   - `aiProviderViewSchema` = `{ config: aiProviderConfigSchema | null,
     fallbackAvailable: boolean }` (`fallbackAvailable` = provider env ada);
   - `upsertAiProviderConfigInputSchema` (strict): `connectionType`,
     `baseUrl` (trim, 1..500), `defaultModel` (trim, 1..200,
     `/^[\w.:/@+-]+$/`), `apiKey?` (trim, 16..500, `/^\S+$/`). Tanpa
     `tenantId` (TEN-02);
   - `aiProviderTestResultSchema` = `{ status, testedAt, errorCode | null }`;
   - endpoint `getAiProviderConfig` GET `/api/ai/provider`,
     `upsertAiProviderConfig` PUT `/api/ai/provider`, `deleteAiProviderConfig`
     DELETE `/api/ai/provider`, `testAiProviderConfig` POST
     `/api/ai/provider/test` (body `z.strictObject({})`). Semua respons
     `dataResponseSchema(...)`; DELETE mengembalikan `{ data: view }` dengan
     `config: null`. Nama sengaja tidak `getAiProvider` (bentrok dengan
     factory). Fixture mock ditambahkan bila tes cakupan kontrak memintanya.
   Kode galat baru di `packages/shared/src/ai/errors.ts` (status + pesan
   default): `AI_PROVIDER_URL_BLOCKED` 422, `AI_PROVIDER_KEY_REQUIRED` 422,
   `AI_PROVIDER_CONNECTION_UNSUPPORTED` 422, `AI_PROVIDER_NOT_CONFIGURED` 404,
   `AI_PROVIDER_TEST_TOO_SOON` 429.
7. **Rute** di file baru `apps/api/src/routes/ai-provider.routes.ts`, dipasang
   di `routes/index.ts` dengan `apiRouter.use("/ai", aiProviderRouter)` di
   sebelah `aiGovernanceRouter`. Gate per rute (bukan `router.use`), urutan:
   `requireAuth, requireTrustedOrigin, requireTenantContext,
   requireBackOfficeSurface(), requireTenantPermission("ai.governance.manage")`,
   lalu `jsonBody` untuk PUT dan POST. `requireBackOfficeSurface` memaksa MFA
   untuk peran `mfaRequired`. `requireTenantPermission` sudah memasang
   `Cache-Control: private, no-store`. Service dipanggil dengan
   `getScopedTenantContext(req)` dan `getAuth(req).user.id`.
8. **Aturan simpan (PUT)** di `apps/api/src/services/ai-provider-config.service.ts`:
   - `chatgpt_oauth` ditolak `AI_PROVIDER_CONNECTION_UNSUPPORTED`;
   - `baseUrl` dinormalisasi (buang `/` akhir), lalu `checkAiUrl(url, true,
     resolve)`. **URL milik tenant selalu strict, juga di dev dan test**:
     tenant tidak pernah dipercaya menunjuk jaringan internal. Model lokal
     (Ollama) di dev tetap lewat env. Alasan ditolak dikirim sebagai pesan
     `AI_PROVIDER_URL_BLOCKED` (teks url-guard, tanpa kunci);
   - config baru tanpa `apiKey`, atau `baseUrl` berubah tanpa `apiKey` baru:
     `AI_PROVIDER_KEY_REQUIRED`. Jadi admin tidak bisa memindahkan kunci lama ke
     host lain untuk mencurinya;
   - `apiKey` absen dan `baseUrl` sama: kunci lama dipertahankan;
   - setiap perubahan `baseUrl`, `defaultModel` atau kunci mengosongkan
     `last_test_*`;
   - `recordAudit` untuk simpan dan hapus. Snapshot hanya `connectionType`,
     `baseUrl`, `defaultModel`, `hasKey`, `keyLast4`;
   - DELETE menghapus baris (hard delete, tanpa riwayat), 404
     `AI_PROVIDER_NOT_CONFIGURED` bila tidak ada.
9. **Uji koneksi (POST /test)** menguji config **tersimpan**. Body kosong, jadi
   kunci tidak lewat jalur ini lagi. File baru `apps/api/src/lib/ai/provider-probe.ts`,
   `probeOpenAiCompatible({ baseUrl, apiKey, model, timeoutMs, fetch?,
   resolve? })`, mengembalikan `{ status, errorCode }`, tidak pernah throw:
   - `checkAiUrl(url, true, resolve)` dulu; ditolak = `URL_BLOCKED`, tanpa fetch;
   - satu `POST <baseUrl>/chat/completions` berisi `{ model, messages: [{ role:
     "user", content: "Reply with OK." }], stream: false }` tanpa parameter
     token (cocok untuk semua server, tanpa adaptasi), `redirect: "manual"`,
     `AbortSignal.timeout(min(env.AI_TIMEOUT_MS, 15000))`, `maxAttempts` 1;
   - klasifikasi: 2xx dengan `choices` = ok; 2xx lain atau JSON rusak =
     `BAD_RESPONSE`; 3xx = `REDIRECT_REFUSED` (tidak diikuti); 401/403 =
     `AUTH_FAILED`; 404 = `NOT_FOUND`; 400/422 = `REQUEST_REJECTED`; 429 =
     `RATE_LIMITED`; 5xx dan lainnya = `PROVIDER_ERROR`; `TimeoutError` atau
     `AbortError` = `TIMEOUT`; throw lain = `NETWORK_ERROR`. Badan respons galat
     **tidak dibaca** (`body.cancel()`), tidak dicatat, tidak dikembalikan;
   - blob tidak bisa dibuka = `KEY_UNREADABLE`, tanpa fetch;
   - hasil ditulis ke `last_test_*`. Uji kurang dari 10 detik setelah uji
     sebelumnya ditolak `AI_PROVIDER_TEST_TOO_SOON`;
   - uji tidak lewat `aiComplete`, tidak dihitung anggaran (beberapa token, di
     kunci tenant sendiri).
   DNS rebinding: `checkAiUrl` me-resolve lalu fetch me-resolve ulang. Bila
   `undici` sudah ada di dependensi `apps/api`, probe dan provider tenant
   memakai `dispatcher: new Agent({ connect: { lookup } })` dengan lookup yang
   menolak alamat `isBlockedIp`. Bila belum ada, celah ini tetap tercatat
   (sama dengan `AI_BASE_URL` env) dan masuk daftar second-opinion.
10. **Resolusi provider.** `provider-factory.ts` mendapat:
    - `buildTenantAiProvider({ baseUrl, apiKey, model })` →
      `createOpenAiCompatibleProvider` dengan `timeoutMs: env.AI_TIMEOUT_MS`
      dan `checkUrl: (url) => checkAiUrl(url, true)`. Redirect sudah ditolak
      di provider (`redirect: "error"`);
    - `isAiProviderOverridden(): boolean` untuk `setAiProviderForTests`.
    Service mengekspor `resolveTenantAiProvider(context): Promise<{ provider,
    model, source: "tenant" | "platform" } | null>`, urutannya:
    1) override test aktif → `getAiProvider()`;
    2) ada baris tenant → `connection_type` `api_key` dan blob terbuka →
       provider tenant; `chatgpt_oauth` atau blob gagal dibuka → `null`
       (`AI_PROVIDER_UNAVAILABLE`). **Tidak jatuh ke kunci platform** bila
       tenant punya baris: salah konfigurasi tidak tersembunyi, dan platform
       tidak diam-diam membayar;
    3) tanpa baris → `getAiProvider()` (env, cadangan) dengan `env.AI_MODEL`.
    Status uji terakhir tidak memblokir pemakaian. Tanpa cache: satu query
    berindeks plus satu dekripsi per panggilan, kecil dibanding panggilan
    model, dan DELETE langsung berlaku di semua proses.
    `aiComplete` memanggil `resolveTenantAiProvider(gatewayContext(access))`
    sebagai ganti `getAiProvider()`. `recordUsage` menerima nama provider dan
    model hasil resolusi (bukan `getAiProvider()?.name` dan `env.AI_MODEL`).
    `ai-governance.service.ts` `providerAvailable` memakai resolusi yang sama.
    `settingsVersionOf` digabung dengan `updated_at` config provider, supaya
    cache jawaban lama gugur saat provider diganti.
11. **Anggaran tidak berubah.** `aiPreflight` tetap berjalan sebelum resolusi
    provider. `monthlyBudgetIdr` default `idr(0)` tetap memblokir
    (`AI_BUDGET_EXCEEDED`), apa pun sumber providernya. Pemakaian dengan kunci
    tenant tetap dicatat di `ai_usage_*` dan dihitung ke anggaran tenant
    dengan `priceFor(model)`. Model tak dikenal dihargai Opus (tidak pernah
    kurang hitung). Lihat pertanyaan founder 1.
12. **Kunci tidak bocor.** Kunci hanya ada di memori: saat seal di PUT dan
    saat membangun provider atau probe. Tidak ada di respons, audit, log,
    pesan galat, `ai_usage_events`, atau objek `AiError`. Galat Zod dari PUT
    tidak boleh menggemakan nilai `apiKey`: handler galat sudah membuang
    `input`; test membuktikannya.
13. **Test wajib, gagal dulu,** di file baru
    `apps/api/src/test/ai-provider-config.test.ts` (fetch dan resolver
    disuntik, tanpa jaringan):
    - kunci tidak muncul di body respons GET, PUT, POST test, galat 422, baris
      audit, maupun log (spy logger, `JSON.stringify` semuanya);
    - isolasi: config tenant A tidak terlihat dan tidak dipakai tenant B; blob A
      yang disalin ke baris B gagal dibuka (AAD);
    - pengguna tanpa `ai.governance.manage` (hanya `ai.ask`) mendapat 403 di
      keempat rute;
    - PUT dan test menolak `https://127.0.0.1`, `https://10.0.0.5`,
      `https://169.254.169.254`, `http://` publik, `https://localhost`, dan nama
      yang di-resolve ke IP privat; respons 302 dari probe = `REDIRECT_REFUSED`
      dan URL tujuan tidak pernah di-fetch;
    - timeout probe = `TIMEOUT`;
    - `baseUrl` berubah tanpa `apiKey` = `AI_PROVIDER_KEY_REQUIRED`;
    - anggaran 0 memblokir walau tenant punya config;
    - tenant tanpa config memakai provider cadangan dan `env.AI_MODEL`; tenant
      dengan config memanggil `baseUrl` dan `defaultModel` miliknya;
    - `chatgpt_oauth` ditolak `AI_PROVIDER_CONNECTION_UNSUPPORTED`;
    - rotasi menyegel ulang baris versi lama.
14. **Daftar file.** Buat: `apps/api/src/db/schema/ai-provider.ts`,
    `apps/api/src/db/schema/ai-provider.custom.sql`,
    `apps/api/drizzle/0188_ai_provider_configs.sql`,
    `apps/api/drizzle/meta/0188_snapshot.json`,
    `packages/shared/src/ai/provider.ts`,
    `apps/api/src/lib/ai/provider-probe.ts`,
    `apps/api/src/services/ai-provider-config.service.ts`,
    `apps/api/src/routes/ai-provider.routes.ts`,
    `apps/api/src/test/ai-provider-config.test.ts`. Ubah:
    `apps/api/drizzle/meta/_journal.json`, `apps/api/src/db/schema/index.ts`,
    `packages/shared/src/ai/index.ts`, `packages/shared/src/ai/errors.ts`,
    `packages/shared/src/ai/fixtures.ts` (bila tes cakupan meminta),
    `apps/api/src/lib/secrets.ts`, `apps/api/src/lib/ai/provider-factory.ts`,
    `apps/api/src/services/ai-gateway.service.ts`,
    `apps/api/src/services/ai-governance.service.ts`,
    `apps/api/src/routes/index.ts`. UI Kelola menyusul di slice terpisah
    mengikuti `ui-standard.md`.
15. **Pertanyaan founder** (default dipakai sampai dijawab):
    1) Pemakaian dengan kunci AI milik tenant tetap dihitung ke anggaran AI
       bulanan tenant (dengan harga platform)? Default: ya, supaya anggaran 0
       tetap menghentikan semua AI.
    2) Super Admin di Panel Platform boleh melihat atau mengatur provider AI
       tenant? Default: tidak; hanya admin tenant dan owner.

Celah yang diketahui: DNS rebinding (butir 9) bila `undici` tidak tersedia;
model tenant di luar daftar harga dihitung dengan harga Opus.

## 2026-11-10: WS-07 cash & bank reconciliation (legend-fnxl)

Context: PRD v1.7 §3.19 "Kas & Bank [P0]", ACC-04 (auto-match ≥ 99%, every
difference a case with a PIC), ACC-05 (undeposited-cash alert). The contract
(`packages/shared/src/accounting/banking.ts`, endpoints) already existed
without tables or handlers. Kas-bank only; gateway/EDC settlement matching
waits for legend-cs7 (card legend-fnxl.8). Reviewed by one architect
subagent before the schema landed.

1. **One migration, `0191_cash_bank_recon`** (`when` 1794270000000, prevId =
   0186 snapshot). Every foreign key sits inside its `CREATE TABLE`
   (contracts.md FK-into-FORCE pattern 1); tables are created in dependency
   order. Tenant RLS on all seven tables; `cash_deposits` (outlet_id NOT
   NULL) also gets outlet RLS. Bank accounts, imports, lines, matches and
   cases (nullable outlet) rely on the service layer for outlet reach.
2. **Entity-level work needs tenant scope.** Import, match, exclude, unmatch,
   case open and bank-account writes call `assertTenantScope`: outlet RLS on
   deposits would hide documents from an outlet-scoped caller and could turn
   an ambiguous hit into a wrong automatic match.
3. **Account numbers are sealed** (lib/secrets.ts AES-GCM, AAD binds tenant,
   row, field and key version), indexed by a tenant-separated HMAC for
   "one number per legal entity", and only the last 4 digits are kept in
   clear for the mask. The GL account FK is (tenant, legal entity, account),
   so a bank account cannot post to another entity's CoA.
4. **Re-import adds nothing.** `bank_statement_lines` is UNIQUE (tenant, bank
   account, `dedupe_key`); lines insert with ON CONFLICT DO NOTHING and the
   skipped rows count as duplicates. The dedupe key keeps identical rows in
   one file apart by occurrence. A file with one unreadable row is refused
   whole, with a message naming the row and column.
5. **One document, one line.** Matches live in `bank_statement_line_matches`
   with UNIQUE (tenant, ref_type, ref_id), not in a jsonb column on the line.
   A collision during auto-match is skipped (ON CONFLICT DO NOTHING); in a
   manual match it is `STATEMENT_LINE_ALREADY_MATCHED`.
6. **Automatic match never guesses.** Exact amount, date within the tenant's
   `matchingPolicy.dateToleranceDays`, and unique both ways: the line has one
   candidate (shared `findStatementMatch`) and the document is wanted by one
   line. Candidates: `recorded` cash deposits into the account (local business
   date in the outlet's time zone) and journals whose net movement on the
   account's GL account equals the line, excluding reversals, reversed
   entries, journals behind a cash deposit and write-off adjustment journals.
   Matching runs over every unmatched line of the account after an import and
   after a cash deposit is recorded, so late deposits still match.
7. **Entity lock.** Every write that touches lines, matches or deposits takes
   one advisory lock per (tenant, legal entity), then row locks. Journals
   belong to the entity and its GL account, and two bank accounts may share a
   GL account, so a per-account lock would let them race for one journal.
8. **Cash collections are not stored.** ACC-05 collections are derived from
   closed `pos_shifts` per (outlet, business date):
   `cash_sales − cash_refunds − cash_out + variance`, floored at 0. The
   variance (counted minus expected) is in, so a short shift does not show
   cash that never existed as undeposited, and extra cash does show. Cash
   drops stay in the outlet (not banked) and cash in is float, so neither
   counts. Deposits in every status cover cash
   FIFO (shared `undepositedCashAlerts`); alerts are computed on read with
   `loadCashDepositPolicy`, no alert table.
9. **Cases** live in `bank_reconciliation_cases` (the gateway-specific
   `payment_reconciliation_cases` is untouched). Every action (open, start,
   reassign, resolve, write_off) writes one row in the append-only
   `bank_reconciliation_case_events` (the app role has no UPDATE/DELETE).
   A write-off only links an existing journal (same entity, not reversed,
   debit total = |difference|, used by one case: partial unique index); this
   bead posts nothing (legend-9pz9 owns automatic journals).
10. **Case due date is a server default of 7 days** (`reconciliationPolicySchema`)
    until the finance policy carries `caseDueDays`: adding it now would change
    the strict PUT contract. Follow-up card filed.
11. **A line in a case stays `in_case` after the case closes.** Resolving or
    writing off the case is how that line is reconciled; unmatch refuses
    `in_case` lines, and deposits in a case stay `discrepancy`. Refs of type
    `gateway_settlement`, `edc_settlement` and `supplier_payment` are stored
    on a case as given until legend-cs7 can validate them; nothing acts on them.
12. **An unmatched pair is never auto-matched again.** Unmatch writes the
    (line, document) pair to `bank_statement_match_rejections`; automatic
    matching skips it. A person can still match that pair by hand, which
    clears the row (review finding, 2026-11-10).
13. **Uniqueness is counted per GL account, not per bank account.** Two bank
    accounts of one entity may share a GL account, so the "only one line
    wants this document" test counts candidate lines of every bank account on
    that GL account. A document named in a case that is still open is no
    candidate, cannot be matched by hand, and a case cannot name a document
    that is already matched (one document, one place).
14. **Opening a case is idempotent** (`idempotencyKey` added to the
    open-case body, stored in `bank_reconciliation_cases.idempotency_key`),
    like every other cash-bank command.
15. **The dedupe key keeps its readable format** (the web preview compares
    keys); a row whose normalized key exceeds 400 characters is refused with
    STATEMENT_VALUE_INVALID instead of failing the insert.

## 2026-11-10: Member identity and point ledger (legend-k2l, legend-111j, legend-u57q)

Context: the member page (legend-u57q) has a UI but no backend. Customers
already sign in with WhatsApp reverse OTP, which creates rows in the Better
Auth `user` table; there is no customer profile, ledger, rewards or member
authorization. Full design and card plan: `docs/design/ws08-member-loyalty.md`.

1. **One person table.** Members and staff share the Better Auth `user` table;
   membership is a `customer_profiles` row per tenant, staff access a role
   assignment. A second Better Auth instance was rejected: it would rewrite the
   tested WhatsApp login and hide the cashier-is-the-member link that the
   self-serve ban needs. Every member table keys on `customer_profile_id`, so
   the cookie can still move to its own instance later.
2. **Member sign-in = WhatsApp, email magic link, Google.** All mint customer
   sessions. The email magic link runs on the existing `login_challenges` flow
   (AUTH-01: 15 minutes, single use, keyed digest), not the Better Auth
   `magicLink` plugin. Each session records `auth_method`; only a `password`
   session upgrades to management, so an inbox or a WhatsApp code can never
   replace a staff password plus MFA. Staff may sign in with a member method
   and get customer-only access (403 on staff routes). The self-serve ban still
   stops them earning on their own sales. Email and Google stay off until their
   keys exist. Points need a verified WhatsApp (AUTH-07).
3. **Merge only WhatsApp-only accounts.** Proving a number held by an account
   with no other identity, no role and no platform access merges it into the
   signed-in account; everything else is refused with
   `IDENTITY_MERGE_NEEDS_SUPPORT`. Profiles move, the ledger does not. A magic
   link verified in another browser (`auth_cross_device`) cannot link WhatsApp
   or merge: 403 `IDENTITY_LINK_REAUTH_REQUIRED`.
4. **The database keeps the money rules.** `point_ledger` is append-only, the
   balance column is maintained only by an insert trigger and cannot go below
   zero, writers lock the profile row, and the unique source key makes every
   paid, refund, redemption and expiry posting happen once. A trigger copies the
   point value onto every row and locks it at the first posting, so the
   liability sum always matches outstanding points.
5. **Member isolation in two layers.** `requireMember` turns the session into
   a `MemberScope` that services take as their only identity input, and a
   RESTRICTIVE `member_self` policy keyed on `app.customer_profile_id` hides
   other members' rows if a query forgets its filter.
6. **Earn from the existing outbox events.** `order.paid` and
   `order.refunded` drive a `loyalty-earn` consumer; the member comes from the
   order row. Base = gross sales minus discount minus points tender, before
   service and PBJT. Partial refunds reverse cumulatively, rounded against the
   member, clamped at the balance with an anomaly row. A void of a paid POS
   sale (`order.voided` with `voidedFinalOrder`) reverses all remaining points.
7. **Consent from the member app** is written with source `member_pwa` against
   a versioned `consent_policy_versions` row; an outdated version is refused.
8. **Defaults until the founder decides (A15, 30 Nov):** program inactive,
   Rp10.000 = 1 point, point value Rp100, 12-month expiry and tier window,
   daily cap 1.000 (contract default), self-serve ban on, referral off, points tender off. All are
   settings, not code.
9. **Restore keeps the original expiry.** A cancelled or expired redemption
   puts its points back as a positive `adjust` row that points at the redeem
   row, so the restored points keep the expiry of their grant.

## 2026-11-10: Split bill per order, per-part payment and claim tokens (legend-ms3)

Context: PRD v1.7 §3 F10 Split Bill and "Klaim Poin per Orang", §6.D
`bill_splits`, ORD-06. The shared contract (`splitBill`, `billSplitSchema`,
`createSessionSplits`, pay target `split`) existed; the API side did not.

1. Scope is one order: the session's single `awaiting_payment` order (pay-first).
   No awaiting order answers 422 `NOTHING_TO_SPLIT`; more than one answers 409;
   an order with an applied reservation deposit answers 422. Session-level
   splits stay reserved in the contract (`orderId` nullable) until a
   session-level payment flow exists.
2. One table `bill_splits`, one row per part, grouped by `split_set_id`
   (no header table; `qrOrderIdempotent` handles the request key). by_item
   assignments are a `uuid[]` of order item ids, checked under the order lock.
   A partial unique index on live parts stops two concurrent live sets.
   `payment_intents.bill_split_id` gets a composite FK to it.
3. Rounding reuses `splitBill()` (largest remainder) on `orders.total_idr`, which
   already holds tax, service and rounding, so parts sum exactly to what the
   payment link collects. A zero part is refused (an intent must be above 0).
4. Each part pays through its own payment intent on the order's single payment
   link (`createSplitPartIntent`): the amount is the part, bounded by the link's
   outstanding balance, and only that part's pending code is superseded, so
   several guests can pay at once. The order turns paid through the existing
   rule (link paid >= link total); the part turns paid in the payment consumer
   from `intent.bill_split_id`, replay-safe by a conditional update.
5. Re-split is refused (409 `SPLIT_LOCKED`) once any part is paid, any money
   reached the link, or any code on the link is still payable. Otherwise the
   live parts are voided and a new set is written.
6. Unpaid-order sweep counts payment attempts per part, so a 4-way split is not
   voided for attempts; when an order with money on it is voided, each paid
   intent goes through the existing late-payment refund request.
7. Claim token per part: issued when the part is paid, valid 24 hours from
   that moment, stored as a sha256 hash plus a sealed copy so the guest can
   read it again; redeemed once by a conditional update. No public redeem
   route and no points until the member point ledger (legend-111j) lands.
   When the order is voided, its unpaid parts are voided and the paid parts'
   claims end at once; redeeming needs a paid part on an order not voided.
8. One payable code per part (architect review K). A superseded code stays
   payable at the gateway until its own expiry, and a second payment on one
   part would not show as an overpayment of the bill. So a part answers 409
   `SPLIT_CODE_ACTIVE` to a different method while its code, or a superseded
   code still inside its expiry plus the late-payment grace, can be paid; the
   same method returns the same code. Re-split also waits for such codes.
   Trade-off: a guest who switches from VA to QRIS waits for the VA code to
   lapse (up to the VA lifetime).
9. A guest reads the claim only while the table session credential is valid;
   after the table closes, the receipt carries the token (legend-arp35,
   legend-90na8).

## 2026-11-10: Metric sources, metrics_daily and report runs (legend-5wzoc, legend-31fi)

Context: founder Q54 puts all 110 standard reports and 89 metrics in scope
before release. On m1 only `GET /api/metrics/query` answers, for 12 money
metrics read from posted journal lines and split by outlet only; every other
metric answers null. Twelve family cards (F1-F12) build the remaining sources
in parallel. Reviewed with an architect consult before implementation.

1. **Money totals stay on the ledger; other splits come from the sub-ledger
   with the ledger as control.** A money metric whose figure the ledger posts
   (`GL_METRIC_SOURCES`) keeps its ledger total for every query. A split the
   ledger cannot carry (channel, menu item, hour, employee, payment method,
   ...) is read from operational rows (orders, order items, payments) through
   `metrics_daily`. The rows of such a split are always followed by one
   residual row, dimension value `__ledger_adjustment__` (shown as
   "Penyesuaian buku besar"), equal to the ledger total minus the sum of the
   split rows for the same bucket and outlet filter. The rows therefore add
   up to the ledger total, like the "Tingkat badan usaha" series of the
   outlet split (DASH-02). The residual row is shown whenever it is not zero;
   there is no tolerance that hides it. Split rows are never scaled pro rata
   to the ledger: a scaled per-menu or per-employee figure would be a number
   nobody recorded. Split rows carry the finality of the ledger total of
   their bucket. A percent metric split this way (food cost % per menu) is
   recomputed per row from its split numerator and denominator; the residual
   row gets the ratio of the residual components, null when the residual
   denominator is zero. The old I1 rule (`metrics-query.service.ts` header)
   is narrowed to: a money total never comes from operational rows when the
   ledger posts it. A money metric the ledger never posts (void amount, pax
   spend, settlement in transit) may read operational rows directly; its
   family card states why in the source's comment and removes it from
   `NON_GL_MONEY_METRICS`.
2. **One registry, one engine.** `apps/api/src/services/metric-sources/`
   holds exactly one `MetricSource` per registry metric code (`gl`, `daily`,
   `derived` or `unavailable`) and at most one `MetricSplitSource` per
   (ledger metric, dimension). The 12 ledger sources live in
   `metric-sources/gl.ts`; each family file adds its own sources and splits
   and never edits another file. A code no family claims resolves to
   `unavailable` (`source_not_built`), so all 89 codes always resolve. The
   registry refuses at load a code claimed twice, a code missing from the
   catalog, a unit that does not fit the source kind, and a split on a code
   that is not `gl`. `evaluateMetrics` in `metrics-query.service.ts` is the
   only path that turns codes into values. `GET /api/metrics/query`, report
   run and preview (`report-run.service.ts`), the dashboard batch (F11) and
   the AI tools all call it. The AI helpers in
   `apps/api/src/services/ai-metrics/` (sales, finance, labor, stock) still
   compute registry metrics from operational tables, for example `net_sales`
   from orders. The card that owns each metric moves its helper onto the
   engine: sales to F1, stock to F5, finance to F6, labor to F9. The guard
   test `metric-single-path.test.ts` lists these four files as the only
   allowed exceptions, and INT requires the list to be empty.
3. **`metrics_daily` plus a batch engine for the 3-second dashboard.**
   `metrics_daily` stores outlet-day values of `daily` sources and of splits
   (tenant and outlet RLS forced). Ledger totals stay live from journal lines
   in the existing REPEATABLE READ READ ONLY snapshot, so a close or reopen
   is never stale. `evaluateMetrics` takes many codes for one period, bucket
   and outlet filter, and makes one ledger read and one `metrics_daily` read
   per call. F11 groups the 18 owner tiles by (period, bucket, outlet
   filter) and evaluates them in one snapshot. The p95 budget for one owner
   dashboard load is 3 s. F11 measures it on a seed of 10 outlets and 400
   days. If the ledger read alone exceeds 1 s p95 there, F11 adds a daily
   ledger roll-up as its own bead; A does not build one now. Ratios
   (`aggregation: ratio`) are never stored; they are recomputed from their
   input codes per bucket. A report run groups by the outlet and at most one
   other dimension in this release. A deeper group-by answers "belum
   tersedia" (`dimension_not_supported`) instead of a wrong table.
4. **Closed versus estimate.** A stored row is `final` only when its business
   day has settled (day end plus the settle delay, as in the AI daily
   summary). Point-of-sale metrics also need a `pos_daily_closes` row for
   that outlet and date. Every other row is `estimate`. On read, a value is
   `final` only when every stored row behind it is `final` and
   `metricValueFinality` says `final` now. `closed_period_only` metrics also
   need closed books (`bookState`). So a reopened month or a late
   recomputation turns a value back into an estimate without waiting for the
   job. `requireFinal` keeps refusing with `PERIOD_NOT_CLOSED` before any
   value is read; an unavailable metric is not counted in that check.
5. **The daily job is idempotent per outlet and date.**
   `worker/metrics-daily.job.ts` runs from the worker tick per tenant, every
   15 minutes. It handles today (estimate) and the last 7 settled business
   dates per open outlet. Each (tenant, outlet, date) takes a transaction
   advisory lock. Each family runs in its own savepoint, so a failing family
   is logged and retried on the next tick without blocking the others. The
   rows of a code are upserted on the unique key and rewritten only when the
   value, finality or definition version changes, so a rerun leaves
   `updated_at` unchanged. Rows of that code whose dimension no longer exists
   are deleted. A changed `final` row is logged as `metrics_daily final row
changed` (late data) and still written. Dates older than the window are
   recomputed only through `recomputeMetricsDaily(context, outletId, from,
to)`. A family card that bumps a definition version runs it over the
   history it changes. A family card that ships a new reader also runs it
   over the history its reports cover, before its reports leave the mock.
   Every reader writes a total row (no dimension) per outlet-day, zero when
   nothing happened; a stored value is `final` only when every business day
   of its bucket has that total row, so a day the job never computed (worker
   down for more than the window, a reader shipped without backfill) keeps
   the value an `estimate` instead of a closed figure that silently misses
   days (architect review 2026-11-10).
6. **"Belum tersedia" is a field, not a zero, an error or an empty row.**
   Report results (`reportResultSchema`) and metric series carry an
   availability per metric: `available`, or `unavailable` with a reason
   (`source_not_built`, `dimension_not_supported`) and an Indonesian message.
   An unavailable metric has null in every cell. A report whose metrics are
   all unavailable answers 200 with no rows and every metric marked
   `unavailable`, so the viewer, the dashboard and Tanya AI can say "belum
   tersedia". The low-level `GET /api/metrics/query` keeps answering 400
   `METRIC_DIMENSION_NOT_SUPPORTED` for a split the metric does not declare
   (unchanged). A split the metric declares but no card has built yet is
   marked `unavailable` by the engine and by report runs; `GET
/api/metrics/query` keeps its m1 answer (400) for that case too, so the
   existing ledger regression tests stay unchanged. A split of a percent
   ledger metric is `dimension_not_supported` until a family card builds its
   numerator and denominator splits. Report run rows carry their bucket
   (`bucket` on the result, `bucketStart`/`bucketEnd` on each row; for
   `total` both equal the period bounds), so `day`, `week` and `month`
   reports answer one row per bucket and split; rows order by bucket, then
   dimensions, `sort` applies inside a bucket and `limit` counts all rows
   (legend-ymtsg, brief 267). A run splits by `outlet` plus at most
   `REPORT_RUN_MAX_SPLIT_DIMENSIONS` (1) other dimension: `metrics_daily`
   stores one dimension per row, so going deeper needs a schema change. A
   deeper `groupBy` is not refused by the schema; the run answers 200 with
   `unavailable` / `dimension_not_supported` (legend-hdfd2).
7. **File ownership.** Only card A, and after A merges only a serialized
   follow-up bead labelled `ws11-shared`, edits
   `metrics-query.service.ts`, `metrics-gl-sources.ts`,
   `metric-sources/index.ts`, `types.ts` and `gl.ts`,
   `report-run.service.ts`, `routes/reports.routes.ts`,
   `db/schema/metrics.ts`, `worker/metrics-daily.job.ts`,
   `packages/shared/src/metrics/*`, `packages/shared/src/dashboard/*` and
   `mock-day-model.ts`. A family card that needs a change there comments on
   that bead and does not edit the file in its own branch. A family card owns
   its own `metric-sources/<family>.ts`, `test/ms-<family>.test.ts`,
   `mock-families/<family>.ts`, `routes/_kelola/reports.<family>.*.tsx`, and
   any new schema file of its own migration. Report families map to source
   files as follows: sales; traffic and operations; menu and cogs; payments
   and tax; inventory and purchasing; finance; loyalty and crm; reservation
   and delivery; attendance, payroll and performance (`hr`); facility.
8. **`GET /api/metrics/query` follows the report run access rule**
   (legend-svrzc, CTO decision 2026-11-10, brief 267). Each metric's source
   report decides access: its full permission gives the caller's own scope;
   without it, `report.aggregate.view` gives the tenant aggregate only when
   the source report is on the aggregate whitelist
   (`reportAcceptsAggregateView`). Scopes intersect across the asked
   metrics; an empty intersection or no access answers 403
   `REPORT_NOT_PERMITTED`, never a tenant-wide figure. A metric code without
   a known source report keeps its old permission, without aggregate
   fallback. The shared logic lives in `routes/report-viewer.ts`. Callers
   that passed through the aggregate before without the source report now
   get 403: a shareholder asking for `cogs` (source `inventory.food_cost`,
   not whitelisted) is refused. The rule also widens access: money metrics
   no longer all need `report.financial.view`; each needs its source
   report's permission, so `report.operational.view` reads `cogs`,
   `food_cost_pct`, `waste_cost`, `payment_fee` and `stock_value`, and
   `report.sales.view` reads `net_sales` and `discount_amount`. The same
   figures were already readable through a report run (architect review
   2026-11-10).
   Founder decisions (legend-upmn7, 2026-11-10):
   - Q59: a shareholder (`report.aggregate.view`) may read the business
     total of `cogs` through `GET /api/metrics/query`, never a breakdown.
     `AGGREGATE_TOTAL_METRIC_CODES = ["cogs"]` in
     `packages/shared/src/dashboard/catalog.ts` lists such total-only
     metrics. A listed metric gets the aggregate reach only for a request
     with no `groupBy`, no `outletIds` filter and bucket `total`; any split
     (outlet, menu item, menu category), an outlet filter or a smaller
     bucket answers 403 `REPORT_NOT_PERMITTED`. The mark is per metric, so
     `food_cost_pct` from the same source report stays 403.
     `inventory.food_cost` is not added to `AGGREGATE_VIEW_REPORT_CODES`: its
     report run, with per-menu detail, stays closed to the aggregate view.
     The metric query follows the founder's words literally (whole business,
     whole period), although the `finance.income_statement` report run,
     which accepts the aggregate view, already lists `cogs` per outlet to a
     shareholder and `gross_profit` is `net_sales - cogs`; the per-menu split
     is the only detail no path shows (architect review 2026-11-10).
   - Q61 (2026-11-10): a shareholder may see the income statement per
     outlet, including each outlet's `cogs`, through the
     `finance.income_statement` report run. The per-menu `cogs` breakdown
     stays closed. The current behaviour already matches; no code change.
   - Q60: widening `report.operational.view` to `cogs`, `food_cost_pct`,
     `waste_cost`, `payment_fee` and `stock_value` is approved only within
     the outlets the role reaches. An outlet-scoped holder reads their own
     outlet without a filter and gets 403 for another outlet's filter
     (`apps/api/src/test/metrics-query-access.test.ts`).

9. **Shared round 2 (brief 272, 2026-11-10).**
   - One reader per metric code and dimension in `metrics_daily`; a
     reader's stale-row delete covers only the dimensions it writes. Which
     reader owns a code's total row is explicit (`writesTotal`), and two
     total writers for one code are refused by `assertRegistry`.
   - `net_sales` splits by `payment_method` (each order's net spread over
     its captured tenders with `allocateByWeight`, then the paid intent
     method, then `unassigned`) and by `menu_category` / `menu_item`
     (largest remainder per order). Sales owns every `net_sales` reader.
   - New source kinds: `share` (a split's summed value over the summed
     total, for `menu_popularity_pct`) and GL `balance` (all lines up to the
     bucket end, for `tax_payable`). A balance is a tenant figure only: by
     outlet, an outlet filter or an outlet scope answer
     `dimension_not_supported`, because the PBJT remittance journal may carry
     no outlet. A GL term may be limited to journal
     source types: `tax_collected` and `service_charge_collected` count
     only `sale` and `refund` journals (a reversal counts as the entry it
     reverses), so remittances and payouts do not reduce them.
   - `food_cost_pct` splits by splitting `cogs` and `net_sales` and
     dividing per split value; a split one side lacks is
     `dimension_not_supported`.
   - Multi-day `avg_serving_time` and `avg_dwell_minutes` are weighted by
     the catalog counts `served_ticket_count` and `closed_session_count`
     (`weightCode`); days without stored weight fall back to the plain
     mean until history is recomputed (legend-ka1hg).
   - A GL split is final only when every outlet with ledger lines has a
     final total row for every day of the bucket.
   - Dashboards: `managerRole` on the management query; tiles and queues
     carry `availability`; an unbuilt queue answers 200 with no rows and
     `source_not_built` instead of 501.

## 2026-11-10: WS-11: HPP per baris pesanan saat penjualan (legend-u4js6)

Konteks: `order_items.cost_snapshot_idr` (bigint, nullable) sudah ada tapi tidak
ada insert yang mengisinya. Pembacanya `ai-metrics/sales.ts` dan reader WS-11
F3 (`metric-sources/menu-cogs.ts`) sudah menganggapnya "HPP seluruh baris saat
terjual" dan NULL = tidak diketahui. Ditinjau architect sebelum implementasi
(tingkat K, uang).

1. **Nilai = HPP total baris** (jumlah x HPP per porsi), rupiah bulat. Resep
   satu baris diledakkan dengan jumlah sebenarnya (bukan 1 porsi dikali jumlah),
   lalu jumlah bahan (Decimal4) x `avg_cost_idr` (Decimal4) dijumlah dalam skala
   penuh dan dibulatkan **sekali per baris**, setengah ke atas, lewat
   `scaledCostToIdr` (`inventory-ops.shared.ts`). Tanpa pembulatan per bahan.
2. **Sumber biaya: `stock_balances.avg_cost_idr` di lokasi jual outlet
   (`outlet_inventory_settings.sale_location_id`) pada saat baris dimasukkan**,
   di transaksi yang sama. Alasan: kolom ini "HPP teoretis saat terjual"
   (PRD), ditulis sekali bersama barisnya, tanpa jalur tulis kedua dan tanpa
   menyentuh konsumen `order.paid` milik `recipe-deduction.service.ts`. Biaya
   deduksi (`recipe_deductions.cost_idr`) boleh berbeda: real_time memakai
   rata-rata saat lunas, day_close saat tutup hari, dan deduksi dibulatkan per
   pesanan, bukan per baris. Selisih itu (pergerakan harga rata-rata, pembulatan,
   baris NULL) masuk ke baris residual `__ledger_adjustment__` WS-11; itu yang
   diharapkan, bukan bug. `recipes.theoretical_cost_idr` tidak dipakai (belum
   pernah diisi, default 0).
3. **Varian dan modifier ikut**, dengan aturan yang sama dengan deduksi: resep
   varian, kalau tidak ada resep menu; modifier add-on dan aturan
   add/replace/remove. Pesanan delivery menyimpan `modifiers: []`, jadi modifier
   platform tidak dihitung (hanya resep dasar). Batas yang diketahui.
4. **NULL, bukan 0**, untuk baris yang: menunya tanpa resep; resepnya tidak aktif
   atau rusak; outletnya tanpa lokasi jual; jumlahnya kurang dari 1; resepnya
   meledak jadi nol bahan; atau satu saja bahannya tidak punya saldo di lokasi
   jual atau `avg_cost_idr` = 0. **Tidak ada nilai sebagian**: HPP sebagian
   terbaca sebagai margin palsu. Bahan yang memang gratis ikut jadi NULL;
   selisihnya tertampung di residual. Baris lain di pesanan yang sama tetap
   dihitung sendiri-sendiri.
5. **Edge `qr-order-applier.ts` menulis NULL, payload tidak diubah.** Pesanan
   itu dibuat di cloud oleh `qr-order.service.ts`, yang sudah menulis snapshot
   di barisnya; laporan membaca cloud, jadi tidak perlu pengisian ulang. Payload
   `qr_order.placed` adalah `z.strictObject`: menambah field membuat edge versi
   lama menolak event dan menahan semua pesanan QR. Master sync edge tidak
   membawa resep atau `stock_balances`. POS yang berjalan di edge memakai helper
   yang sama dan mendapat NULL bila data itu tidak ada. Bila nanti ada applier
   cloud untuk pesanan dari edge (legend-kai), applier itu memanggil helper ini
   di cloud saat menerapkan.
6. **Snapshot tidak pernah ditulis ulang.** Void, refund, koreksi, remake, comp
   dan fire hanya mengubah `status` atau `fire_status`; pembaca mengecualikan
   baris `voided`. Remake dan comp punya biaya sendiri di deduksinya. Replay
   edge memakai `onConflictDoNothing`.
7. **Kegagalan tidak menggagalkan pesanan.** Helper berjalan di savepoint
   (`tx.transaction(...)`, pola `openRefundChainSafely` di
   `payment-refund.service.ts`). Galat SQL tanpa savepoint membatalkan seluruh
   transaksi Postgres, jadi try/catch saja tidak cukup. Galat tak terduga: semua
   baris pesanan NULL, `logger.warn` dengan tenant, outlet, order id dan kode
   galat saja. Alasan NULL yang biasa (tanpa resep dan sebagainya) tidak dicatat
   ke log.
8. **Bentuk.** Berkas baru `apps/api/src/services/order-cost-snapshot.service.ts`:
   `computeLineCostSnapshots(tx, context, outletId, lines) -> Promise<(number |
null)[]>` (urutan sama dengan `lines`; baris =
   `{menuItemId, variantId, modifierIds, quantity}`). Nama tidak bentrok dengan
   `estimateDeductionCostIdr` (cabang KDS, yang mengembalikan 0, kontrak
   berbeda), dan tidak mengimpor dari `recipe-deduction.service.ts`. Satu
   pesanan memakai jumlah query tetap: lokasi jual (berhenti di sini bila
   kosong), satu ledakan per baris yang memuat data master sekali, satu baca
   saldo. Untuk itu `recipe-bom.service.ts` mendapat ekspor tambahan
   `explodeMenuLinesEach` (hasil per baris), dengan pemuatan data master dan
   konversi UOM diekstrak ke fungsi internal bersama; perilaku
   `explodeMenuLines` tidak berubah. Dipanggil tepat sebelum
   `insert(orderItems)` di `pos-order.service.ts`, `qr-order.service.ts` dan
   `delivery-inject.ts`. Tidak ada migrasi; slot 0183 dilepas.
9. **Tidak ada backfill dan tidak ada kartu bd untuk itu.** Mengisi baris lama
   dengan harga hari ini memalsukan "saat terjual". Baris lama tetap NULL dan
   tampil sebagai residual WS-11.

Tindak lanjut (legend-n8r5m, cabang `ws/cost-snapshot-edge`): DTO order POS
(`pos-order-support.ts`) tidak lagi memetakan NULL ke 0. HPP adalah data
finance (`inventory.cost.view`) sedangkan DTO POS bisa dibaca peran dengan
`order.view` saja, jadi DTO POS selalu mengirim `costSnapshotIdr: null` (tidak
diketahui / tidak ditampilkan); pembaca biaya memakai SQL. `ai-metrics/sales.ts`
masih menjumlah dengan `COALESCE` (HPP tak diketahui terbaca 0); berkas itu
milik alur WS-11 dan menunggu di sana.

Pesanan lewat edge: cloud tidak punya titik ingest `order_items` untuk pesanan
edge. Applier `qr_order.placed` hanya berjalan di edge (arah cloud_to_edge, baris
itu salinan dari pesanan cloud yang sudah ber-HPP) dan event `order.*` dari edge
hanya diparkir di `edge_deferred_events`. Pengisian HPP untuk pesanan POS edge
menunggu applier backfill (legend-078n).

10. **Shared round 3 (brief 284, 2026-11-10).**
    - Readers get the job's clock (`DailyComputeInput.now`) and never read
      the wall clock.
    - Finality hold: a reader may declare `pendingDay`; the job asks it
      before computing, and while it holds the reader's rows stay
      estimates. Delivery holds while an order of the day is
      `received`..`picked_up`; incident response holds while an incident of
      the day has no `responded_at`. Each sweep also revisits held days up
      to 90 days back, so a late end turns the day final and its value
      follows.
    - `keepFinal`: a reader whose inputs are configuration without history
      (facility operating hours) keeps its closed days as they are. Hours
      with an effective date are a follow-up (legend-4us1a).
    - Facility occupancy, unit utilization and incident response time are
      derived ratios over new stored sums, so multi-day values are weighted
      by volume.
    - `stock_value`, `purchase_total`, `supplier_due` and `delivery_sales`
      are owned by daily readers and are no longer listed as ledger gaps.
    - Training orders change no sales metric. Their sales journals are a
      separate bug (legend-gkc6b).
    - Mocks follow the registry: every family mock lists its unavailable
      metrics and a drift test pins the list to the registry.

## 2026-11-08: Worker event transport, acknowledgement and gap replay (legend-18qw)

Context: the production worker refused to start without an operator-supplied
transport module (`WORKER_TRANSPORT_MODULE`) and had no notification recipient
resolver or channel providers, so no outbox event was delivered in production.
Reviewed with an architect consult before implementation.

1. **No new HTTP ingest.** The authenticated edge/cloud ingest is the existing
   edge link `/api/edge-link` (legend-2pi): bearer credential checked against
   its stored hash, Origin header refused, re-verified every 30 s, revoked nodes
   closed with 4403. A second ingest path would duplicate that surface.
2. **Built-in transport** (`apps/api/src/worker/transport.ts`, selected with
   `WORKER_TRANSPORT=builtin`; the module overrides stay for operators):
   - Cloud: destination `cloud-sync` is a local sink. The in-process consumers
     already ran inside `consumeOutbox`; the `domain_event_consumptions` row
     (unique per consumer + event id) is the durable, idempotent
     acknowledgement, so a redelivered job is a no-op.
   - Edge (`EDGE_MODE=true`): `cloud-sync` events are queued `edge_to_cloud`
     with `enqueueEdgeEvent` on the consumption transaction (idempotent by
     event id, gap-free link sequence). The link's batch/ack/resend frames
     carry them; `edge_outbound_queue.status` + `sync_cursors.acked_out_seq`
     are the wire acknowledgement. This is the edge outbox drain the up-sync
     bead legend-kai mentions; legend-kai keeps the cloud-side applier,
     reconciliation and outage tests.
   - Any other destination, or a row with a non-null `direction`, throws: the
     job retries and then dead-letters (operator replay exists). Cloud-to-edge
     fan-out is not routed here: outbox sequences are per destination, not per
     edge node, and master-data versus transaction classification belongs to
     legend-97p.
3. **Gap replay.** An outbox sequence is allocated in the producer's own
   transaction, so a missing sequence is a producer bug that no peer can fill;
   wire-level gaps are already resent by the link. `requestMissing` records the
   gap in `domain_event_gap_requests` (unique per tenant, destination,
   aggregate and missing sequence; tenant RLS), counts repeats, logs
   `Outbox sequence gap` on the first request and each power of two, and the
   relay marks it resolved once the consumer offset passes it. The relay asks
   every tick, but a gap row is counted and rewritten at most once a minute
   (a resolved gap requested again is always reopened). Nothing skips a gap
   automatically; the aggregate stays held until the event arrives. An
   audited operator "skip gap" action would be a separate bead. A failure to
   write the gap record is logged and never aborts the relay tick.
4. **Producer bug fixed.** `operations-events.ts` numbered checklist events
   across destinations, so the `notification` alert of a started run got a
   sequence above 1 and was blocked forever. Sequences are now per
   destination, like the other allocators.
5. **Notifications fail closed at startup.** `NOTIFICATION_EMAIL_PROVIDER`,
   `NOTIFICATION_PUSH_PROVIDER` and `NOTIFICATION_WHATSAPP_PROVIDER` are
   required; `disabled` is an explicit value. A disabled channel is reported as
   unreachable to the delivery planner, so it is skipped, never reported as
   sent; in-app notifications are always written. Email has a Brevo adapter
   (account and sender domain: legend-wwuc); web push and WhatsApp templates
   stay `disabled` until legend-hyq. Only Brevo 400 and 422 decline a
   message for good; every other failure (401, 403, 404, 408, 429, 5xx,
   network) throws, is retried and is logged with the channel and HTTP status
   only (never the body, the address or the key). `BREVO_API_KEY` must be
   printable ASCII without spaces and `NOTIFICATION_EMAIL_FROM` must not be a
   placeholder (`.invalid`, `replace_me`); both are checked at startup.
6. **Recipients come from server state only**, by event name:
   `approval.requested` goes to holders of the current level's approver roles
   whose assignment covers the outlet (requester excluded);
   `approval.resolved` to the requester; `support_access.*` to tenant admins
   (`org.settings.manage` on a tenant-wide assignment); checklist missed and
   failed alerts to the outlet's `supervisor`/`outlet_manager` roles, falling
   back to the tenant owner. An event without a rule throws, so it is retried
   and dead-lettered instead of dropped silently. Banned (disabled) or missing
   accounts are dropped from every audience before a fallback is chosen (a
   banned supervisor does not hide the owner fallback) and unreachable at send
   time; an account whose `ban_expires` has passed counts as active again.
   `approval.resolved` reaches the requester only while they still hold an
   active assignment in the tenant. A malformed stored preference falls back
   to the defaults for that user only.
7. **Email is at-least-once, deduplicated within Brevo's window.** Every send
   carries `headers.idempotencyKey`, a UUID derived from the delivery
   attempt's stable reference, so a retry of the same attempt (lost response,
   worker crash) reuses the key. Brevo processes a key once for 30 minutes and
   answers a reuse with error code `duplicate_parameter` (status undocumented,
   so any 4xx carrying it counts), which the adapter treats as the
   acknowledgement. A retry later than 30 minutes after an accepted send whose
   response was lost can still deliver a second copy; with the default retry
   table (30 s, 2 min, 10 min, 1 h; tenant policy may change it) only the
   last retry falls outside the window. A duplicate notification email is accepted as the lesser failure
   compared with a lost one.

## WS-07: purchase return and petty purchase journals (legend-1xbs, legend-v3lh)

Decided 10 Nov 2026 (architect, tier K money). Design brief: `docs/briefs/298a-sub-purchase-return-posting-design.md`.

1. **Return payload carries the split.** `purchase_return.recorded` adds
   `outletId`, `uninvoicedValueIdr`, `invoicedValueIdr` and `ppnIdr`;
   `valueIdr = uninvoicedValueIdr + invoicedValueIdr`, and `ppnIdr > 0` only
   when `invoicedValueIdr > 0`. A split (not one flag) keeps a mixed return
   balanced. The emitter sums per-line rounded values; it never prorates the
   total.
2. **Return journal.** Dr `grni` for the uninvoiced part (receipt not yet
   billed), Dr `accounts_payable` for the invoiced part plus PPN (debit note),
   Cr `inventory` for `valueIdr`, Cr `ppn_input` for `ppnIdr`. A return with
   `valueIdr = 0` posts nothing.
3. **Petty purchase** is an expense, never stock (the contract says it is not
   a stock document, so debiting `inventory` would break the GL to stock
   ledger tie). New event `petty_purchase.recorded` (id-only payload), new role
   `petty_purchase_expense`, default account `5104 Pembelian Langsung (Kas
   Kecil)` (tenant can remap). Credit goes to `petty_cash` (1102), not
   `cash_on_hand` (1101 is the POS drawer, settled at shift close). This
   overrides the card text "kredit kas". No PPN input on petty purchases.
4. **New journal source types** `purchase_return` and `petty_purchase`
   (check constraint widened in migration 0205, which also backfills 5104).
5. **Goods receipt is NOT posted here.** `goods_receipt.recorded` has a rule
   but no consumer yet (legend-29vw). A return that debits GRNI is only
   correct once receipts credit GRNI, so legend-29vw must ship before the
   purchase return emitter goes live. No emitter exists today, so nothing
   posts and no balance drifts.
6. **Known gaps (follow-up beads):** a debit note reduces AP in the ledger but
   creates no AP open item; invoice-vs-receipt price differences on returns;
   receipts recorded before go-live need a finance cutover entry; no PPN input
   on petty purchases; `supplier_invoice.recorded` still unposted.
