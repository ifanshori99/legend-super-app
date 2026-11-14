# Sub-brief: Pengaturan AI v2 (legend-nnufz)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-ed8a86ef` (jangan cd ke checkout lain). Cabang kerja.

## Mockup disetujui (W5 Q2)

Ekstrak read-only: `/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend-ed8a86ef/4bca05f2-2a3d-4ac7-84d0-b6beb8098bf8/scratchpad/mock/design/mockups/ai/`

- `ai-settings.html` (sumber, semua state lewat `?state=`), `README.md` (keputusan desain), PNG per state `ai-settings-<state>-{desktop,mobile}.png`.
- State: empty, device, connected, failed, expired, detected, disabled (platform mati), loading, offline, session (sesi habis), plus `&role=admin`.
  Keputusan: utama (ChatGPT) dan cadangan (model kustom) tampil bersama; persetujuan risiko (checkbox) sebelum tombol login ChatGPT; pengaturan teknis dilipat; sesi habis = login ulang lalu kembali ke halaman ini.

## Layar sekarang

`apps/web/src/features/ws12-ai-settings/` dan route `apps/web/src/routes/_kelola/kelola.pengaturan_.ai.tsx`. Teks di `packages/shared/src/i18n/messages/ws12-ai-settings*.ts` (katalog; uji `tests/text-contract.test.mjs`). Commit asal 95de4c6d1, 3c4a5c73a.

## Keputusan founder W16 Q7 (14 Nov)

Platform mematikan AI untuk tenant => SEMUA AI tenant terkunci (ChatGPT, model kustom, anggaran, pemakaian AI, MCP), bukan hanya ChatGPT. Server wajib menolak (API pengaturan tulis + jalur pemakaian AI/MCP). UI: banner + semua kontrol nonaktif.

## Aturan

- Jangan pkill. Test terarah: `cd <worktree> && LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` (satu pemegang heavy per thread; hanya subagent yang diberi token heavy yang menjalankan test/tsc).
- Jangan commit; agent induk yang commit.
- Laporan singkat: file:line, temuan, tanpa salin isi file panjang.

## UI: pembagian file (tidak bertumpuk)

Bandingkan dengan PNG mockup state-mu (desktop + mobile) dan `ai-settings.html` (grep teks, jangan baca utuh: ada font base64). Teks baru wajib masuk katalog i18n (bukan string literal di TSX). Hapus `?ai=off` lama tidak perlu; mock state cukup lewat `?state=`.

- **A (halaman)**: `components/ai-settings-page.tsx`, baru `components/page-states.tsx` (loading satu `role=status` + kerangka layout; offline kartu "Koneksi terputus" + Coba lagi; sesi habis kartu "Sesi Anda sudah habis" + "Masuk kembali" -> `/masuk?lanjut=<path ini>` pakai `safeReturnPath` dari `features/ws01-login/flow.ts`), baru `components/platform-lock-banner.tsx` (banner `role=alert` "AI dimatikan oleh platform"), `components/order-card.tsx`, `mock.ts` (tambah `?state=disabled|loading|offline|session`), `hooks.ts` (tambah `useAiPlatformLock(): {locked:boolean; isPending:boolean}`; sementara dari ChatGPT `platformDisabled`, nanti diganti flag server), katalog `ws12-ai-settings.ts`. Gerbang halaman: provider/ChatGPT query pending -> loading; ApiError NETWORK_ERROR -> offline; 401 -> sesi habis. Saat terkunci: banner + teruskan `locked` ke SEMUA kartu (fail closed saat pending).
- **B (ChatGPT)**: `components/chatgpt-panel.tsx`, `components/revoke-chatgpt-dialog.tsx`, katalog `ws12-ai-settings-chatgpt.ts`. State empty/device/connected/failed/expired + `role=admin`. Kotak risiko bergaya peringatan (amber) seperti mockup. Prop `disabled` tetap: saat terkunci kontrol nonaktif, TANPA notice kunci di dalam kartu (banner halaman yang menjelaskan).
- **C (model kustom + anggaran)**: `components/custom-model-panel.tsx`, `components/budget-card.tsx`, katalog `ws12-ai-settings-custom.ts`. State empty/detected/disabled. Pengaturan teknis dilipat default (hapus `open`), tombol uji sesuai mockup. Tambah prop `locked?: boolean` ke `CustomModelPanel` dan `BudgetCard`: nilai tersimpan tetap terlihat, semua kontrol nonaktif, mutasi tidak dipanggil.
- `OrderCard` juga dapat `locked?: boolean` (A).
  Selesai: `cd <worktree> && pnpm exec prettier --write <file-mu>`; JANGAN jalankan tsc/test (pemegang heavy terpisah). Lapor file berubah + kunci katalog baru.

## Server: kunci platform AI per tenant (desain architect, final)

