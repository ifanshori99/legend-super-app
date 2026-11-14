# 864 sub-brief: backfill modul ai_assistant (internal, dari hasil Explore)

Migrasi data: `apps/api/drizzle/0451_ai_assistant_auto_enable.sql` (journal idx 451, tag sama; snapshot tidak perlu; journal sudah tidak kontigu).

## Definisi (keputusan engineer, konservatif)

- Paket memuat AI: `tenants.plan` = `platform_packages.key` DAN `platform_packages.modules ? 'ai_assistant'` DAN `platform_packages.status = 'active'` (retired = tidak otomatis).
- Sudah memakai AI: ada `ai_usage_events` dengan `status = 'ok'` DAN `channel IN ('tanya_ai','mcp')` (bukan `job`), ATAU ada `ai_messages` dengan `role = 'user'`. Config saja (`ai_settings`, `ai_provider_configs`, `ai_chatgpt_connections`) BUKAN bukti.
- Tenant juga harus `tenants.status = 'active'` (bukan archived/suspended).
- Tenant yang sudah punya `ai_assistant` di `feature_flags->'modules'`: dilewati (idempoten, tanpa audit baru).
- Efek: `feature_flags = jsonb_set(feature_flags, '{modules}', modules || '"ai_assistant"')`. Jangan sentuh `limits`, `plan`, `integrationProviders`.
- Audit: satu baris `audit_logs` per tenant yang berubah: actorType `system`, actorId null, action `tenant.package_changed`? TIDAK: pakai action baru `tenant.module_auto_enabled`, objectType `tenant`, reason "founder Q6 (15 Nov 2026): otomatis untuk tenant paket-AI yang sudah memakai AI".

## RLS

`tenants` tidak FORCE. `audit_logs`, `ai_usage_events`, `ai_messages` FORCE RLS: lift `NO FORCE` di awal migrasi dan pulihkan `FORCE` sebelum akhir (pola 0360), seperti 0116/0147/0205/0335.

## Test (apps/api/src/test/ai-module-auto-enable-migration.test.ts)

Pola: `cash-movement-mapping-backfill-migration.test.ts` + `helpers/migration-replay.ts`.
Kasus: paket-AI+pemakai -> modul menyala + 1 audit; paket-AI tanpa pemakaian -> tetap; pemakai tanpa paket-AI -> tetap; pemakaian hanya channel job atau status error/blocked -> tetap; paket retired -> tetap; tenant archived -> tetap; jalan dua kali -> tidak menggandakan modul dan audit; tenant A menyala, tenant B tidak (isolasi); `limits`/`plan` tidak berubah; modul lain tetap.
Registry: tambah `"0451_ai_assistant_auto_enable.sql"` di `MIGRATION_DATA_STATEMENTS` (`src/test/data-import-registry.test.ts:67`).
