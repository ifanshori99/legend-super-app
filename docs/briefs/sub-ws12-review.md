# Review brief WS-12 AI (tingkat K: auth, akses data, migration)

Worktree `.worktrees/ws12-ai`, branch `ws/ws12-ai`, uncommitted changes vs HEAD (`git diff HEAD` + untracked files, `git status`). Context: `docs/briefs/sub-ws12-ai.md` (design + invariants). Read-only review. Report only real defects: file:line, failure scenario, severity (P0 leak/bypass, P1 wrong behaviour, P2 minor), suggested fix. No style nits. <= 40 lines.

Invariants to verify: every AI data access uses the CALLER's AccessSnapshot + `contextFor` + `withTenant` (tenant/outlet RLS); self-only tools bind to `access.userId`; no cross-tenant read/write path; write tools never mutate before approval; tokens/codes hashed, PKCE S256 only, revocation < 60 s; PII never sent to provider or logged; tool output treated as data; new tables have tenant RLS.

Areas:
- R1 MCP + OAuth: `apps/api/src/services/mcp-*.ts`, `routes/mcp.routes.ts`, `routes/ai-mcp-admin.routes.ts`, `app.ts` mount lines, SQL functions `app.mcp_resolve_*` in `db/schema/ai.custom.sql` / `drizzle/0087_ai_rls.sql`. Known question: `GET /oauth/authorize` issues a code without an explicit consent step when a session exists — judge the risk.
- R2 tool authorization + read tools: `services/ai-tool-invoke.service.ts`, `services/ai-tools/**` (except write/), `services/ai-metrics/**`.
- R3 gateway, orchestrator, schema: `services/ai-gateway.service.ts`, `ai-governance.service.ts`, `ai-pricing.ts`, `ai-orchestrator.service.ts`, `ai-conversation.service.ts`, `ai-prompts.ts`, `routes/ai-chat.routes.ts`, `routes/ai-governance.routes.ts`, `lib/ai/**`, `db/schema/ai.ts`, `drizzle/0086..0088`.
