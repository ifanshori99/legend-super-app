# Sub-brief: checklist engine gaps (legend-5v69, PRD v1.7 §3 F45 / OPS-01)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/checklist-engine` (cd there; `apps/api` = API).
Do NOT commit. Do NOT touch files outside your section. Do NOT read `.env*`. Follow `AGENTS.md`.

## Already exists (do not rebuild)

- Templates (versioned, `version` bumps on item edit), runs with item snapshot (`snapshotChecklistTemplate`), record result (`CHECKLIST_ITEM_NOT_IN_RUN` 404), transitions, failed alert (`checklist.failed`), missed sweep (`sweepMissedChecklistRuns`, `src/services/operations-escalation.service.ts`) run every minute by the worker relay in `src/worker-main.ts:~205`. Supervisor recipients: `src/worker/notification-adapters.ts:480`.
- Services: `src/services/operations-checklist.service.ts`. Tests pattern: `src/test/operations-checklist.test.ts`, `src/test/operations-escalation.test.ts` (fixed `NOW`, direct sweep calls with `withTenant`/`asTenant`).
- Helpers: `zonedInstant` (`src/services/facility-rules.ts:56`), `minutesOfDay` (`src/services/menu-availability.ts:58`), `localDate(instant, tz)` (`src/services/reservation-plan.ts:55`). Outlet tz: `outlets.timezone`.
- NEW (done by lead): column `ops_checklist_runs.scheduled boolean NOT NULL DEFAULT false` (drizzle `opsChecklistRuns.scheduled`) + partial unique index `ops_checklist_runs_scheduled_key (tenant_id, template_id, shift_date) WHERE scheduled`, migration `drizzle/0063_public_amazoness.sql`. Table already has RLS FORCE (tenant+outlet).

## Section B — scheduler (implementer)

File: NEW `apps/api/src/services/operations-checklist-scheduler.service.ts`, plus one try/catch block in `apps/api/src/worker-main.ts` placed right BEFORE the missed-run sweep block (same style, `withTenant(db, context, (tx) => generateScheduledChecklistRuns(tx, context))`, `console.error("Checklist run generation failed")`).
Export `generateScheduledChecklistRuns(tx: OperationsTx, context: ScopedTenantContext, now: Date = new Date()): Promise<number>` (returns runs inserted). Rules:

1. `assertTrustedScopedContext(context)`. Select templates of the tenant with `roleId IS NOT NULL`, joined to outlets for `timezone`; explicit outlet filter when `context.outletScope.kind === "outlets"` (like the sweep). Templates without `roleId` are never auto-generated (manual runs only).
2. Per template: `shiftDate = localDate(now, tz)`; `dueAt = zonedInstant(shiftDate, minutesOfDay(schedule.dueTime), tz)`. Skip when `dueAt <= now` (never create a run that is born missed → no spurious alert).
3. Assignee: one user with an ACTIVE role assignment for `template.roleId` (`validFrom <= now`, `validUntil` null or > now), scope tenant OR outlet = template outlet. Deterministic order: outlet-scoped first, then `validFrom` asc, then `userId` asc. None → skip.
4. Insert run: snapshot via `snapshotChecklistTemplate(toContractTemplate)` (build a ChecklistTemplate from the row, or replicate fields: templateId, templateVersion=row.version, items), `shiftTemplateId = schedule.shiftTemplateId ?? null`, `status "pending"`, `results []`, `scheduled: true`, `createdAt/updatedAt = now`. Use `.onConflictDoNothing({ target: [tenantId, templateId, shiftDate], where: sql\`${opsChecklistRuns.scheduled}\` })` so a rerun / overlapping tick inserts nothing twice. Count only rows returned.
5. Cap at 500 templates per tick (ordered by id). Header comment explaining F45/OPS-01 like the escalation service.
   Verify: `pnpm --filter @starter/api exec tsc --noEmit -p .` (or repo typecheck) passes for your files.

## Section C — manual run assignment rules (implementer)

File: `apps/api/src/services/operations-checklist.service.ts` only, function `createChecklistRun` + `assertAssigneeInOutlet`.

1. `shiftTemplateId`: default to `template.schedule.shiftTemplateId` when input omits it (`input.shiftTemplateId ?? template.schedule.shiftTemplateId ?? null`). When both set and differ → `HttpError(422, "VALIDATION_ERROR", "Shift tidak sesuai jadwal template")`.
2. Role: when `template.roleId` is set, the assignee's active assignment (same validity + tenant/outlet scope rules as today) must be FOR that role (`roleAssignments.roleId = template.roleId`) → else `HttpError(422, "VALIDATION_ERROR", "Penanggung jawab tidak memegang peran checklist ini")`. Implement by giving `assertAssigneeInOutlet` an optional `roleId` param; keep existing message when no role.
   Verify typecheck. Do not touch tests.

## Section D — acceptance tests (test-writer)

File: NEW `apps/api/src/test/operations-checklist-engine.test.ts` only. Reuse the fixture style of `operations-checklist.test.ts` / `operations-escalation.test.ts` (copy local helpers; seeded `cafeLegendPlatformFixtures`, `asTenant`, `STARTER_TEST_DATABASE_URL`). Tag titles `[legend-5v69][OPS-01]`. Fixed clock, no real waits. Cover:

1. Template versioned: item edit bumps version; a run created before the edit keeps `templateVersion` 1 and its old items after the edit (GET run re-read).
2. Recording an item id not in `run.items` (e.g. item added to the template after the run) → 404 `CHECKLIST_ITEM_NOT_IN_RUN`.
3. Assignment (section C): template with `roleId` → assignee without that role 422; with the role OK; run `shiftTemplateId` defaults from template schedule; mismatching shiftTemplateId 422.
4. Scheduler (section B, call `generateScheduledChecklistRuns(tx, context, NOW)` inside a tenant tx): creates one run per role template for the outlet-local date with dueAt in outlet tz, assignee = role holder, `scheduled = true`; second call returns 0 (idempotent); template whose dueTime already passed → no run; template without roleId → no run; another tenant's templates untouched.
5. Alert ≤15 min with faked time: generated run, sweep at `dueAt + 1 min` marks missed and queues exactly one `checklist.missed` outbox row (destination notification) with `detectedAt <= checklistAlertDeadline(dueAt)`; second sweep queues nothing. Failed run emits exactly one `checklist.failed` even if the transition request is replayed.
6. Isolation: outlet B scope cannot see/generate outlet A runs; tenant B context generates nothing for tenant A.
   Run: `cd apps/api && pnpm vitest run src/test/operations-checklist-engine.test.ts` needs Postgres; if no `STARTER_TEST_DATABASE_URL`, use repo `node scripts/test.mjs unit -- src/test/operations-checklist-engine.test.ts` style from root (check `scripts/test.mjs` for arg passing). Sections B/C are being written in parallel — code against the signatures above; report failures that are caused by B/C rather than weakening asserts.
