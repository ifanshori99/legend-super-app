# WS-12 AI and MCP: frontend contract

Beads: legend-hi82 (admin), legend-jk6s (approval and guidelines), legend-mlnu (chat). Source of truth is `packages/shared/src/ai/endpoints.ts`, `schemas.ts`, `errors.ts` (import `@starter/shared/ai`). No UI is specified here; mockups are not approved.

Rules for every screen: tenant comes from the domain, never the body. Lists use cursor pages. Errors arrive as `{ code, message }`; the UI maps `code` to catalog text and uses the Indonesian default message as fallback. Raw MCP tokens never appear.

## 1. Chat (legend-mlnu), permission `ai.ask`

| Need | Endpoint | Schemas |
|---|---|---|
| Ask | `POST /api/ai/ask` | `askAiSchema` -> `askAiResponseSchema` |
| History list | `GET /api/ai/conversations` | `aiConversationListQuerySchema` -> page of `aiConversationSchema` (deleted ones are excluded) |
| Open history | `GET /api/ai/conversations/:conversationId` | `aiConversationDetailSchema` |
| Delete history | `DELETE /api/ai/conversations/:conversationId` | 204, owner only, soft delete |
| Start empty | `POST /api/ai/conversations` | `createAiConversationSchema` |
| Quota and availability | `GET /api/ai/usage` | `aiUsageSummarySchema` |
| Draft created by a write tool | `GET /api/ai/action-requests/:actionRequestId` | `actionRequestSchema` |

States the UI must show:
- Sourced answer: each `aiMessageSchema.sources[]` has `label`, relative `link`, optional `metricCode` and `period`. Render as source chips.
- "Dibantu AI" label on every message with `aiAssisted: true` (always true for assistant).
- Draft pending: `askAiResponse.actionRequestIds` non-empty means "diajukan, menunggu persetujuan"; nothing has changed yet.
- Unavailable: `usage.aiEnabled === false` (admin switch) or `usage.providerAvailable === false` (provider down, optional field, absent = unknown). Also on error `AI_PROVIDER_UNAVAILABLE` (503). The rest of the app keeps working.
- Quota left: `usage.features[].usedToday / dailyLimit`; `isEnabled: false` hides or disables that feature.
- Empty history, loading, and delete confirmation.

Error codes on ask: `AI_FEATURE_DISABLED` 403, `AI_TOOL_DISABLED` 403, `AI_QUOTA_EXCEEDED` 429, `AI_BUDGET_EXCEEDED` 402, `AI_PROVIDER_UNAVAILABLE` 503, `AI_PII_BLOCKED` 422 (question carries personal data: tell the user to remove it), `AI_TOOL_FORBIDDEN` 403, `AI_CONVERSATION_NOT_FOUND` 404.

## 2. Approval inbox and guidelines (legend-jk6s)

Action request in the approval inbox:
- `GET /api/ai/action-requests/by-approval/:approvalRequestId` -> `actionRequestReviewSchema` (NEW). Contains `actionRequest` (status, tool code, outlet, `expiresAt`, `resultRef`, `failureReason`), `toolTitleId`, `requestedByName`, `outletName` (null = tenant-level) and `summary[]` (label/value lines, redacted; render this, not the raw `payload`).
- Own list: `GET /api/ai/action-requests` with new optional filter `approvalRequestId`, plus `status`, `toolCode`.
- Decide (approve or reject) goes through the approval module, not through `/api/ai`. Execution happens after approval.
- Status badges for `actionRequestStatusSchema`: `pending`, `approved`, `rejected`, `executed`, `failed` (show `failureReason`), `expired`.
- Errors: `ACTION_REQUEST_NOT_FOUND` 404, `ACTION_REQUEST_INVALID_TRANSITION` 409.
- Note for the route author: register `/action-requests/by-approval/:approvalRequestId` before `/action-requests/:actionRequestId`.

Guidelines page (Pedoman Penggunaan AI, PRD Fitur 40 Transparansi):
- `GET /api/ai/guidelines` -> `aiGuidelinesSchema` (NEW): `version`, `updatedAt`, `sections[]` with `id`, `titleId`, `paragraphsId[]`. Any signed-in user. Text is static per release (written by tech-writer, served by the API).
- States: loading, error with retry.

## 3. AI admin (legend-hi82)

Permissions: governance, tools, usage, audit -> `ai.governance.manage`; clients and tokens -> `mcp.client.manage` (own token list and revoke also for the token owner).