- Sumber: AI tenant TERKUNCI bila `isModuleEnabled(tenants.feature_flags, "ai_assistant")` false (fail closed; null/rusak = terkunci). Tanpa migrasi. Modul `mcp` TIDAK ditegakkan di sini (bead terpisah). Kunci ai_assistant juga mematikan MCP.
- Error baru `AI_PLATFORM_DISABLED` status 403, pesan id "AI dimatikan oleh platform untuk organisasi Anda." di `packages/shared/src/ai/errors.ts`. `ai-governance.service.ts` `BLOCK_REASON_BY_CODE`: petakan ke `feature_disabled`.
- Helper `apps/api/src/services/ai-platform-lock.ts`: `isAiPlatformLocked(executor, tenantId): Promise<boolean>` dan `assertAiPlatformUnlocked(executor, tenantId)` (lempar AI_PLATFORM_DISABLED). Baca `tenants` langsung (pola `tenantFeatureFlags` di platform-org.service).
- Middleware `requireAiPlatformEnabled()` di `apps/api/src/middleware/module.ts`, dipasang setelah cek izin pada jalur TULIS/PAKAI: ai-governance PATCH settings; ai-provider PUT/PATCH/test; ai-chatgpt POST (start/poll); ai-mcp-admin create/update (POST/PATCH); ai-chat `/ask` + buat percakapan; ai-insights generate. TETAP DIBUKA (pencabutan kredensial, mengurangi akses): DELETE provider, DELETE chatgpt, revoke/DELETE client/token MCP, DELETE percakapan, acknowledge anomali, semua GET.
- Gateway: `aiPreflight` (ai-gateway.service.ts ~354) blok `feature_disabled` sebelum kuota; `reserveAiBudget` (~459) cek; `aiComplete` (~775) cek baris pertama sebelum resolve provider. `ai-system-call.ts` ~93 -> `feature_disabled`. MCP: `mcp-common.ts` `loadMcpSettings` tambah `platformLocked` dan paksa aiEnabled/mcpEnabled false; `mcp-server.service.ts:118` lempar AI_PLATFORM_DISABLED; OAuth ikut tertutup.
- Kontrak UI: `platformLocked: boolean` di `aiProviderViewSchema` (shared ai/provider.ts), `aiGovernanceSettingsSchema` (schemas.ts), `aiUsageSummarySchema` (endpoints.ts) + fixture `packages/shared/src/ai/fixtures.ts`. `platformDisabled` ChatGPT tetap = env global saja.
- Test gagal-dulu `apps/api/src/test/ai-platform-lock.test.ts` (tenant `createAiTenant`, hapus `ai_assistant` lewat SQL): (1) tiap route tulis 403 AI_PLATFORM_DISABLED, baris tak berubah, uji provider tanpa fetch keluar; (2) `/ask` diblok, ledger error_code, ai_usage_daily tak naik, provider palsu tak dipanggil; (3) `aiComplete` langsung lempar, reserved_cost_idr tetap; (4) systemAiComplete ok:false; (5) bearer MCP 403, OAuth authorize access_denied; (6) GET provider/governance/usage 200 + platformLocked:true, nilai utuh; (7) DELETE provider/chatgpt tetap boleh saat terkunci; (8) modul diaktifkan lagi: pulih; tenant lain tak terdampak.

### Pembagian server

- **S1 (kontrak + route)**: shared errors/schemas/fixtures, helper `ai-platform-lock.ts`, middleware, pemasangan di routes.
- **S2 (gateway + system-call + MCP)**: ai-gateway.service.ts, ai-system-call.ts, mcp-common.ts, mcp-server.service.ts, mcp-oauth bila perlu, BLOCK_REASON_BY_CODE. Impor `assertAiPlatformUnlocked`/`isAiPlatformLocked` dari `services/ai-platform-lock.ts` (dibuat S1; signature di atas) dan kode `"AI_PLATFORM_DISABLED"`.
- **T (test-writer)**: test di atas; pemegang token heavy thread ini. Jalankan terhadap kode sebelum S1/S2 untuk bukti gagal (catat), lalu tunggu instruksi untuk jalankan ulang.
- **W (web)**: `hooks.ts` `useAiPlatformLock` baca `provider.data.platformLocked` (fail closed saat pending); `mock.ts` isi `platformLocked` sesuai `?state=disabled`; `OrderCard` saat terkunci tampilkan status tersimpan seperti mockup disabled (bukan "Dikunci platform"); perbarui `e2e/legend-nnufz.mock.spec.ts` (teks tombol uji kini "Uji koneksi"/"Uji ulang koneksi"; tambah cek banner kunci + semua kontrol nonaktif di state disabled). Jangan jalankan test.

## Perbaikan audit UI (putaran 2)

