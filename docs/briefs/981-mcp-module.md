# 981 / legend-hbuq3: modul `mcp` ditegakkan di jalur MCP

Keputusan: modul `mcp` mati (tenants.feature_flags) menutup SEMUA jalur MCP saja (bukan AI umum). Ditolak tanpa bocor info (bentuk respons sama dengan tenant/tool tidak ada; jangan sebut nama modul atau flag).

Peta (dari Explore):

- `apps/api/src/app.ts:457` `/mcp` router (tanpa tenantContext), `routes/mcp.routes.ts:53` POST / (auth `authenticateMcpToken` :57), GET/DELETE 405.
- OAuth: `mcp.routes.ts` :124 authorization-server, :147 protected-resource, :162 authorize, :197 token, :229 register. Register sudah cek ai-platform lock (:236).
- Pola lock: `services/ai-platform-lock.ts` (isAiPlatformLocked*, assertAiPlatformUnlocked*), `mcp-common.ts:51-88 loadMcpSettings.platformLocked` memaksa mcpEnabled=false, `mcp-server.service.ts:138`, `mcp-oauth.service.ts:50,126`. Express guard `middleware/module.ts` (`requireModuleEnabled`).
- Modul key `mcp` sudah ada di `packages/shared/src/platform/modules.ts:29`.
- Seed: `packages/shared/src/platform/fixtures.ts:103-106` MENYARING `mcp` keluar. Ubah seed agar `mcp` aktif untuk tenant demo/test; sesuaikan test yang menyalin feature_flags: `src/test/mcp-scope.test.ts:697`, `src/test/ai-tool-calls-mcp-token.test.ts:152`.

Test fail-first: `apps/api/src/test/mcp-module-flag.test.ts` (test-writer). Jangan lemahkan test MCP lain.
Batas: jangan sentuh `apps/web`, refund/recon, payroll, POS, edge, payment.
