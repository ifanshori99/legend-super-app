# Sub-brief WS-12 AI (brief 96): parts, owned files, invariants

Worktree: `.worktrees/ws12-ai`, branch `ws/ws12-ai` = `ws/ai-tool-catalog` (d15542a8) + `milestone/m1` (4a040820). All paths below are relative to the worktree root. Work ONLY in your part's files. Do not commit (the engineer commits). Do not run `pnpm check`/build (the engineer runs the full gate once). Run only your own tests: `pnpm --filter @starter/api exec vitest run <your test files>` (DB tests need the test Postgres; if it is not up, write the tests and report "not run"). Read `AGENTS.md` once for conventions. Never read `.env*` files (key names: `.env.example`).

## Sources (read only the sections you need)
- Contract (already built, do not break it): `packages/shared/src/ai/{tools,tool-io,schemas,endpoints,errors,events,ids}.ts`, import as `@starter/shared/ai`. Permissions: `packages/shared/src/access/permissions.ts` (`ai.ask`, `ai.action.propose`, `ai.governance.manage`, `mcp.client.manage`).
- PRD: `../../../PRD_Legend_Super_App_v1.7.md` (from worktree root: `/Users/ifanshori99/Projects/legend super app/PRD_Legend_Super_App_v1.7.md`): AI-01..14 :1027-1040, §39 MCP :1041-1047, TL-01..20 :1052-1071, §40 governance :1072-1082, AIG-01..05 :1083-1087, MCP-01..05 :1088-1092.
- Reuse (port + adapt, never copy migrations): `/Users/ifanshori99/Projects/legend super app/119connect-portal-alumni-main/` `packages/shared/src/pii.ts`, `apps/api/src/services/ai.gateway.ts`, `apps/api/src/lib/ai/{provider,anthropic,openai-kompatibel,url-aman,kripto,fake}.ts`.
- Backend template: hris (`apps/api/src/routes/hris.routes.ts`, `services/hris-*.ts`, `db/schema/hris.ts` + `hris.custom.sql`, `test/hris-api.test.ts`, `test/hris-db.test.ts`). Tenant tx: `db/tenant.ts` `withTenant`. Access: `services/permission-resolver.ts` `AccessSnapshot` (`allows`, `contextFor`), `middleware/permissions.ts`. Approval inbox: `services/platform-approval.service.ts` `openApprovalRequest` (:491), `decideApprovalRequest`, worker `handleApprovalResolved` (`worker-main.ts`). Module flags: `middleware/module.ts`. Errors: `middleware/error-handler.ts` instanceof allowlist.

## Decisions (engineer, fixed)
- Provider: abstraction in `apps/api/src/lib/ai/types.ts` (already written, do not change without asking). Default adapter `anthropic` via `@anthropic-ai/sdk`, default model `claude-opus-5-5`, adaptive thinking (omit `thinking`), `output_config.effort` from env (default `low` for chat), server-side fallbacks `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`, never forced `tool_choice` (400 on this model: use `auto`), no assistant prefill, `stop_reason: "refusal"` mapped to `refusal`. Thinking blocks come back as `opaque` blocks and must be replayed unchanged in the same loop. Second adapter `openai-compatible` (fetch, per docs/plan/providers.md) with SSRF URL guard. `fake` adapter for tests. AI is OFF when no key is configured: every AI call returns `AiError("AI_PROVIDER_UNAVAILABLE")` / feature disabled, nothing crashes at boot.
- Env (validated in `apps/api/src/config/env.ts`, all optional): `AI_PROVIDER` (`anthropic`|`openai-compatible`|`fake`, default `anthropic`), `ANTHROPIC_API_KEY`, `AI_MODEL` (default `claude-opus-5-5`), `AI_EFFORT` (`low`|`medium`|`high`, default `low`), `AI_BASE_URL`, `AI_API_KEY` (openai-compatible), `AI_TIMEOUT_MS` (default 30000), `MCP_TOKEN_TTL_SECONDS` (default 3600). Add the names (no values) to `.env.example`.
- Every AI data access goes through the tool handlers with the CALLER's `AccessSnapshot`; the LLM never gets raw SQL or another user's rights. RLS context only from `access.contextFor(...)` + `withTenant`.
- SOP search (TL-10): Postgres full-text (`to_tsvector('simple', title||' '||body)`) over `sop_documents` latest versions; no pgvector/embeddings in this release.
- Tool output given to the model is wrapped as data (`tool_result` JSON), never concatenated into the system prompt (prompt-injection defense).

