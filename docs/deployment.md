# Hosting the monorepo

Deploy two Node.js services — the API and the web app — connected to a persistent PostgreSQL service. Neither app keeps data on its filesystem.

## Environment and data policy

PRD v1.7 §3 (Environment & Deployment) and §7 require separate development,
staging and production environments. Only production may contain real data.
The settings below describe the deployment and are separate from `NODE_ENV`,
which selects Node runtime behavior. Set them consistently for every service.

| Environment | `DEPLOYMENT_MODE`         | `EDGE_MODE` | `DATA_CLASSIFICATION`                                               | Data                           |
| ----------- | ------------------------- | ----------- | ------------------------------------------------------------------- | ------------------------------ |
| Development | `development`             | `false`     | `synthetic`                                                         | Synthetic only                 |
| Staging     | `staging`                 | `false`     | `synthetic`                                                         | Synthetic only                 |
| Production  | `production`              | `false`     | `synthetic` or `real`                                               | Real data permitted            |
| Edge node   | Corresponding environment | `true`      | `synthetic` outside production; `synthetic` or `real` in production | Same policy as its environment |

The defaults are `development`, `false`, and `synthetic`. Explicitly set the
appropriate values in each deployment; an edge node is a topology, not an
exception to the environment's data policy. The edge topology requires the same web image configured with `EDGE_MODE=true`;
its offline provisioning and synchronization remain separate work.

Use fictional synthetic menus, 30 employees, and transactions for load and
payroll testing. Do not copy production databases, backups, customer or employee
records into development or staging, including masked or anonymized copies as a
substitute for synthetic data. Keep secrets in environment variables or a secret
manager, never in the repository.

Classification is a declaration, not a way to detect actual data. Import code
must classify its input honestly and call the real-data import guard before it
reads or writes the data; deployment and database access controls must also
prevent bypassing the application. Setting `DATA_CLASSIFICATION=synthetic` does
not make a production dump synthetic.

## Startup validation

Every runtime validates the three settings when its process starts, using one
schema in `@starter/shared/env` (`packages/shared/src/env/index.ts`), so a
service cannot run while disagreeing with the others about its data policy.
The check prints the offending setting names and messages — never the values —
and exits non-zero before the service accepts traffic.

| Runtime | Where the check runs                                                                          |
| ------- | --------------------------------------------------------------------------------------------- |
| API     | `apps/api/src/config/env.ts`, imported by the server entry                                    |
| Web     | `apps/web/server/plugins/deployment-env.ts` (built server) and `apps/web/src/server.ts` (dev) |
| Worker  | `apps/api/src/worker-main.ts` validates the deployment settings before starting work          |
| Edge    | The web runtime validates the same settings with `EDGE_MODE=true`                             |

The web app needs two entry points because it has two servers. The built server
(`node .output/server/index.mjs`, produced by Nitro) opens its port before it
loads the app — its default entry is a lazy handler — so a Nitro runtime plugin
in `apps/web/server/plugins/deployment-env.ts` runs the check while the process
starts, and a bad deployment exits before the port opens. `vite dev` uses
TanStack Start's own server instead, whose entry is `apps/web/src/server.ts`;
there the check runs when the server entry loads, on the first server render.
Both import `apps/web/src/lib/env.server.ts` (the module that reports and
exits), and `vite.config.ts` registers the plugin under `nitro.plugins`;
`tests/deployment-env.test.mjs` fails if either import or that registration is
dropped. TanStack Start strips `.server.ts` modules from the browser bundle, so
the check never reaches a client.

A future worker or edge entrypoint repeats the same three lines:

```ts
import { assertDeploymentEnv } from "@starter/shared/env";

// Before the loop or HTTP handler that serves work.
const settings = assertDeploymentEnv(process.env);
if (settings.EDGE_MODE) {
  // Edge-only wiring: local database, device sync, offline queue.
}
```

The module also exports `parseDeploymentEnv` (returns problems instead of
throwing, for a doctor command or a health endpoint) and
`assertDataImportAllowed` (the real-data import guard described above, already
used by the API).

## Domains and cookies

The browser calls the API directly with cookies, and the web server reads the same cookie during server rendering. Put both apps on subdomains of one site and share the cookie with `COOKIE_DOMAIN`:

