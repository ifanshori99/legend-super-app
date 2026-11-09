# Plan W1 legend-hsk: Wi-Fi agent backend + simulator

Architect plan, 2026-11-09. Worktree `.worktrees/ws09-wifi`. Tier K (migration, personal data: device MAC). Reviewer + architect review at the end of the wave, second opinion queued before the release gate.

## Decision

Build an edge-side Wi-Fi agent on the existing `WifiProvider` (`authorize`, `revoke`; no interface change). The agent keeps one ledger table of controller grants on the edge's local Postgres, switches speed by **make-before-break** (authorize a new grant, then mark the old one superseded, never revoke it), and runs a reconcile loop that downgrades a full-speed grant to base speed before the controller can expire it. Quota numbers stay in kmd3. The vendor adapter stays in dpc. In dev/test the provider is a new device-level simulator. The shared `FakeWifiProvider` stays as is (it is the contract fake for `tests/adapters-contract.test.mjs`).

Out of scope: kmd3 (wifi_sessions table, `/api/wifi/sessions*` routes, quota/spend/peak math, 2 devices per account, `wifi_session.*` and `wifi_quota.updated` events, the cloud->edge applier). dpc (vendor adapter, verifying client IP <-> MAC at the controller, 300-device field test). Web portal (no change).

## 1. Provider semantics (doc only, `packages/shared/src/adapters/providers.ts`)

Add JSDoc on `WifiProvider`, no type change:

- `reference` is one grant. Same reference + same request replays; a different request fails `IDEMPOTENCY_KEY_REUSED`; a revoked reference never re-authorizes (`authorized: false`). (Matches the fake.)
- A new `authorize` for a `deviceId` that already holds a grant **replaces** that device's rate and duration without a gap (RADIUS CoA or controller API update). The adapter must guarantee this; dpc implements it.
- `revoke` of a reference that has been superseded on its device is a no-op for the device.
- `durationSeconds` lapsing at the controller is a cut. Callers renew before it lapses.
- `walledGarden` is the pre-auth allowlist (hosts). Adapters that can set it at the controller also implement the optional `WifiWalledGardenSync` capability (section 4).

## 2. Table: `wifi_device_grants` (T, E, operational, edge-local)

File `apps/api/src/db/schema/edge-wifi.ts`, RLS in `edge-wifi.custom.sql`, folded into the generated migration `apps/api/drizzle/0099_<name>.sql` (renumber at merge if 0099 is taken). Never synced to the cloud. Same migration on the cloud and the edge (one image), empty on the cloud.

| Column                    | Type                             | Rule                                                                                                |
| ------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| id                        | uuid PK default random           | also the provider `reference`                                                                       |
| tenant_id                 | uuid NOT NULL                    | `tenantIdColumn`                                                                                    |
| outlet_id                 | uuid NOT NULL                    | FK (tenant_id, outlet_id) -> outlets(tenant_id, id)                                                 |
| wifi_session_id           | uuid NOT NULL                    | opaque; kmd3 adds FK (tenant_id, wifi_session_id) -> wifi_sessions later                            |
| device_hash               | varchar(64) NOT NULL             | sha256 hex of `${tenantId}:${normalized controller id}`; CHECK `^[0-9a-f]{64}$`                     |
| controller_device_id      | varchar(64) NULL                 | raw controller id (MAC). Needed to downgrade/renew without the guest. NULL on terminal rows (scrub) |
| speed_tier                | varchar(8) NOT NULL              | CHECK in ('full','base')                                                                            |
| bandwidth_kbps            | integer NOT NULL                 | CHECK 1..1000000                                                                                    |
| base_bandwidth_kbps       | integer NOT NULL                 | CHECK 1..1000000, <= bandwidth_kbps; lets the loop downgrade without kmd3                           |
| duration_seconds          | integer NOT NULL                 | CHECK 1..129600                                                                                     |
| status                    | varchar(16) NOT NULL             | CHECK in ('pending','active','unknown','superseded','revoked','failed')                             |
| attempt_count             | integer NOT NULL default 0       |                                                                                                     |
| last_error_code           | varchar(64) NULL                 | code only, never a message from the vendor                                                          |
| renew_until               | timestamptz NOT NULL             | min(sessionEndsAt, now + 24 h)                                                                      |
| requested_at              | timestamptz NOT NULL             |                                                                                                     |
| authorized_at, expires_at | timestamptz NULL                 | NOT NULL when status = active                                                                       |
| revoke_requested_at       | timestamptz NULL                 | write-ahead for revoke retries                                                                      |
| end_reason                | varchar(32) NULL                 | only with revoked; CHECK in wifiEndReason values                                                    |
| ended_at                  | timestamptz NULL                 | NOT NULL when terminal                                                                              |
| superseded_by             | uuid NULL                        | FK (tenant_id, superseded_by) -> (tenant_id, id)                                                    |
| created_at, updated_at    | timestamptz NOT NULL default now |                                                                                                     |

