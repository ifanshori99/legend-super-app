# Brief 111: Codex second-opinion WS-12 AI backend (tingkat K)

Peran: second-opinion. Baca `~/.agents/team/roles/second-opinion.md`.
Cabang: `ws/ws12-ai` 9f6d680e (basis `ws/ai-tool-catalog` d15542a8 + `milestone/m1`). Hanya baca, jangan commit.
Diff: `git diff milestone/m1...ws/ws12-ai -- <file>`. Abaikan test, `drizzle/meta`, dan fixture.

Total ~19 ribu baris kode. Dibagi 5 run, satu run per thread Codex, maks 800-1100 baris. Tulis temuan P0-P3 dengan file:line dan skenario gagal ke `docs/reviews/codex-ws12-<run>.md`.

## Run A1 (auth): OAuth + PKCE MCP
`apps/api/src/services/mcp-oauth.service.ts`, `apps/api/src/routes/mcp.routes.ts`.
Cek: validasi PKCE S256, redirect_uri persis, kode sekali pakai, token dicabut, batas registrasi klien, scope tenant/outlet.

## Run A2 (auth/akses data): server dan admin MCP
`mcp-server.service.ts`, `mcp-admin.service.ts`, `mcp-common.ts`, `routes/ai-mcp-admin.routes.ts`, `services/ai-tool-invoke.service.ts`.
Cek: tool dipanggil dengan izin pemilik token, token dicabut saat eksekusi berjalan, kebocoran antar tenant.

## Run B (uang + data pribadi): gateway AI
`ai-gateway.service.ts`, `lib/ai/pii.ts`, `lib/ai/url-guard.ts`, `ai-system-call.ts`, `lib/ai/anthropic.ts`.
Cek: anggaran dan kuota tidak bisa dilewati (race, retry, streaming), kill switch, PII keluar ke provider, SSRF lewat url-guard.

## Run C (uang): action request dan executor tulis
`ai-action-request.service.ts`, `ai-action-executors/{price-change,promotion,stock-adjustment,access,menu-availability}.ts`.
Cek: persetujuan tidak bisa dilompati, idempotensi, rollback promo multi-outlet, perubahan harga/stok/akses lintas outlet.

## Run D (migrasi + isolasi data)
`drizzle/0086_ai_tables.sql`, `0087_ai_rls.sql`, `db/schema/ai.ts`, `ai.custom.sql`, `ai-insights.ts`, `services/ai-metrics/scope.ts`, `ai-insights-access.ts`, `ai-conversation.service.ts` (cache).
Cek: RLS FORCE dan policy tiap tabel, FK ke tabel ber-FORCE RLS, cache antar outlet/MFA, shareholder dan periode terbuka.

Laporan: jumlah temuan per tingkat, 3 teratas, path berkas review.
