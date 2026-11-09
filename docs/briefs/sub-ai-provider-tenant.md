# Sub-brief: WS-12 provider AI per tenant (legend-dwrr)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ai-provider-tenant` (cabang `ws/ai-provider-tenant`). Semua path relatif ke worktree ini. Jangan sentuh folder lain. Jangan baca `.env*`.

## Tujuan

Tiap tenant mengatur provider AI sendiri (OpenAI-compatible) lewat kunci API. Kolom tipe koneksi: `api_key` sekarang, `chatgpt_oauth` dicadangkan (jangan bangun OAuth).

## Yang sudah ada

- `apps/api/src/lib/ai/{openai-compatible,url-guard,provider-factory,types,anthropic,fake,pii}.ts`
- `apps/api/src/lib/secrets.ts` (helper enkripsi/rahasia?)
- `apps/api/src/test/ai-provider.test.ts`
- `apps/api/src/config/env.ts` (AI_MODEL global, anggaran AI)

## Kebutuhan

1. Tabel config per tenant: connection_type (`api_key`|`chatgpt_oauth`), base_url, default_model, api key terenkripsi, key_last4, status uji terakhir (ok/gagal, waktu, pesan galat aman). `tenantIdColumn`, RLS lewat `.custom.sql`. Migrasi `0188`, `when` 1794267000000, satu migrasi.
2. Rute admin: GET (tanpa kunci; `hasKey` + `keyLast4`), PUT simpan/ganti, DELETE, POST uji koneksi. `requireAuth`, `requireTrustedOrigin`, `requirePermission` admin tenant/platform.
3. Uji koneksi lewat url-guard (tolak localhost, IP privat, link-local, metadata cloud, redirect terlarang), timeout, galat tanpa kunci.
4. provider-factory pakai config tenant; AI_MODEL global hanya cadangan. Anggaran default 0 tetap memblokir.

## Test wajib (gagal-dulu)

Kunci tidak muncul di respons/log/galat; isolasi tenant A/B; non-admin ditolak; uji koneksi ke internal + redirect terlarang ditolak; anggaran 0 blokir; tenant tanpa config pakai cadangan.

Desain final: `docs/DECISIONS.md` bagian "WS-12 provider AI per tenant" (ditulis architect).

## Desain

Sumber kebenaran: `docs/DECISIONS.md` bagian "2026-11-10: WS-12 provider AI per tenant" butir 1-15. Ikuti persis. Tambahan engineer di bawah mengikat.

## Seam test bersama (mengikat semua potongan)

- `apps/api/src/lib/ai/provider-factory.ts` mengekspor `setAiProviderNetworkForTests(net: { fetch?: typeof fetch; resolve?: HostResolver } | null)` dan `aiProviderNetwork(): { fetch: typeof fetch; resolve: HostResolver }`. Service memakai `aiProviderNetwork()` untuk cek URL PUT, probe, dan provider tenant. Default: `guardedFetch` (di bawah) dan resolver default url-guard.
- `buildTenantAiProvider({ baseUrl, apiKey, model })` dan `isAiProviderOverridden()` di provider-factory (butir 10).
- DNS rebinding ditutup (bukan celah): `undici` tidak tersedia. Buat `apps/api/src/lib/ai/guarded-fetch.ts`: `createGuardedFetch(resolve?: HostResolver): typeof fetch` memakai `node:https` dengan opsi `lookup` yang me-resolve lewat resolver lalu menolak alamat `isBlockedIp` (galat `EAI_BLOCKED`). Hanya https, tanpa ikut redirect (kembalikan status 3xx apa adanya), dukung `method`, `headers`, `body` string, `signal`; badan respons di-buffer jadi `new Response(buf, { status, headers })`. `guardedFetch = createGuardedFetch()`.

## Potongan (file tidak bertumpuk)