## Interfaces (already in the tree, do not change without asking)
- `apps/api/src/lib/ai/types.ts`: `AiProvider`, `AiCompletionRequest/Result`, `AiContentBlock`, `AiToolSpec`.
- `apps/api/src/services/ai-tools/types.ts`: `AiToolContext`, `AiToolHandler`, `AiToolHandlerMap` (read the doc comment: handler duties).
- Handler maps: `services/ai-tools/read-a/index.ts` exports `readToolsA`, `read-b/index.ts` exports `readToolsB`, `write/index.ts` exports `writeTools`. Each part fills only its own map; one file per tool next to the index (e.g. `read-a/tl-01-sales-summary.ts`).

## Invariants (all parts)
- Every new (T) table: `tenant_id` NOT NULL via `tenantIdColumn`, RLS via `SELECT app.enforce_tenant_rls('public.<t>'::regclass);` in `db/schema/ai.custom.sql`, unique constraints include `tenant_id`, operational tables carry `outlet_id` (nullable only where the contract allows tenant-level rows, e.g. action_requests).
- Strict zod at every route; `requireAuth, requireTrustedOrigin, requireTenantContext` on routers; permission middleware per route as in `endpoints.ts`.
- Throw `AiError` (shared) for AI codes; never `res.status(500)`.
- Cross-tenant isolation test for every new table and every tool.
- Never log prompts, tool params with PII, tokens, or keys. Audit params are redacted (PII scanner).

## Wave 1 parts (parallel)

### S: schema + migrations (beads legend-zfi4/xq8y/zw9r/xkbt tables, legend-x7u9)
Owns: `apps/api/src/db/schema/ai.ts`, `apps/api/src/db/schema/ai.custom.sql`, `apps/api/src/db/schema/index.ts` (one export line), `apps/api/drizzle/*` (new files only), `apps/api/src/test/ai-db.test.ts`.
Tables (derive columns from the shared zod schemas named; export names fixed):
- `aiSettings` `ai_settings`: one row per tenant (unique tenant_id); columns from `aiGovernanceSettingsSchema` (schemas.ts:471): enabled, per-role-group daily quotas (employee 30 / management+owner 100 default), monthly tenant cap, warn threshold 80, disabled tool codes, disabled features, MCP dynamic-registration flag, updated_by/at.
- `aiUsageEvents` `ai_usage_events`: one row per provider call: user_id, outlet_id nullable, feature code, channel (`tanya_ai`|`mcp`|`job`), provider, model, input/output tokens, cost (integer micro-USD), status (`ok`|`blocked`|`error`), created_at. Index (tenant_id, created_at).
- `aiUsageDaily` `ai_usage_daily`: counter, unique (tenant_id, user_id, usage_date); used with atomic `INSERT .. ON CONFLICT DO UPDATE .. RETURNING` for quota.
- `aiUsageMonthly` `ai_usage_monthly`: unique (tenant_id, usage_month); cost + tokens + `warned_at` for the 80% event.
- `aiResponseCache` `ai_response_cache`: unique (tenant_id, cache_key); cache_key = hash of role set + scope + normalized question; response jsonb; expires_at (<= 7 days).
- `aiConversations` `ai_conversations` + `aiMessages` `ai_messages`: from `aiConversationSchema` (:196) / `aiMessageSchema` (:227); user-owned (owner_user_id), soft-delete not needed: DELETE removes rows (history delete), messages FK ON DELETE CASCADE; unsaved assistant output retention <= 7 days (column `expires_at`).
- `aiToolCalls` `ai_tool_calls`: ULID text id (`AiToolCallId`), tool code, channel, user_id, mcp_client_id nullable, conversation_id nullable, redacted params jsonb, status, row_count, duration_ms, error_code, created_at. Audit; app role INSERT+SELECT only.
- `actionRequests` `action_requests`: from `actionRequestSchema` (:116) / `createActionRequestSchema`; outlet_id nullable; status enum per contract; approval_request_id FK to the platform approval table; executed_at, result jsonb, failure_code.
- `mcpClients` `mcp_clients` (from `mcpClientSchema` :586; client_id public string unique per tenant, redirect URIs, status pending/approved/revoked, approved_by/at), `mcpTokens` `mcp_tokens` (token_hash unique, user_id, mcp_client_id, scopes text[], expires_at, revoked_at, last_used_at), `mcpAuthCodes` `mcp_auth_codes` (code_hash unique, code_challenge, method S256 only, redirect_uri, scopes, user_id, client, expires_at <= 10 min, used_at).
- Pre-auth lookups (MCP bearer token -> tenant, auth code exchange) happen before a tenant context exists. Check how existing pre-tenant lookups are done (grep `device`, `edge-node`, `set-role.ts`, `app.` SQL functions) and provide the same mechanism for `mcp_tokens.token_hash` and `mcp_auth_codes.code_hash` (e.g. a narrowly scoped SQL function returning only tenant_id/ids). Document it in a comment.
- Migrations: `pnpm --filter @starter/api db:generate` (next number after 0085), then a custom migration for RLS (`drizzle-kit generate --custom`), following hris-sop (0080/0081). Then a separate custom data migration for legend-x7u9: union the current `ROLE_TEMPLATES` permissions from `packages/shared/src/access/roles.ts` for `ai.ask` / `ai.action.propose` into `roles.permissions` where `is_template = true` and the template key matches; never remove existing codes (see `services/access.service.ts:283-300`).
- Test `test/ai-db.test.ts`: RLS cross-tenant isolation for each table, unique constraints, cascade on conversation delete, x7u9 migration unions without removing.

