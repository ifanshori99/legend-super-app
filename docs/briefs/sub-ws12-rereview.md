# WS-12 re-review of review fixes (tingkat K)

Worktree: this repo, branch ws/ws12-ai, all changes uncommitted (`git diff` + untracked). Base invariants: docs/briefs/sub-ws12-review.md.

Verify each fix is correct and complete; hunt for new holes it introduced. Read-only. Report ≤40 lines, `path:line` + severity + scenario. Do not run tsc or full suite.

1. Cache leak (P0): ai-gateway.service.ts cache key (tenant, brandId, userId, reach hash, settings updated_at); ai-orchestrator.service.ts cache-hit revalidation against listTools.
2. Role-override per template: permission-resolver.ts `allowsVia`/`permissionsVia`; ai-metrics/scope.ts (resolveTenantScope match, outlet grouping), ai-tool-invoke.service.ts `callerToolMatches`, read-a/tl-06 closedOnly, read-b/support.ts, MFA gate on TL-05/06/08/09/10/12.
3. MCP: mcp.routes.ts GET /oauth/authorize redirect-only; POST /api/ai/mcp/authorize in ai-mcp-admin.routes.ts (session, trusted origin, approve:true, membership/ai.ask/master switch/MFA, scope intersection); mcp-server.service.ts authenticateMcpToken (banned user, ai.ask, master switch); registration map pruning.
4. AI action requests: ai-action-request.service.ts pickApprovalAction (stricter of module policy vs ai_action/mcp_action, amounts), ai-action-executors/access.ts holdsToolAccess at proposal+execution (banned, revoked MCP client), stock-adjustment write perms, promotion/price idempotency.
