# Build on this starter

This is the **Express + TanStack Start + PostgreSQL monorepo** of the ngodingpakeai starter family. An Express 5 API (Better Auth, Drizzle, RBAC) and a TanStack Start web app live side by side and share one TypeScript contract package. Help beginners turn a plain-language idea into a working app. Keep explanations short, explain decisions in familiar words, and implement the smallest useful feature end to end. Ask only about product decisions that materially change the work.

## First prompt: set up, then build

A request to build or run an app includes preparing its local development environment. Do this on the first feature prompt even if the user never asks about a database. For read-only questions or reviews, do not start services unnecessarily.

1. Read `README.md`, `package.json`, and `.agents/skills/starter-setup/SKILL.md`.
2. If dependencies are missing, run `pnpm run setup`. If installed, run `pnpm dev:prepare` and `pnpm run doctor`. These commands preserve existing settings and data, prepare missing secrets and origins, start managed PostgreSQL, wait for health, and apply committed migrations. Fix a reported setup problem before relying on database behavior.
3. Use the local Docker database by default when no `DATABASE_URL` is supplied. Do not ask beginners to choose a database provider, generate passwords, copy environment files, or create tables. If an existing Docker installation is stopped, start it when permitted. If a prerequisite needs user action, explain the exact action and continue work that does not depend on it.
4. Start `pnpm dev` in a persistent terminal unless it is already running. It starts both apps: the API on `BETTER_AUTH_URL` (default `http://localhost:4000`) and the web app on `WEB_URL` (default `http://localhost:3000`); each dev server takes its port from its URL. Verify both respond (`/api/health` on the API). Avoid duplicate servers.
5. Continue the user's requested feature. Setup alone does not complete a request to build an app.

Always write `pnpm run setup` and `pnpm run doctor`: `pnpm setup` and `pnpm doctor` are pnpm built-ins that ignore this project's scripts. Other scripts (`pnpm dev`, `pnpm test`, `pnpm db:migrate`, …) can be called directly.

Use the relevant skill below. Clients without skill discovery should open its file directly. `agent.md` is an alternate entrypoint to these canonical instructions.

| Task                                                   | Project skill                            |
| ------------------------------------------------------ | ---------------------------------------- |
| First app prompt or setup problem                      | `.agents/skills/starter-setup/SKILL.md`  |
| Start, inspect, stop, or troubleshoot the dev database | `.agents/skills/dev-database/SKILL.md`   |
| Build a feature, change the UI, or add data            | `.agents/skills/build-feature/SKILL.md`  |
| Create a dashboard/chatbot/other derivative            | `.agents/skills/create-variant/SKILL.md` |

## Development database

`compose.dev.yaml` runs PostgreSQL only; both apps run on the host. Use `pnpm db:up`, `db:status`, `db:logs`, and `db:down` so private environment settings and the saved Compose project name are loaded. Fresh setup chooses a free database port, generates credentials, and stores data in a persistent named volume. `db:down` keeps that volume. Preserve `.env.local` and never run volume deletion or destructive resets to repair setup. Supplied external connections bypass Docker. See `docs/local-development.md`.

## Current documentation with Context7

For library, framework, SDK, API, CLI, or cloud-service syntax, configuration, setup, migrations, or library-specific debugging, use Context7 even when the API seems familiar. Do not use it for pure business logic, general programming, or code review without an API question.

1. Call `resolve-library-id` with the library's official name and the actual question, unless the user supplied an exact Context7 library ID.
2. Select the official project or authoritative docs by relevance, reputation, coverage, and installed version. Refine a mismatched search.
3. Call `query-docs` with the resolved ID and a focused question. Use separate queries for unrelated concepts and observe the tool's call limits.
4. Check the examples against the installed version. If Context7 is unavailable, say so, use official documentation, and continue work that does not depend on the missing answer. Do not claim a connection was tested just because its config exists.

Project-scoped MCP files for Codex, Claude Code, Cursor, and VS Code are included. See `docs/ai-workflow.md`. Never put credentials into prompts or committed MCP files.

## Code map and boundaries

```text
apps/api        Express 5 API: Better Auth, Drizzle/PostgreSQL, routes → services
apps/web        TanStack Start web app: pages, Better Auth client, TanStack Query hooks
packages/shared validators (zod), permissions (RBAC), API DTO types, site identity
```

**API (`apps/api/src`)**

