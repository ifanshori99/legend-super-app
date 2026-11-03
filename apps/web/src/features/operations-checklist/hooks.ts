// The only way components touch checklist data. Reads keep endpoint keys;
// writes update the run detail cache from the response the API returns and
// invalidate the board list so progress stays one truth.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EndpointInput } from "@starter/shared/api";
import {
  createChecklistRun as createChecklistRunEndpoint,
  createChecklistTemplate as createChecklistTemplateEndpoint,
  listChecklistRuns,
  listChecklistTemplates,
  recordChecklistItemResult as recordChecklistItemResultEndpoint,
  updateChecklistTemplate as updateChecklistTemplateEndpoint,
  type OpsChecklistItemId,
  type OpsChecklistRunId,
  type OpsChecklistTemplateId,
} from "@starter/shared/operations";
import { newIdempotencyKey } from "@/lib/idempotency";
import * as api from "./api.ts";
import {
  checklistRunQuery,
  checklistRunsQuery,
  checklistTemplateQuery,
  checklistTemplatesQuery,
  floorQuery,
} from "./queries.ts";

export type CreateRunInput = Omit<
  EndpointInput<typeof createChecklistRunEndpoint>["body"],
  "idempotencyKey"
>;

export type RecordResultInput = Omit<
  EndpointInput<typeof recordChecklistItemResultEndpoint>["body"],
  "idempotencyKey"
>;

export type UpdateTemplateInput = Omit<
  EndpointInput<typeof updateChecklistTemplateEndpoint>["body"],
  "idempotencyKey"
>;

export type CreateTemplateInput = Omit<
  EndpointInput<typeof createChecklistTemplateEndpoint>["body"],
  "idempotencyKey"
>;

export function useChecklistRuns(outletId: string | null | undefined) {
  return useQuery({
    ...checklistRunsQuery(outletId ?? ""),
    enabled: Boolean(outletId),
  });
}

export function useChecklistTemplates(outletId: string | null | undefined) {
  return useQuery({
    ...checklistTemplatesQuery(outletId ?? ""),
    enabled: Boolean(outletId),
  });
}

export function useChecklistRun(runId: string | undefined) {
  return useQuery({
    ...checklistRunQuery(runId ?? ""),
    enabled: Boolean(runId),
  });
}

export function useChecklistTemplate(templateId: string | undefined) {
  return useQuery({
    ...checklistTemplateQuery(templateId ?? ""),
    enabled: Boolean(templateId),
  });
}

/** Zones for the filters and the builder (`getCurrentFloor`). */
export function useFloorZones() {
  return useQuery(floorQuery());
}

export function useCreateChecklistRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRunInput) =>
      api.createChecklistRun({
        ...input,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: (run) => {
      queryClient.setQueryData(checklistRunQuery(run.id).queryKey, run);
      return queryClient.invalidateQueries({
        queryKey: [listChecklistRuns.id],
      });
    },
  });
}

export function useRecordChecklistItemResult(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RecordResultInput & { itemId: string }) => {
      const { itemId, ...body } = input;
      return api.recordChecklistItemResult(
        {
          runId: runId as OpsChecklistRunId,
          itemId: itemId as OpsChecklistItemId,
        },
        { ...body, idempotencyKey: newIdempotencyKey() },
      );
    },
    onSuccess: (run) => {
      queryClient.setQueryData(checklistRunQuery(runId).queryKey, run);
      return queryClient.invalidateQueries({
        queryKey: [listChecklistRuns.id],
      });
    },
  });
}

export function useChecklistRunTransition(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: "start" | "complete" | "fail" | "miss") =>
      api.postChecklistRunTransition(
        { runId: runId as OpsChecklistRunId },
        { action, idempotencyKey: newIdempotencyKey() },
      ),
    onSuccess: (run) => {
      queryClient.setQueryData(checklistRunQuery(runId).queryKey, run);
      return queryClient.invalidateQueries({
        queryKey: [listChecklistRuns.id],
      });
    },
  });
}

export function useCreateChecklistTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTemplateInput) =>
      api.createChecklistTemplate({
        ...input,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: (template) => {
      queryClient.setQueryData(
        checklistTemplateQuery(template.id).queryKey,
        template,
      );
      return queryClient.invalidateQueries({
        queryKey: [listChecklistTemplates.id],
      });
    },
  });
}

export function useUpdateChecklistTemplate(templateId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTemplateInput) =>
      api.updateChecklistTemplate(
        { templateId: templateId as OpsChecklistTemplateId },
        { ...input, idempotencyKey: newIdempotencyKey() },
      ),
    onSuccess: (template) => {
      queryClient.setQueryData(
        checklistTemplateQuery(templateId).queryKey,
        template,
      );
      return queryClient.invalidateQueries({
        queryKey: [listChecklistTemplates.id],
      });
    },
  });
}
