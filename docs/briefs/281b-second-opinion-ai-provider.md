# Brief: second-opinion (Codex) for WS-12 provider AI per tenant (legend-dwrr)

Do not run before the CTO decides. Tier K (tenant secrets, access, migration). Effort: xhigh. Required before the release gate. It does not block the next slice.

## Role

Read `~/.agents/team/roles/second-opinion.md`, then follow it. Read and report only; do not edit.

## Repo

`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/ai-provider-tenant`, branch `ws/ai-provider-tenant`.

```
git diff $(git merge-base milestone/m1 ws/ai-provider-tenant)..ws/ai-provider-tenant
```

## Context

- Decision: `docs/DECISIONS.md`, entry 2026-11-10 "WS-12 provider AI per tenant", points 1 to 15.
- Sub-brief: `docs/briefs/sub-ai-provider-tenant.md` (shared test seams, guarded fetch).
- Migration `0188_ai_provider_configs` (`when` 1794267000000, prevId = snapshot id of 0186). Tenant RLS via `apps/api/src/db/schema/ai-provider.custom.sql`.
- Card: `bd show legend-dwrr`. Follow-up OAuth card `legend-z83k` is out of scope.

## Invariants to check

1. The tenant API key never leaves the server in clear: not in any response (GET, PUT, DELETE, POST /test), Zod or `AiError` message, log line, audit snapshot, `ai_usage_*` row, or provider error text. Only `hasKey` and `keyLast4`.
2. Encryption: `sealSecret`/`openSecret` from `apps/api/src/lib/secrets.ts`, AAD `ai_provider_config:<tenantId>:<rowId>`. A blob copied to another row or tenant must fail to open. Rotation (`rotateAiProviderKeys`) re-seals only rows with an old version and never loses a key.
3. Tenant isolation: tenant B cannot read, change, delete, test, or use tenant A's config. Every query filters `tenant_id` explicitly; RLS is the second wall. Check `withTenant` use everywhere, including resolution inside `aiComplete`.
4. Access: all four routes require `requireAuth`, `requireTrustedOrigin`, `requireTenantContext`, `requireBackOfficeSurface()`, `requireTenantPermission("ai.governance.manage")`. No other route exposes the config.
5. SSRF: tenant base URLs are always strict (also in dev and test). Check `apps/api/src/lib/ai/guarded-fetch.ts` (connect-time lookup refuses `isBlockedIp`, https only, no redirect following, body cap), `provider-probe.ts` (redirect 3xx = `REDIRECT_REFUSED`, target never fetched, timeout `min(AI_TIMEOUT_MS, 15000)`), and that the tenant runtime provider also uses the guarded fetch. Look for IPv6, IPv4-mapped IPv6, decimal or octal IP forms, `0.0.0.0`, DNS rebinding, and TLS SNI mistakes.
6. Key exfiltration by changing host: changing `baseUrl` without a new `apiKey` must fail `AI_PROVIDER_KEY_REQUIRED`.
7. Fallback: a tenant with a row never falls back to the platform key, even when its blob cannot be opened or its type is `chatgpt_oauth`. A tenant without a row uses the env provider and `AI_MODEL`.
8. Budget: `aiPreflight` still runs before resolution; budget 0 blocks every call whatever the provider source. Usage on the tenant key is recorded with the resolved provider and model.
9. Migration 0188: CHECK constraints, unique index on `tenant_id`, FK, FORCE RLS and restrictive tenant policy present; `pnpm db:generate` is empty after it.

## Report

Findings with file:line, severity, and a concrete failure scenario. Say which invariants you checked and found clean.
