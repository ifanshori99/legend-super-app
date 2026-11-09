# Brief 88 (sub): production migrator role and pre-deploy outbox check

Worktree: `.worktrees/deploy-prep`, branch `ws/deploy-prep` (from `milestone/m1` 8e2e7bc0).
Tier K (migrations, DB auth). Do not edit any existing file in `apps/api/drizzle/`.
Never read or print `.env*`. Never kill test processes you did not start.

## Problem

- legend-jtnd: migrations 0000..0064 fail on a fresh database when the
  migration login is a non-superuser table owner WITHOUT `BYPASSRLS`: adding a
  foreign key to a table with `FORCE ROW LEVEL SECURITY` validates under the
  tenant policy and raises `tenant context is required` (first hit 0004,
  `domain_event_replays`; again 0063). Nothing in deploy names the migrator role.
  See `apps/api/src/test/edge-received-events-migration.test.ts:547-553`.
- legend-k1np: outbox sequences are now allocated per destination
  (`max(sequence)+1` per `(tenant_id, destination, aggregate_type, aggregate_id)`,
  e.g. `apps/api/src/services/pos-order-support.ts:543-556`). Before legend-18qw
  one aggregate's events shared one count across destinations. No backfill.
  Outbox rows are never deleted. So the new-scheme invariant is: per
  `(tenant_id, destination, aggregate_type, aggregate_id)`, `min(sequence) = 1`
  and `max(sequence) = count(*)` (uniqueness is already a constraint). A group
  breaking it is an old-scheme stream. No production data exists yet.

## Decision (fixed; do not redesign)

Three database roles in production:

| Role                                                                     | Attributes                                                                                                                                                    | Used by                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Bootstrap superuser (`POSTGRES_USER` of the postgres image, compose.env) | SUPERUSER                                                                                                                                                     | Only `provision-roles.sh --migrator`, once at first boot, and break-glass. Never in any service env file.   |
| Migrator `legend_migrator_<16 hex>`, password 48 hex                     | LOGIN NOSUPERUSER BYPASSRLS CREATEROLE NOCREATEDB NOREPLICATION INHERIT, owner of the database (so it is `pg_database_owner` and owns every table it creates) | `MIGRATION_DATABASE_URL` in migrator.env only: migrate, pre-deploy check, provision/audit restricted logins |
| `legend_runtime_*` / `legend_worker_*`                                   | unchanged: NOBYPASSRLS etc.                                                                                                                                   | api/worker                                                                                                  |

A superuser in `MIGRATION_DATABASE_URL` is still accepted by the pre-deploy
check (allowed alternative), but the documented default is the dedicated
migrator.

## Interfaces (all pieces code against these exactly)

### A. `apps/api/src/db/migrator-role.ts` (new) + `--migrator` in `apps/api/src/provision-roles.ts`

```ts
export const MIGRATOR_LOGIN = /^legend_migrator_[a-f0-9]{16}$/;
export async function provisionMigrator(options: {
  bootstrap: { user: string; password: string }; // superuser creds
  migratorUrl: string; // MIGRATION_DATABASE_URL
}): Promise<{ user: string; outcome: "created" | "updated" }>;
```

- Connect as bootstrap to the host, port and database named in `migratorUrl`
  (build a `pg` Client config object, not a URL string, so the password needs no
  encoding). Keep TLS/timeout query params of the migrator URL if any.
- Refuse (`ProvisionError`) unless the bootstrap session is a superuser.
- Validate migrator user against `MIGRATOR_LOGIN`, password 48 hex; refuse if
  migrator user equals bootstrap user.
- In one transaction with the same advisory lock as `withAdmin` (export what
  you need from `apps/api/src/db/provision-roles.ts`: `ProvisionError`,
  `scramSha256Verifier`, quoting helper, URL parse helper, lock key, server
  version check): `CREATE ROLE` or `ALTER ROLE` to exactly
  `LOGIN NOSUPERUSER BYPASSRLS CREATEROLE NOCREATEDB NOREPLICATION INHERIT VALID UNTIL 'infinity' CONNECTION LIMIT -1 PASSWORD <SCRAM verifier>`,
  `RESET ALL` role settings, then `ALTER DATABASE "<db>" OWNER TO "<migrator>"`.
- Refuse, changing nothing, if any relation or schema in schemas `public`,
  `app`, `drizzle` (and the schemas `app`, `drizzle` themselves) is owned by a
  role other than the migrator: the database was migrated by another login;
  message tells the operator to run, as superuser,
  `REASSIGN OWNED BY <old> TO <migrator>` and re-run. (`pgboss` is owned by the
  queue login and is excluded.)
- After commit, sign in with `migratorUrl` and confirm `current_user`, database,
  `rolbypassrls = true`, `rolsuper = false`, `rolcreaterole = true`.