| App | Example origin            |
| --- | ------------------------- |
| API | `https://api.example.com` |
| Web | `https://app.example.com` |

Unrelated domains (e.g. `app.example.com` and `example-api.net`) are not supported: the web server would never receive the session cookie. `pnpm run doctor` checks this rule against your settings. Better Auth marks cookies `Secure` automatically when `BETTER_AUTH_URL` is HTTPS.

`COOKIE_DOMAIN` sends the session cookie to **every** host under that domain, not just these two. Anything else served there — a marketing site on a third-party platform, user uploads, preview deployments — receives your users' sessions. Host such content on a different domain, or give the app its own parent (e.g. `api.app.example.com` and `web.app.example.com` with `COOKIE_DOMAIN=.app.example.com`).

## Production environment

**API** (private values through your host):

```dotenv
NODE_ENV=production
DEPLOYMENT_MODE=production
EDGE_MODE=false
DATA_CLASSIFICATION=real
DATABASE_URL=postgresql://user:password@database-host:5432/app
BETTER_AUTH_SECRET=your-random-secret-at-least-32-characters
BETTER_AUTH_URL=https://api.example.com
WEB_URL=https://app.example.com
COOKIE_DOMAIN=.example.com
# Behind a load balancer or reverse proxy (hop count, or a subnet list; never true):
TRUST_PROXY=2
# Optional: extra browser origins allowed to call the API with cookies.
# TRUSTED_ORIGINS=https://admin.example.com
# Optional direct connection when DATABASE_URL uses a pooler:
# MIGRATION_DATABASE_URL=postgresql://user:password@direct-host:5432/app
```

**Web**:

```dotenv
NODE_ENV=production
DEPLOYMENT_MODE=production
EDGE_MODE=false
DATA_CLASSIFICATION=real
# Build time — inlined into the browser bundle:
VITE_API_URL=https://api.example.com
# Runtime, optional — the address the web server uses to reach the API privately:
API_INTERNAL_URL=http://api:4000
```

`NODE_ENV=production` switches both servers to JSON logs and the web app to sending HSTS. The Docker images set it; set it yourself everywhere else.

`TRUST_PROXY` matters: the API resolves the client IP from it and hands that IP to Better Auth and the public rate limiter for per-IP limits on sign-in/sign-up and the guest reads. Set the number of proxies in front of the API (usually `1`, `2` when Cloudflare sits in front of your reverse proxy) or their subnets. The API refuses `true`, which would trust any `X-Forwarded-For` a client sends and let it choose the IP its attempts are counted under. Without a proxy, leave it unset (the socket address is used and client-supplied `X-Forwarded-For` is ignored).

Keep provider-required TLS settings. Do not disable certificate verification. The example credentials are placeholders, not defaults.

## Release steps without Docker

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
VITE_API_URL=https://api.example.com pnpm build
NODE_ENV=production node apps/api/dist/server.js           # API
NODE_ENV=production node apps/web/.output/server/index.mjs # Web
```

Apply migrations once per release. Both servers honor `PORT` and `HOST`. The API bundle (`apps/api/dist`) includes its dependencies; it needs only `dist/` (and `drizzle/` for migrations).

## Docker images

Build from the repository root. Each Dockerfile prunes the workspace with `turbo prune`, installs from the pruned lockfile, builds, and ships only the output:

```sh
docker build -f apps/api/Dockerfile -t my-api .
docker build -f apps/api/Dockerfile --target migrator -t my-api-migrate .
docker build -f apps/web/Dockerfile --build-arg VITE_API_URL=https://api.example.com -t my-web .
```

```sh
docker run --rm -e DATABASE_URL="$DATABASE_URL" my-api-migrate

docker run -d -p 4000:4000 \
  -e DEPLOYMENT_MODE=production \
  -e EDGE_MODE=false \
  -e DATA_CLASSIFICATION=real \
  -e DATABASE_URL="$DATABASE_URL" \
  -e BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
  -e BETTER_AUTH_URL=https://api.example.com \
  -e WEB_URL=https://app.example.com \
  -e COOKIE_DOMAIN=.example.com \
  -e TRUST_PROXY=1 \
  my-api

docker run -d -p 3000:3000 -e DEPLOYMENT_MODE=production -e EDGE_MODE=false \
  -e DATA_CLASSIFICATION=real -e API_INTERNAL_URL=http://api:4000 my-web
