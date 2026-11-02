// Mock mode for the report builder (`VITE_API_MOCK=true`): preview, saved
// reports and email schedules (docs/frontend.md "Typed endpoints and mock
// mode"). Save and schedule are stateful in the mock store, so a report saved
// here shows in the list and its schedule can be paused; a reset re-seeds from
// the shared fixtures. Handlers answer like the service: a schedule for a
// personal-data report is refused with EXPORT_PII_APPROVAL_REQUIRED (DASH-04),
// an unknown saved report with SAVED_REPORT_NOT_FOUND.
//
// `?mock=empty` returns empty lists and previews without rows;
// `?mock=slow|error|offline` are handled by the runtime.
//
// Loaded in Node by tests/ws11-report-builder.test.mjs: bare package imports
// and relative `.ts` paths only, no `@/` alias.
import {
  createReportScheduleEndpoint,
  createSavedReportEndpoint,
  listReportSchedulesEndpoint,
  listSavedReportsEndpoint,
  previewReportBuilderEndpoint,
  reportScheduleFixture,
  savedReportFixture,
  updateReportScheduleEndpoint,
  updateSavedReportEndpoint,
  type ReportSchedule,
  type SavedReport,
} from "@starter/shared/dashboard";
import { ApiError } from "../../lib/api/errors.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { queryHasPersonalData } from "./builder.ts";
import { buildPreviewResult } from "./mock-preview.ts";

const savedStore = createMockStore<SavedReport[]>(() => [savedReportFixture]);
const scheduleStore = createMockStore<ReportSchedule[]>(() => [
  reportScheduleFixture,
]);

/** Newest first, like the list endpoints order their rows. */
function newestFirst<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Mock-only: next delivery, one period after now at the given local time. */
function nextRunAt(
  settings: { frequency: string; timeOfDay: string },
  now: Date,
): string {
  const [hours = 0, minutes = 0] = settings.timeOfDay.split(":").map(Number);
  const next = new Date(now);
  next.setUTCHours(hours, minutes, 0, 0);
  next.setUTCDate(
    next.getUTCDate() +
      (settings.frequency === "monthly"
        ? 30
        : settings.frequency === "weekly"
          ? 7
          : 1),
  );
  return next.toISOString();
}

registerMock(previewReportBuilderEndpoint, ({ body, scenario }) => ({
  data: buildPreviewResult(body, { empty: scenario === "empty" }),
}));

registerMock(listSavedReportsEndpoint, ({ query, scenario }) =>
  paginateFixture(
    newestFirst(savedStore.get()),
    query,
    (item) => item.id,
    scenario,
  ),
);

registerMock(createSavedReportEndpoint, ({ body }) => {
  const now = new Date().toISOString();
  const report: SavedReport = {
    id: crypto.randomUUID() as SavedReport["id"],
    tenantId: savedReportFixture.tenantId,
    name: body.name,
    description: body.description ?? null,
    query: body.query,
    ownerUserId: savedReportFixture.ownerUserId,
    status: "active",
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
  };
  savedStore.set([...savedStore.get(), report]);
  return { data: report };
});

registerMock(updateSavedReportEndpoint, ({ params, body }) => {
  const current = savedStore
    .get()
    .find((report) => report.id === params.savedReportId);
  if (current === undefined)
    throw new ApiError(
      404,
      "SAVED_REPORT_NOT_FOUND",
      "Laporan tersimpan tidak ditemukan.",
    );
  const next: SavedReport = {
    ...current,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.description !== undefined
      ? { description: body.description }
      : {}),
    ...(body.query !== undefined ? { query: body.query } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
    updatedAt: new Date().toISOString(),
  };
  savedStore.set(
    savedStore.get().map((report) => (report.id === next.id ? next : report)),
  );
  return { data: next };
});

registerMock(listReportSchedulesEndpoint, ({ query, scenario }) =>
  paginateFixture(
    newestFirst(scheduleStore.get()),
    query,
    (item) => item.id,
    scenario,
  ),
);

registerMock(createReportScheduleEndpoint, ({ body }) => {
  const report = savedStore
    .get()
    .find((item) => item.id === body.savedReportId);
  if (report === undefined)
    throw new ApiError(
      404,
      "SAVED_REPORT_NOT_FOUND",
      "Laporan tersimpan tidak ditemukan.",
    );
  // DASH-04: personal data never leaves by email without an approved request.
  if (queryHasPersonalData(report.query))
    throw new ApiError(
      403,
      "EXPORT_PII_APPROVAL_REQUIRED",
      "Ekspor data pribadi memerlukan approval.",
    );
  const now = new Date();
  const schedule: ReportSchedule = {
    id: crypto.randomUUID() as ReportSchedule["id"],
    tenantId: report.tenantId,
    savedReportId: report.id,
    frequency: body.frequency,
    timeOfDay: body.timeOfDay,
    dayOfWeek: body.dayOfWeek,
    dayOfMonth: body.dayOfMonth,
    format: body.format,
    recipients: body.recipients,
    isEnabled: true,
    nextRunAt: nextRunAt(body, now),
    lastRunAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  scheduleStore.set([...scheduleStore.get(), schedule]);
  return { data: schedule };
});

registerMock(updateReportScheduleEndpoint, ({ params, body }) => {
  const current = scheduleStore
    .get()
    .find((schedule) => schedule.id === params.reportScheduleId);
  if (current === undefined)
    throw new ApiError(
      404,
      "SAVED_REPORT_NOT_FOUND",
      "Jadwal pengiriman tidak ditemukan.",
    );
  const now = new Date();
  const next: ReportSchedule = {
    ...current,
    ...body,
    nextRunAt: body.isEnabled ? nextRunAt(body, now) : null,
    updatedAt: now.toISOString(),
  };
  scheduleStore.set(
    scheduleStore
      .get()
      .map((schedule) => (schedule.id === next.id ? next : schedule)),
  );
  return { data: next };
});