- Idempotent. Print role names only, never URL or password.
- CLI: `node dist/provision-roles.js --migrator` reads `MIGRATION_DATABASE_URL`
  (or `_FILE`, existing `setting()`), `BOOTSTRAP_DATABASE_USER`,
  `BOOTSTRAP_DATABASE_PASSWORD` (or `_FILE`). Success line:
  `Migrator login <name> <created|updated>: owns the database, BYPASSRLS, CREATEROLE, not superuser.`
  Usage line becomes `provision-roles [--audit | --migrator]`.

### B. `apps/api/src/db/predeploy-check.ts` (new) + `apps/api/src/predeploy-check.ts` (new entry) + tsup entry `"predeploy-check": "src/predeploy-check.ts"` in `apps/api/tsup.config.ts`

```ts
export class PredeployCheckError extends Error {}
export type PredeployReport = {
  migrator: { user: string; superuser: boolean; bypassRls: boolean };
  outbox: { present: boolean; rows: number; oldSchemeStreams: number };
};
export async function runPredeployCheck(
  migrationUrl: string,
): Promise<PredeployReport>;
```

- One connection, `BEGIN READ ONLY`, `SET LOCAL search_path = pg_catalog`.
- Migrator: read `rolsuper, rolbypassrls, rolcreaterole` for `current_user`.
  Throw unless `rolsuper OR (rolbypassrls AND rolcreaterole)`. Message names
  legend-jtnd and says to create the migrator with
  `deploy/single-vm/provision-roles.sh --env-file ... --migrator`.
- Outbox: `to_regclass('public.domain_event_outbox')` null → `present:false`,
  pass. Else count rows and count groups `GROUP BY tenant_id, destination,
aggregate_type, aggregate_id HAVING min(sequence) <> 1 OR max(sequence) <> count(*)`.
  Any such group → throw; message names legend-k1np, the count of streams and
  the distinct destinations involved (destination names only; no tenant ids,
  no payload), and says: write and test a backfill, or confirm the consumers
  start clean and empty the outbox, before enabling the relay.
- Entry `predeploy-check.ts`: reads `MIGRATION_DATABASE_URL` (or `_FILE`, same
  rule as `provision-roles.ts` `setting()`), does not load `.env`. Success:
  `Pre-deploy check passed: migrator <user> (<superuser|BYPASSRLS>), outbox <absent|N rows, per-destination sequences intact>.`
  Failure: `Pre-deploy check failed: <message>` exit 1. Error text never
  contains a URL or password (fixed texts for network errors; SQLSTATE plus
  server message only for server errors, like `provision-roles.ts describe`).

### C. Shell and deploy files

- `deploy/single-vm/provision-roles.sh`: new mode `--migrator` (exclusive with
  `--dry-run`/`--audit`). Runs all existing env validation, then requires
  `POSTGRES_USER` and `POSTGRES_PASSWORD` in compose.env (value_of), requires
  `MIGRATION_DATABASE_URL` user to match `legend_migrator_[a-f0-9]{16}` and
  password 48 hex (use `endpoint_of`), then `compose up -d --wait postgres`,
  exports `BOOTSTRAP_DATABASE_USER`/`BOOTSTRAP_DATABASE_PASSWORD` only for
  `compose --profile provisioning run --rm -e BOOTSTRAP_DATABASE_USER -e BOOTSTRAP_DATABASE_PASSWORD provision-roles node dist/provision-roles.js --migrator`
  (values via environment, never argv). Update header comment + usage.
  Default provision mode: run `compose --profile migration run --rm migrate node dist/predeploy-check.js`
  after `up postgres`, before `migrate`.
- `deploy/single-vm/deploy.sh`: after `compose up -d --wait postgres`, before
  migrate: `compose --profile migration run --rm migrate node dist/predeploy-check.js || { echo "Pre-deploy check failed: nothing was migrated and services were not started. See docs/deployment.md (Pre-deploy check)." >&2; exit 1; }`. Update header comment and dry-run text.
- `deploy/single-vm/test-deploy.sh`: update counts/line numbers; assert the
  check runs before migrate.
- `deploy/single-vm/runtime.env.example`: migrator.env comment names
  `legend_migrator_<16 hex>` and its attributes; compose.env needs POSTGRES_USER/PASSWORD (bootstrap superuser) and they never go into a service env file.
- `deploy/single-vm/compose.yaml`: only if the provision-roles service needs
  the two BOOTSTRAP vars declared; prefer `run -e` without editing.
- `tests/db-role-provisioning.test.mjs`: add stub-docker cases for
  `provision-roles.sh --migrator`: bad migrator name refused before docker;
  success path issues `up -d --wait postgres` then the `--migrator` run; no
  password on any docker argv line.

