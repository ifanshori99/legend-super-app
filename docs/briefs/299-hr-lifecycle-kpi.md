# Brief 299: WS-10 lifecycle + KPI backend (legend-ovxw)

Worktree: `.worktrees/hr-lifecycle-kpi`, branch `ws/hr-lifecycle-kpi` (base `ws/hr-scheduling` 88cc626e).
PRD: `docs/PRD.md` F24 onboarding/offboarding (:113, :902-903, flow M :1230), F29 KPI (:118, :946), tables :1990/:2000.
Tier K (access revocation, money summary). No UI, no payroll engine (`legend-j2l2`), no attendance (`legend-wh71`).

## Fixed facts

- Migration: ONE file `apps/api/drizzle/0206_hris_lifecycle_kpi.sql`, journal `when` 1794285000000, prevId = id of `drizzle/meta/0199_snapshot.json`.
- RLS: custom SQL file next to schema, `SELECT app.enforce_tenant_rls('public.<t>'::regclass);` per table (see `db/schema/hris-sop.custom.sql`), plus outlet RLS only on tables with NOT NULL outlet_id. Tests `migration-force-rls-guard`, `migration-fk-force-rls` must pass.
- Every table: `tenant_id` NOT NULL, uniques include tenant_id.
- Services: `withTenant(db, context, tx => …)`, `loadHrisAccess(tx, context, actorUserId, now)` (`services/hris-access.ts`), `access.viewerFor(row)` null → 404, outlet scope via `isOutletInScope`. Audit: `recordAudit(tx, context, hrisAuditEntry(...), HRIS_AUDIT_SAFE_FIELDS)` (example `hris-employee.service.ts:396`).
- Routes: `defineEndpoint` in `packages/shared/src/hris/endpoints.ts`; routers mounted under `/hris` in `routes/index.ts:276-287`; permission sets in `hris.routes.ts:142-148`. Permission keys: `hr.employee.manage`, `hr.employee.view`, `hr.kpi.manage`, `self.profile.view`, `payroll.view`.
- Existing contracts (reuse, extend, do not fork): `packages/shared/src/hris/checklists.ts` (template, task, status machine `transitionChecklistTask`, `isChecklistComplete`), `packages/shared/src/hris/performance.ts:52-136` (kpiDefinition, kpiScore, kpiReview), endpoints `listChecklistTasks` (:225), `listKpiReviews` (:738).
- Employee: `db/schema/hris.ts:171` `employees` (`userId` nullable :177, `homeOutletId`, `joinDate`, `endDate`, `status` onboarding|active|suspended|resigned|terminated).
- Revocation services (reuse, do not rewrite):
  - Sessions: `identity-session.service.ts:258 revokeOwnSession({userId, sessionId})` (global db, idempotent; only own). No bulk revoke exists.
  - Devices: `device.service.ts:416 revokeDevice(context, actorUserId, {deviceId, reason})` idempotent, own withTenant.
  - PIN: `staff_pins` (`db/schema/device-pin.ts`), `device-pin.service.ts` only `setStaffPin`; `attemptStaffPin` (:378) rejects non-members via `isOutletMember` + `user.banned`.
  - Role assignments: `access.service.ts:929 endRoleAssignment` (not idempotent for ended rows; last-owner rule; emits event).
  - Login: `user.banned` global; tenant surfaces call `hasActiveAssignment` (`identity-access.service.ts:40`).
  - Shifts: `hris-scheduling-roster.service.ts:740 cancelShiftAssignment(context, actorUserId, assignmentId, now)` one at a time.
- KPI source: `metrics_daily` (`db/schema/metrics.ts`, migration 0176), employee split via `dimension_key='employee'` (`metric-sources/sales.ts:544` void_amount, `metric-sources/payments-tax.ts:213` cash_variance). Engine `evaluateMetrics` (`metrics-query.service.ts`) is the only path from codes to values (DECISIONS 2026-11-10 §2).
- Settlement data: `employeeLoans` (`db/schema/payroll.ts:758`, outstandingIdr/status), `reimbursements` (:899), `payrollRuns` (:412), `leaveBalances` (`hris-leave.ts:88`). FE helpers it mirrors: `apps/web/src/features/ws10-lifecycle/lib.ts:371-440`.
- PDF pattern exists: `services/purchasing-po-pdf.ts` (pdf-lib), test helper `src/test/pdf-text.ts`.

