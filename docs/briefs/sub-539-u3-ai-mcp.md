# Sub-brief 539-U3: Tanya AI + MCP UI (branch ui/ai-mcp)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ai-mcp` (work ONLY here).
Cards: legend-mlnu (chat), legend-jk6s (action detail + approval inbox + guide), legend-39d.1 (consent), legend-hi82 (admin).
Standard: `~/.agents/team/ui-standard.md` (states, a11y, AI UI rules). `DESIGN.md` at repo root. Components: `@/components/ui/*` only, tokens only, light + dark.

## Inputs
- Mockups (approved by founder 12 Nov, follow exactly): `/Users/ifanshori99/Projects/legend super app/legend/design/mockups/ai/` (outside this worktree; read the `.html` for copy/structure and ONLY the two PNGs of your screen).
- Contract: `docs/contracts/ws12-ai-fe.md`. Schemas/endpoints: `packages/shared/src/ai/{endpoints,schemas,errors,fixtures}.ts`, import `@starter/shared/ai`. Base fixtures: `cafeLegendAiFixtures`.
- Data pattern to copy: `apps/web/src/features/ws05-payment-admin/` (`api.ts` via `callEndpoint`, `queries.ts`, `hooks.ts`, `mock.ts` with `registerMock`, scenarios). Mock files are auto-loaded by glob (`features/*/mock.ts`, `features/*/*-mock.ts`). Components never know data is mock.
- Missing fixtures (usage, tenant usage, governance tools, guidelines, action-request review, consent preview, ask response): build them in YOUR feature's mock.ts and `schema.parse()` them so they match the contract. Do NOT edit `packages/shared/src/ai/*`.
- Routes: TanStack file routes in `apps/web/src/routes/_<area>/`, see `routes/_kelola/kelola.akses-dukungan.tsx` (guard + head title). Nav: `features/<f>/nav.ts` default export `AreaNavEntry[]` (see `features/ws01-approvals/nav.ts`).
- Text: ALL UI text in your own catalog file `packages/shared/src/i18n/messages/ws12-ai-<part>.ts` (already wired into `id.ts`; do NOT edit `id.ts`). Use `useT()` from `@/components/i18n`. Copy = mockup strings verbatim.
- Permissions: `ai.ask`, `ai.action.propose`, `ai.governance.manage`, `mcp.client.manage`.

## Rules for every implementer
- Own only the files listed for your part. Do NOT edit `apps/web/src/routeTree.gen.ts` (lead regenerates once), `id.ts`, other parts' folders.
- Every screen: loading (skeleton shaped like content), empty, error (what + how to recover), success; offline where relevant; desktop and 390 px (mobile is designed, not squeezed; primary action ≥ 44 px; no horizontal scroll at 320 px).
- Mock scenarios for each non-default state, reachable by URL in mock mode, like payment-admin does. List the scenario URLs in your report.
- Pure logic (no React/router/framework imports) goes in your `logic.ts`, exact signatures below; a test-writer writes `tests/ws12-ai-ui.test.mjs` against them in parallel.
- Do NOT run tsc, vitest, build, Playwright, or dev servers (lead holds the one heavy token). `pnpm exec prettier --write <your files>` is fine.
- No commits. Report: files changed, routes, scenario URLs, any deviation from mockup + reason, any backend endpoint still missing.

## Parts

