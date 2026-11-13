# Brief: sambung layar Pengaturan AI ke kontrak nyata (legend-nnufz.1)

Worktree sudah memuat backend (`@starter/shared/ai`, `PATCH /api/ai/provider`). Scope: `apps/web/src/features/ws12-ai-settings/**`, `apps/web/src/routes/_kelola/kelola.pengaturan_.ai.tsx`, test web. Dilarang: `apps/api/**`, `packages/shared/**`, migrasi.

## Fakta (hasil Explore)

- Path/method UI sudah sama dengan backend. Selisih ada di `contract.ts` (kontrak interim) yang harus diganti `@starter/shared/ai` (nama sama: getAiProviderConfig, upsertAiProviderConfig, testAiProviderConfig, getChatgptLogin, startChatgptLogin, pollChatgptLogin, revokeChatgptLogin, patchAiProviderConfig, tipe `AiModelCapabilityOverrides`, `ChatgptLoginStatus`, dst). Cek nama persis di `packages/shared/src/ai/{provider,chatgpt}.ts`.
- Importer `contract.ts`: `api.ts`, `hooks.ts`, `queries.ts`, `components/custom-model-panel.tsx:28`, `components/chatgpt-panel.tsx:31`. `contract.ts` dihapus.
- Start ChatGPT body `{riskAccepted:true}`, poll body `{}` (keduanya sah; `model`/`attemptId` opsional, tidak dipakai).
- `components/ai-settings-page.tsx:21-22,54,57`: `locked = platformOff || status.isPending` dipakai CustomModelPanel dan BudgetCard. `platformDisabled` hanya kunci koneksi ChatGPT.
- `components/custom-model-panel.tsx` `CapabilityEditor` (~547-640) simpan `{...base, capabilityOverrides}` lewat PUT; restore kirim `capabilityOverrides:null`.
- Mock: `mock.ts` (di-glob `lib/mock/transport.ts`, aktif bila `VITE_API_MOCK=true`; `?ai=off` menyetel platformDisabled). Belum ada handler PATCH `/api/ai/provider`.

## Kesepakatan antarmuka (agar dua implementer tidak bertabrakan)

`hooks.ts` mengekspor `usePatchProviderCapabilities()`: mutation yang menerima `capabilityOverrides: AiModelCapabilityOverrides | null` dan memanggil `patchProvider(capabilityOverrides)` di `api.ts` (`callEndpoint(patchAiProviderConfig, { body: { capabilityOverrides } })`). Sukses menulis balik cache provider seperti `useSaveProvider`. Komponen mengirim HANYA field yang berubah dibanding keadaan yang tampil; `null` = reset semua override.

## Pemilik berkas

- Implementer A: `api.ts`, `queries.ts`, `hooks.ts`, `contract.ts` (hapus), `mock.ts`, `components/chatgpt-panel.tsx` (hanya import).
- Implementer B: `components/ai-settings-page.tsx`, `components/custom-model-panel.tsx` (termasuk import tipe dari `@starter/shared/ai`).
- test-writer: `e2e/legend-nnufz.mock.spec.ts` dan/atau `tests/ws12-ai-settings-*.test.mjs`. Tidak mengedit src.

## Bukti selesai

Lihat brief induk: typecheck web hijau (`heavy`), test terarah hijau, prettier/eslint, text-contract bila ada teks baru, screenshot 390 dan 1280 di `docs/screenshots/ai-settings/`, satu ui-auditor.
