# D4 WS-11 F12 (saved, schedules, exports): handoff

Bead legend-ay6e6, branch `ws/1272-d4`. State on 27 Nov 2026.

## Done (pushed)

- Migration `0540_report_delivery` (after int/rc2 0539_edc_settlement_csv): `saved_reports`, `report_schedules`, `report_exports` (tenant RLS, inline FKs, file kept in `file_content` bytea, `viewer` column). `pnpm db:generate` is empty.
- Saved reports: GET/POST/PATCH `/api/reports/saved`, owner only (`report-saved.service.ts`).
- Exports: GET/POST `/api/reports/exports`, GET `/:id`, GET `/:id/file` (`report-exports.service.ts`, `report-export-files.ts`).
  - CSV, XLSX and PDF. CSV is formula-safe: cells starting `= + - @ \t \r` get a leading `'`.
  - Personal data opens a WS-01 approval (`personal_data_export`).
  - Files expire after 7 days (410).
  - Every download is audited.
- Schedules: GET/POST/PATCH `/api/reports/schedules` (`report-schedules.service.ts`).
  - `runDueReportSchedules` creates one export job per recipient under that recipient's own access, once per slot.
  - The period rolls to end the day before the run.
  - `sweepReportExports` generates the files.
  - Worker wiring in `worker-main.ts`, cloud only.
  - Notification `report_export.delivered` uses category `report_delivery` (in-app, email by default). It names the report and period, never figures.
- Tests: `reports-saved` (13), `reports-exports` (22), `reports-schedules` (10). 45/45 pass. Fail-first was proven for each part. api and web typecheck pass, as do prettier, eslint and the text contract.

## Decisions

- No WhatsApp in v1 (legend-hyq not done). Delivery is a file, an in-app notification, and email when that channel exists.
- Personal data and money figures only go to people who hold that report's permission.
  - Recipients are checked at save time and again at every run. A recipient who lost permission is skipped and gets no job.
  - A schedule that would contain personal data is refused (403, `EXPORT_PII_APPROVAL_REQUIRED`).
- Another user's, tenant's or outlet's resource answers 404.
- A file rendered with the `full` viewer cannot be downloaded by someone who now only has the aggregate view (404).
- Recipients need `export.data.run` (contract `reportScheduleGate`).

## Remaining

- Full gate (`pnpm check`) not run.
- Architect review (tier K: personal data and access).
- `report_export.delivered` is not yet in the domain event catalog (if there is a catalog test, add it there).
- Layering: services import `resolveViewerFor` from `routes/report-viewer.ts`. Consider moving it to `services/`.
- Files live in Postgres bytea. Move them to object storage if they grow.
- FE screens: legend-x73li.
- Close legend-rmvu, legend-mqds and legend-atcu once the review passes.

## Review K fixes (27 Nov, docs/qa/1272-d4-review.md)

- P1: merged origin/int/rc2; migration is `0540_report_delivery` (regenerated, journal `when` after 0539, `db:generate` empty; the RLS block is re-appended by hand from `report-delivery.custom.sql`).
- P2: `generating` jobs older than 15 min go back to `queued` (new column `attempts`, max 3), then `failed` (`REPORT_QUERY_INVALID`, no dedicated "timed out" code yet).
- P3: generate refuses unless the gate says `queue`; owner reads select metadata columns only (file bytes read at download after the checks); no schedule on an archived saved report; a schedule whose owner is blocked or has no active role is paused and tenant admins (`org.settings.manage`) get notification `report_schedule.paused`.
- Delivery is at most once per slot: the slot advances before jobs are made, a failed slot is skipped and not backfilled (comment on `runDueReportSchedules`).