## Slices (filled after architect design: see DECISIONS entry "WS-10 lifecycle")

1. Checklist templates + tasks + actions (implementer A).
2. Offboarding + exit clearance (engineer).
3. KPI definitions, system actuals, review cycle (implementer B).
4. Final settlement summary (engineer).
5. Work certificate render data + PDF (implementer C).

---

# Design (final). Source of truth: docs/DECISIONS.md "2026-11-10: WS-10 lifecycle" + this section.

## Tables (`apps/api/src/db/schema/hris-lifecycle.ts`, owner: engineer)

All: `tenant_id NOT NULL`, `unique(tenant_id,id)`, composite FKs `(tenant_id, x_id)`, tenant RLS forced (`hris-lifecycle.custom.sql`). Timestamps timestamptz. Drizzle exports in brackets.

- `hris_checklist_templates` [hrisChecklistTemplates]: id, kind (onboarding|offboarding), position_id NULL, title varchar150, items jsonb, version int default 1, is_active bool default true, created_by text, created_at, updated_at. Partial uniques on active: (tenant,kind,position_id) pos not null; (tenant,kind) pos null.
- `hris_checklist_tasks` [hrisChecklistTasks]: id, employee_id, offboarding_id NULL, template_id NULL, kind, code varchar40, title varchar200, category varchar20 CHECK, requires_document bool, document_id NULL (FK employee_documents), sort_order int, status varchar10 default 'open' CHECK, system_managed bool default false, due_at, done_by text, done_at, block_reason varchar500, waive_reason varchar500, created_at, updated_at. CHECKs: done_by/done_at both null or both set; done ⇔ done_at; blocked ⇒ block_reason; waived ⇒ waive_reason; (kind='offboarding') = (offboarding_id not null). Uniques: (tenant,employee_id,code) where kind='onboarding'; (tenant,offboarding_id,code) where offboarding_id not null.
- `hris_checklist_task_actions` [hrisChecklistTaskActions] append-only: id, task_id, action CHECK (complete|block|unblock|waive), from_status, to_status, reason varchar500, document_id NULL, actor_user_id text NOT NULL, idempotency_key varchar100 NULL, created_at. CHECK action in(block,waive) ⇒ reason not null. Unique (tenant,task_id,idempotency_key). REVOKE UPDATE, DELETE FROM legend_app.
- `hris_offboardings` [hrisOffboardings]: id, employee_id, exit_type (resignation|termination|contract_end), reason varchar1000 NOT NULL, notice_date date NULL, last_working_date date NOT NULL, status (open|revoked|completed|cancelled) default open, access_revoked_at, access_revoked_by, revocation_result jsonb, settlement_snapshot jsonb, completed_at, completed_by, cancelled_at, cancelled_by, cancel_reason varchar500, certificate_no varchar40, certificate_issued_at, created_by, created_at, updated_at. Unique (tenant,employee_id) where status<>'cancelled'; unique (tenant,certificate_no) where not null. CHECKs: revoked/completed ⇒ access_revoked_at; completed ⇒ completed_at and settlement_snapshot; cancelled ⇒ access_revoked_at null and cancel_reason.
- `hris_kpi_definitions` [hrisKpiDefinitions]: id, position_id NULL, name varchar150, source (system|manager), metric_code varchar60 NULL, target numeric(18,4) NULL >=0, unit varchar20, direction (higher_is_better|lower_is_better), is_active, created_by, created_at, updated_at. CHECK (source='system') = (metric_code not null). Active name unique per position (two partial indexes).
- `hris_kpi_reviews` [hrisKpiReviews]: id, employee_id, cycle (monthly|quarterly), period_start, period_end, status (draft|submitted), reviewer_user_id text NULL, submitted_at, overall_score numeric(5,2) NULL, note varchar2000, created_by, created_at, updated_at. Unique (tenant,employee_id,cycle,period_start). CHECKs: period_end>=period_start; submitted ⇔ (submitted_at and reviewer_user_id not null).
- `hris_kpi_scores` [hrisKpiScores]: id, review_id, kpi_definition_id, definition_snapshot jsonb NOT NULL, system_actual numeric(18,4) NULL, system_availability varchar30 NULL, system_computed_at, actual numeric(18,4) NULL, actual_source (system|manual) NULL, score smallint NULL 0..100, comment varchar1000. Unique (tenant,review_id,kpi_definition_id).