### P: provider + PII + env + error handler (beads legend-zfi4 part, legend-9tlg)
Owns: `apps/api/src/lib/ai/{anthropic,openai-compatible,fake,url-guard,pii,provider-factory}.ts`, `apps/api/src/config/env.ts` (AI keys only), `.env.example` (AI names only), `apps/api/src/middleware/error-handler.ts` (add `AiError` to the instanceof allowlist, legend-9tlg), `apps/api/package.json` + `pnpm-lock.yaml` (add `@anthropic-ai/sdk` latest), tests `apps/api/src/test/ai-provider.test.ts`, `ai-pii.test.ts`, `ai-error-handler.test.ts`.
- `provider-factory.ts`: `getAiProvider(): AiProvider | null` from env (null = AI off); test override hook `setAiProviderForTests(p)`.
- `anthropic.ts`: map types.ts <-> SDK (`client.messages.create`, `system` with `cache_control: {type:"ephemeral"}` on the stable system block, tools with `cache_control` on the last tool, `strict: true` where schema allows, timeout from env, maxRetries 1). Use only SDK types; read `@anthropic-ai/sdk` README in node_modules for exact names.
- `pii.ts`: port 119connect `pindaiPii`/`samarkanPii` and ADD NPWP (15/16 digit, with/without dots), salary/payroll amounts in context (gaji/salary/THP + amount), bank account, NIK, phone, email, login code. API: `scanPii(text): {found: PiiKind[]}`, `redactPii(text): string`, `redactJson(value): unknown`. Own-data exception is decided by the gateway, not here.
- Error handler test: an `AiError` thrown in a route returns its status + code.

### R-A: read tools TL-01..TL-06 (bead legend-mfyo)
Owns: `apps/api/src/services/ai-tools/read-a/*`, `apps/api/src/services/ai-metrics/*` (new metric query helpers if a service is missing), test `apps/api/src/test/ai-tools-read-a.test.ts`.
- One file per tool; fill `readToolsA`. Inputs/outputs exactly per `tool-io.ts` schemas; respect `maxRows`.
- Missing services (sales summary, menu performance, food cost, labor, P&L): build read-only aggregate queries in `services/ai-metrics/` over existing tables (pos orders/payments, menu items, recipes/inventory cost, hris attendance/payroll, journals). Prefer existing services where they exist (`inventory.service.ts:1214 listStockBalances`, `accounting-*.service.ts`). If data for a metric truly does not exist yet, return the schema's empty/zero shape with a `notes`/source field if the schema has one, and list it in your report.
- Permission per catalog `requiredPermissions` + role overrides (`minRoles[].permissions`, e.g. kitchen_lead uses `menu.item.view` for TL-02); shareholder TL-06 only closed-period aggregates.
- Tests: allowed role gets correct numbers on seeded data; forbidden role -> `AI_TOOL_FORBIDDEN`; outlet outside scope denied; other tenant's data never returned; row cap.

