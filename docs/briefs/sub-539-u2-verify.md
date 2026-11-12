# sub-539-u2 final verify (test-runner)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-extra`, run from there. Do not edit files. All heavy work through `heavy`. Exit 73 or 75 (lock wait): wait 120s and retry, max 4 per step. Report failures only (shortest decisive line) + counts per step.

1. `heavy pnpm --filter @starter/web typecheck` — list `error TS` lines (≤250 chars). Stop if errors.
2. `LEGEND_TEST_FILES="tests/ws04-pos-extra-logic.test.mjs tests/ws04-pos-kasir-mock-engine.test.mjs tests/pos-customer-display.test.mjs" heavy pnpm test`
3. eslint + `npx prettier --check` on `git diff --name-only origin/milestone/m1...HEAD` + `git diff --name-only` files matching `.ts/.tsx/.mjs` (exclude routeTree.gen.ts); use the root lint config.
4. `UI_CHECK_URL=http://localhost:3243 heavy node scripts/ui-check-pos-u2.mjs` (mock dev server already up). Report totals and each failed state with error. First delete old `design/screenshots/pos-u2/*.error.png`.
5. Mock e2e `e2e/legend-azt.mock.spec.ts` and `e2e/legend-mxl.mock.spec.ts`: find the right command in package.json (mock Playwright config) and run through `heavy`; report failures.