## Shared contract (owner: implementer S) `packages/shared/src/hris/`

- `ids.ts`: add `offboardingIdSchema`, `checklistTaskActionIdSchema` (follow existing id style).
- `checklists.ts`: `checklistTaskSchema` gains `offboardingId` (nullable), `requiresDocument`, `documentId` (nullable), `systemManaged`, `blockReason` (nullable), `waiveReason` (nullable), `sortOrder`; refine: blocked ⇒ blockReason, waived ⇒ waiveReason. Add `checklistActionSchema` enum, `checklistTaskActionSchema` (id, tenantId, taskId, action, fromStatus, toStatus, reason, documentId, actorUserId, createdAt), inputs `createChecklistTemplateInputSchema`, `updateChecklistTemplateInputSchema`, `checklistTaskActionInputSchema` (strict: action, reason? 1..500 required for block/waive, documentId?), all built on `clientInputSchema`-style strict objects like other hris inputs.
- `lifecycle.ts` (new): `exitTypeSchema` (resignation|termination|contract_end), `offboardingStatusSchema`, `offboardingSchema` (id, tenantId, employeeId, exitType, reason, noticeDate, lastWorkingDate, status, accessRevokedAt, accessRevokedBy, revocationResult nullable {roleAssignmentIds: string[], sessionsRevoked: int, pushSubscriptionsRemoved: int, cancelledShiftIds: string[], employeeStatus}, completedAt, completedBy, cancelledAt, cancelReason, certificateNo, createdAt), inputs `createOffboardingInputSchema` {exitType, reason 1..1000, noticeDate?, lastWorkingDate}, `updateOffboardingInputSchema`, `cancelOffboardingInputSchema` {reason}. `finalSettlementSummarySchema`: {offboardingId, employeeId, exitType, joinDate, lastWorkingDate, runningSalary: {lastPayrollRun: {id, periodStart, periodEnd, status} | null, unpaidFrom: date|null, unpaidTo: date, unpaidCalendarDays: int}, outstandingLoans {count, amountIdr, loanIds}, unpaidReimbursements {count, amountIdr, pendingCount}, leave: [{leaveTypeId, name, periodYear, entitledDays, carriedOverDays, usedDays, pendingDays, remainingDays}], pendingPayrollEngine: ("prorated_salary"|"thr"|"bpjs"|"leave_cash_out"|"net_payout")[], computedAt, frozen: boolean}. Day counts are decimal strings if leave uses decimals (match `hris-leave` contract). `workCertificateSchema`: {offboardingId, certificateNo, issuedAt, company {name}, employee {id, fullName, employeeNo}, positionName, outletName, joinDate, lastWorkingDate, exitType, managerName|null}. Move pure `outstandingLoans` and `unpaidReimbursements` helpers here from `apps/web/src/features/ws10-lifecycle/lib.ts:418-445` (do NOT edit web; FE switches later). No THR/BPJS helpers.
- `performance.ts`: `kpiDefinitionSchema` gains `metricCode` (nullable; refine set iff source system). `kpiScoreSchema`: `actual` signed decimal nullable, `score` nullable, add `systemActual` nullable, `systemAvailability` nullable string, `actualSource` nullable, `comment` nullable. `kpiReviewSchema`: add `note`, `overallScore` nullable; submitted refine also requires reviewerId and every score non-null. Inputs: `createKpiDefinitionInputSchema`, `updateKpiDefinitionInputSchema`, `createKpiReviewInputSchema` {employeeId, cycle, periodStart}, `updateKpiScoresInputSchema` {scores: [{kpiDefinitionId, actual?, score?, comment?}], note?}.
- `endpoints.ts`: add `defineEndpoint` for every route below and register in the exported map like existing ones. Contract root test must pass.

## Endpoints (paths under `/api/hris`; M=`hr.employee.manage`, K=`hr.kpi.manage`, P=`payroll.view`, READ/READ_OR_SELF as in hris.routes.ts)

