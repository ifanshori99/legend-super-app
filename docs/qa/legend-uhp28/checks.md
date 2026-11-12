# legend-uhp28 verification

Base: `ab574d58` (`milestone/m1`). Branch: `fix/web-root-500`.
Separate local database: `legend_uhp28`; API port 4387, web port 3387.

## Reproduction and live results

| Check                                      | Before | After |
| ------------------------------------------ | ------ | ----- |
| API health                                 | 200    | 200   |
| Anonymous localhost public site            | 404    | 200   |
| Seeded verified domain public site         | 200    | 200   |
| Web root                                   | 500    | 200   |
| Missing site, with loader fix before alias | 500    | 404   |
| Unknown direct Host                        | 404    | 404   |
| Unknown forwarded Host during SSR          | 404    | 404   |

The seed already contained a published site. The local hostname had no public
tenant mapping, and public loaders propagated the expected API 404 as an SSR
error. `/api/tenant/site` is not an endpoint; the website uses `/api/public/site`
and branding uses `/api/tenant/context`. The root loader predates batch49; the
platform-tenant commit did not alter this resolver or seed.

## Tests and gates

All commands below exited 0.

```sh
LEGEND_TEST_FILES="src/test/dev-public-site-host.test.ts src/test/platform-tenant-api.test.ts src/test/public-site-api.test.ts" heavy pnpm test
# 3 files, 80 tests passed

heavy node --test tests/dev-public-site-setup.test.mjs tests/website-not-found.test.mjs tests/setup.test.mjs
# 31 tests passed

heavy pnpm --filter @starter/api typecheck
heavy pnpm --filter @starter/web typecheck
heavy pnpm build
# 2 builds passed, no cache

heavy pnpm test:setup
# Fresh setup, repeated setup, doctor and persistence passed

heavy ghostex visual check docs/qa/legend-uhp28/evidence.html --out /tmp/legend-uhp28-evidence.png
# Fits at 390px and 1280px
```

Failing-first evidence: web 8 failures/13 tests (typed API 404 was not Router
notFound), API alias 10 failures/37 initial tests (null stub), setup 6
failures/12 tests (no-op stub). Five additional hostile-header API cases were
added before the final green run.

Changed-file lint and format commands:

```sh
heavy pnpm exec eslint apps/api/src/app.ts apps/api/src/config/env.ts apps/api/src/lib/development-public-site.ts apps/api/src/test/dev-public-site-host.test.ts apps/web/src/features/ws08-website/lib/loader.ts apps/web/src/routes/_public/index.tsx apps/web/src/routes/_public/menu.tsx apps/web/src/routes/_public/reservasi.tsx apps/web/src/routes/_public/reservation.tsx scripts/dev-public-site.mjs scripts/doctor.mjs scripts/prepare.mjs tests/dev-public-site-setup.test.mjs tests/website-not-found.test.mjs

heavy pnpm exec prettier --check apps/api/src/app.ts apps/api/src/config/env.ts apps/api/src/lib/development-public-site.ts apps/api/src/test/dev-public-site-host.test.ts apps/web/src/features/ws08-website/lib/loader.ts apps/web/src/routes/_public/index.tsx apps/web/src/routes/_public/menu.tsx apps/web/src/routes/_public/reservasi.tsx apps/web/src/routes/_public/reservation.tsx scripts/dev-public-site.mjs scripts/doctor.mjs scripts/prepare.mjs tests/dev-public-site-setup.test.mjs tests/website-not-found.test.mjs docs/PROGRESS.md docs/local-development.md docs/qa/legend-uhp28/evidence.html docs/qa/legend-uhp28/checks.md
```

Actual `pnpm dev:prepare` and `pnpm run doctor` passed. Setting
`DEV_PUBLIC_SITE_HOST=missing.example.test` made doctor exit 1 with an actionable
configuration/seed message. The local dev process tree and ports 3387/4387 were
verified stopped; `pnpm db:down` stopped the worktree database and retained its
volume.

## Review and remaining scope

A fresh S reviewer approved the web diff, and a fresh access architect approved
the API/setup diff without findings. No migration, protected-branch update,
deployment, full `pnpm check`, or full e2e suite was performed by this thread.

Six live screenshots and the [visual evidence](evidence.html) are included.
Remote fixture photos did not load; separate issue `legend-vv3nc` records this
existing media problem. It does not affect HTTP 200/404 handling.