- `app.ts` builds the Express app (middleware order matters — read the comments); `server.ts` listens and shuts down gracefully. `pnpm dev` restarts the API on every change (`tsx watch`, including `packages/shared` and `.env.local`).
- `routes/*.routes.ts`: thin HTTP handlers. Mount `requireAuth` then `requireTrustedOrigin` on each router; use `jsonBody` on POST/PATCH. Tenant and outlet routes add `requireTenantPermission` or `requireOutletPermission`; platform routes add `requirePlatformAdmin` and `requireSessionMfa()` (see `routes/platform.routes.ts`). Register routers in `routes/index.ts`.
- `services/*.service.ts`: all application logic and Drizzle queries. Receive the verified user ID as an argument; filter ownership in SQL. Name cross-account functions with an `Any` suffix and call them only behind the route guards above.
- `db/schema/<table>.ts` (export from `db/schema/index.ts`), `drizzle/` (committed migrations), `db/index.ts` (shared pool).
- `lib/auth.ts` (Better Auth server), `lib/logger.ts` (pino), `lib/request-context.ts` (AsyncLocalStorage reqId/userId), `middleware/` (auth, origin, body, errors).
- Express 5 forwards rejected promises to the error handler: throw `HttpError` or let Zod throw; never `res.status(500)` by hand.

**Web (`apps/web/src`)**

- `routes/`: TanStack Start file routes. `_auth/` = sign-in/up; route areas (`_customer/`, `_kelola/`, `_platform/`, …, defined in `lib/areas/definitions.ts`) hold the app screens, and each area layout's `beforeLoad` applies its guard. Pages render on the server first, then hydrate; any component may use hooks. `routeTree.gen.ts` is generated and committed.
- `lib/auth-client.ts`: Better Auth browser client pointed at the API origin with `credentials: "include"`.
- `lib/auth.middleware.ts` + `lib/session.ts`: server function middleware that reads the visitor's session from the API by forwarding their cookie; the root route stores it in router context.
- `lib/api/client.ts`: `apiFetch` + `ApiError`. Isomorphic: in the browser it calls `VITE_API_URL` with cookies; during SSR it calls `API_INTERNAL_URL` forwarding the cookie and request ID.
- `features/<feature>/api.ts` (one function per endpoint) → `queries.ts` (query keys + `queryOptions`) → `hooks.ts` (custom hooks: `useX`, `useCreateX`, …). Components use hooks only. Route loaders call `context.queryClient.ensureQueryData(xQuery(...))` so SSR renders data.
- Files ending in `.server.ts` are server-only; TanStack Start import protection fails the build if browser code imports one. Reach them via `createServerFn`, `createMiddleware().server()`, or the `.server()` branch of `createIsomorphicFn` — and keep server-only names out of `.client()` branches, even in types.
- `components/ui`: owned shadcn/ui primitives (`npx shadcn@4.21.0 add <component>` from `apps/web`). `styles/globals.css`: Tailwind v4 tokens. Motion from `motion/react`; respect reduced motion.

**Shared (`packages/shared/src`)**: `validators/` (strict zod input schemas, used by API handlers and typed by web forms), `permissions.ts` (statement, roles, `roleHasPermission`), `types/api.ts` (response DTOs with ISO-string dates), `site.ts` (identity from `starter.config.json`). Keep it free of Node-only or browser-only code.

## Security rules

Authenticate at every API boundary: `requireAuth` answers JSON 401. The web app's layout guard is presentation, not authorization. Filter every user-owned read/update/delete by the verified session's user ID; never trust a submitted owner ID. Validate bodies, IDs, and pagination with strict shared schemas before services run.

The browser calls the API cross-origin with cookies. CORS and Better Auth `trustedOrigins` allow exactly `WEB_URL` (plus `TRUSTED_ORIGINS`). Every cookie-authenticated mutation, including DELETE, must pass `requireTrustedOrigin`. Session cookies reach the web server because both apps share a host locally (cookies ignore ports) and a parent `COOKIE_DOMAIN` in production — keep `BETTER_AUTH_URL`, `WEB_URL`, and `VITE_API_URL` consistent (`pnpm run doctor` checks).

