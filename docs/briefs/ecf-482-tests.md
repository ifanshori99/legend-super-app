# ecf-482 tests: names and signatures used

Test files sit next to the source. Run each with
`LEGEND_TEST_FILES=<path relative to apps/api> heavy pnpm test`.

## Card 1, legend-10nex: `apps/api/src/edge/catalog-freshness.test.ts`

New module `apps/api/src/edge/catalog-freshness.ts` (guessed names):

- `CRITICAL_CATALOG_STREAMS: readonly string[]` (price and product status
  streams, at least 2). `"stations"` is assumed non-critical.
- `createCatalogFreshness({ now: () => Date, timeZone?: string, staleAlarmAfterMs?: number, onOwnerAlarm?: (e: { stream, reason, lastSuccessAt }) => void })`
  - `.recordSuccess(stream)`
  - `.recordFailure(stream, { reason: string, cloudReachable: boolean })`
  - `.snapshot()` returns `{ streams: Record<stream, { lastSuccessAt: Date | null, ageMs: number | null, failureReason: string | null }>, stale, ownerAlarm, cashierWarning: string | null, salesBlocked }`
- Cashier text: `katalog belum diperbarui sejak HH:MM` (HH:MM in `timeZone`, test uses Asia/Jakarta).
- Founder decision applied: stale always keeps selling. `salesBlocked` is always
  false, there is no `sellPolicy` option or per-tenant setting.
- Owner alarm: stale for strictly more than 30 minutes AND `cloudReachable: true`;
  `onOwnerAlarm` fires once per stale episode. Pure offline (`cloudReachable: false`)
  never alarms, but the cashier warning still shows.
- Recovery needs every critical stream to succeed again.
- Not covered: wiring into `master-sync.ts` (no existing public seam known).

## Card 2, legend-2dlxq: `apps/api/src/edge/catalog-puller.test.ts`

Names chosen by the implementer: `CATALOG_PROTOCOL_VERSION` (2),
`CATALOG_PROTOCOL_MIN_VERSION` (2) in `@starter/shared/edge`; top-level page field
`protocolVersion`; errors `CATALOG_CLOUD_OUTDATED` (cloud too old or field missing)
and `CATALOG_EDGE_OUTDATED` (cloud newer than the edge). Covers: cloud page and
empty cloud page carry the version (`listCatalogRecordsSince`); old, missing and
newer versions are refused (also on empty pages), nothing stored, checkpoint
unchanged; controls accepted.
Older tests updated because pages now need `protocolVersion`:
`test/helpers/catalog-cloud.ts` (used by `edge-catalog-sync.test.ts`),
`edge-catalog-rewind.test.ts`, `edge-catalog-followups.test.ts`,
`edge-catalog-loop.test.ts`.

## Card 3, legend-sdqni: `apps/api/src/db/provision-roles-audit.test.ts`

Uses existing `provisionRoles` and `auditRoles` from `db/provision-roles.ts`
(same scratch-database setup as `test/provision-roles-idle-timeout.test.ts`).
`auditRoles` must reject, with a message naming
`idle_in_transaction_session_timeout`, when the app or queue login has no timeout
(reset one, reset both, other settings present but no timeout). Control: a freshly
provisioned set passes.