- **A schema+migrasi**: `apps/api/src/db/schema/ai-provider.ts`, `ai-provider.custom.sql`, `schema/index.ts`; `pnpm db:generate` (dari root worktree), ganti nama hasil jadi `0188_ai_provider_configs.sql`, journal `idx` 188 `when` 1794267000000 tag `0188_ai_provider_configs`, snapshot `0188_snapshot.json`; tempel isi `.custom.sql` di akhir SQL migrasi dengan `--> statement-breakpoint` (pola 0184). Generate kedua harus kosong. Periksa SQL (CHECK, unique index, FK).
- **B kontrak shared**: `packages/shared/src/ai/provider.ts`, `ai/index.ts`, `ai/errors.ts`, `ai/fixtures.ts` bila perlu, plus root contract test `tests/ai-contract.test.mjs` bila cakupan kontrak memintanya. Jalankan typecheck shared tidak perlu (engineer jalankan di akhir).
- **C lib**: `lib/ai/guarded-fetch.ts`, `lib/ai/provider-probe.ts`, `lib/ai/provider-factory.ts`, `lib/secrets.ts` (`sealedVersion`, `currentSealVersion`), unit test `apps/api/src/test/ai-provider-probe.test.ts` (fetch/resolve disuntik + guarded-fetch menolak lookup ke IP privat; tanpa DB). Jangan ubah `ai-provider.test.ts` yang ada kecuali perlu.
- **D service+rute** (setelah A-C): `services/ai-provider-config.service.ts`, `routes/ai-provider.routes.ts`, `routes/index.ts`, `services/ai-gateway.service.ts`, `services/ai-governance.service.ts`, pemanggil `rotateAiProviderKeys` di samping `rotateIntegrationCredentials`.
- **E test integrasi** (test-writer, paralel, gagal dulu): `apps/api/src/test/ai-provider-config.test.ts` sesuai butir 13, memakai seam di atas dan helper `ai-acceptance-helpers.ts` / `helpers.ts`. Tenant kedua dibuat sendiri. Tulis dari spesifikasi, bukan dari implementasi.

Test: `bash -c 'cd "<worktree>" && pwd && LEGEND_TEST_FILES="src/test/<file>" pnpm test'`. Jangan `pnpm check` / `pnpm test` penuh. Jangan commit (engineer commit).

## Perbaikan review architect (R)

- **R1 (HIGH)** `lib/ai/guarded-fetch.ts` ~124-145: `new Response` melempar `RangeError` untuk status di luar 200-599 di dalam listener `end`, lolos ke `uncaughtException` dan mematikan proses. Bungkus seluruh isi listener `end` (dan callback `res`) dengan try/catch dan reject; status di luar 200-599 = reject sebagai galat jaringan. Test: server https palsu tidak mudah; uji lewat fungsi kecil yang diekspor (mis. `toFetchResponse(status, headers, body)`) atau stub `node:https`. Probe memetakan reject itu ke `NETWORK_ERROR`.
- **R2 (LOW)** `lib/ai/url-guard.ts` `isBlockedIp`: blok juga `64:ff9b:1::/48` (NAT64 lokal). Test.
- **R3 (LOW)** Service: URL tenant hanya port 443 (port kosong atau `:443`); lainnya `AI_PROVIDER_URL_BLOCKED`. Berlaku di PUT dan sebelum probe/provider tenant. Env `AI_BASE_URL` tidak berubah.
- **R4 (LOW)** Service: pesan `AI_PROVIDER_URL_BLOCKED` ke klien jangan membedakan "nama resolve ke IP privat" vs "tidak ditemukan" (bocor DNS internal). Pakai satu pesan generik, mis. "Base URL tidak diizinkan. Pakai alamat https publik di port 443."
- **R5 (LOW)** `services/ai-gateway.service.ts` ~550: bila sumber provider `tenant`, hitung biaya dengan `resolved.model` (model config tenant), bukan nama model yang dilaporkan server tenant.
