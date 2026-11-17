# Local development

Open this folder in your AI editor and describe the app you want:

> Build a personal reading list with accounts. Set up this project, run it, and let each person manage their own books.

`AGENTS.md` tells the agent to handle setup before continuing your feature. `agent.md` points to the same instructions. The project skills provide setup, database troubleshooting, feature-building, and derivative workflows.

## What runs where

`compose.dev.yaml` runs PostgreSQL 17. The Express API and the TanStack Start web app run on your computer. You need Node.js 22.18+ (the scripts load TypeScript through Node type stripping), pnpm (`corepack enable` provides the pinned version), and Docker with Compose v2; Docker Desktop includes both the engine and Compose.

```sh
pnpm run setup
pnpm dev
```

Setup checks Node.js and pnpm, installs the lockfile, generates missing private settings in the ignored root `.env.local`, chooses a free database port, creates a unique Compose project and persistent volume, waits for PostgreSQL health, applies committed Drizzle migrations, and checks the result. It can be repeated without changing credentials or deleting records.

`pnpm dev` prepares the database again (cheap when already running) and starts both apps with Turborepo:

| App | Address (default)       | Reloads                                                       |
| --- | ----------------------- | ------------------------------------------------------------- |
| API | `http://localhost:4000` | restarts on changes to `apps/api`, `packages/shared`, `.env*` |
| Web | `http://localhost:3000` | Vite hot module replacement                                   |

`pnpm dev:api` and `pnpm dev:web` start one app alone.

## Environment and synthetic data

Local development defaults to `DEPLOYMENT_MODE=development`, `EDGE_MODE=false`,
and `DATA_CLASSIFICATION=synthetic`. Staging also uses synthetic data only;
real data is permitted only in production. Never import a production database,
backup, or customer or employee records into a local environment. Generate
fictional menus, employees, and transactions for development and tests instead.
See the [environment matrix and import policy](deployment.md#environment-and-data-policy).

`EDGE_MODE=true` selects edge topology; it does not change the data policy or
provide the edge runtime by itself. Set environment values in your private local
configuration, and do not commit secrets.

Managed local development also seeds the synthetic tenant's published website
and records its verified domain in `DEV_PUBLIC_SITE_HOST`. This lets the public
home page and menu work at your local `WEB_URL` without editing DNS or hosts.
The alias applies only to three public GET endpoints from loopback in development
with synthetic data; it grants no sign-in or tenant management access. Real
tenant domains keep their normal verified-domain resolution.

Run `pnpm dev:prepare` followed by `pnpm run doctor` in a fresh worktree or if the
local site is missing. Doctor checks the configured domain, active tenant, and
published website. Existing settings are preserved; external databases are not
automatically seeded or assigned an alias. An unknown tenant or unpublished site
returns a normal 404 page. The website endpoint is `/api/public/site`;
`/api/tenant/context` supplies its theme, and `/api/tenant/site` does not exist.

## Origins and ports

Three settings in `.env.local` must agree; setup writes consistent defaults and `pnpm run doctor` checks them:

| Setting           | Meaning                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_URL` | The API's origin. The API dev server listens on its port.                                          |
| `WEB_URL`         | The web app's origin. The web dev server listens on its port; the API trusts it for CORS and CSRF. |
| `VITE_API_URL`    | The API origin the browser calls. Must equal `BETTER_AUTH_URL`.                                    |

To move the web app to port 3001, set `WEB_URL=http://localhost:3001` and restart `pnpm dev`. Use `localhost` for both apps: cookies are shared across ports of the same host, but `localhost` and `127.0.0.1` are different hosts. A one-off override from the shell also works, because shell values win over `.env.local`:

```sh
WEB_URL=http://localhost:3001 pnpm dev
```

## Database commands

| Command           | Result                                                                   |
| ----------------- | ------------------------------------------------------------------------ |
| `pnpm db:up`      | Generate missing local settings and start PostgreSQL; wait until healthy |
| `pnpm db:status`  | Show this copy's running or stopped database container                   |
| `pnpm db:logs`    | Show the last 80 database log lines without following indefinitely       |
| `pnpm db:down`    | Remove this copy's container and network, keeping its data volume        |
| `pnpm db:migrate` | Apply committed migrations (`apps/api/drizzle`)                          |
| `pnpm db:studio`  | Browse the database with Drizzle Studio                                  |
| `pnpm run doctor` | Verify settings, origins, connection, tables, and project tooling files  |

Use these commands instead of bare `docker compose up`: the wrappers load `.env.local` and `.env` with the same precedence as the apps and apply the saved project name. The database listens only on `127.0.0.1`, using a generated high port recorded in `.env.local`. Each fresh derivative has its own project, password, port, and volume.

Preserve `.env.local` across restarts. Do not delete the volume to fix a password or migration error. If a saved port becomes occupied, update both `POSTGRES_PORT` and the port in the managed `DATABASE_URL`, then run `db:up` again. Changing the environment password does not change an existing database role's password.

## Logs

Both dev servers print colorized single-line logs prefixed by Turborepo (`@starter/api:dev`, `@starter/web:dev`). Each request shows its method, path, status, duration, and `reqId`; API lines also show `userId` once signed in. An SSR page load shows the same `reqId` on the web line and on the API calls it made. Set `LOG_SQL=true` to see SQL, or `LOG_LEVEL=info` to quiet health checks and debug lines.

## Existing PostgreSQL connections

If you set `DATABASE_URL` before setup, the script keeps it and skips Docker. Use a database dedicated to your app. `MIGRATION_DATABASE_URL` is optional for a separate direct connection. The local container status/log/stop commands do not operate on external databases; use `pnpm run doctor` to check their connection.

## Mock browser tests

Run one mock spec by passing its file path after `--`:

```sh
pnpm run test:e2e:mock -- e2e/mock-mode.mock.spec.ts
```

You can pass several files and Playwright options in the same command:

```sh
pnpm run test:e2e:mock -- e2e/mock-mode.mock.spec.ts e2e/legend-1j7.mock.spec.ts --reporter=line
```

With no arguments, `pnpm run test:e2e:mock` runs the entire mock suite. Add
`--list` to list the selected tests without running them.

## Verify a fresh start

```sh
pnpm test:setup
```

This integration check creates a temporary source copy with no dependencies or environment file, runs setup, stores a marker, repeats setup, recreates the database container, and confirms the marker survived. It removes only its own temporary copy and generated Docker volume. Docker and package registry access are required. The main project's environment and database are never used.
