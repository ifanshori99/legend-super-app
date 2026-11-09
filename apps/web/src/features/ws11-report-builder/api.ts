// Typed calls of the report builder (WS-11 contract, bead legend-mmjb; PRD
// v1.7 §3 F36). Responses are unwrapped to their payload.
import { callEndpoint } from "@/lib/api/endpoint";
import { orgEndpoints, type Outlet } from "@starter/shared/platform";
import {
  createReportScheduleEndpoint,
  createSavedReportEndpoint,
  listReportScheduleRecipientsEndpoint,
  listReportSchedulesEndpoint,
  listSavedReportsEndpoint,
  previewReportBuilderEndpoint,
  updateReportScheduleEndpoint,
  updateSavedReportEndpoint,
  type CreateReportScheduleInput,
  type CreateSavedReportInput,
  type ReportBuilderQuery,
  type ReportResult,
  type ReportSchedule,
  type ReportScheduleRecipient,
  type SavedReport,
  type UpdateReportScheduleInput,
  type UpdateSavedReportInput,
} from "@starter/shared/dashboard";

export async function previewReport(
  query: ReportBuilderQuery,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const response = await callEndpoint(
    previewReportBuilderEndpoint,
    { body: query },
    { signal },
  );
  return response.data;
}

/** Walks the cursor pages: a tenant has a handful of saved reports. */
export async function fetchSavedReports(
  signal?: AbortSignal,
): Promise<SavedReport[]> {
  const items: SavedReport[] = [];
  let cursor: string | undefined;
  do {
    const page = await callEndpoint(
      listSavedReportsEndpoint,
      { query: { limit: 100, ...(cursor ? { cursor } : {}) } },
      { signal },
    );
    items.push(...page.data);
    cursor = page.meta.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return items;
}

/** One Idempotency-Key per save attempt, so a double submit makes one row. */
export async function createSavedReport(
  input: CreateSavedReportInput,
  idempotencyKey: string,
): Promise<SavedReport> {
  const response = await callEndpoint(
    createSavedReportEndpoint,
    { body: input },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );
  return response.data;
}

export async function updateSavedReport(
  savedReportId: SavedReport["id"],
  input: UpdateSavedReportInput,
): Promise<SavedReport> {
  const response = await callEndpoint(updateSavedReportEndpoint, {
    params: { savedReportId },
    body: input,
  });
  return response.data;
}

export async function fetchReportSchedules(
  signal?: AbortSignal,
): Promise<ReportSchedule[]> {
  const items: ReportSchedule[] = [];
  let cursor: string | undefined;
  do {
    const page = await callEndpoint(
      listReportSchedulesEndpoint,
      { query: { limit: 100, ...(cursor ? { cursor } : {}) } },
      { signal },
    );
    items.push(...page.data);
    cursor = page.meta.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return items;
}

/** Tenant users a schedule can be sent to (the server holds their emails). */
export async function fetchScheduleRecipients(
  signal?: AbortSignal,
): Promise<ReportScheduleRecipient[]> {
  const items: ReportScheduleRecipient[] = [];
  let cursor: string | undefined;
  do {
    const page = await callEndpoint(
      listReportScheduleRecipientsEndpoint,
      { query: { limit: 100, ...(cursor ? { cursor } : {}) } },
      { signal },
    );
    items.push(...page.data);
    cursor = page.meta.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return items;
}

export async function createReportSchedule(
  input: CreateReportScheduleInput,
  idempotencyKey: string,
): Promise<ReportSchedule> {
  const response = await callEndpoint(
    createReportScheduleEndpoint,
    { body: input },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );
  return response.data;
}

export async function updateReportSchedule(
  reportScheduleId: ReportSchedule["id"],
  input: UpdateReportScheduleInput,
): Promise<ReportSchedule> {
  const response = await callEndpoint(updateReportScheduleEndpoint, {
    params: { reportScheduleId },
    body: input,
  });
  return response.data;
}

/** Outlets of the caller's scope, for the outlet picker (names only). */
export async function fetchBuilderOutlets(
  signal?: AbortSignal,
): Promise<Outlet[]> {
  const page = await callEndpoint(
    orgEndpoints.listOutlets,
    { query: { limit: 100 } },
    { signal },
  );
  return page.data;
}