Authorize separately from authentication when a feature reaches past the caller's own rows. Platform-level cross-account routes use `requireAuth, requireTrustedOrigin, requirePlatformAdmin, requireSessionMfa()`. `requirePermission` alone is not enough there: a platform admin removed from `platform_admins` keeps `user.role`. Tenant and outlet routes use `requireTenantPermission` or `requireOutletPermission`. Roles come from `user.role`, which signup cannot set; use `pnpm role:set <email> <role>`. Guard web pages by role with `roleHasPermission(session.user.role, …)` in `beforeLoad` (throw `notFound()`); that is presentation only. Hiding UI is never the access check.

Keep secrets server-side; only `VITE_*` values reach the browser, and `VITE_API_URL` is the only one. Validate new API settings in `apps/api/src/config/env.ts`. Never log cookies, passwords, tokens, or connection strings — the pino loggers redact the common fields; do not log request bodies. Encode IDs placed in API paths with `encodeURIComponent`.

Request bodies are capped at 100 kB, including Better Auth's (`limitAuthBody`). Better Auth rate limits are on outside the API tests; `TRUST_PROXY=true` is refused. The web app sets framing, nosniff, and referrer headers (HSTS in production) in `apps/web/src/start.ts`. Before production, walk through the security checklist in `docs/deployment.md`.

## Adding a resource end to end

Follow the patterns in `docs/backend.md` and `docs/frontend.md`; `apps/api/src/routes/floor.routes.ts` is a complete tenant router:

1. Table: `apps/api/src/db/schema/<table>.ts`, export from `index.ts`, `pnpm db:generate`, inspect the SQL, `pnpm db:migrate`. Commit SQL and `drizzle/meta` together. Never rewrite applied migrations or reset to fix errors.
2. Contract: strict zod schemas in `packages/shared/src/validators/<resource>.ts` and DTO types in `packages/shared/src/types/api.ts`; add the subpath to `packages/shared/package.json` `exports`.
3. API: `services/<resource>.service.ts`, `routes/<resource>.routes.ts`, register in `routes/index.ts`; tests in `apps/api/src/test/`.
4. Web: `features/<resource>/{api,queries,hooks}.ts`, components, and a page under its area's route folder (`routes/_<area>/`, see `docs/frontend.md` "Where to put a new screen") with a loader that ensures the query.

Use PostgreSQL `pgTable`/boolean/timestamp-with-time-zone columns and asynchronous queries. Never substitute SQLite syntax or disable TLS verification.

## Test terarah

- Verifikasi kecil: `LEGEND_TEST_FILES="src/test/x.test.ts src/test/y.test.ts" pnpm test` dari root worktree (path dipisah spasi). Perintah ini juga menyiapkan DB, dan dianggap ringan oleh hook `heavy`.
- `pnpm test` penuh dan `pnpm check` hanya untuk gate akhir: sekali, lewat `heavy`, oleh satu `test-runner`.
- Jangan menjalankan suite penuh paralel dari worktree yang sama.

## Pra-gate sebelum lapor

- Migrasi baru: pindahkan FK tabel baru dari `ALTER TABLE ... ADD CONSTRAINT` hasil `db:generate` ke dalam `CREATE TABLE` sebelum migrasi diterapkan.

## Verify and hand off

Run `pnpm check` (lint, typecheck, API + root tests on disposable PostgreSQL) and `pnpm build` for substantive changes. For auth/routing/session/CORS changes also run `pnpm test:e2e` (production builds + Playwright). For setup or Compose changes run `pnpm test:setup`. Add tests for real behavior and data isolation. Review the UI at narrow and wide widths when changing layout. The starter placeholder page and `e2e/starter.spec.ts` are gone (bead legend-fbu); new screens go in a route area, see `docs/frontend.md` "Where to put a new screen".

In a git worktree (`.worktrees/<name>`), run `pnpm worktree:setup` (or `node scripts/worktree-setup.mjs` before any install) once after creating it. It runs an offline `pnpm install`, replaces a `node_modules` symlink to the main checkout, copies `.claude/settings.local.json`, and checks that `@starter/shared` resolves to this worktree's `packages/shared`. Never symlink `node_modules` from another checkout: `pnpm check` and `pnpm build` refuse to run when links leave the checkout (`scripts/check-workspace-links.mjs`, bead legend-meki).

Report the result, how to use it, checks run, and any remaining limitation. Keep dashboard-specific, chatbot-specific, billing, and provider-specific features in derivatives unless the user asks to add them to this base. Do not deploy, purchase services, or choose an AI provider just because this is an AI-friendly starter.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->

## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**

- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.

<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->

## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