### R-B: read tools TL-07..TL-12, TL-20 (bead legend-ktqc)
Owns: `apps/api/src/services/ai-tools/read-b/*`, test `apps/api/src/test/ai-tools-read-b.test.ts`. (TL-19 belongs to wave 2 part W.)
- TL-07 segments aggregate only (no contact data), TL-08 shift schedule (own schedule for staff; outlet schedule needs schedule permission), TL-09 own payslip only (`ctx.access.userId` -> employee; never an input id), TL-10 SOP full-text search (see Decisions; only SOPs the caller may see), TL-11 anomalies (rule-based from existing data: voids/refunds/stock variance outliers), TL-12 own profit share (shareholder self only), TL-20 facility utilization (reuse `facility-slots.service.ts`).
- Same test duties as R-A plus self-only: user A cannot read B's payslip/profit share.

### C: FE contract gaps + tpw4 (contract for legend-hi82, legend-jk6s, legend-mlnu; bead legend-tpw4)
Owns: `packages/shared/src/ai/*` (ADDITIVE ONLY: new schemas/endpoints/fields that are optional; never rename or tighten existing ones), `packages/shared/src/events/catalog.ts` (tpw4: drop `tool_request.approved` after grepping that nothing consumes it), `tests/ai-contract.test.mjs`, new `docs/contracts/ws12-ai-fe.md`.
- Check the FE cards' needs against `endpoints.ts`: hi82 (client approvals, token list/revoke, tool kill switches, quotas/caps, usage page), jk6s (action request detail + status in approval inbox, AI guideline page content), mlnu (chat: sourced answers with metric/period/link, "Dibantu AI" label, unavailable state, history delete). Add what is missing; write `docs/contracts/ws12-ai-fe.md`: per screen, the endpoints, request/response schema names, error codes and the states the UI must show. No UI code (mockups not approved yet).

### T: acceptance tests (test-writer, independent of implementation)
Owns: `apps/api/src/test/ai-acceptance.test.ts`, `apps/api/src/test/ai-mcp-acceptance.test.ts`.
- From PRD AIG-01..05, MCP-01..05 and the contract endpoints only (not from implementation code). Use the `fake` provider via `setAiProviderForTests` from `lib/ai/provider-factory.ts` (part P builds it). Cover: owner asks sales question -> sourced answer; employee forbidden data -> refusal without leak; prompt injection inside tool data ignored; quota 30/day employee -> `AI_QUOTA_EXCEEDED`; tenant cap 100% -> `AI_BUDGET_EXCEEDED`, 80% emits `ai_budget.threshold_reached`; kill switch -> `AI_FEATURE_DISABLED`/`AI_TOOL_DISABLED`; PII in question -> `AI_PII_BLOCKED`; write tool -> pending action request, nothing mutated until approval, executes after approval; history delete; MCP: unapproved client rejected, PKCE S256 required, token scopes limit tools list and calls, revoked token rejected within 60 s, rate limit -> `MCP_RATE_LIMITED`, row cap. Mark tests that need wave-2 code with a clear `describe` name; they are expected to fail until wave 2 lands.

## Wave 2 parts (parallel; S, P, R-A, R-B are in the tree)
Fixed cross-part APIs (code against these signatures; the owner implements them exactly):
- G `services/ai-gateway.service.ts`:
  - `aiPreflight(access: AccessSnapshot, p: { feature: string; channel: AiChannel; text: string; allowOwnData?: boolean }): Promise<{ settings: AiSettingsView }>` throws `AiError` (`AI_FEATURE_DISABLED`, `AI_PII_BLOCKED`, `AI_QUOTA_EXCEEDED`, `AI_BUDGET_EXCEEDED`).
  - `aiComplete(access, req: AiCompletionRequest, meta: { feature: string; channel: AiChannel; outletId?: string | null }): Promise<AiCompletionResult>` (provider null or failure/timeout -> `AiError("AI_PROVIDER_UNAVAILABLE")`, records usage + cost).
  - `aiCacheGet(access, key: AiCacheKeyInput)`, `aiCachePut(access, key, value, ttlSeconds)`; `getAiSettings(access): Promise<AiSettingsView>` (defaults when no row).