Constraints and indexes:

- unique (tenant_id, id); unique (tenant_id, outlet_id, id).
- CHECK `(controller_device_id IS NOT NULL) = (status IN ('pending','active','unknown'))`.
- partial unique `wifi_device_grants_one_active` on (tenant_id, outlet_id, device_hash) WHERE status = 'active'.
- partial unique `wifi_device_grants_one_inflight` on (tenant_id, outlet_id, device_hash) WHERE status IN ('pending','unknown').
- index (tenant_id, outlet_id, wifi_session_id); index (tenant_id, outlet_id, status, expires_at) for the loop.

`edge-wifi.custom.sql` (pattern: `edge-node.custom.sql`):

- `SELECT app.enforce_tenant_rls('public.wifi_device_grants'::regclass);` and `app.enforce_outlet_rls(...)` (ENABLE + FORCE).
- Trigger `app.guard_wifi_device_grant_update()`: the request columns are immutable (id, tenant_id, outlet_id, wifi_session_id, device_hash, speed_tier, bandwidth_kbps, base_bandwidth_kbps, duration_seconds, renew_until, requested_at), because a reference's request is fixed at the provider. A terminal status (superseded, revoked, failed) never changes. ERRCODE 42501.
- Export from `apps/api/src/db/schema/index.ts` (one line).

## 3. Contract: `packages/shared/src/edge/wifi.ts` (new, exported from the edge barrel)

