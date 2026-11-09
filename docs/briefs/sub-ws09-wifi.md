# Sub-brief WS-09 Wi-Fi (CTO brief after 97)

Worktree: `.worktrees/ws09-wifi`, branch `ws/ws09-wifi` = `milestone/m1` + merge of `ws/ws-09-ws` (9ed513cf).
Work only in this worktree. Do not commit, push or merge (the engineer agent commits). Never pkill/killall global processes; stop only your own PIDs.

## Rules

- Heavy only for: typecheck web/api, full `pnpm test`, full lint, build, e2e. Light commands run plain: `pnpm exec prettier`, `pnpm exec eslint <file>`, `node --test tests/<file>.mjs`.
- API integration tests (targeted, NO heavy): from the worktree root, `LEGEND_TEST_FILES="src/test/a.test.ts src/test/b.test.ts" pnpm test` (DB prepared automatically). Running from `apps/api` has no DB. Never run the full `pnpm test` / `pnpm check`: the engineer runs it once at the end.
- e2e mock: `LEGEND_MOCK_PORT=5183 heavy pnpm test:e2e:mock e2e/<spec>`.
- Do not read `.env*` or secrets. Do not weaken or skip tests in `e2e/acceptance/` or baselines in `e2e/visual/`.
- Migrations (tier K): follow the existing pattern (tenant_id NOT NULL, FK, ENABLE + FORCE RLS policy, unique keys include tenant_id, outlet_id on operational tables). Generate with `pnpm db:generate`, plus a hand-written RLS SQL like `apps/api/src/db/schema/edge-node.custom.sql` / `apps/api/drizzle/0098_doit_webhook_events_rls.sql`. Never edit applied migrations.

## Work items

- W1 legend-hsk: Wi-Fi provider backend + simulator. The interface is already `WifiProvider` in `packages/shared/src/adapters/providers.ts`, with a fake in `adapters/fakes.ts`. PRD §3 F5 + F25, FAC-11 (docs/PRD.md:886, walled garden: ordering/payment reachable without Wi-Fi login), FAC-13 (`tests/facility-contract.test.mjs:602`, throttle not cut). Edge runtime: `apps/api/src/services/edge-*.ts`, schema `db/schema/edge-node.ts`. Policy: `services/wifi-policy.service.ts`, rules `packages/shared/src/facility/wifi.ts`. Web portal (mock) `apps/web/src/features/ws09-wifi/`. Plan: `docs/briefs/sub-ws09-wifi-plan.md` (architect writes it).
- W2 legend-1rmk: the peak window cannot cover 23:59–24:00. Fix in `packages/shared/src/facility/wifi.ts` (`isPeakAt` + time schema): allow `24:00` as a window end. Turn the todo at `tests/legend-ws09-wifi-rules.test.mjs:206` into a passing test.
- W3 missing tests: (a) the owner fallback of `facility_incident.raised` in `apps/api/src/worker/notification-adapters.ts` (no booth holder on the outlet → owners; none → fail closed), in `apps/api/src/test/worker-notification-adapters.test.ts`; (b) the facility list row merge after a General save (`apps/web/src/features/facility-admin/hooks.ts` `patchFacilityRow`) keeps the counts; (c) the General tab refills from the refetched row after a 412 only (`components/general-tab.tsx`). The web has no unit runner: prefer a root `tests/*.test.mjs` on a pure helper (extracting one is fine), or an e2e mock spec.
- W4 e2e facility rerun: `e2e/legend-er32*.mock.spec.ts`, `e2e/legend-emcy-wifi-policy.mock.spec.ts`, `e2e/legend-zx8k.mock.spec.ts`.
- W5 (Codex brief 105, P2): an idempotency key K used on outlet A, then on outlet B, gives 500 from the unique (tenant_id, key). Align the lookup, the advisory lock and the unique scope, or map the cross-outlet reuse to 409 CONFLICT without a migration. Files: `apps/api/src/services/facility-config-guard.ts:101` and `apps/api/src/services/facility-incidents.service.ts:263` (check the shared helper `createOnce`/`readIdempotentResult` too). Add regression tests with two outlets in `facility-config-api.test.ts` and `facility-incidents-api.test.ts`.