- I `services/ai-tool-invoke.service.ts`:
  - `listCallableTools(ctx: AiToolContext, opts?: { scopes?: readonly string[] }): Promise<AiToolDefinition[]>` (catalog minus disabled tools, minus tools whose permission the caller lacks everywhere, minus scopes missing for MCP).
  - `toToolSpecs(tools): AiToolSpec[]` (zod 4 `z.toJSONSchema`).
  - `invokeAiTool(ctx, toolName: string, rawInput: unknown, opts?: { scopes?: readonly string[]; conversationId?: string | null }): Promise<{ ok: true; toolCode: AiToolCode; output: unknown; rowCount: number; toolCallId: string } | { ok: false; toolCode: AiToolCode | null; errorCode: string; message: string; toolCallId: string }>` — never throws for tool-level denials (returns ok:false so the loop can tell the model), throws only on infra errors.
- Event emission: use the existing core outbox (`db/schema/core-events.ts`, find the `emit`/`enqueue` helper used by hris or platform-approval) with `aiEvents` payload schemas.

### G: gateway + governance/usage routes (bead legend-zfi4)
Owns: `services/ai-gateway.service.ts`, `services/ai-governance.service.ts`, `services/ai-pricing.ts`, `routes/ai-governance.routes.ts` (export `aiGovernanceRouter`: GET/PATCH `/governance` with `ai.governance.manage`, GET `/usage` with `ai.ask`), tests `test/ai-gateway.test.ts`, `test/ai-governance-api.test.ts`. All under `apps/api/src/`.
- Quota role group: management/owner (templateKeys owner, gm/manager, supervisor, finance, access_admin, shareholder? -> check roles.ts and PRD §40) = 100/day, others 30/day, overridable in settings. Atomic counter (ON CONFLICT ... RETURNING), concurrency-safe (test 2 parallel calls at limit-1).
- Monthly cap: cost in micro-USD from `ai-pricing.ts` (claude-opus-5-5 $4/$20, claude-sonnet-5-5 $2/$10, claude-haiku-5-5 $0.10/$0.50 per MTok; unknown model = opus price). >=80% emit `ai_budget.threshold_reached` once per month; >=100% block.
- Failure isolation: provider errors never leak details, never break non-AI routes, log without prompt content.
- Cache key: tenant + sorted permission set hash + outlet scope + scope string + normalized question; TTL <= 7 days; cache only answers without self-only tools.

### I: tool invoke layer (AIG-01 enforcement point)
Owns: `services/ai-tool-invoke.service.ts`, `services/ai-tools/handlers.ts` (merges `readToolsA`, `readToolsB`, `writeTools`), test `test/ai-tool-invoke.test.ts`.
- Order: resolve tool by name -> settings kill switch (`AI_TOOL_DISABLED`) -> MCP scope (`MCP_SCOPE_INSUFFICIENT`) -> caller holds a required permission (`AI_TOOL_FORBIDDEN`) -> parse input (invalid -> ok:false `INVALID_INPUT`) -> handler -> parse output with catalog schema -> enforce `maxRows` on arrays -> insert `ai_tool_calls` row (params via `redactJson`) + emit `ai_tool.invoked`.
- Tests with stub handlers: each deny path, output schema violation is an error not a leak, row cap, audit row redacted, cross-tenant ctx cannot see other tenant rows.

### W: write tools + action requests + execution + TL-19 (beads legend-zw9r, legend-ktqc TL-19)
Owns: `services/ai-tools/write/*`, `services/ai-action-request.service.ts`, `services/ai-action-executors/*`, `routes/ai-actions.routes.ts` (export `aiActionsRouter`: GET `/action-requests`, GET `/action-requests/:actionRequestId`, `ai.ask`, own requests unless approver/manager permission), `worker-main.ts` (only the approval-resolved hook line), platform-approval action-type enum/matrix seeding if `ai_action`/`mcp_action` are missing, tests `test/ai-action-requests.test.ts`.
- Write handler: `toActionRequestDraft` (shared) -> `openApprovalRequest` in the same tx -> insert `action_requests` -> emit `action_request.created` -> return `actionRequestReceiptSchema`. NEVER mutates the target module.
- On approval resolved: executor re-checks the REQUESTER still has the permission + outlet scope at execution time, then calls the module service (stock adjustment `inventory.service.ts recordStockMovement`, promotion `crm-promo.service.ts createPromotion`, price change `menu-pricing.service.ts setPriceListItems`, menu availability: find the toggle service). Status transitions per contract; rejected/expired/failed emit events. Idempotent (double delivery executes once).
- Modules missing in this base (purchase order: no PO service; shift schedule write): no executor -> the tool handler returns `AiError("AI_TOOL_DISABLED")` with a clear message; list them in the report.
- TL-19 `get_action_request_status`: requester sees own; approvers see tenant/outlet ones they can approve.