```

The builds need no secrets. Pass real values to running containers; never put secrets in `--build-arg`, `ENV`, or the image. `VITE_API_URL` is public by design. Rebuild the web image when the API's public origin changes.

Both images run as the unprivileged `node` user. Their `HEALTHCHECK`s report liveness only (`/api/health`, `/icon.svg`), so a database outage does not restart healthy processes. `GET /api/health/ready` additionally checks PostgreSQL for platforms that want a readiness probe. Both servers shut down gracefully on SIGTERM.

## Logs in production

Both servers write one JSON object per line to stdout with `level`, `time`, `service` (`api`/`web`), `env`, `msg`, and `reqId` (plus `userId` on authenticated API requests). Ship stdout to your log platform; correlate a page render across services by `reqId`. Forward an `X-Request-Id` from your load balancer and both servers reuse it. `LOG_LEVEL` adjusts verbosity; `LOG_SQL=true` is for debugging only.

## Connection pooling and scaling

The API uses one node-postgres pool with at most ten connections per process. Multiple instances multiply the connection count: use your provider's pooler and tune limits. Better Auth's rate-limit storage is in memory per instance; for several API instances configure shared rate-limit storage (see Better Auth's rate-limit docs). The web server keeps no state.

## Public API rate limits

The API's session-free reads — the guest QR scan and menu (`/api/qr/*`), the brand website and its menu (`/api/public/site/*`), the SSR brand context (`/api/tenant/*`) and customer payment links (`/api/payments/links/*`) — are capped by one in-memory limiter in the API. Authenticated routes are bounded by their session and permissions; these have no session at all, and the menu reads return the whole catalogue.

Two fixed one-minute windows are charged on every public read: one per client IP and one per resolved tenant. A request over either limit answers `429` with `{"error":{"code":"RATE_LIMITED"}}`, a `Retry-After` header holding the whole seconds left in the window, and `Cache-Control: no-store`. Health, Better Auth (`/api/auth/*`), provider webhooks and the TLS ask are not mounted on the limiter.

| Variable                              | Default  | Meaning                                                              |
| ------------------------------------- | -------- | -------------------------------------------------------------------- |
| `PUBLIC_RATE_LIMIT_PER_MINUTE`        | `600`    | Requests per client IP per minute                                    |
| `PUBLIC_RATE_LIMIT_TENANT_PER_MINUTE` | `6000`   | Requests per resolved tenant per minute                              |
| `PUBLIC_RATE_LIMIT_INTERNAL_IPS`      | loopback | Web server address(es) that skip the per-IP bucket (comma-separated) |

Sizing the defaults — they must not break legitimate traffic:

- Guests on the venue Wi-Fi usually reach the API through **one NAT address**, so all their scans, menu reads and payment polls share one IP bucket. Payment status polls every 2 s while a payment is pending (30 requests a minute per guest).
- The web server's **SSR fetches** (website pages, the brand context on every render) come from one address — the web server's — and carry no visitor IP. That address skips the per-IP bucket and only counts against the tenant bucket: list it in `PUBLIC_RATE_LIMIT_INTERNAL_IPS` (loopback by default, for web and API on one VM; add the web container's address under Docker). Without it every visitor would share one 600/min bucket.
- Authenticated payment admin (`/api/payments/admin/*`) is not on the limiter: staff at the venue share the guests' NAT address.
- The store is bounded (20 000 keys per bucket, least recently used evicted first) and lives in memory per API process. Several API instances each enforce their own window, so N instances allow up to N times the configured limit; the Cloudflare rule below is the shared edge layer.

`TRUST_PROXY` decides which address is "the client": the limiter uses `req.ip` as Express resolved it, never a raw `X-Forwarded-For`. Behind Cloudflare in front of Caddy that is **two** hops (`TRUST_PROXY=2`); with a single reverse proxy it is `1`. If the hop count is too low, every client appears as the proxy's address and all of them share one bucket.

### Cloudflare free-plan rule (edge layer)

The API limiter is one process's backstop. Put a stricter, shared rule at the edge where the plan allows it. On the **Free plan** Cloudflare's rate limiting rules allow **one rule**, a **10-second counting period**, **IP-only** counting, a **10-second mitigation timeout**, and expressions limited to **path** (plus verified bot). One rule can still cover the two catalogue-dumping surfaces:

- Field: `http.request.uri.path`, match `contains "/api/qr/"` **or** `contains "/api/public/site/"` (a single custom expression). The other two prefixes keep the API limiter only; payment links carry a 256-bit token and are polled during checkout, the brand context is one read per page.
- Requests: `30` per `10 seconds` per IP — 180 a minute, below the API's 600 default, so the edge sees an abuser first.
- Action: **Managed Challenge**, so a real guest recovers by solving one page instead of waiting for the block to lift. Use **Block** with the 10-second mitigation period only if the venue never needs to scrape its own menu.

On Pro and above, split the paths into separate rules with a longer period and a block action. Keep the API limits at or above the edge limits, so a legitimate client never meets the API's 429 before the edge rule has had its chance to challenge it.

## Security checklist

Built in: authenticated and origin-checked API routes, ownership filtered in SQL, sign-in/sign-up rate limits, 100 kB request bodies (including Better Auth's), `httpOnly` `SameSite=Lax` session cookies, helmet on the API, and frame/nosniff/referrer headers (plus HSTS in production) on the web app. Before launch, confirm:

- [ ] Both origins are HTTPS and `NODE_ENV=production` is set on both services.
- [ ] `TRUST_PROXY` matches your proxy hops, so rate limits see real client IPs (two hops with Cloudflare in front of Caddy).
- [ ] The public API rate limits suit the venue: guests behind one NAT address and the web SSR traffic both share a per-IP bucket ([public API rate limits](#public-api-rate-limits)), and a Cloudflare rule covers `/api/qr/` and `/api/public/site/` at the edge.
- [ ] Nothing untrusted is served under `COOKIE_DOMAIN` (see [Domains and cookies](#domains-and-cookies)).
- [ ] Several API instances share rate-limit storage (see [scaling](#connection-pooling-and-scaling)).
- [ ] Your proxy or load balancer also caps request bodies and slow uploads.
- [ ] `admin` is granted only to people trusted with every account: it can impersonate users, set their passwords and emails, delete them, and grant roles. Give moderators a narrower role ([roles](backend.md#role-based-access)).
- [ ] Features that create many rows or call paid services have per-user limits.
- [ ] You decided on email verification and password recovery; neither is configured.
- [ ] If you want a script-blocking Content Security Policy, add one with per-request nonces; the base only restricts framing, `<base>`, and plugins.

## Local Docker versus hosted data

`compose.dev.yaml` is a local convenience. It publishes PostgreSQL on loopback only and stores data in a named volume. Use PostgreSQL backups or your provider's backup service and test restoration; Docker volumes are persistence, not backups.

Account emails are not verified by the base. Add an email provider for verification and password recovery when needed.

References: [Better Auth Express integration](https://better-auth.com/docs/integrations/express), [Better Auth cookies](https://better-auth.com/docs/concepts/cookies), [TanStack Start hosting](https://tanstack.com/start/latest/docs/framework/react/hosting), [Turborepo Docker guide](https://turborepo.com/docs/guides/tools/docker), [node-postgres pooling](https://node-postgres.com/features/pooling).

## CI quality checks

The workflow runs these checks locally with `pnpm` after `pnpm install --frozen-lockfile`:

```sh
pnpm exec node --test scripts/ci/*.test.mjs
pnpm exec node scripts/ci/tenant-hardcode.mjs
pnpm exec node scripts/ci/color.mjs
pnpm exec node scripts/ci/pending.mjs
pnpm audit --audit-level high
pnpm audit --audit-level critical
pnpm check
pnpm build
```

The tenant-branch and color scanners are heuristics, not proofs: review indirect tenant-specific logic and dynamically constructed colors. The color scanner documents its starter exceptions in source. The isolation harness accepts an adapter for two authenticated tenants; its in-memory tests verify the harness only, not application isolation.

Lighthouse for `/menu` and `/t/*` and real tenant isolation remain explicit placeholders until the routes and modules exist (legend-wwsa). The 80% business-logic coverage gate requires domain modules and a coverage provider (legend-dd0g). Dependency scanning blocks critical advisories; known high findings are reported but do not block while legend-ziit tracks remediation. The high-level audit command returns nonzero for those findings. Do not treat these placeholders as release evidence.

## Single-VM deployment (legend-8br)

The configuration in `deploy/single-vm/compose.yaml` is a starting point for one
small Jakarta VM, with Cloudflare in front of Caddy and private PostgreSQL. It
is not a production readiness certification: measure VM, storage, egress and
backup costs together against the Rp1,000,000/month ceiling. Use separate VMs,
volumes, credentials and synthetic data for staging; staging never receives a
production backup. Choose image tags built and scanned by CI. The image workflow
builds and scans locally in CI and never pushes or deploys.

Build the API (`runner`), web (`runner`), worker, migrator, and edge targets
using the Dockerfiles above; build the backup-enabled PostgreSQL image with
`docker build -f deploy/backup/Dockerfile .`. Edge uses the same web image with
`EDGE_MODE=true`. See `deploy/backup/README.md` for required private pgBackRest
configuration, initialization, two independent encrypted object repositories,
daily backups and isolated restore drills. Configure Biznet Gio S3-compatible
storage as one repository and an independent off-site failure domain as the
other. Monitor archive failures and disk use; the config alone does not prove
RPO or RTO. Complete a real restore drill before launch.

Copy `deploy/single-vm/compose.env.example` outside the repository and set its
values and absolute paths. Create separate private env files for migrator, API,
web and worker; give each process only the credentials it needs. The runtime
example lists settings, not a complete production secret configuration. Provision
restricted app and worker database roles after migration using
`scripts/provision-app-role.mjs`; configure the worker's trusted transport and
notification adapters before starting it. Set `WORKER_TRANSPORT_PATH` to the
absolute path of the trusted transport module, which compose mounts read-only.
These adapters are not supplied yet
(legend-18qw), so event delivery must not be considered operational.

Run `deploy/single-vm/deploy.sh --env-file /absolute/path/compose.env --dry-run`
to validate without starting services. Without `--dry-run`, it starts PostgreSQL,
runs the migration job once, then starts the services. Run only after setting up
backup configuration, provisioning roles and checking the rollout plan. Image
builds and this script do not purchase or provision infrastructure.

### Deployment security checklist

- Restrict origin ports 80 and 443 to current Cloudflare IP ranges at the host
  firewall; do not publish PostgreSQL, API, web, or the local Caddy ask bridge.
  Use Cloudflare Full (strict) and verify custom-domain issuance and renewal.
- Set `TRUST_PROXY=2` for Cloudflare → Caddy → API and set
  `PUBLIC_RATE_LIMIT_INTERNAL_IPS=172.29.17.10` for this compose network. Ensure
  its subnet does not overlap another network and update both if it changes.
- Set the same long, random `TLS_ASK_TOKEN` for Caddy and API. Keep all secret
  files outside source control and readable only by the intended service.
- Verify forwarding headers, tenant isolation, cache keys by hostname, backup
  restore, alert delivery, and provider wiring in the target environment.
  Never cache authenticated or tenant-specific pages as public responses.
- `deploy/caddy/README.md` describes the local authenticated TLS ask bridge and
  Cloudflare firewall requirements; update the firewall and proxy IP list as
  Cloudflare's ranges change.

Monitoring setup and its limits are documented in `deploy/monitoring/README.md`.
The stack bounds Docker local log retention; arrange external uptime probes and
alert delivery. Device heartbeat, queue and sync-lag alerting require additional
production sources and provider adapters before they can be treated as covered.

### First boot and backup schedule

On a new VM, prepare the private pgBackRest configuration and transport module
before starting application services. Start PostgreSQL and run the migration job
separately using the same `--env-file` and Compose file as the deploy script.
Then initialize and check the pgBackRest stanza as the container's `postgres`
user, provision the restricted application and queue roles against the migrated
database, and confirm a successful base backup to both repositories. The role
provisioner exports functions; it is not a standalone CLI. Run it from a trusted
operator environment with connectivity to the private database and dependencies
installed, and never put the administrator credentials into application env
files. Provisioning is a first-boot prerequisite; the deploy script does not
perform it. See `deploy/backup/README.md` for the supplied systemd timer example
and restore-drill procedure. Once those prerequisites and the transport adapter
are ready, use the deploy script for subsequent releases.
