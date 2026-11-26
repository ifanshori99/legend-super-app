# D5 WS-11 INT (legend-x73li): progress

Branch `ws/1272-d5`, state 27 Nov 2026.

## Done

- Audit: report viewer, catalog, builder (saved, schedules, recipients), owner, shareholder and management dashboards already call the real API through `callEndpoint`; mock answers only in mock mode.
- Export button is no longer hidden in a real build (`reportExportOffered` removed; the export API exists since D4).
- Download links now use `publicApiUrl(downloadPath)`. A relative path pointed at the web origin, so a cloud build (web and API on different origins) would 404.
- Viewer lists `availability.note` caveats once each (`resultNotes` in `ws11-reports/lib.ts`, shown under the summary strip).
- API test: a second tenant in `ms-finance.test.ts` (own figures, own split, own note, first tenant unchanged). This guards existing behavior, so it passed on first run.
- Tests: `tests/ws11-reports-not-ready.test.mjs` (fail-first proven), `ms-finance` 14/14. Web and API typecheck, prettier, eslint, text contract pass.

## Not done / not verified

- Families finance, attendance, payroll, performance stay "Segera hadir" (`FAMILIES_HELD_BACK`, founder decision 21 Nov no. 17). Opening finance needs founder approval.
- No browser e2e against a real API run (heavy browser lane not used). Dashboard = report parity not re-proved here.
- Full `pnpm check` not run (final gate).
