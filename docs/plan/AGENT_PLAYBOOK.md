# Agent playbook (read before any bead)

Every implementing agent (Codex, ZCode, Sonnet, Opus) follows this file. Your brief only adds the
bead-specific part. If the brief and this file disagree, the brief wins.

## 1. Start

1. `cd` into your worktree `legend/.worktrees/<bead>` in **every** shell command. Never write in
   the main folder or another bead's worktree. Never create anchor/scratch files in the repo.
2. `git merge main` (main moves fast), then `pnpm install`.
3. `bd show <bead>` → read the spec, acceptance IDs and dependencies. `bd update <bead> --claim`.
4. Read only what the bead needs: the PRD sections it cites (`docs/PRD.md`), `docs/plan/contracts.md`,
   the contract folders you import, and `DESIGN.md` for UI. Do not read the whole PRD.

## 2. Build rules

- **Contracts first.** Import from `@starter/shared/<domain>`; never redefine a type that exists.
  Core conventions: `Idr` (BIGINT whole rupiah) for money, `Decimal4` strings for unit cost/qty,
  branded ids (ULID-in-uuid), `ScopedTenantContext` + `assertTrustedScopedContext` at every service
  boundary, `CoreError` codes, cursor pagination `{data, meta:{limit,nextCursor}}`, business dates in
  the outlet time zone. Tenant id never comes from the client (TEN-02).
- **Imports:** relative imports end in `.ts`. `@starter/shared/core/server` is server-only.
- **Your domain only.** Allowed shared edits (minimal, append-only): one subpath in
  `packages/shared/package.json` exports; your domain's line in `packages/shared/src/events/catalog.ts`;
  deps in the relevant `package.json` + lockfile; `apps/api/src/db/schema/index.ts` export line;
  `.env.example` keys. The coordinator resolves merge conflicts — do not block on them.
- **Migrations:** `git merge main` → `pnpm db:generate` → inspect SQL. Never hand-edit
  `drizzle/meta/_journal.json` or rewrite applied migrations. Every tenant table: `tenant_id`,
  RLS policy via the helper in `apps/api/src/db`, `outlet_id` when outlet-owned.
- **Backend:** routes thin → services hold logic; queries run inside the tenant transaction helper
  (RLS); writes that emit events use the transactional outbox; side effects idempotent.
- **Frontend:** `DESIGN.md` tokens/components only (no raw colors, no new ad-hoc components when one
  exists in `components/ui`), text from the i18n catalog, endpoints via `defineEndpoint` + typed
  client, a `features/<name>/mock.ts` so the screen works with `VITE_API_MOCK=true`. Every screen has
  loading / empty / error / offline states. Mobile 390px and desktop 1440px, light (white) + dark.
  RYUX anti-slop: no gradients-for-decoration, no emoji icons, no fake metrics, no lorem ipsum.
- **No invented business rules.** Cite the PRD section in a code comment or test name when you
  implement a rule. If the PRD is silent, pick the safest option, write it down in your report.
- **Security:** deny by default; validate every input with strict Zod; never log secrets/PII; money
  and state transitions only through the contract state machines.

## 3. Definition of done (all must be true before you report)

- [ ] Acceptance IDs from the bead each have at least one test whose name contains the ID.
- [ ] `pnpm check` exit 0 (lint, typecheck, API + root tests).
- [ ] `pnpm build` exit 0.
- [ ] `node scripts/ci/color.mjs` and `node scripts/ci/tenant-hardcode.mjs` pass.
- [ ] `pnpm exec prettier --check` clean on files you changed.
- [ ] UI beads: screenshots at 390 + 1440, light + dark, plus empty/error state, saved under
      `docs/design/screenshots/<bead>/`, and you looked at them.
- [ ] Committed on `ws/<bead>` (message: `<type>(<scope>): <what> (<bead>)`). No merge, no push.
- [ ] New work you discovered is a bead (`bd create … --deps discovered-from:<bead>`).

Two failed attempts at the same problem → stop, `bd update <bead> --status blocked --append-notes`,
report the blocker with the exact error.

## 4. Report format

```
STATUS: Selesai | Risiko | Butuh keputusan
Branch/commit: ws/<bead> <hash>
Changed: <files / behaviour>
Acceptance → tests: <ID → test name>
Verified: <gate lines>
Not verified: <area — reason>
Decisions I made (PRD silent): <list>
Follow-up beads: <ids>
```

## 5. Pitfalls already hit in this repo (do not repeat)

- Forgetting to register domain events in `events/catalog.ts` → register them yourself.
- Writing into another bead's worktree or the main folder → always `cd` to your worktree.
- Extensionless relative imports → break native Node ESM tests.
- Tests placed where vitest does not discover them → API unit tests may sit next to code
  (`src/**/*.test.ts`); root contract tests go in `tests/*.test.mjs`.
- Trusting a TypeScript brand at runtime → use the server-minted trust helpers.
- Fake adapters that ignore idempotency keys → fakes must behave like the real provider.
- Missing role/amount metadata silently granting access → fail closed.
- Duplicate keys in `packages/shared/package.json` exports → add exactly one line.

## 6. Review (coordinator-run)

Every branch written by Codex, ZCode or Sonnet is reviewed by Claude Opus before it merges. The
reviewer reads the diff + the contracts it touches, fixes small issues directly, and sends larger
ones back. Write code that is easy to review: small commits, clear names, tests next to behaviour.
