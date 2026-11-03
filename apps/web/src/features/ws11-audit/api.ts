// Typed call of the audit log list (contract: `@starter/shared/audit`).
import {
  listAuditEventsEndpoint,
  type AuditEventListQuery,
} from "@starter/shared/audit";
import { callEndpoint } from "@/lib/api/endpoint";

/** One cursor page of audit rows, newest first. */
export async function fetchAuditEvents(
  query: AuditEventListQuery,
  signal?: AbortSignal,
) {
  return callEndpoint(listAuditEventsEndpoint, { query }, { signal });
}
