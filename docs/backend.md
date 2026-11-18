# Backend standard (Express API)

The API is a working backend that saves real PostgreSQL rows and uses the Better Auth accounts. It has no seeded users, mock sessions, or fabricated responses. `apps/api/src/routes/floor.routes.ts` is a complete tenant router to copy the structure from.

```text
HTTP request
  → apps/api/src/routes/<resource>.routes.ts
  → requireAuth (Better Auth session) → requireTrustedOrigin (mutation CSRF check)
  → jsonBody (POST/PATCH: 415 / 400 before the handler)
  → @starter/shared/<domain>: validate body, params, and query
  → apps/api/src/services/<resource>.service.ts: domain operations and Drizzle queries
  → apps/api/src/db/schema/<table>.ts: PostgreSQL table
```

## Responsibilities

- **Routes** own HTTP: authenticate (router-level middleware), parse/validate, call a service, and choose the response status. They do not query Drizzle or PostgreSQL directly.
- **Services** own application rules and database queries. They receive the verified session's user ID as a separate argument. Every user-owned read, update, and delete filters by it in SQL. Updates/deletes use one scoped statement, avoiding a separate ownership check that could race. Services never accept a request, send a response, or read cookies.
- **Validators** (in `packages/shared`) define allowed input and inferred TypeScript types, shared with the web app. Strict schemas reject unknown fields, including submitted owner IDs. PATCH requires at least one editable field. IDs and query parameters are validated before queries.
- **Schemas** define tables, indexes, defaults, and relationships. Each table has its own file; `db/schema/index.ts` exports them all for Drizzle Kit, the pool, and Better Auth. Table files import dependencies directly from sibling files.
- **Middleware** provides session checks (`requireAuth`, the scoped and platform guards below), the origin check, JSON body handling, private caching, and the single error handler. Better Auth's `/api/auth/*` handler stays delegated to Better Auth and its Drizzle adapter.

```ts
// apps/api/src/routes/<resource>.routes.ts (excerpt, names are placeholders)
export const <resource>Router = Router();
<resource>Router.use(requireAuth, requireTrustedOrigin);

<resource>Router.post("/", jsonBody, async (req, res) => {
  const input = create<Resource>Schema.parse(req.body);
  const row = await create<Resource>(getAuth(req).user.id, input);
  res.status(201).location(`/api/<resource>/${row.id}`).json({ data: row });
});
```

Express 5 forwards rejected promises to the error handler: throw `HttpError(status, code, message)` for expected failures and let Zod throw for invalid input. Do not catch-and-respond in handlers.

## Response and input conventions

All application endpoints require the Better Auth session cookie. POST/PATCH accept `Content-Type: application/json`. Every mutation, including DELETE, requires an `Origin` header matching `WEB_URL` (or `TRUSTED_ORIGINS`); browsers send it on cross-origin fetches. Command-line clients must set it explicitly. Requests marked `Sec-Fetch-Site: cross-site` are rejected even with a valid cookie.

Input schemas are strict: unknown fields, including submitted owner IDs, are rejected. IDs are UUIDs. List endpoints validate query parameters with the shared schemas before a service runs.

Single-item responses wrap the record in `data`. Lists return `{ "data": [...], "meta": { "limit", "offset", "hasMore" } }`. Owner IDs and auth records are not part of these responses. The shapes are typed in `packages/shared/src/types/api.ts`.

Errors use `{ "error": { "code": "...", "message": "..." } }`, with field `details` for validation errors. Statuses: 400 malformed JSON, 401 missing/invalid session, 403 rejected origin or missing permission, 404 missing or unowned record (identical responses), 411 streamed body without `Content-Length` (`/api/auth/*`), 413 body over 100 kB (application routes and `/api/auth/*`), 415 unsupported content type, 422 invalid input, 500 unexpected failure. Database exceptions and private values are never returned. Application responses use `Cache-Control: private, no-store` and carry an `X-Request-Id`.

## Cross-origin rules

The web app and API are different origins. The API allows exactly the trusted origins:

- `cors({ origin: trustedOrigins, credentials: true })` — browsers on other origins cannot read responses.
- Better Auth `trustedOrigins` — its own endpoints reject other origins.
- `requireTrustedOrigin` — application mutations reject other origins.

`trustedOrigins` is `WEB_URL` plus the optional comma-separated `TRUSTED_ORIGINS`.

## Role-based access

