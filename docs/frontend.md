# Frontend standard (TanStack Start web app)

The web app has no database or auth server of its own. It renders pages, talks to the Express API, and keeps API data in TanStack Query. Each feature folder follows the same layers; the examples below use `<resource>` as a placeholder name.

```text
component
  → custom hook            features/<resource>/hooks.ts      useX, useCreateX, …
  → query options / keys   features/<resource>/queries.ts    xKeys, xListQuery
  → endpoint function      features/<resource>/api.ts        listX, createX, …
  → apiFetch               lib/api/client.ts                 base URL, cookies, ApiError
  → Express API
```

## Authentication

- **Browser client** — `lib/auth-client.ts` creates the Better Auth client for `VITE_API_URL` with `credentials: "include"` and the admin plugin (sharing `@starter/shared/permissions`). Sign-in, sign-up, and sign-out forms call it directly, then `router.invalidate()` re-runs the route guards.
- **Server middleware** — `lib/auth.middleware.ts` defines `authMiddleware`, a TanStack Start server function middleware. On the web server it reads the visitor's session from the API by forwarding their cookie (`lib/session.server.ts`) and puts it on `context.session`. `requireAuthMiddleware` additionally rejects anonymous calls — attach it to any server function you add that must not run signed out.
- **Session in routes** — `routes/__root.tsx` calls `getSessionFn()` in `beforeLoad` and shares `{ session }` as router context. the area layouts (`routes/_<area>.tsx`, see "Where to put a new screen") redirect to `/sign-in` without one; `_auth.tsx` redirects signed-in visitors with `postLoginPath(access)` (`lib/areas/post-login.ts`): `/kelola` for a session holding `dashboard.management.view`, else the app home (`siteConfig.appHomePath`, `/member`), and so do sign-up and sign-in; `/` (`siteConfig.homePath`) stays the public brand website.
- **Roles in the UI** — `roleHasPermission(session.user.role, { <resource>: ["<action>"] })` from `@starter/shared/permissions` hides links and, in a page's `beforeLoad`, throws `notFound()`. The API re-checks every request; never treat a UI check as authorization.

The session cookie belongs to the API host. The web server receives it because cookies ignore ports (`localhost`) or because production sets `COOKIE_DOMAIN` to a parent domain of both apps.

## Calling the API

`apiFetch<T>(path, { method, query, body, signal })` is isomorphic (`createIsomorphicFn`):

- **In the browser** it calls `VITE_API_URL` with `credentials: "include"`; the browser adds the `Origin` header the API's CSRF check requires.
- **On the web server** (route loaders during SSR) it calls `API_INTERNAL_URL` (or `VITE_API_URL`), forwarding the visitor's `cookie` and the request's `X-Request-Id`, and logs upstream failures.

Non-2xx responses throw `ApiError(status, code, message, details)` built from the API's error envelope; network failures throw `ApiError(0, "NETWORK_ERROR", …)`. 204 resolves to `undefined`. Only GETs run on the server; mutations come from the browser.

## Query options and keys

```ts
export const xKeys = {
  all: ["x"] as const,
  lists: () => [...xKeys.all, "list"] as const,
  list: (params: ListXInput) => [...xKeys.lists(), params] as const,
  detail: (id: string) => [...xKeys.all, "detail", id] as const,
};

export function xListQuery(params = { limit: 20, offset: 0 }) {
  return queryOptions({
    queryKey: xKeys.list(params),
    queryFn: ({ signal }) => listX(params, signal),
  });
}
```

Hierarchical keys make invalidation precise: `xKeys.lists()` refreshes every page of the list; `xKeys.all` refreshes everything about the resource.

## Custom hooks

Components never call `apiFetch` or `useQuery` directly; they use the feature's hooks, which own cache updates:

```ts
export function useX(params?: ListXInput) {
  return useSuspenseQuery(xListQuery(params));
}

export function useCreateX() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createX,
    onSuccess: (item) => {
      queryClient.setQueryData(xKeys.detail(item.id), item);
      return queryClient.invalidateQueries({ queryKey: xKeys.lists() });
    },
  });
}
```