### D. Test `apps/api/src/test/migrator-role.test.ts` (new, vitest)

Pattern: `apps/api/src/test/edge-received-events-migration.test.ts`
(disposable server guard, scratch DB, `waitForNoSessions`, drop in afterAll).
Prove, on a scratch DB created by the test superuser:

1. `provisionMigrator` creates the role (NOSUPERUSER, BYPASSRLS, CREATEROLE),
   makes it database owner; second run → `updated`.
2. `runPredeployCheck(migratorUrl)` passes on the empty DB (outbox absent).
3. Full `migrate()` of `apps/api/drizzle` from zero as the migrator succeeds.
4. Tables are owned by the migrator; RLS still forced on e.g. `domain_event_outbox`, `outlets`.
5. `provisionRoles({ adminUrl: migratorUrl, appUrl, workerUrl })` succeeds;
   app login has `rolbypassrls=false`; querying a tenant table as the app login
   without `app.tenant_id` rejects `/tenant context is required/`; with
   `set_config('app.tenant_id', A, false)` it sees only tenant A rows.
6. `runPredeployCheck` passes with per-destination contiguous outbox rows and
   fails `/legend-k1np/` after seeding one old-scheme stream (same aggregate,
   destination X seq 1, destination Y seq 2). Seed as the migrator (bypasses RLS).
7. Contrast: a NOSUPERUSER NOBYPASSRLS CREATEROLE owner on another scratch DB:
   `runPredeployCheck` rejects `/legend-jtnd/`, and `migrate()` from zero rejects
   `/tenant context is required/`.
   Look up real outbox/tenant columns in `apps/api/drizzle/0003_*.sql` and the
   seed helpers of the pattern test.

### E. Docs `docs/deployment.md`

- In "First boot" sections: new step before migrations, "Create the migrator
  login" (`provision-roles.sh --migrator`), roles table with the three rows
  above and why BYPASSRLS (legend-jtnd, FK validation under FORCE RLS).
  Update the restricted-roles table intro (migration login is
  `legend_migrator_*`). Existing DB migrated by another login: REASSIGN OWNED.
- New section "Pre-deploy check (legend-jtnd, legend-k1np)": what it checks,
  where it runs (deploy.sh and first-boot provisioning, before migrate), what
  to do when it fails (jtnd: create migrator; k1np: backfill or clean start,
  never enable relay first). Keep the doc's existing tone; short.

## Review fixes (round 1)

Already done in `apps/api/src/db/migrator-role.ts` + `apps/api/src/provision-roles.ts`:
`provisionMigrator` takes optional `appUrl`/`workerUrl` (CLI reads
`APP_DATABASE_URL`/`WORKER_DATABASE_URL` if set) and grants the migrator
`ADMIN OPTION, INHERIT FALSE, SET FALSE` on `legend_app` and only those two
logins when they already exist; `verifyMigrator` refuses a migrator that is a
member of any role with INHERIT or SET; ownership refusal advises per-object
`ALTER ... OWNER` (or recreate the empty DB) when the old owner is the bootstrap
superuser (oid 10), since REASSIGN OWNED cannot move from it.

F1 (shell, `deploy/single-vm/provision-roles.sh` + `tests/db-role-provisioning.test.mjs`):
`--migrator` must refuse, before docker, a `POSTGRES_USER` or `POSTGRES_PASSWORD`
value containing `$`, `\` or a quote character (Compose would resolve it
differently from `value_of`); message names the key only. In `--migrator` mode
also export the already-validated `APP_DATABASE_URL`/`WORKER_DATABASE_URL` to
the job (same subshell as BOOTSTRAP vars; compose service already lists them).
Add a stub-docker test for the `$` refusal and assert no password on argv.

F2 (test, `apps/api/src/test/migrator-role.test.ts`): outlet code must match
`^[A-Z0-9][A-Z0-9-]{0,19}$` (use uppercase suffix). Pass `appUrl`/`workerUrl`
to `provisionMigrator` in the main suite. Add cases: (a) migrator holds ADMIN
on pre-existing `legend_app` with `inherit_option=false, set_option=false`;
(b) a role named like `legend_runtime_<16 hex>` NOT in the URLs gets no grant;
(c) bootstrap-owned table in a scratch DB → refusal mentions the bootstrap
superuser / ALTER ... OWNER (bootstrap = test superuser; skip (c) if the test
superuser is not oid 10, but still assert refusal).

F3 (docs, `docs/deployment.md`): mention the ADMIN-only grants on pre-existing
roles, the oid-10 case advice, and the `$`/`\`/quote restriction on
POSTGRES_USER/POSTGRES_PASSWORD for `--migrator`.