### P1 chat (legend-mlnu) — folder `apps/web/src/features/ws12-ai-chat/`, text `ws12-ai-chat.ts` (ns `aiChat`)
Mockup `tanya-ai.html` (+ `?state=denied|unavailable|delete`). Reusable `TanyaAiPage` + answer-with-source component ("Dibantu AI" label, metric/period/source link card, "Periksa sumber..." note), history pane (own conversations, "Percakapan baru", delete-all dialog = DELETE each conversation or the contract's delete; destructive → confirm), composer (label visible), streaming-like progressive reveal with stop + retry, `aria-live="polite"` on the answer only. States: denied banner, unavailable banner (Coba lagi / Buka laporan), quota/budget/PII messages via `classifyAskError`. Sidebar link to "Panduan AI" (`<area>/tanya-ai/panduan`, built by P2).
Routes: `_owner/owner.tanya-ai.tsx`, `_shareholder/shareholder.tanya-ai.tsx`, `_kelola/kelola.tanya-ai.index.tsx`, `_karyawan/karyawan.tanya-ai.tsx`, `_kitchen/kds.tanya-ai.tsx` (check each area's path prefix; use `_` suffix segments if a parent layout file would capture it). `nav.ts` entries per area, `anyPermission: ["ai.ask"]`.
`logic.ts`:
- `classifyAskError(err: unknown): "denied" | "unavailable" | "quota" | "budget" | "pii" | "error"` — uses `ApiError` (`apps/web/src/lib/api/errors.ts`, `.code`, `.status`). `AI_TOOL_FORBIDDEN` or any other 403 not listed below → `"denied"`; `AI_FEATURE_DISABLED`, `AI_TOOL_DISABLED`, `AI_PROVIDER_UNAVAILABLE`, `AI_PROVIDER_NOT_CONFIGURED`, any 503, and any non-ApiError (network) → `"unavailable"`; `AI_QUOTA_EXCEEDED` → `"quota"`; `AI_BUDGET_EXCEEDED` → `"budget"`; `AI_PII_BLOCKED` → `"pii"`; anything else → `"error"`.

### P2 guide (legend-jk6s part) — folder `apps/web/src/features/ws12-ai-guide/`, text `ws12-ai-guide.ts` (ns `aiGuide`)
Mockup `panduan.html`. Data from `GET /api/ai/guidelines` (`aiGuidelinesSchema`) if it carries the items; otherwise static catalog text. Routes `<area>/tanya-ai/panduan` for the same 5 areas as P1 (e.g. `_kelola/kelola.tanya-ai.panduan.tsx`, `_owner/owner.tanya-ai_.panduan.tsx` if `owner.tanya-ai.tsx` is a leaf). "Kembali ke Tanya AI" links to that area's chat. No nav entry. No `logic.ts` needed.

### P3 action (legend-jk6s) — folder `apps/web/src/features/ws12-ai-action/`, text `ws12-ai-action.ts` (ns `aiAction`)
Mockup `action-detail.html`. Route `_kelola/kelola.tanya-ai.aksi.$actionRequestId.tsx` (`GET /api/ai/action-requests/:id` + review schema). Draft diff view, status badge with icon+text, approval flow card ("Penyetuju harus orang yang berbeda dari pemohon"), "Buka kotak persetujuan" → `/kelola/persetujuan/<approvalRequestId>`. Also plug an AI section into the approval inbox detail: `features/ws01-approvals/components/approval-detail.tsx` (only additive: when `GET /api/ai/action-requests/by-approval/:approvalId` returns data, render your `AiActionSummary` component with "Dibantu AI" label + link to the action detail). States incl. not found (`ACTION_REQUEST_NOT_FOUND`) and every status.
`logic.ts`:
- `actionStatusView(status: ActionRequestStatus): { tone: "waiting" | "info" | "success" | "danger" | "muted"; labelKey: string }` — pending→waiting, approved→info, executed→success, rejected→danger, failed→danger, expired→muted; `labelKey` = `` `aiAction.status.${status}` `` (add those 6 keys to your catalog).

### P4 consent (legend-39d.1) — folder `apps/web/src/features/ws12-ai-consent/`, text `ws12-ai-consent.ts` (ns `aiConsent`)
Mockup `consent.html`. Route `/mcp/consent` at root, outside areas: `apps/web/src/routes/mcp.consent.tsx`. Follow the contract section "MCP consent screen" exactly: preview via `previewMcpAuthorize`; "Setujui akses" posts `POST /api/ai/mcp/authorize` (no shared endpoint const exists: define a typed local endpoint/`apiFetch` call in your `api.ts` matching the contract, body = OAuth query snake_case + `approve: true`, response `{ redirectTo }`) then `window.location.assign(redirectTo)`; "Tolak" → `buildDenyRedirect` without API call. States: signed-out (find the app's existing sign-in redirect-with-return pattern), loading, preview error (show message, no redirect), missing params, MFA-required (follow redirectTo), success "Menyambungkan...". Robots noindex.
`logic.ts`:
- `parseConsentQuery(search: string): ConsentQuery | null` — reads `client_id, redirect_uri, response_type, scope, state, code_challenge, code_challenge_method` (leading `?` optional); keeps only those keys that are present and non-empty, drops unknown keys; returns `null` if `client_id` or `redirect_uri` is missing/empty.
- `buildDenyRedirect(q: ConsentQuery): string | null` — `new URL(q.redirect_uri)`, keep its existing query, set `error=access_denied`, set `state=<q.state>` only when present; return `href`; invalid URL → `null`.
- `buildAuthorizeBody(q: ConsentQuery): ConsentQuery & { approve: true }`.

### P5 admin (legend-hi82) — folder `apps/web/src/features/ws12-ai-admin/`, text `ws12-ai-admin.ts` (ns `aiAdmin`)
Mockup `admin.html` (+ `?state=revoke`). Route `_kelola/kelola.pengaturan_.mcp-ai.index.tsx` (guard `anyPermission ai.governance.manage | mcp.client.manage`), nav entry in `nav.ts`. Sections: service controls (master switch + Tanya AI switch via `PATCH /governance`, confirm before turning off), "Kelola tool" → sheet listing `GET /governance/tools` with per-tool kill switches, MCP clients table (pending → approve with scopes; approved → revoke) that becomes stacked cards on mobile, quota & cap card (budget %, warn ≥ 80 % / stop banner, daily per-role limits, "Ubah" dialog for caps). Link "Lihat pemakaian" → P6 route; "Lihat log audit" → existing audit route if present, else P6 tool-call log.
Founder decision Q11 (must show): revoking one client = ALL sessions of that client disconnect. Revoke dialog shows client name, active token count and distinct user count (`clientRevokeImpact`), says every session of that app ends and each user must approve access again, requires a reason (contract `revokeMcpClientSchema.reason`, min 3 chars, label visible, inline error), and after success shows "berlaku dalam 1 menit" (MCP-02).
`logic.ts`:
- `mcpTokenState(t: { expiresAt: string; revokedAt: string | null }, now: Date): "active" | "expired" | "revoked"` — revokedAt non-null → revoked; else `Date.parse(expiresAt) <= now` → expired; else active.
- `clientRevokeImpact(tokens: { clientId: string; userId: string; expiresAt: string; revokedAt: string | null }[], clientId: string, now: Date): { activeTokens: number; users: number }` — only active tokens of that client; users = distinct userId among them.
- `budgetPercent(spentIdr: number, capIdr: number | null): number | null` — cap null or ≤ 0 → null; else `Math.max(0, Math.floor(spentIdr * 100 / capIdr))` (not clamped above 100).

### P6 admin usage + tokens (legend-hi82 part) — files `apps/web/src/features/ws12-ai-admin/usage-*.tsx|ts` and `usage-mock.ts` (NOT P5's files), text `ws12-ai-admin-usage.ts` (ns `aiAdminUsage`)
No own mockup: reuse admin.html visual language (cards, table→stacked cards on mobile). Route `_kelola/kelola.pengaturan_.mcp-ai.pemakaian.tsx`: month picker, `GET /governance/usage?month` (byFeature table, blockedByReason, mcpToolCalls, budget banner), token list `GET /mcp-tokens?scope=tenant` with state badges (import `mcpTokenState` from `./logic.ts`, P5 writes it — if missing at your time, write against the signature above) and per-token revoke (confirm, "berlaku dalam 1 menit"), tool-call audit `GET /tool-calls` with filters. Empty month state. Back link to `/kelola/pengaturan/mcp-ai`.