Checklist (implementer A): `GET/POST checklist-templates` (M; write needs tenant-wide reach), `PATCH checklist-templates/:templateId` (M), `POST employees/:employeeId/onboarding` (M; picks active template for employee position else default; repeat returns existing tasks), `GET employees/:employeeId/checklist-tasks` (exists; READ_OR_SELF), `POST checklist-tasks/:taskId/actions` (block/unblock/waive: M; complete: M, or self on own onboarding task with category documents|training; system_managed refuses manual complete 409 `TASK_SYSTEM_MANAGED`; requires_document refuses complete without documentId of same employee 422), `GET checklist-tasks/:taskId/actions` (READ).
Offboarding (engineer): `POST employees/:employeeId/offboarding`, `GET/PATCH offboardings/:offboardingId`, `POST offboardings/:offboardingId/cancel|revoke-access|complete` (M), `GET offboardings/:offboardingId/settlement` (M or P).
Work certificate (implementer C): `GET offboardings/:offboardingId/work-certificate` and `.../work-certificate.pdf` (M once status revoked|completed; self only when completed). First call assigns `certificate_no` = `SK/<YYYY>/<seq 4 digits per tenant per year>` under advisory lock, stamps `certificate_issued_at`; repeats return the same.
KPI (implementer B): `GET kpi-definitions` (K or READ), `POST/PATCH kpi-definitions[/:id]` (K, tenant-wide reach; system code must be in metric catalog with `employee` dimension and same unit), `GET kpi-reviews` (exists; K or READ; self sees own submitted only), `POST kpi-reviews` (K; full calendar month/quarter only; creates score rows for active defs of employee position + position-null defs; computes system actuals), `PATCH kpi-reviews/:reviewId/scores`, `POST kpi-reviews/:reviewId/refresh-actuals`, `POST kpi-reviews/:reviewId/submit` (K; reviewer ≠ subject's user; draft only; submit freezes).
All services: `withTenant` + `loadHrisAccess`, 404 when `viewerFor` null, outlet scope by employee home outlet, audit via `hrisAuditEntry`. Strict zod at routes.

## File ownership (no overlaps)

- engineer: `db/schema/hris-lifecycle.ts`, `db/schema/hris-lifecycle.custom.sql`, `db/schema/index.ts`, `drizzle/0206_*`, `drizzle/meta/*`, `routes/index.ts`, `services/hris-offboarding.service.ts`, `services/hris-settlement.service.ts`, `routes/hris-offboarding.routes.ts`, `services/access.service.ts` (append only), `services/hris-scheduling-roster.service.ts` (split cancel into InTx only), `src/test/hris-offboarding-*.test.ts`.
- S: `packages/shared/src/hris/{ids,checklists,lifecycle,performance,endpoints,index}.ts`.
- A: `services/hris-checklist.service.ts`, `routes/hris-checklist.routes.ts`, `src/test/hris-checklist-api.test.ts`.
- B: `services/hris-kpi.service.ts`, `routes/hris-kpi.routes.ts`, `src/test/hris-kpi-api.test.ts`.
- C: `services/hris-work-certificate.service.ts`, `services/hris-work-certificate-pdf.ts`, `routes/hris-work-certificate.routes.ts`, `src/test/hris-work-certificate-api.test.ts`.
- test-writer: `src/test/hris-offboarding-clearance.test.ts` (fail-first, against the endpoints above).
  Each router exports a `Router` named `hris<Slice>Router`; engineer mounts it under `/hris` in `routes/index.ts`. Do not edit another slice's files. Need a change elsewhere: stop and report.

## Tests (pattern: `src/test/hris-scheduling-roster-api.test.ts` + `tenant-isolation-harness.ts`)

Run: `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/<file>" pnpm test'`. Never full `pnpm test`/`pnpm check`. Each slice proves: cross-tenant isolation (tenant B cannot read/act), outlet scope (manager of other outlet gets 404), permission (role without key gets 403/404), plus slice specifics:

- A: waive without reason 422 and the action row records reason+actor; block needs reason; done/waived terminal (409); self-complete only own onboarding documents/training.
- B: system actual equals `evaluateMetrics` result for the same code/period/user (seed `metrics_daily` rows with dimension employee=userId; compare); submit freezes (refresh after submit 409); reviewer = subject refused.
- C: certificate number stable across calls; employee self only after completed; PDF text contains name and dates (`src/test/pdf-text.ts`).
- clearance: revoke twice → second returns same result, no extra audit/event rows; sessions revoked (old session cookie gets 401 on a tenant route); PIN login answers not_member; shifts after last day cancelled, before kept; Owner refused 409; before last working date 409 `EXIT_NOT_DUE`; other tenant's session of same user untouched.
