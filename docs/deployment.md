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
# Staff device PINs (PRD §3 F6): its own secret, never derived from
# BETTER_AUTH_SECRET. Required in production; rotating it invalidates every
# stored PIN, so staff must set a new one after a rotation.
STAFF_PIN_PEPPER=another-random-secret-at-least-32-characters
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
  -e STAFF_PIN_PEPPER="$STAFF_PIN_PEPPER" \
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
| `PUBLIC_RATE_LIMIT_GUEST_TENANT_PER_MINUTE` | `60000` | QR guest table-session requests per tenant per minute (own bucket; guests also get 10x the per-IP budget for a venue NAT and 600/min per table credential) |

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
restricted app and worker database roles after migration with
`deploy/single-vm/provision-roles.sh` (see "First boot: restricted database
roles" below); configure the worker's trusted transport and notification
adapters before starting it.

#### Worker transport and notification settings (legend-18qw)

The worker refuses to start unless its transport and every notification channel
are configured. Compose sets `WORKER_TRANSPORT=builtin`; put the rest in
`worker.env`:

| Key                              | Values              | Notes                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKER_TRANSPORT`               | `builtin`           | Built-in outbox transport. On the cloud a `cloud-sync` event is consumed locally (the consumption row is the durable, idempotent acknowledgement). With `EDGE_MODE=true` it is queued on the authenticated edge link (`/api/edge-link`) to the cloud. `WORKER_TRANSPORT_MODULE` / `WORKER_CONFIG_MODULE` still override it with a trusted module. |
| `NOTIFICATION_EMAIL_PROVIDER`    | `disabled`, `brevo` | Required. `brevo` also needs `BREVO_API_KEY` and `NOTIFICATION_EMAIL_FROM` (optional `NOTIFICATION_EMAIL_FROM_NAME`). The provider account and sender domain (SPF/DKIM) are bead legend-wwuc.                                                                                                                                                     |
| `NOTIFICATION_PUSH_PROVIDER`     | `disabled`          | Required. Web push (VAPID) is bead legend-hyq.                                                                                                                                                                                                                                                                                                    |
| `NOTIFICATION_WHATSAPP_PROVIDER` | `disabled`          | Required. WhatsApp templates are bead legend-hyq.                                                                                                                                                                                                                                                                                                 |

A disabled channel is never planned for a recipient: in-app notifications are
still written and the attempt is skipped, never reported as sent. A gap in an
outbox stream (an event whose earlier sequence never arrived) is recorded in
`domain_event_gap_requests` and logged as `Outbox sequence gap`; that aggregate
stays held until the missing event arrives. Watch for that log line: it means a
producer bug, and nothing skips the gap automatically.

Run `deploy/single-vm/deploy.sh --env-file /absolute/path/compose.env --dry-run`
to validate without starting services (it also runs the role wrapper's
`--dry-run`). Without `--dry-run`, it starts PostgreSQL, runs the migration job
once, audits the restricted database roles (`provision-roles.sh --audit`), and
starts the services only if the audit passes. Run only after setting up backup
configuration, provisioning roles and checking the rollout plan. Image
builds and this script do not purchase or provision infrastructure.

### Deployment security checklist

- Restrict origin ports 80 and 443 to current Cloudflare IP ranges; do not
  publish PostgreSQL, API, web, or the local Caddy ask bridge. Docker-published
  ports bypass `ufw`/INPUT rules, so enforce the allowlist in the cloud
  provider's security group or in the `DOCKER-USER` iptables chain, and verify
  from a non-Cloudflare address that 80/443 are refused.
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
user, provision the restricted application and queue roles (next section), and
confirm a successful base backup to both repositories. Provisioning is a
first-boot prerequisite; the deploy script does not perform it. See
`deploy/backup/README.md` for the supplied systemd timer example and
restore-drill procedure. Once those prerequisites and the transport adapter are
ready, use the deploy script for subsequent releases.

### First boot: restricted database roles (legend-zoqc)

The API and worker never receive the migration (administrator) credentials.
They log in with two restricted roles that a one-shot job creates after the
migrations (PRD §3 F3, TEN-02):

| Login                     | Env key (file)                                                 | What it can do                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legend_runtime_<16 hex>` | `APP_DATABASE_URL` (api.env, worker.env; `DATABASE_URL` equal) | Member of `legend_app` only: read and write tenant tables through forced RLS. Not superuser, no `BYPASSRLS`, owns nothing, cannot create or alter objects. |
| `legend_worker_<16 hex>`  | `WORKER_DATABASE_URL` (worker.env only)                        | Owns only the `pgboss` queue schema and reads `app.active_tenant_registry`. No access to domain tables.                                                    |

1. Generate each login name and password on the VM, and write them into the
   private env files; never commit or paste them anywhere else:

   ```sh
   echo "legend_runtime_$(openssl rand -hex 8)"   # application login name
   echo "legend_worker_$(openssl rand -hex 8)"    # queue login name
   openssl rand -hex 24                            # a password (one per login)
   ```

   `api.env`: `APP_DATABASE_URL` and `DATABASE_URL` set to
   `postgresql://<app login>:<app password>@postgres:5432/legend`.
   `worker.env`: the same two lines plus `WORKER_DATABASE_URL` with the queue
   login. `migrator.env` alone holds `MIGRATION_DATABASE_URL`.

2. Run the job from the private network, on the VM:

   ```sh
   deploy/single-vm/provision-roles.sh --env-file /absolute/path/compose.env --dry-run
   deploy/single-vm/provision-roles.sh --env-file /absolute/path/compose.env
   ```

   The script first refuses to continue if `api.env`, `web.env` or `worker.env`
   contains `MIGRATION_DATABASE_URL`, if `web.env` holds any database URL, if
   `api.env` and `worker.env` disagree on the application login, if a URL is
   not exactly `postgresql://<login>:<48 hex>@host:port/database` (no query
   string), or if the restricted URLs and `MIGRATION_DATABASE_URL` name
   different databases. It also refuses when the shell exports
   `API_ENV_FILE`, `WEB_ENV_FILE`, `WORKER_ENV_FILE` or `MIGRATOR_ENV_FILE`
   with a value other than the one in `compose.env` (Compose would prefer the
   shell's), and pins the checked paths for every Compose call. Any env file
   with a non-ASCII character before a key on some line (a byte-order mark or
   a no-break space, which Compose silently skips, so a hidden
   `MIGRATION_DATABASE_URL` would reach the service) is refused with only the
   line number shown (lines inside a quoted value that spans lines are not
   keys and may hold any text); save such files as plain text. Compose output
   is hidden during validation because Compose echoes an unparsable env line,
   secrets included.

   Those checks read line starts, and Compose reads more: text after a closing
   quote is a new `KEY=value` (`A="x" MIGRATION_DATABASE_URL=...`), and a
   quoted value can span lines and swallow a later line. So, except with
   `--dry-run`, the script also checks the configuration Compose will really
   apply: `docker compose config --format json` is piped straight into
   `deploy/single-vm/check-compose-env.mjs`, run with `node` from the
   migrator image in a container with no network and no env file. It refuses
   unless no service except the two jobs receives `MIGRATION_DATABASE_URL`
   (or `_FILE`), `web` receives no database URL, and the URLs `api` and
   `worker` receive equal the ones just validated. Its messages name only
   services and keys, never values. Compose fills `${VAR}` in env files from
   the shell and `compose.env`, so the configuration is read with the
   environment `deploy.sh` uses to start the services (which never exports
   the URLs); the two validated URLs go to the checker only. `MIGRATOR_IMAGE` must be a plain image reference, and if the
   checker cannot start (image not pulled, no `node`) the script says so and
   stops. `--dry-run` skips this check (it needs the migrator image);
   `deploy.sh` always runs it through `--audit` before any service starts.
   It then starts
   PostgreSQL, applies migrations, and runs the `provision-roles` service (the
   migrator image, `node dist/provision-roles.js`) with `migrator.env` plus the
   two restricted URLs taken from the services' own env files. The URLs reach
   the container through the environment, never a command line.

3. Expect `Restricted database roles are ready.` Only role names are printed.
   Then start the services with `deploy.sh`, which re-checks the roles after
   every migration with `provision-roles.sh --env-file ... --audit`: the same
   checks, changing nothing, plus a sign-in with each URL. If the logins were
   never provisioned, a password no longer matches the env file, or a
   migration widened their rights, the audit fails and no service starts.

The job is idempotent and doubles as an audit: run it again at any time. Each
run, inside one locked transaction, creates a missing login or re-keys an
existing one to the password in the env file (so changing the password there
and re-running is how to rotate it; restart the API and worker afterwards). It
also resets drift that would only break or bend a login (`NOINHERIT`, an
expiry, a connection limit, role-level settings such as `search_path`, a
`legend_app` membership without `INHERIT` or with `ADMIN OPTION`; a superuser
migration login revokes such a grant whoever made it, a non-superuser only its
own, and the job otherwise refuses and names the grantor). Settings a
non-superuser owner cannot reset (for example `session_replication_role`) make
the job fail until a superuser runs `ALTER ROLE ... RESET ALL`. It then
fails, changing nothing, if `legend_app` can log in or has elevated attributes,
or if a login:

- is a superuser or has `BYPASSRLS`, `CREATEDB`, `CREATEROLE` or `REPLICATION`,
  directly or inherited, or inherits any predefined `pg_*` role;
- owns any table, function, type, schema, operator, collation or other
  object outside its own schema (`pgboss`);
- may run a built-in function that `PUBLIC` cannot (such as `pg_read_file`),
  or holds rights on a system catalog beyond `PUBLIC`'s (such as reading
  `pg_authid`);
- can reach, by any path including a grant to `PUBLIC`, an object on the fixed
  sensitive list: `pg_authid`, `pg_shadow`, `pg_user_mapping`, `pg_statistic`,
  `pg_statistic_ext_data`, `pg_largeobject`, `pg_subscription.subconninfo`,
  the file and server functions (`pg_read_file`, `pg_read_binary_file`,
  `pg_ls_dir` and the other `pg_ls_*dir`, `pg_stat_file`, `lo_import`,
  `lo_export`, `pg_reload_conf`, `pg_rotate_logfile`, `pg_promote`) and any
  `dblink*` function. This is an explicit denylist, not a comparison with
  PostgreSQL's default catalog privileges per major version: such a baseline
  would have to be copied and kept for every release, while the denylist is
  short, reviewable and version-independent. Other catalog grants to `PUBLIC`
  are not detected;
- can create objects in the database or any schema outside its own;
- holds, directly, through a group or through `PUBLIC`, `SET` on a parameter
  that is not a plain user setting (such as `session_replication_role`, which
  skips triggers and foreign keys) or on a parameter no loaded module defines
  yet, or `ALTER SYSTEM` on any parameter. As a superuser, remove it with
  `REVOKE SET ON PARAMETER <parameter> FROM <role|PUBLIC>` (or
  `REVOKE ALTER SYSTEM ON PARAMETER ...`) and re-run;
- belongs, directly or through `legend_app`, to any role other than
  `legend_app` (with or without `ADMIN OPTION`; the queue login: to none);
- holds table rights beyond `SELECT/INSERT/UPDATE/DELETE` (application) or
  beyond `SELECT` on `app.active_tenant_registry` (queue), including grants on
  single columns. `TRUNCATE` ignores RLS and is always refused, as are
  `REFERENCES`, `TRIGGER` and, on PostgreSQL 17, `MAINTAIN`. Extension views
  readable by everyone (such as `pg_stat_statements`) are not counted;
  application tables granted to `PUBLIC` are;
- holds sequence rights beyond `USAGE/SELECT` (application) or any sequence
  right outside `pgboss` (queue). `UPDATE` allows `setval()`, which can push a
  sequence to its end and break every insert that uses it;
- would receive such rights on tables or sequences created later through
  default privileges (`ALTER DEFAULT PRIVILEGES`), any default table or
  sequence right granted to `PUBLIC`, or a default `CREATE` on schemas. Remove
  them with `ALTER DEFAULT PRIVILEGES ... REVOKE` and re-run.

The same run (and every audit) also checks tenant isolation itself (TEN-02):
every table with a `tenant_id` column (in `pgboss` only if the application can
reach it, including through a grant on a single column) must have row-level security enabled and forced, and a restrictive
policy for all commands and roles whose `USING` and `WITH CHECK` are exactly
`tenant_id = app.require_tenant_id()`, as `app.enforce_tenant_rls` creates it.
Five tables are documented exceptions, the same list as
`apps/api/src/db/rls.test.ts`: `tenant_domains` and `payment_link_tokens`
(must keep row-level security enabled; reads are open, writes are
tenant-checked: every permissive `INSERT`, `UPDATE`, `DELETE` or `ALL` policy
the application login can use must have `USING` and `WITH CHECK` exactly
`tenant_id = app.require_tenant_id()`, as the migrations create them), and `session`, `login_challenges` and `wa_inbound_messages`
(read before a tenant is known; scoped by the services). A table that fails
the check stops the job. As the migration owner, fix "disabled" with
`ALTER TABLE <table> ENABLE ROW LEVEL SECURITY` and "not forced" with
`ALTER TABLE <table> FORCE ROW LEVEL SECURITY`. For a missing or altered policy,
drop the table's `tenant_access` and `tenant_isolation` policies, then run
`SELECT app.enforce_tenant_rls('<table>'::regclass)` (it creates both and fails
if either exists). Never run it on `tenant_domains` or `payment_link_tokens`:
they only need row-level security enabled. For a write policy on either
reported as "not limited to the tenant", drop it (`DROP POLICY <policy> ON
<table>`), or, if the migrations created it (`tenant_domain_*`,
`payment_link_tokens_*`), restore its expressions with `ALTER POLICY`. The job compares the policy text
with `search_path` set to `pg_catalog`, so a custom `search_path` does not
matter.

After committing, the job signs in with each URL exactly as given and checks
that PostgreSQL reports that login (not a superuser) on the same database. URLs
may carry only TLS and timeout parameters after `?` (`sslmode`, `sslrootcert`,
`sslcert`, `sslkey`, `ssl`, `channel_binding`, `application_name`,
`connect_timeout`); `user`, `password`, `host`, `options` and the like would
override the login and are refused. PostgreSQL 16 or newer is required.

Changing the queue login name: pg-boss keeps its jobs in tables the old login
owns, so the new name must be the same role, renamed. With a new name in
`worker.env` the job stops, creating nothing, with "The pg-boss schema is owned
by <old>, not <new>". As the migration owner run
`ALTER ROLE "<old login>" RENAME TO "<new login>"` (the role keeps its OID, so
it keeps the schema and every table in it), then re-run the job: it re-keys the
password from `worker.env`. Do not create a separate login and move only the
schema: the queue tables would stay with the old role and the worker could not
read them.

An existing role with unsafe attributes is never adopted; fix or drop it by
hand. Passwords are sent to PostgreSQL as SCRAM-SHA-256 verifiers, so the
plaintext never reaches the server or its logs. The migration login must be a
superuser (the Compose `POSTGRES_USER`) or, on managed PostgreSQL, a
`CREATEROLE` + `BYPASSRLS` owner holding `ADMIN` on `legend_app`; existing data
migrations run under forced RLS. With a non-superuser owner the job grants that owner `SET` (never `INHERIT`) on the queue login so it can
hand it the `pgboss` schema.

Outside Compose (another host on the private network, with the API bundle or
the repository), run `node dist/provision-roles.js` or
`pnpm --filter @starter/api exec tsx src/provision-roles.ts` with
`MIGRATION_DATABASE_URL`, `APP_DATABASE_URL` and `WORKER_DATABASE_URL` set. Each
may instead be supplied as `<NAME>_FILE`, a path to a file holding the URL. The
job does not read `.env` files. Local development keeps using
`pnpm dev:prepare`, which provisions its own random login through the same code.