A delete hook can use an optimistic update: remove the item from every cached page immediately, restore the snapshot if the API refuses, and refetch afterwards. Mutation errors are `ApiError`s; a small helper in the feature's form component can turn them (including field `details`) into readable text.

## Server rendering with data

```ts
export const Route = createFileRoute("/_<area>/<url-with-dots>")({
  validateSearch: z.object({
    offset: z.coerce.number().int().min(0).max(1_000_000).catch(0).default(0),
  }),
  loaderDeps: ({ search }) => ({ offset: search.offset }),
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(
      xListQuery({ limit: 20, offset: deps.offset }),
    ),
  component: XPage, // calls useX({ limit: 20, offset })
});
```

`router.tsx` creates a fresh `QueryClient` per request and calls `setupRouterSsrQueryIntegration`, which provides the `QueryClientProvider` and dehydrates queries fetched during SSR. The loader fills the cache on the server, the HTML includes the list, and the browser hydrates the same cache entry instead of fetching again. Client-side navigations run the loader in the browser. Queries are fresh for 30 seconds; 4xx `ApiError`s are not retried.

## Server-only code

Files ending in `.server.ts` (`session.server.ts`, `logger.server.ts`, `api/upstream.server.ts`, `request-context.server.ts`) never reach the browser; TanStack Start's import protection fails the build if browser code imports one. Use them only inside `createServerFn` handlers, middleware `.server()` callbacks, or `createIsomorphicFn().server()` — and keep their names out of `.client()` branches, even in type positions (`typeof x` keeps the import alive).