Ownership answers "is this row mine?". Roles answer "may this account reach past its own rows?". Roles are declared in `packages/shared/src/permissions.ts` (statement of resources → actions, plus roles, `roleHasPermission()`) and enforced by the Better Auth admin plugin configured in `apps/api/src/lib/auth.ts`.

Roles live in `user.role` as a string; a comma-separated list such as `admin,support` grants the union. Signup cannot set it, so an account can never promote itself. Grant a role to an existing account:

```sh
pnpm role:set someone@example.com admin
```

Pick the guard by how far the route reaches:

| Reach                  | Guard                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| The caller's own rows  | `requireAuth`; the service filters by the verified user ID in SQL                                 |
| Tenant or outlet data  | `requireTenantPermission` or `requireOutletPermission` (`apps/api/src/middleware/permissions.ts`) |
| Platform, all accounts | `requireAuth, requireTrustedOrigin, requirePlatformAdmin, requireSessionMfa()`                    |

Platform routes mount the full chain on the router, as `apps/api/src/routes/platform.routes.ts` does:

```ts
platformRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requirePlatformAdmin,
  requireSessionMfa(),
);
```

`requirePermission(permissions)` (`apps/api/src/middleware/auth.ts`) checks the stored `user.role` through Better Auth. It is not enough for platform routes: a platform admin removed from `platform_admins` keeps `user.role = admin`, so the platform chain also requires an active `platform_admins` row and a verified second factor. Revoking a role takes effect on the next request for role-only checks.

Cross-account service functions carry an `Any` suffix because they deliberately skip the ownership filter; call them only behind the guards above.

The Better Auth admin plugin adds its own `/api/auth/admin/*` endpoints. `apps/api/src/lib/auth.ts` refuses every `/admin/*` path (403) except `impersonate-user` and `stop-impersonating`. Impersonation also needs an active platform admin and a support access grant. `has-permission` works only for server calls. The `admin` role in `packages/shared/src/permissions.ts` keeps only `user: ["impersonate"]` to match. Grant `admin` only to people trusted with platform access.

## Extend it

1. Create a table file under `apps/api/src/db/schema/` and export it from `index.ts`. Leave auth table names and fields unchanged.
2. Define strict input schemas in `packages/shared/src/validators/` and response types in `packages/shared/src/types/api.ts`; add the subpath to the package's `exports`.
3. Add `apps/api/src/services/<resource>.service.ts` with all queries. Require the authenticated user ID for user-owned operations.
4. Add `apps/api/src/routes/<resource>.routes.ts` with `requireAuth` + `requireTrustedOrigin` (plus the guard from the role table for cross-account endpoints), then register it in `routes/index.ts`.
5. `pnpm db:generate`, inspect the SQL, `pnpm db:migrate`. Keep SQL and metadata together; never edit applied migrations.
6. Add tests in `apps/api/src/test/` for CRUD, rejected input, anonymous access, origin checks, and cross-account isolation; then build the web side ([frontend](frontend.md)). Run `pnpm check`.

For a newly created table, `db:generate` may emit foreign keys as separate `ALTER TABLE ... ADD CONSTRAINT` statements. Before applying the migration, move each constraint definition inside that table's `CREATE TABLE` parentheses, separated by commas, and remove its separate `ALTER TABLE` statement. This avoids validating the FK later against a FORCE RLS table without tenant context; see migration `0352_edge_link_dead_letters` for an example. Never modify an already applied migration.

## Tenant database role

Tenant tables use forced RLS. Migrations run using the owner/admin connection in
`MIGRATION_DATABASE_URL` (or `DATABASE_URL`), while the API uses the restricted
`APP_DATABASE_URL` when supplied. Managed local `pnpm dev:prepare` creates a
separate random login and grants it membership of `legend_app`; credentials are
stored in the worktree's private `.env.local`. Provisioning requires an admin
with `CREATEROLE`, but the API login does not. External environments must
provision a non-owner, non-superuser, non-BYPASSRLS login and grant it
`legend_app` before starting the API. Never use the migration credentials as
application credentials.

Tenant services must use `withTenant` with server-minted tenant and outlet
scope; it installs transaction-local settings and fails closed for unsafe roles.
The development tenant lookup is synthetic and must not resolve production
requests. Real registered-domain resolution is a separate integration.

## Core database columns

Use `apps/api/src/db/columns.ts` for new schema columns: `ulidInUuid("id")`
converts a ULID to a PostgreSQL `uuid` and back; `uuidId("id")` accepts a UUID
(and can be branded with `.$type<YourId>()`). `idrColumn("total_idr")` uses
`BIGINT` with safe-integer validation on both reads and writes.
`decimal4Column("unit_cost_idr")` uses `NUMERIC(14,4)` as an exact `Decimal4`
string, including for `ai_jobs.cost_idr`. `businessDate("business_date")` is
an outlet-local calendar date, not a timestamp. Construct values using the
shared core schemas and helpers, never floating point for decimal arithmetic.