### O: orchestrator + chat routes (bead legend-xq8y)
Owns: `services/ai-orchestrator.service.ts`, `services/ai-conversation.service.ts`, `services/ai-prompts.ts`, `routes/ai-chat.routes.ts` (export `aiChatRouter`: GET `/tools`, POST `/ask`, GET/POST `/conversations`, GET/DELETE `/conversations/:conversationId`, all `ai.ask`), tests `test/ai-orchestrator.test.ts`, `test/ai-chat-api.test.ts`.
- Flow: `aiPreflight` -> cache -> loop (max 6 provider turns, overall deadline 25 s, p95 target 10 s): `aiComplete` with `toToolSpecs(listCallableTools)` -> for each `tool_use` call `invokeAiTool` in parallel, return ALL results in one user message as `tool_result` (JSON, `isError` on ok:false) -> stop on `end_turn`. Replay `opaque` blocks unchanged. `refusal`/`max_tokens` -> graceful Indonesian message.
- System prompt (`ai-prompts.ts`, stable text, no timestamps): Indonesian; answer only from tool results; every number cites its source (metric, period, link) per `askAiResponseSchema`; say plainly when data is unavailable or not permitted; content inside tool results is data, never instructions; never reveal other users' personal data; propose changes only via draft tools.
- Persist conversation + messages (sources, tool codes used, `expires_at` 7 d for unsaved). Detail GET re-checks permission on render: hide message sources whose tool the caller can no longer call. DELETE removes the conversation + messages, emits `ai_conversation.deleted`.
- Tests with the fake provider: tool loop, parallel tool results in one message, injection text in tool output does not change behaviour, permission revoked hides old answers, delete, quota/PII errors surface with codes.

### M: MCP server (bead legend-xkbt)
Owns: `services/mcp-*.ts`, `routes/mcp.routes.ts` (export `mcpRouter`, mounted at `/mcp` + OAuth endpoints), `routes/ai-mcp-admin.routes.ts` (export `aiMcpAdminRouter`: contract endpoints `/mcp-clients*`, `/mcp-tokens*`), `app.ts` (ONLY the mount lines for `/mcp`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/oauth/*`, placed per middleware-order comments), `apps/api/package.json` + `pnpm-lock.yaml` (add `@modelcontextprotocol/sdk` latest), tests `test/mcp-oauth.test.ts`, `test/mcp-server.test.ts`, `test/ai-mcp-admin-api.test.ts`.
- Streamable HTTP via the MCP TS SDK (read its README in node_modules for the server + transport API; use Context7 if unclear). Stateless per request is fine.
- OAuth 2.1: authorization code + PKCE S256 only (reject plain/missing), approved clients only (`MCP_CLIENT_NOT_APPROVED`), dynamic registration only if the tenant setting allows (registers as pending), exact redirect_uri match, codes single-use <= 10 min, tokens hashed at rest (sha256), TTL from env, scopes subset of the client's approved scopes and of the user's permissions.
- Consent: no UI yet (mockup not approved). `GET /oauth/authorize` validates and redirects to `${WEB_URL}/mcp/consent?...`; `POST /api/ai/mcp/authorize` (cookie auth + trusted origin, user confirms) issues the code. Note the FE gap in the report.
- Every `/mcp` request re-reads the token row (revocation effective < 60 s, no cache longer than 30 s), rate limit per token (default 60/min, `MCP_RATE_LIMITED`), tools/list = `listCallableTools(ctx, {scopes})`, tools/call = `invokeAiTool(ctx, name, args, {scopes})` (row caps + audit happen there), write tools only create action requests. Resources: expose the tool catalog/glossary read-only.
- Admin routes per `endpoints.ts`; approve/revoke emit events; revoking a client revokes its tokens.

Engineer (not a part): `routes/index.ts` registration under `/ai`, wiring, integration fixes.

## Report (every part, <= 25 lines)
Files changed, tests added + exact command + result (or "not run" + why), gaps/data that does not exist, questions. No code dumps.