- **P (halaman: ai-settings-page.tsx, page-states.tsx, platform-lock-banner.tsx, hooks.ts, katalog ws12-ai-settings.ts)**: (a) provider gagal muat selain 401/0 dan belum ada data: ganti kartu dengan kartu galat tingkat halaman (kunci `aiSettings.error.*` yang ada) + "Coba lagi", bukan kartu terkunci tanpa alasan; (b) tombol Coba lagi offline dapat `loading` dari `isFetching`, paragraf offlineBody `role="alert"`; (c) hapus `aria-label` pada div loading tanpa role (atau `role="group"`); (d) banner dan intro `text-base leading-6`. Banner tetap merah `role=alert` (sesuai mockup).
- **Q (chatgpt-panel.tsx, revoke-chatgpt-dialog.tsx, katalog ws12-ai-settings-chatgpt.ts)**: (a) saklar global env `status.platformDisabled` (ChatGPT saja): `disabled={disabled || platformDisabled}` dan satu notice di kartu ChatGPT (kunci katalog baru, teks: "Login ChatGPT sedang dimatikan oleh platform. Model kustom tetap dipakai sebagai cadangan."); (b) Notice risiko `text-base leading-6`; (c) eyebrow pakai `type-eyebrow`; (d) `aria-describedby` tombol Hubungkan ke label persetujuan. Batal/Cabut tetap nonaktif saat terkunci (mockup).
- **R (custom-model-panel.tsx, budget-card.tsx)**: (a) paragraf deskripsi penting `text-base leading-6` (hint tetap text-sm); (b) eyebrow `type-eyebrow`; (c) satu aksi utama: tombol uji `outline` bila ChatGPT belum terhubung (baca `useChatgptLogin()` dari ../hooks, state !== "connected").
  Selesai: prettier --write file-mu; jangan jalankan tsc/test.

## Perbaikan selisih mockup (putaran 3)
Acuan: PNG mockup `preview-<state>-{desktop,mobile}.jpg` di folder mockup (lihat atas). Mobile: tombol aksi full-width (`w-full sm:w-auto`). Tombol nonaktif tampil abu netral (variant `secondary`/muted solid), bukan teal/merah pudar. Hint `text-xs`, label field `font-semibold`.
- **F1 (budget-card.tsx + mock anggaran)**: mock budget/governance mengikuti `?state=`: empty/device/failed/expired = Rp 0, "AI belum aktif · Anggaran Rp 0", tanpa bar; connected/detected/disabled = pakai Rp 125.000 dari batas Rp 500.000 (25%), bar netral. Sumber mock ada di `features/ws12-ai-admin/mock.ts` (useBudget/governance); tambahkan pembacaan state dengan cara yang sama seperti `ws12-ai-settings/mock.ts` tanpa merusak halaman admin lain (default tetap). budget-card: cabang "AI belum aktif" saat batas 0, tombol full-width mobile, tipografi.
- **F2 (page-states.tsx + scripts/ui-check-ai-settings.mjs)**: skeleton warna muda (`bg-muted`/token beige, bukan `--skeleton` gelap), pola baris w-1/3 lalu w-full, `min-h` kartu ChatGPT dan Anggaran seperti mockup. Script: screenshot seluruh konten (konten menggulung di dalam `main#main-content`; perbesar tinggi viewport ke tinggi scroll konten sebelum screenshot, atau screenshot elemen), lebar tetap 1280/390.
- **F3 (chatgpt-panel.tsx)**: tombol full-width mobile (Hubungkan, Buat kode baru, Buka halaman login, Batalkan, Cabut), tombol nonaktif abu netral, rapatkan jarak checkbox ke tombol (~mockup).
- **F4 (custom-model-panel.tsx)**: hint `text-xs`, label `font-semibold`, tombol uji full-width mobile, nonaktif abu netral.
Selesai: prettier --write; jangan jalankan tsc/test.

## Gerbang putaran 3 (test-runner)
Urut, satu heavy sekaligus, dari root worktree. Dev server mock sudah jalan di :3417 (jangan start/kill).
1. `heavy pnpm --filter web typecheck` (atau script typecheck web yang ada).
2. `heavy node --test tests/ws12-ai-settings-wire.test.mjs tests/text-contract.test.mjs tests/ai-contract.test.mjs` (langsung node --test, bukan LEGEND_TEST_FILES).
3. `heavy node scripts/ui-check-ai-settings.mjs` → laporkan isi ringkas `docs/screenshots/ai-settings-v2/summary.json` (axe gagal, overflow).
4. `heavy pnpm exec playwright test e2e/legend-nnufz.mock.spec.ts` (pakai config mock yang dipakai sebelumnya; cek package.json script `test:e2e:mock` bila ada). Bila test "a failed ChatGPT status reads as unavailable" gagal lagi: laporkan isi error-context.md / teks halaman yang terlihat.
5. `pnpm exec eslint` + `pnpm exec prettier --check` pada file berubah (`git diff --name-only` + untracked .ts/.tsx/.mjs).
Laporan: hanya gagal + baris error penting.