- `controllerDeviceIdSchema`: trim, 1..64, `^[A-Za-z0-9:._-]+$`, lowercased by `normalizeControllerDeviceId`.
- `wifiEndReasonSchema = z.enum(["session_ended","staff_revoked","device_moved","day_closed"])`. No quota reason: running out of quota never ends a grant (FAC-13).
- `wifiGrantStatusSchema` (the six statuses above).
- `applyWifiSessionInputSchema` (strict): `outletId`, `wifiSessionId` (uuid), `controllerDeviceId`, `speedTier` (`wifiSpeedTierSchema`), `fullSpeedKbps`, `baseSpeedKbps` (1..1000000, full > base), `remainingSeconds` (int 0..86400), `sessionEndsAt` (iso). No tenantId: it comes from the context.
- `wifiGrantViewSchema` (strict): id, tenantId, outletId, wifiSessionId, `deviceTag` (first 8 hex of device_hash), speedTier, bandwidthKbps, status, authorizedAt, expiresAt, endedAt, endReason. Never the raw controller id.
- Endpoints (`defineEndpoint`):
  - `listEdgeWifiGrants`: GET `/api/edge/wifi/grants`, strict empty query, response `dataResponseSchema(z.array(wifiGrantViewSchema).max(500))` (live grants of the node's outlet).
  - `revokeEdgeWifiSession`: POST `/api/edge/wifi/sessions/:wifiSessionId/revoke`, strict empty body, response the session's grants.
  - `getEdgeWifiWalledGarden`: GET `/api/edge/wifi/walled-garden`, response `{ hosts: string[], version: string }` (version = sha256 of the sorted list).
- `PAYMENT_WALLED_GARDEN_HOSTS = { doit: ["pay.doit.id"] }` (dpc field test confirms extra hosts such as QRIS image or bank 3DS pages).
- Pure `buildWalledGarden({ orderingHosts, paymentHosts, portalHosts, extraHosts })`: lowercase, strip trailing dot, reject scheme/port/path/userinfo, allow `*.` only as a leading label, dedupe, sort, throw `WIFI_WALLED_GARDEN_TOO_LARGE` above 100 (the `wifiRequestSchema` cap).
- `WifiWalledGardenSync` type: `{ syncWalledGarden(context: ScopedTenantContext, hosts: readonly string[]): Promise<void> }` plus guard `supportsWalledGardenSync(provider)`.
- `WifiProviderError` with codes `WIFI_PROVIDER_TIMEOUT | WIFI_PROVIDER_UNAVAILABLE` (transport failures; the agent maps them to `unknown`).

## 4. Services

### Simulator: `apps/api/src/edge/wifi/simulator.ts`

`WifiControllerSimulator implements WifiProvider, WifiWalledGardenSync`, constructor `{ now?: () => Date }`.

- Scope checks like the fake: `assertTrustedScopedContext`, schema parse, tenant equality, `assertOutletInScope`.
- Idempotent per (tenant, outlet, reference) with a fingerprint; reused reference with another request -> `IDEMPOTENCY_KEY_REUSED`; revoked reference -> `authorized: false`.
- Per device: current reference; a new authorize replaces it with no gap; revoke of the current reference blocks the device; revoke of a superseded one is a no-op.
- `syncWalledGarden` stores the pre-auth allowlist per outlet.
- Scripted faults per call: `script(method, "ok" | "reject" | "timeout" | "transport_error" | "applied_then_timeout")`.
- Probes: `deviceAccess(tenantId, outletId, deviceId)` -> `{ state: "blocked" } | { state: "online", bandwidthKbps, reference, expiresAt }`; `canReach(tenantId, outletId, deviceId | null, host)` (allowlist match, exact or `*.` suffix, or the device is online); `cuts()` records every time the clock passes the current grant's expiry while the device was never revoked; `calls` counters.

### Registry: `apps/api/src/edge/wifi/registry.ts`

`createDefaultWifiProvider({ simulator: boolean; production?: boolean }): WifiProvider | null`. Simulator in production throws (same rule as `createDefaultEdcRegistry`). Production without a vendor adapter returns null until dpc registers one.

### Agent: `apps/api/src/services/edge-wifi-agent.service.ts`

```ts
export function createWifiAgent(options: {
  provider: WifiProvider;
  contextFor(outletId: OutletId): ScopedTenantContext; // server-minted, the edge node's own tenant
  now?: () => Date;
  providerTimeoutMs?: number; // default 5000
}): WifiAgent;
export type WifiAgent = {
  applySession(
    ctx: ScopedTenantContext,
    input: ApplyWifiSessionInput,
  ): Promise<WifiGrantView>;
  endSession(
    ctx: ScopedTenantContext,
    input: { outletId: OutletId; wifiSessionId: string; reason: WifiEndReason },
  ): Promise<WifiGrantView[]>;
  listLiveGrants(
    ctx: ScopedTenantContext,
    outletId: OutletId,
  ): Promise<WifiGrantView[]>;
  walledGarden(
    ctx: ScopedTenantContext,
  ): Promise<{ hosts: string[]; version: string }>;
  reconcile(
    ctx: ScopedTenantContext,
    outletId: OutletId,
  ): Promise<{
    authorized: number;
    downgraded: number;
    renewed: number;
    revoked: number;
    failed: number;
  }>;
};
export const WIFI_RECONCILE_INTERVAL_MS = 30_000;
export const WIFI_FULL_GRACE_SECONDS = 300;
export const WIFI_RENEW_LEAD_SECONDS = 600;
export const WIFI_BASE_CHUNK_SECONDS = 14_400;
```

Every method: trusted context, outlet in scope, all queries inside `withTenant` and filtered by tenant_id + outlet_id. Provider calls never run inside a DB transaction.

`applySession`:

1. Parse input. `remainingSeconds = 0` means base. Full: bandwidth = fullSpeedKbps, duration = min(remaining, until renew_until) + 300 s grace. Base: bandwidth = baseSpeedKbps, duration = min(4 h, until renew_until) + 300 s.
2. Tx + `pg_advisory_xact_lock(hashtext(tenant:outlet:device_hash))`. A live row of another wifi_session_id -> 409 `WIFI_DEVICE_BOUND_ELSEWHERE` (stops one guest claiming another's MAC). Same session, same tier and bandwidth, expiry far enough -> return it (no provider call). An in-flight row with the same request -> return it; with another request -> 409 `WIFI_GRANT_IN_FLIGHT`. Otherwise insert `pending`, commit.
3. `provider.authorize` with reference = row id and `walledGarden` from `walledGarden()`, raced against the timeout.
4. `authorized: true` -> tx: new row `active`, previous active row `superseded` (superseded_by, ended_at, scrub controller id). No provider revoke for the old row. `authorized: false` -> `failed` (scrub), old active untouched, 502 `WIFI_AUTHORIZE_REFUSED`. Timeout/transport -> `unknown`, attempt_count + 1, return the view (the portal shows "menyambungkan"). The old active grant always stays until the new one is confirmed: the device is never cut by a speed change.

`endSession`: tx sets revoke_requested_at + end_reason on every live row of the session; then `provider.revoke` per row; success -> `revoked`, ended_at, scrub. Failure keeps the row for the loop.

`reconcile` (bounded to 100 rows per tick):

1. Live rows with revoke_requested_at -> retry revoke.
2. pending/unknown older than 10 s -> authorize again with the identical request (same reference, idempotent) -> active/failed.
3. Active full rows with `expires_at - 300 s <= now` (quota spent) -> new base grant, make-before-break (FAC-13 holds even when kmd3 is late).
4. Active base rows within 600 s of expiry and `now < renew_until` -> renew with a new base grant.
5. Active rows past expires_at with `now >= renew_until` -> revoke, end_reason `day_closed`.
6. If the provider supports `WifiWalledGardenSync` and the version changed -> sync.

### Walled-garden source: `apps/api/src/services/edge-wifi-walled-garden.service.ts`

`loadWalledGardenSources(ctx)`: `tenant_domains` hostnames of the tenant (SELECT is open by design), host of `env.WEB_URL` and `env.BETTER_AUTH_URL` (on the edge these are the edge's own origins serving `/wifi`, ordering and checkout), all `PAYMENT_WALLED_GARDEN_HOSTS`. No new env key. Feeds `buildWalledGarden`.

## 5. Edge call path

- `apps/api/src/edge/wifi/port.ts`: `type WifiEnforcement = Pick<WifiAgent, "applySession" | "endSession">`; `installWifiEnforcement(impl | null)`; `wifiEnforcement()` default throws HttpError 503 `WIFI_AGENT_NOT_READY` (fail closed). kmd3's `/api/wifi/sessions*` services (served on the edge) call `wifiEnforcement().applySession(...)` in process.
- `apps/api/src/edge/runtime.ts`: on the edge, role `primary` only, after the boot guards: `createDefaultWifiProvider({ simulator: NODE_ENV !== "production", production })`. Null -> install nothing (routes and port answer 503). Otherwise `createWifiAgent({ provider, contextFor })` with the same server-minted node context the link uses, `installWifiEnforcement(agent)`, take a session-level `pg_try_advisory_lock` per outlet (single owner, like the EDC agent), run `reconcile` every 30 s (timer `unref`, stopped on shutdown, errors logged by name/code only). Add `"wifi_device_grants"` to `EDGE_REQUIRED_TABLES`.
- Cloud: nothing installed. The cloud never talks to a controller. Quota changes computed on the cloud (a payment landing) travel down as `wifi_quota.updated` through the link; the edge applier (kmd3/oc3) calls `wifiEnforcement().applySession`.
- Hand-off gap for kmd3: `startWifiSessionSchema` has no controller device id yet. kmd3 adds `controllerDeviceId` taken from the controller's portal redirect (param name from dpc).

## 6. Routes: `apps/api/src/routes/edge-wifi.routes.ts`

Mounted in `apps/api/src/routes/index.ts` as `apiRouter.use("/edge/wifi", edgeWifiRouter)` before `/edge`. `/api/edge/*` is already edge-only in `edge/mode.ts`, so no prefix change. Guards: same as `edge-device.routes.ts` (node tenant, `requireAuth`, tenant context). Permission `device.registry.manage` on the node's outlet, checked in the service layer (no new permission code). Strict Zod on query, params and body; tenant and outlet always from the node identity, never the request.

- GET `/grants` -> `agent.listLiveGrants`.
- POST `/sessions/:wifiSessionId/revoke` -> `agent.endSession(reason "staff_revoked")`, audited with `auditFacility`-style audit row (action `wifi_grant.revoked`). Unknown session in this tenant/outlet -> 404.
- GET `/walled-garden` -> `agent.walledGarden` (for manual controller provisioning when the vendor has no API).

## 7. Tests

Commands: node tests plain (`node --test tests/<file>.mjs`); API tests from the worktree root with `LEGEND_TEST_FILES="src/test/a.test.ts ..." heavy pnpm test`.

- `tests/legend-hsk-wifi-contract.test.mjs`: apply schema strict (extra key, full <= base, remaining > 86400 rejected); end reasons contain no quota reason; grant view has no controller id key; `buildWalledGarden` normalize/dedupe/sort/limit 100, rejects scheme/port/path, `*.` rule, payment hosts present.
- `apps/api/src/test/edge-wifi-simulator.test.ts`: replay, `IDEMPOTENCY_KEY_REUSED`, revoked reference stays off, other tenant context refused, out-of-scope outlet `OUTLET_OUT_OF_SCOPE`, supersede without gap, revoke of superseded is a no-op, expiry recorded in `cuts()`, pre-auth reach, scripted faults, simulator in production throws.
- `apps/api/src/test/edge-wifi-rls.test.ts` (pattern `edc-rls.test.ts`): FORCE RLS on; tenant B cannot select/insert/update tenant A rows; outlet B rows invisible under an outlet A scope; WITH CHECK refuses a foreign tenant_id; outlet FK of another tenant refused; immutable request columns; terminal status frozen; scrub CHECK; one active and one in-flight per device.
- `apps/api/src/test/edge-wifi-agent.test.ts` (DB + simulator + fake clock): first grant full; repeat apply makes no provider call; base apply is make-before-break with `cuts()` empty; loop downgrades full at quota end without kmd3; base renewal before expiry; timeout -> unknown -> loop re-authorizes the same reference (one effective grant); reject -> failed and old grant intact; device bound to another live session -> 409; endSession revokes and scrubs; revoke failure retried; renewal stops at renew_until; every authorize carries the built walled garden; tenant B context cannot see or end tenant A sessions (cross-tenant); outlet-scoped context of another outlet -> `OUTLET_OUT_OF_SCOPE`.
- `apps/api/src/test/edge-wifi-routes.test.ts`: cloud mode 404 `EDGE_ONLY_ROUTE`; edge without agent 503; no session 401; no `device.registry.manage` 403; list shows only the node outlet and no raw device id; extra body/query key rejected; non-uuid param 400; other tenant's session id 404; walled-garden shape; port default fails closed; runtime installs the agent on primary only; `EDGE_REQUIRED_TABLES` has the table.
- `apps/api/src/test/edge-wifi-acceptance.test.ts`: FAC-11 an unauthenticated simulated device reaches every ordering host (tenant_domains + WEB_URL host) and payment host, not `example.com`, and still reaches them after throttling; FAC-13 a simulated day (full -> quota spent -> base -> renewals) with the loop paused 240 s keeps `cuts()` empty and the device never `blocked` before endSession; two tenants on one database stay isolated end to end; 300 devices applied then one reconcile tick stays within the 100-row bound (FAC-15 smoke, not a load test).

## 8. Slices (disjoint file ownership)

S1 and S2 land first (types and table). S3, S4 and S5 may start at the same time against the signatures above; they run their tests after S1 and S2 are committed.

| Slice                           | Owner                      | Files (only these)                                                                                                                                                                                                                                                                                                                          | Done when                                                                                  |
| ------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| S1 Contract + simulator         | implementer                | `packages/shared/src/edge/wifi.ts` (new), the edge barrel export line in `packages/shared/src/edge/index.ts`, JSDoc in `packages/shared/src/adapters/providers.ts`, `apps/api/src/edge/wifi/simulator.ts`, `apps/api/src/edge/wifi/registry.ts`, `tests/legend-hsk-wifi-contract.test.mjs`, `apps/api/src/test/edge-wifi-simulator.test.ts` | both test files pass; `tests/adapters-contract.test.mjs` unchanged and passing             |
| S2 Schema + migration + RLS     | implementer (Opus, tier K) | `apps/api/src/db/schema/edge-wifi.ts`, `apps/api/src/db/schema/edge-wifi.custom.sql`, one export line in `apps/api/src/db/schema/index.ts`, `apps/api/drizzle/0099_*.sql` + `apps/api/drizzle/meta/*`, `apps/api/src/test/edge-wifi-rls.test.ts`                                                                                            | `pnpm db:generate` gives no further diff; RLS test passes                                  |
| S3 Agent + walled-garden source | implementer (Opus)         | `apps/api/src/services/edge-wifi-agent.service.ts`, `apps/api/src/services/edge-wifi-walled-garden.service.ts`, `apps/api/src/test/edge-wifi-agent.test.ts`                                                                                                                                                                                 | agent test passes                                                                          |
| S4 Port + routes + runtime      | implementer                | `apps/api/src/edge/wifi/port.ts`, `apps/api/src/routes/edge-wifi.routes.ts`, mount line in `apps/api/src/routes/index.ts`, `apps/api/src/edge/runtime.ts`, `apps/api/src/test/edge-wifi-routes.test.ts`                                                                                                                                     | routes test passes; existing `edge-link*.test.ts` and `edge-mode-guard.test.ts` still pass |
| S5 Acceptance tests             | test-writer                | `apps/api/src/test/edge-wifi-acceptance.test.ts`                                                                                                                                                                                                                                                                                            | passes against S1-S4                                                                       |

Wave close: heavy typecheck for api, full `pnpm test`, lint; reviewer (Opus, tier K) on the diff, architect pass on the migration and the MAC handling, second opinion queued.

## 9. Risks

1. The portal-supplied controller device id can be spoofed. The 409 on a device bound to another live session limits damage; the real check (client IP <-> MAC at the controller) belongs to dpc.
2. The raw MAC sits on the edge while a grant is live (personal data). It is scrubbed on every terminal row and never sent to the cloud. A MAC hash is brute-forceable, so the hash is only a key, not anonymization.
3. The interface has no pre-auth walled-garden call. FAC-11 before login relies on the optional `WifiWalledGardenSync` or manual provisioning from `/api/edge/wifi/walled-garden`. dpc must pick one per vendor.
4. Supersede-without-gap is assumed of the vendor. If the controller cannot update a device in place, dpc implements it inside the adapter (CoA) or raises it before the field test.
5. If the agent is down longer than the 300 s grace while a full grant ends, the controller cuts the device. The base grant has the same grace before renewal.
6. Migration number 0099 may collide with other branches; regenerate at merge, never edit an applied migration.
