// Query keys and options for the checklist screens. GET keys are
// `[endpoint.id, input]` (docs/frontend.md), so invalidating `[endpoint.id]`
// refreshes every view of that endpoint. Writes invalidate the list; the run
// response updates the detail cache directly in hooks.ts.
//
// Ids arrive as route params / dialog state (`string`); the contract's branded
// id schemas are re-applied here at the data boundary, so the rest of the
// feature does not sprinkle casts.
import { queryOptions } from "@tanstack/react-query";
import { getCurrentFloor } from "@starter/shared/qr-order";
import type { OutletId } from "@starter/shared/core";
import {
  getChecklistRun,
  getChecklistTemplate,
  listChecklistRuns,
  listChecklistTemplates,
  type OpsChecklistRunId,
  type OpsChecklistTemplateId,
} from "@starter/shared/operations";
import { endpointQueryKey, endpointQueryOptions } from "@/lib/api/endpoint";
import * as api from "./api.ts";

/** The board reads one page of runs; a day rarely exceeds it, and the cursor
 *  stays available if the API needs a pager later. */
export const BOARD_LIMIT = 100;

export const checklistRunsQuery = (outletId: string) =>
  endpointQueryOptions(listChecklistRuns, {
    query: { outletId: outletId as OutletId, limit: BOARD_LIMIT },
  });

export const checklistTemplatesQuery = (outletId: string) =>
  endpointQueryOptions(listChecklistTemplates, {
    query: { outletId: outletId as OutletId, limit: BOARD_LIMIT },
  });

export const checklistRunQuery = (runId: string) =>
  queryOptions({
    queryKey: endpointQueryKey(getChecklistRun, {
      params: { runId: runId as OpsChecklistRunId },
    }),
    queryFn: ({ signal }) =>
      api.getChecklistRun({ runId: runId as OpsChecklistRunId }, { signal }),
    // One quick retry, then the screen's own error state with "Coba lagi".
    retry: 1,
  });

export const checklistTemplateQuery = (templateId: string) =>
  queryOptions({
    queryKey: endpointQueryKey(getChecklistTemplate, {
      params: { templateId: templateId as OpsChecklistTemplateId },
    }),
    queryFn: ({ signal }) =>
      api.getChecklistTemplate(
        { templateId: templateId as OpsChecklistTemplateId },
        { signal },
      ),
    retry: 1,
  });

/** Zone names/options. The floor endpoint already exists (the floor editor
 *  owns its mock); the checklist contract stores only `zoneId`. */
export const floorQuery = () => endpointQueryOptions(getCurrentFloor);