`src/start.ts` registers request middleware: browser security headers (CSP `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, and HSTS in production; a route that sets one keeps its own value), Start's CSRF check for server functions (a custom `start.ts` must add it back explicitly), and the access logger that assigns `X-Request-Id`. The CSP does not restrict scripts: Start renders inline scripts, so a `script-src` policy needs per-request nonces — add one deliberately if your app needs it.

## Add a feature's UI

1. `features/<resource>/api.ts`: one typed function per endpoint using `@starter/shared` types. Encode values placed in a path (`` `/api/<resource>/${encodeURIComponent(id)}` ``): during SSR the call carries the visitor's cookie, and an unencoded `../` from a URL parameter would reach a different API route.
2. `features/<resource>/queries.ts`: keys and `queryOptions`.
3. `features/<resource>/hooks.ts`: `useX` (suspense), mutations with cache updates.
4. Components under `features/<resource>/components/`, reusing `components/ui`.
5. A page under its area's route folder (`routes/_<area>/`, see "Where to put a new screen") whose loader ensures the query; `roleHasPermission` in `beforeLoad` for cross-account pages.
6. A Playwright test in `e2e/` for the main flow, then `pnpm test:e2e`.

### Forms

Use `FormField` (`components/ui/form-field.tsx`) for every labelled control; it owns the label, hint, error and the `id`/`aria-describedby`/`aria-invalid`/`aria-required` wiring. **FormField + Select: the trigger takes the label through context; don't hand-wire `htmlFor` for Radix Select.** A Radix `<Select>` root renders no DOM node, so FormField hands the wiring to `SelectTrigger` by context — keep the `<Select>` as the direct child and leave the trigger without an `id`/`aria-label` unless the visible label really differs.

## Where to put a new screen

Bead `legend-fbu` · PRD v1.7 §3 F3, §5 "Peta situs". Every URL belongs to one of nine **areas**. An area fixes the shell, the density, the guard and the navigation, so a feature bead only adds its screen.

| Area          | URL prefixes (PRD §5)                             | Shell · density (DESIGN.md §1)    | Guard (RBAC §3.7)                                   | Route files in `routes/` |
| ------------- | ------------------------------------------------- | --------------------------------- | --------------------------------------------------- | ------------------------ |
| `public`      | `/`, `/menu`, `/reservasi`, `/masuk`              | Customer · Hangat                 | open, indexed                                       | `_public/`               |
| `customer`    | `/t/$token`, `/f/$facility`, `/member/*`, `/wifi` | Customer · Hangat                 | open; `/member/*` needs a session; noindex          | `_customer/`             |
| `ops`         | `/pos/*`, `/fasilitas/*`, `/operasional/*`        | Operations · Kontras Tinggi       | permission, surface `pos` (staff PIN, no MFA), edge | `_ops/`                  |
| `kitchen`     | `/kds/*`, `/expo`, `/pickup`                      | Operations · Kontras, always dark | permission, surface `kds`, edge                     | `_kitchen/`              |
| `kelola`      | `/kelola/*`                                       | Management · Padat                | `dashboard.management.view`, MFA (AUTH-05)          | `_kelola/`               |
| `owner`       | `/owner/*`                                        | Management · Padat                | `dashboard.owner.view`, MFA                         | `_owner/`                |
| `shareholder` | `/shareholder/*`                                  | Management · Padat                | `dashboard.shareholder.view`, MFA                   | `_shareholder/`          |
| `karyawan`    | `/karyawan/*`                                     | Customer · Hangat (PWA)           | `self.profile.view`, surface `hris`                 | `_karyawan/`             |
| `platform`    | `/platform/*`                                     | Management · Padat                | `platform.*`, MFA                                   | `_platform/`             |

The table is data in `lib/areas/definitions.ts` (tested by `tests/areas.test.mjs`); change an area there, not in a route.

### Add a page

1. **Route file** `routes/_<area>/<url-with-dots>.tsx`, e.g. `/kelola/inventori/stok` → `routes/_kelola/kelola.inventori.stok.tsx`, `/pos/meja/$tableId` → `routes/_ops/pos.meja.$tableId.tsx`. Do not add a layout: the `_<area>.tsx` layout already runs the guard and renders the shell around your `<Outlet />`. Run `pnpm dev` (or `pnpm build`) once: it regenerates `routeTree.gen.ts`, which you commit (on a merge conflict in that file, regenerate it, do not hand-merge).
2. **Feature folder** `features/<ws>-<name>/` (for example `features/ws06-inventory/`):

   ```text
   api.ts       one function per endpoint (callEndpoint + the contract)
   queries.ts   query keys + queryOptions
   hooks.ts     useX / useCreateX
   mock.ts      registerMock(...) handlers for VITE_API_MOCK=true
   nav.ts       the menu item (below)
   components/  screen components; text from the catalog, tokens from DESIGN.md
   ```

3. **Menu item**: `features/<ws>-<name>/nav.ts` default-exports `AreaNavEntry[]`. It is collected automatically (`lib/areas/nav-registry.ts`), so two beads never edit the same list. `anyPermission` hides the item for visitors without it; it is not an access check.

   ```ts
   import { Boxes } from "lucide-react";
   import type { AreaNavEntry } from "@/lib/areas/nav";

   const nav: AreaNavEntry[] = [
     {
       area: "kelola",
       labelKey: "nav.management.inventory",
       to: "/kelola/inventori",
       icon: Boxes,
       order: 30,
       anyPermission: ["inventory.stock.view"],
     },
   ];
   export default nav;
   ```

4. **Page guard** (only when the page needs more than the area's permission, e.g. `/kelola/inventori` needs `inventory.stock.view`): add it in the page's own `beforeLoad`, using the same evaluator as the area. Never rely on `anyPermission` in `nav.ts` for this.

   ```ts
   import { notFound } from "@tanstack/react-router";
   import { evaluateGuard } from "@/lib/areas/guard";

   export const Route = createFileRoute("/_kelola/kelola/inventori")({
     beforeLoad: ({ context }) => {
       const gate = evaluateGuard(
         {
           kind: "permission",
           surface: "dashboard",
           anyOf: ["inventory.stock.view"],
         },
         context.access,
       );
       if (gate.status !== "allowed") throw notFound();
     },
     component: InventoryPage,
   });
   ```

5. **Text** goes in `packages/shared/src/i18n/messages/id.ts`; add only your own keys.
6. **Replace the placeholder**: each area's `*.index.tsx` renders `AreaIndexPage` (an honest empty state). The bead that owns the area's landing screen replaces it.

### Guards, MFA and the access context

`runGuard` in `lib/areas/route.ts` runs in each area layout's `beforeLoad` using `evaluateGuard` (`lib/areas/guard.ts`), which follows `authorize()` in `@starter/shared/access`: signed out → redirect to `/sign-in`; AUTH-05 second factor missing on `back_office`/`dashboard` → the layout shows "Verifikasi dua langkah diperlukan"; no matching permission → "Anda belum punya akses". The API enforces the same rules; these screens only avoid showing what a visitor cannot use.

The visitor's reach (`context.access`, set in the root route) comes from `lib/areas/access.ts`. Until the API exposes the caller's effective permissions, a real session has **no** permissions, so every work area fails closed. In mock mode (`VITE_API_MOCK=true`) the cookie `legend-mock-role` picks a role template (`cashier`, `general_manager`, `shareholder`, … , `all` = every permission, the default, `none` = signed out) so each area can be reviewed:

```js
document.cookie = "legend-mock-role=cashier; path=/"; // then reload
```

### Shell parts you get for free

- **Offline banner slot**: `OfflineBannerSlot` (`components/layout/`) sits above every page's content; bead `legend-diq` fills it. Operations screens also show the connection badge in the shell header.
- **Theme toggle** in every shell header (kitchen is always dark).
- **noindex** on every area except `public` (PRD §5 "Diindeks: Tidak"). Every page response defaults to `Cache-Control: private, no-store` (`start.ts`), because SSR HTML embeds the visitor's session; a route that is safe to cache sets its own header.
- **Mock mode is dev-only**: a web build with `VITE_API_MOCK=true` refuses to boot unless `DEPLOYMENT_MODE=development` (`lib/env.server.ts`), and `vite build` fails earlier for the same combination (`vite-mock-guard.ts`).
- **PWA**: `public/manifest.webmanifest` is a stub linked from `/member/*` and `/karyawan/*`; the per-brand manifest comes from a worker later (PRD §5).
- **Brand name** in headers is the catalog's `app.defaultBrand` until tenant config supplies the real one (D43); the outlet name and time zone in the operations header wait for the outlet-context bead.

## Typed endpoints and mock mode

Bead `legend-zj2` · PRD v1.7 §3 "Prinsip Pengembangan Paralel". Every screen is built against a contract and fixtures first; the backend arrives later and the screens do not change.

```text
component → hook → queryOptions → endpoint caller (callEndpoint) → apiFetch ─┬─ real API
                                       ▲ contract: defineEndpoint            └─ mock runtime (VITE_API_MOCK=true)
                                       │            in @starter/shared/<domain>      ▲ registerMock(endpoint, handler)
                                       └─ schemas + Cafe Legend fixtures ────────────┘ features/<name>/mock.ts
```

### 1. The contract lives in `packages/shared`

A domain contract bead exports its endpoints next to its schemas (`defineEndpoint` from `@starter/shared/api`). One object per endpoint: method, path template, and Zod schemas for `params`, `query`, `body`, `response`. The API will validate with the same object. Request schemas come from `clientInputSchema` (a submitted `tenantId` is rejected, TEN-02); list endpoints use `cursorPageQuerySchema` / `cursorPageSchema` (D-CORE-5); money fields are `…Idr`.

```ts
import { defineEndpoint } from "@starter/shared/api";
import {
  cursorPageQuerySchema,
  cursorPageSchema,
  outletIdSchema,
  z,
} from "@starter/shared/core";

export const getOutlet = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId",
  params: z.strictObject({ outletId: outletIdSchema }),
  response: dataResponseSchema(outletSchema), // omit `response` for 204
});
```

`@starter/shared/api` also ships working examples (`listExampleOutlets`, `getExampleOutlet`, `addExampleOrderLine`, `removeExampleOrderLine` under `/api/example/…`). They are the reference and the test subject; the API does not implement them.

### 2. Call it with `callEndpoint`

```ts
// features/outlets/api.ts
import { callEndpoint, endpointQueryOptions } from "@/lib/api/endpoint";
import { getOutlet, listOutlets } from "@starter/shared/outlets";

export const outletQuery = (outletId: string) =>
  endpointQueryOptions(getOutlet, { params: { outletId } }); // GET → queryOptions
export const createOutlet = (body) =>
  callEndpoint(createOutletEndpoint, { body }); // mutation
```

- Arguments are typed from the contract: `{ params, query, body }`, only the parts the endpoint declares; the input argument is required exactly when a part is required. A 204 endpoint resolves `undefined`.
- Input is parsed with the endpoint's schemas **before** the request (defaults applied, `ApiError` `VALIDATION_ERROR` with `details` on failure). The response is parsed in development and mock mode; a drift fails loudly as `ApiError` `RESPONSE_SHAPE_INVALID` (502).
- `endpointQueryKey(endpoint, input)` is `[endpoint.id, input]`: hierarchical enough for `invalidateQueries({ queryKey: [endpoint.id] })`.
- Hand-written `apiFetch<T>(path, …)` keeps working, in mock mode too, as long as a mock exists for the path.

### 3. Mock mode

Set `VITE_API_MOCK=true` (and optionally `VITE_API_MOCK_LATENCY_MS`, default 250) in `.env.local` and restart the web dev server. `apiFetch` then never touches the network: it dispatches to the mock runtime in `lib/mock`. A normal build compiles the whole runtime out (checked: no mock code in the bundle). Never set the flag on a real deployment; a production build with the flag logs a console warning. Mock mode also serves as the clickable mockup for demos.

**Add a mock for your feature** in `features/<name>/mock.ts`: files are discovered by glob, so you never edit a shared file.

```ts
// features/outlets/mock.ts
import { registerMock } from "@/lib/mock/registry";
import { paginateFixture } from "@/lib/mock/paginate";
import { createMockStore } from "@/lib/mock/store";
import { ApiError } from "@/lib/api/errors";
import { outletFixtures } from "@starter/shared/outlets";
import { getOutlet, listOutlets } from "@starter/shared/outlets";

registerMock(listOutlets, ({ query, scenario }) =>
  paginateFixture(outletFixtures, query, (o) => o.id, scenario),
);

registerMock(getOutlet, ({ params }) => {
  const outlet = outletFixtures.find((o) => o.id === params.outletId);
  if (!outlet) throw new ApiError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
  return { data: outlet };
});
```

What the runtime does for you, like the real API:

| Behavior            | Detail                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input validation    | `params`, `query`, `body` are parsed with the endpoint's schemas; handlers receive typed, normalized values. Failures are `VALIDATION_ERROR` 400 with `details`. |
| Response validation | The handler's return is parsed with `endpoint.response`; a fixture that breaks the contract is `MOCK_RESPONSE_INVALID` 500, so fixtures cannot rot.              |
| JSON round trip     | Responses are cloned through JSON: no leaked store references, nothing the wire cannot carry.                                                                    |
| Errors              | Throw `ApiError(status, "UPPER_SNAKE", message)` or a `CoreError`; both reach the UI as `ApiError` with the same `code` the API will use.                        |
| Pagination          | `paginateFixture` implements opaque cursors, `limit`, `nextCursor: null` on the last page, tampered cursor → `VALIDATION_ERROR`.                                 |
| State               | `createMockStore(seed)` for data a mutation changes; every store re-seeds on `resetMocks()`.                                                                     |
| Precedence          | `/api/x/special` beats `/api/x/:id`.                                                                                                                             |

Rules for handlers: return fixtures from `@starter/shared/<domain>` (never hand-typed copies in a feature); never read `tenantId` from input; do not invent business rules the PRD does not state. Mock state lives per runtime (SSR server and browser each hold their own), so run mutations in the browser as usual.

### 4. See loading, empty and error states

Needed for the screenshot evidence of every screen. Add `?mock=<scenario>` to the URL (remembered in `localStorage["legend-mock-scenario"]`; `?mock=normal` resets) or use the console:

| Scenario  | Effect                                                                                     |
| --------- | ------------------------------------------------------------------------------------------ |
| `normal`  | Fixtures after the configured latency                                                      |
| `slow`    | 3 s latency: skeletons and spinners                                                        |
| `empty`   | `paginateFixture` returns an empty last page; use `scenario` in handlers for non-list data |
| `error`   | Every call fails with `INTERNAL_ERROR` 500                                                 |
| `offline` | Every call fails with `NETWORK_ERROR` status 0                                             |

```js
window.__legendMock.setScenario("empty");
window.__legendMock.failNext("GET /api/outlets/:outletId", {
  status: 403,
  code: "OUTLET_OUT_OF_SCOPE",
}); // one call
window.__legendMock.reset(); // normal scenario, seed data
```

### 5. Tests

`tests/api-client.test.mjs` loads the contract, the runtime and the example handlers with plain Node ESM (type stripping, no bundler): `lib/api/errors.ts`, `endpoint-core.ts` and everything under `lib/mock` therefore avoid `@/` aliases, framework imports, `enum` and constructor parameter properties. Keep it that way. To unit-test a feature's mock in Node, import it with relative `.ts` paths (the `@/` alias only exists in Vite), then `dispatchMock({ method, path, query, body })` + `assert`. Every domain contract bead also adds a "fixtures parse" test (`docs/plan/contracts.md`).

### 6. Browser specs in mock mode

A screen built against fixtures is reviewable before its API exists, so its Playwright spec runs against those same fixtures: `pnpm test:e2e:mock` starts `vite dev` with `VITE_API_MOCK=true` on `http://localhost:3225` — no API, no database — and runs every mock spec.

- Parallel worktrees must not fight over that port: `LEGEND_MOCK_PORT=3235 pnpm test:e2e:mock` moves the whole run (server, baseURL, `LEGEND_MOCK_WEB_URL`). Default stays 3225.
- Name a mock spec `<name>.mock.spec.ts`; the older per-bead `legend-<bead>.spec.ts` names were all converted (legend-xsau, legend-ny7j), so this is now the only mock pattern. `pnpm test:e2e` ignores it (its production build compiles mock mode out) and runs only the specs that need the real API and its disposable database.
- `playwright.mock.config.ts` owns the server address and exports it to specs as `LEGEND_MOCK_WEB_URL` — the name to write in new specs — and `E2E_MOCK_BASE_URL`, the legacy alias `e2e/legend-g9r3.mock.spec.ts` reads. A spec that skips itself when the variable is missing therefore runs here and still skips under `pnpm test:e2e`.
- Run one spec: `pnpm test:e2e:mock e2e/legend-g9r3.mock.spec.ts`. The mock runtime answers with zero latency in this project; ask for `?mock=slow` when a screen's loading state is the subject.
- The first test on a route pays Vite's cold compile: SSR takes 20-35 s on a loaded machine (beads legend-1336, legend-b0kq), well past Playwright's 5 s assertion default. `e2e/mock-global-setup.ts` therefore opens every route area in a real browser once, after the web server starts and before the first test, so specs run warm and keep normal timeouts. New top-level areas go on its `WARM_ROUTES` list.
- A spec must still survive a dev server started by hand (cold start), so give the **first assertion of the first test** an explicit `{ timeout: 30_000 }` and name the constant `COLD_START_TIMEOUT_MS`. Later tests on the same route rely on the warm-up — no per-spec sleeps.
- CI shards the suite over two parallel jobs (bead legend-x5be): `mock-e2e` runs `--shard=1/2` on `LEGEND_MOCK_PORT=3225` and `--shard=2/2` on `3235`, then `mock-e2e-report` merges the two blob reports into the browsable `mock-e2e-report` artifact with `playwright merge-reports`. A shard is still one worker. `e2e/mock-mode.mock.spec.ts` is the runner's own smoke test: it proves the dev server, the fixtures and both variable names work without an API.
- Screenshot evidence goes through `e2e/screenshots.ts`, never a `docs/` path in the spec: the helper writes to `test-results/` unless `LEGEND_CAPTURE_SCREENSHOTS=1` (section 8).

### 7. Splitting a long mock run (shards)

The mock suite is 224 tests in 41 files; the integrator's baseline is about 11 minutes on one worker (the shard measurement below is from bead legend-x5be). The local default stays one worker on purpose: this 16 GB machine is shared by several agents and two Playwright workers starve each other. Sharding is the opt-in escape hatch.

- `pnpm test:e2e:mock:shard <index>/<total>` (for example `1/4`) validates the argument and runs that shard. It forwards any extra Playwright args, and each shard still uses one worker: `1/4` + `2/4` in parallel is two workers, not eight. `pnpm test:e2e:mock --shard=1/2` is the raw form CI uses.
- Shards on one machine need distinct ports: `LEGEND_MOCK_PORT=3239 pnpm test:e2e:mock:shard 1/4` and `LEGEND_MOCK_PORT=3240 pnpm test:e2e:mock:shard 2/4`. Without a port they race for 3225. Running shards one after another can reuse the default port.
- Every shard starts its own dev server and runs the full `WARM_ROUTES` warm-up, so the fixed cost repeats. Sharding cuts test time, not warm-up time; keep shard counts small (CI uses 2).
- With `fullyParallel: false` (this config) Playwright shards whole spec files, never a file's tests across two shards, so shards hold different test counts (measured: 113 vs 111 for 1/2 and 2/2, 60 for 1/4). Shard boundaries are contiguous in file order, so an early shard runs the first files, not a random sample.
- CI writes a blob report per shard (`reporter: blob` when `CI` is set, `blob-report/report-<shard>.zip`) and `mock-e2e-report` merges them; a local run keeps the list reporter.

Measured on 2026-11-03 (M-series Mac, one worker; other agents were running work on the machine):

| Run                                 | Tests           | Wall time                                                               |
| ----------------------------------- | --------------- | ----------------------------------------------------------------------- |
| Full suite (integrator baseline)    | 224 in 41 files | ~11 min                                                                 |
| Shard 1/4 (`LEGEND_MOCK_PORT=3239`) | 60              | 174 s — 133 s in tests, ~30 s warm-up, ~11 s server/transition overhead |

Two CI shards therefore spend about half the test time plus the repeated warm-up: roughly 6-7 minutes of wall time instead of 11, with the merged report still listing every test.

#### Where the time goes

Ten slowest tests in the shard 1/4 run (a whole-file sample, not a random one):

| Time  | Spec                                 | Test                                                                               |
| ----- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| 8.8 s | `legend-10n.mock.spec.ts`            | KDS mock shows empty, error and offline states                                     |
| 7.6 s | `legend-2m4.mock.spec.ts`            | ORD-01 ORD-02 ORD-03 ORD-11 order from the menu, pay first, see status             |
| 4.9 s | `legend-1j7.mock.spec.ts`            | PRD §3.18 / Alur I: empty and error states offer a way forward                     |
| 4.8 s | `legend-9bh.mock.spec.ts`            | AUTH-05: a failed refresh keeps the idle warning open with retry text              |
| 4.7 s | `legend-azt.mock.spec.ts`            | F11 customer display: offline is its own state                                     |
| 4.5 s | `legend-9bh.mock.spec.ts`            | AUTH-05: a failed load offers a retry instead of a blank page                      |
| 4.5 s | `legend-azt.mock.spec.ts`            | F11 customer display: an error says how to fix it                                  |
| 4.4 s | `legend-1j7-purchasing.mock.spec.ts` | PRD §3.18 / Alur I: request, approve, create a PO and generate a sample share link |
| 3.2 s | `legend-2m4.mock.spec.ts`            | ORD-01 ORD-03 a reload keeps the joined table and the shared cart                  |
| 2.9 s | `legend-7ko.mock.spec.ts`            | ORD-10 merging two unpaid open-bill tables puts them on one bill                   |

Ten slowest spec files in the same sample (sum of test time):

| Time   | Tests | Spec                                 |
| ------ | ----- | ------------------------------------ |
| 21.0 s | 10    | `legend-7ko.mock.spec.ts`            |
| 20.8 s | 9     | `legend-9bh.mock.spec.ts`            |
| 19.7 s | 8     | `legend-azt.mock.spec.ts`            |
| 15.8 s | 5     | `legend-2m4.mock.spec.ts`            |
| 11.7 s | 7     | `legend-2w5-payment.mock.spec.ts`    |
| 10.8 s | 7     | `legend-8tv6.mock.spec.ts`           |
| 8.8 s  | 1     | `legend-10n.mock.spec.ts`            |
| 6.8 s  | 5     | `legend-6irt.mock.spec.ts`           |
| 6.1 s  | 2     | `legend-1j7-purchasing.mock.spec.ts` |
| 5.4 s  | 4     | `legend-10n-board.mock.spec.ts`      |

Obvious waste, biggest first:

1. By default, `globalSetup` warms the full route list on every run and shard (~30 s in the sample above). For a focused run, set `LEGEND_MOCK_WARM_ROUTES` to the comma-separated local paths needed by all selected specs, including paths reached by clicking. For example, `LEGEND_MOCK_WARM_ROUTES=/kelola/pengadaan,/kds pnpm test:e2e:mock e2e/legend-1j7.mock.spec.ts e2e/legend-10n.mock.spec.ts`. Set it to `none` to skip warm-up entirely; a cold first page can then time out. The setup logs the selected paths. Selection is manual: unset keeps the full list, including in CI shards. Check the selection helper itself with `heavy node --test e2e/warm-routes.test.ts`.
2. The slowest tests are multi-state journeys (`?mock=slow` latency, retry and offline paths) and multi-viewport visual checks. Those states are the subject of the specs, not waste — do not speed them up by dropping assertions.
3. The two CI shards get 113 and 111 tests because whole files are assigned in file order; that is even enough that `PWTEST_SHARD_WEIGHTS` is not worth setting yet.

### 8. Screenshot evidence for UI beads

Every UI bead saves screenshots under `docs/design/screenshots/<bead>/` (390 + 1440, light + dark, plus empty/error). Those files are tracked, so a spec that calls `page.screenshot({ path: "docs/..." })` rewrites them on every `pnpm test:e2e:mock` run and leaves every worktree and main dirty even when the screen did not change (bead legend-nt8q). Capture through `e2e/screenshots.ts` instead, passing only the part below the root:

```ts
import { captureScreenshot } from "./screenshots.ts";

await captureScreenshot(page, "legend-baa/masuk-hubungkan-390-light.png");
```

- **Default is test-results/** — the file lands in `test-results/screenshots/<bead>/…`: gitignored, inspectable after the run, and `git status` stays clean.
- **Refresh the tracked evidence** with the opt-in flag; only then does the helper write `docs/design/screenshots/<bead>/…`:

  ```bash
  LEGEND_CAPTURE_SCREENSHOTS=1 pnpm test:e2e:mock e2e/legend-8tv6.mock.spec.ts
  ```

  Commit only the screenshots you meant to change; anything else in `git status` is a signal, not noise. Only the value `1` opts in.

- **Full page is the default**, matching the evidence beads have always produced; pass `{ fullPage: false }` for a viewport crop.
- **Tall screens**: the area shells scroll `#main-content`, not the window, so Playwright's `fullPage` alone stopped at the 900px viewport and left the rest blank (bead legend-ivz8). A full-page capture now measures that container, raises the viewport to its `scrollHeight` plus the shell header, captures, and restores the viewport; pass `{ scrollContainer: "<selector>" }` when a screen scrolls a different element.
- **The guard**: `tests/e2e-screenshot-paths.test.mjs` fails `pnpm test` when an e2e file contains a `docs/` path literal outside the helper, so the tracked evidence cannot be rewritten by accident.
