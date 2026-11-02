// Typed call of the audit log list. The endpoint is defined in ./contract.ts
// until the shared contract bead moves it into `@starter/shared/audit`.
import { callEndpoint } from "@/lib/api/endpoint";
import { listAuditEventsEndpoint, type AuditEventListQuery } from "./contract";

/** One cursor page of audit rows, newest first. */
export async function fetchAuditEvents(
  query: AuditEventListQuery,
  signal?: AbortSignal,
) {
  return callEndpoint(listAuditEventsEndpoint, { query }, { signal });
}