For Drizzle predicates, keep each ID's brand: parse untrusted strings with the
matching shared schema before using them in `eq`, `inArray`, or a `sql`
template. For example, `tenantIdSchema.parse(rawTenantId)` returns a `TenantId`,
and `rawOutletIds.map((id) => outletIdSchema.parse(id))` returns `OutletId[]`.
For another aggregate, use its exported ID schema (or its shared
`uuidIdSchema` / `ulidIdSchema` definition). Reuse the parsed values rather than
casting strings to an ID type. When a value is already a verified ID that
TypeScript only sees as `string` (an event payload, a loose service type), type
it as the brand upstream (`tenantId: TenantId`); if that is not possible, use
`eqId(column, id)` / `inArrayIds(column, ids)` from `db/branded-ids.ts` instead
of `as never` at the call site. They are type-only and emit the same SQL as
`eq` / `inArray` (bead legend-izy5l). A `sql<T>` result annotation is only a TypeScript
type; validate IDs read from raw SQL before treating them as branded values.

Use `tenantIdColumn(() => tenants.id).notNull()` and, for outlet-owned tables,
`outletIdColumn(() => outlets.id).notNull()`. The domain schema must define
appropriate tenant-scoped composite foreign keys where needed to prevent
cross-tenant references; these single-column references alone do not establish
that relationship. Apply `app.enforce_tenant_rls` in the migration for every
tenant table and use `withTenant` for its queries. When `outlet_id` is NOT
NULL, also apply `app.enforce_outlet_rls` right after it (TEN-03, bead
legend-tjey): `withTenant` sets `app.outlet_ids` from the scope, and the guard
test `src/db/outlet-rls.test.ts` fails CI for an outlet-owned table without the
policy. Code that sets `app.tenant_id` by hand must also set `app.outlet_ids`
(`'*'` for tenant-wide). See docs/plan/contracts.md D-CORE-3.

The error middleware converts `CoreError` and recognized domain error classes
with declared HTTP statuses into `apiErrorBody`, including the request ID.
For a domain whose contract does not define HTTP statuses (currently inventory
and purchasing), services must explicitly translate expected failures to
`HttpError` with a documented status. Unrecognized exceptions remain generic
500 responses. Zod errors retain the starter's 422 validation response.

## Promo engine lock order

Checkout (`redeemPromotions`), void (`releasePromotions`) and partial refund
(`recomputeAfterPartialRefund`) run inside their caller's transaction and take
the same locks in the same order, so checkout, void and refund never deadlock
(PRD §3.21; beads legend-9w77 + legend-e5it):

1. The order row — the caller locks it (insert / `FOR UPDATE`) before calling
   in;
2. The per-order advisory lock `promo:<tenant>:<order_id>`;
3. The `promotion_order_applications` row — release/refund only; redeem inserts
   it at the end;
4. The presented voucher row (`resolveCode` / `application.voucher_id`);
5. The customer-day advisory lock `promo-minspend:<tenant>:<outlet>:
<customer>:<business date>` (owner Q40), for an identified customer;
6. The candidate promotion rows, `SELECT ... FOR UPDATE ORDER BY id` — only the
   promotions that can apply to this bill (`lockCandidatePromotions`);
7. The customer's `promotion_customer_usage` rows, by promotion id.

Never lock a promotion row before the voucher and customer-day steps, and never
lock promotions out of id order. The guarded counter `UPDATE`s repeat the cap
in their `WHERE` clause and the table `CHECK`s repeat it again, so an
over-redemption stays impossible even if a caller skipped a lock. The
application row stores `paid_idr`, `refunded_paid_idr` and `rules_snapshot` at
redeem time: a partial refund rechecks the original rules and can never pay out
more than the guest paid (owner Q41).

## Running a subset of API tests

`pnpm test` provisions a disposable PostgreSQL and runs every API test. To run only some files against that
database, set `LEGEND_TEST_FILES` (space separated, paths relative to `apps/api`); the root `node:test` suites are
skipped in that mode:

```bash
LEGEND_TEST_FILES="src/test/qr-order-api.test.ts src/test/service-request-api.test.ts" pnpm test
```

On a shared machine run it through the gate lock (`.coordinator/gate.sh`).