### Settings, quotas, caps, kill switches
- `GET` and `PATCH /api/ai/governance`: `aiGovernanceSettingsSchema`, `updateAiGovernanceSettingsSchema` (partial; absent field = unchanged; at least one field).
- Master switches: `aiEnabled`, `mcpEnabled`, `dynamicClientRegistrationEnabled` (default off, MCP-05).
- Quotas: `features[]` = `{ feature, isEnabled, dailyLimitByRole }`; roles without an entry use 30 (employee-type) or 100 (others).
- Caps: `monthlyBudgetIdr`, `budgetWarnPct` (default 80), `budgetStopPct` (default 100), `mcpRateLimitPerMinute` (1..600), `maxRowsPerResponse` (1..200). Validation: warn must be below stop (422 field error).
- Tool kill switches: `GET /api/ai/governance/tools` -> list of `aiGovernanceToolSchema` (NEW: catalog tool + `isEnabled`; disabled tools are listed here, unlike `/api/ai/tools`). Toggle by PATCH `disabledToolCodes` (full list replaces).

### Usage page
- Own quota and budget: `GET /api/ai/usage` (`budget` non-null for admins).
- Tenant month: `GET /api/ai/governance/usage?month=YYYY-MM` -> `aiTenantUsageSchema` (NEW): `budget` (state `ok|warn|stopped`), `byFeature[]` (jobs, blockedJobs, tokens, costIdr), `blockedByReason[]`, `mcpToolCalls`.
- Audit: `GET /api/ai/tool-calls` -> page of `aiToolCallRecordSchema` (NEW; filters `channel`, `toolCode`, `outcome`, `mcpClientId`, `userId`). Params are already redacted.
- States: budget warn banner at `state: "warn"` (80%), stop banner at `"stopped"`; empty month.

### MCP clients
- `GET /api/ai/mcp-clients?status=pending|approved|revoked` -> page of `mcpClientSchema`.
- `POST /api/ai/mcp-clients` (register, `registerMcpClientSchema`), `POST .../:mcpClientId/approve` (`approveMcpClientSchema`, scopes), `POST .../:mcpClientId/revoke` (`revokeMcpClientSchema`).
- Pending clients need an approve action; a dynamic client lands as `pending`.

### MCP tokens
- `GET /api/ai/mcp-tokens?scope=mine|tenant&clientId&includeInactive` -> page of `mcpTokenSummarySchema` (prefix only; NEW optional `clientName`, `userDisplayName`).
- `POST /api/ai/mcp-tokens/:mcpTokenId/revoke` (`revokeMcpTokenSchema`). Takes effect within 60 seconds (MCP-02): show that text after revoking.
- Token states: active, expired (`expiresAt` past), revoked (`revokedAt`).

### MCP consent screen (route `/mcp/consent`, outside the admin area)
- `GET /oauth/authorize` (API root) validates the request and redirects the browser to `${WEB_URL}/mcp/consent?<the same OAuth query>`. It never returns a code. A refusal on a registered `redirect_uri` is redirected there with `error=`.
- `GET /api/ai/mcp/authorize/preview?client_id&redirect_uri&scope&...` (session, trusted origin, tenant; `mcpAuthorizePreviewQuerySchema`) -> `{ data: { clientName, redirectUri, scopes: [{ scope, label }] } }`. Scopes are the requested ones cut to the client's approved scopes and what the user's role allows; `label` is Indonesian (`MCP_SCOPE_LABELS_ID`). Errors (unknown client, `redirect_uri` not registered, MCP or AI off, user lacks `ai.ask`) come back as a 4xx body `{ error: { code, message } }`: show the message, do not redirect.
- Buttons: "Izinkan" posts `POST /api/ai/mcp/authorize` with the OAuth query as JSON (same snake_case names) plus `approve: true`; the answer is `{ redirectTo }` and the page does `window.location.assign(redirectTo)`. "Tolak" navigates to `redirect_uri?error=access_denied&state=...` without calling the API. `redirectTo` may carry `error=` (a refusal), so always follow it.
- States: signed-out (sign in first, then return to the same URL), loading, preview error, MFA required but not verified (`redirectTo` carries `error=access_denied`), success (short "Menyambungkan..." screen).

Error codes in this area: `MCP_CLIENT_NOT_APPROVED` 403, `MCP_TOKEN_REVOKED` 401, `MCP_TOKEN_EXPIRED` 401, `MCP_SCOPE_INSUFFICIENT` 403, `MCP_RATE_LIMITED` 429.

## Changes made to the contract (all additive)
New endpoints: `listAiGovernanceTools`, `getAiTenantUsage`, `listAiToolCalls`, `getActionRequestByApproval`, `getAiGuidelines`. New optional fields: `mcpTokenSummary.clientName`, `mcpTokenSummary.userDisplayName`, `aiUsageSummary.providerAvailable`, `actionRequestListQuery.approvalRequestId`. Removed event name `tool_request.approved` (legend-tpw4; no emitter or consumer).

Not done: fixtures for the new response schemas (the FE mock mode needs them when the UI starts), and route handlers (wave 2).
