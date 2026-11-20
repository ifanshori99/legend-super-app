// The only way components touch profit-share data: queries keep their endpoint
// keys, mutations invalidate every endpoint whose rows a write can change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EndpointInput } from "@starter/shared/api";
import type {
  createAdjustmentDistribution as createAdjustmentDistributionEndpoint,
  createDistributionRun as createDistributionRunEndpoint,
  createProfitEntity as createProfitEntityEndpoint,
  createShareholder as createShareholderEndpoint,
  createShareAllocationVersion as createShareAllocationVersionEndpoint,
  recordDistributionPayment as recordDistributionPaymentEndpoint,
  updateProfitEntity as updateProfitEntityEndpoint,
  updateShareholder as updateShareholderEndpoint,
  updateShareAllocationVersion as updateShareAllocationVersionEndpoint,
} from "@starter/shared/accounting";
import * as api from "./api";
import {
  distributionRunQuery,
  distributionRunsQuery,
  distributionStatementQuery,
  profitEntitiesQuery,
  profitShareKeys,
  shareholdersQuery,
  shareVersionQuery,
  shareVersionsQuery,
} from "./queries";

// ---- Queries --------------------------------------------------------------

export function useProfitEntities() {
  return useQuery(profitEntitiesQuery());
}

export function useShareholders() {
  return useQuery(shareholdersQuery());
}

export function useShareVersions(profitEntityId: string | undefined) {
  return useQuery(shareVersionsQuery(profitEntityId));
}

export function useShareVersion(
  profitEntityId: string | undefined,
  version: number,
) {
  return useQuery(shareVersionQuery(profitEntityId, version));
}

export function useDistributionRuns(profitEntityId: string | undefined) {
  return useQuery(distributionRunsQuery(profitEntityId));
}

export function useDistributionRun(distributionRunId: string | undefined) {
  return useQuery(distributionRunQuery(distributionRunId));
}

export function useDistributionStatement(
  distributionRunId: string | undefined,
  distributionLineId: string | undefined,
) {
  return useQuery(
    distributionStatementQuery(distributionRunId, distributionLineId),
  );
}

// ---- Mutations ------------------------------------------------------------

function useInvalidate() {
  const queryClient = useQueryClient();
  return (queryKey: readonly unknown[]) =>
    queryClient.invalidateQueries({ queryKey });
}

export type CreateProfitEntityBody = EndpointInput<
  typeof createProfitEntityEndpoint
>["body"];
export type UpdateProfitEntityBody = EndpointInput<
  typeof updateProfitEntityEndpoint
>["body"];
export type CreateShareholderBody = EndpointInput<
  typeof createShareholderEndpoint
>["body"];
export type UpdateShareholderBody = EndpointInput<
  typeof updateShareholderEndpoint
>["body"];
export type CreateShareVersionBody = Omit<
  EndpointInput<typeof createShareAllocationVersionEndpoint>["body"],
  "idempotencyKey"
>;
export type UpdateShareVersionBody = EndpointInput<
  typeof updateShareAllocationVersionEndpoint
>["body"];
export type CreateDistributionRunBody = Omit<
  EndpointInput<typeof createDistributionRunEndpoint>["body"],
  "idempotencyKey"
>;
export type RecordPaymentBody = Omit<
  EndpointInput<typeof recordDistributionPaymentEndpoint>["body"],
  "idempotencyKey"
>;
export type CreateAdjustmentBody = Omit<
  EndpointInput<typeof createAdjustmentDistributionEndpoint>["body"],
  "idempotencyKey"
>;

export function useCreateProfitEntity() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: CreateProfitEntityBody) => api.createProfitEntity(body),
    onSuccess: () => invalidate(profitShareKeys.entities()),
  });
}

export function useUpdateProfitEntity(profitEntityId: string | undefined) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: UpdateProfitEntityBody) =>
      api.updateProfitEntity(profitEntityId ?? "", body),
    onSuccess: () =>
      Promise.all([
        invalidate(profitShareKeys.entities()),
        invalidate(profitShareKeys.versions(profitEntityId ?? "none")),
      ]),
  });
}

export function useCreateShareholder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: CreateShareholderBody) => api.createShareholder(body),
    onSuccess: () => invalidate(profitShareKeys.shareholders()),
  });
}

export function useUpdateShareholder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      shareholderId,
      body,
    }: {
      shareholderId: string;
      body: UpdateShareholderBody;
    }) => api.updateShareholder(shareholderId, body),
    onSuccess: () => invalidate(profitShareKeys.shareholders()),
  });
}

export function useCreateShareVersion(profitEntityId: string | undefined) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: CreateShareVersionBody) =>
      api.createShareVersion(profitEntityId ?? "", body),
    onSuccess: () =>
      invalidate(profitShareKeys.versions(profitEntityId ?? "none")),
  });
}

export function useUpdateShareVersion(profitEntityId: string | undefined) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      version,
      body,
    }: {
      version: number;
      body: UpdateShareVersionBody;
    }) => api.updateShareVersion(profitEntityId ?? "", version, body),
    onSuccess: (updated) =>
      Promise.all([
        invalidate(profitShareKeys.versions(profitEntityId ?? "none")),
        invalidate(
          profitShareKeys.version(profitEntityId ?? "none", updated.version),
        ),
      ]),
  });
}

export function useSubmitShareVersion(profitEntityId: string | undefined) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (version: number) =>
      api.submitShareVersion(profitEntityId ?? "", version),
    onSuccess: () =>
      invalidate(profitShareKeys.versions(profitEntityId ?? "none")),
  });
}

export function useDecideShareVersion(profitEntityId: string | undefined) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      version,
      decision,
      note,
    }: {
      version: number;
      decision: "approve" | "reject";
      note: string | null;
    }) => api.decideShareVersion(profitEntityId ?? "", version, decision, note),
    onSuccess: () =>
      invalidate(profitShareKeys.versions(profitEntityId ?? "none")),
  });
}

export function useCreateDistributionRun(profitEntityId: string | undefined) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: CreateDistributionRunBody) =>
      api.createDistributionRun(profitEntityId ?? "", body),
    onSuccess: () =>
      Promise.all([
        invalidate(profitShareKeys.runs(profitEntityId ?? "none")),
        invalidate(profitShareKeys.entities()),
      ]),
  });
}

export function useSubmitDistributionRun(profitEntityId: string | undefined) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (distributionRunId: string) =>
      api.submitDistributionRun(distributionRunId),
    onSuccess: (run) =>
      Promise.all([
        invalidate(profitShareKeys.run(run.id)),
        invalidate(profitShareKeys.runs(profitEntityId ?? "none")),
      ]),
  });
}

export function useDecideDistributionRun(profitEntityId: string | undefined) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      distributionRunId,
      decision,
      note,
    }: {
      distributionRunId: string;
      decision: "approve" | "reject";
      note: string | null;
    }) => api.decideDistributionRun(distributionRunId, decision, note),
    onSuccess: (run) =>
      Promise.all([
        invalidate(profitShareKeys.run(run.id)),
        invalidate(profitShareKeys.runs(profitEntityId ?? "none")),
      ]),
  });
}

export function useCancelApprovedDistributionRun(
  profitEntityId: string | undefined,
) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      distributionRunId,
      reason,
    }: {
      distributionRunId: string;
      reason: string;
    }) => api.cancelApprovedDistributionRun(distributionRunId, reason),
    onSuccess: (run) =>
      Promise.all([
        invalidate(profitShareKeys.run(run.id)),
        invalidate(profitShareKeys.runs(profitEntityId ?? "none")),
      ]),
  });
}

export function useRecordDistributionPayment(
  profitEntityId: string | undefined,
) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      distributionRunId,
      distributionLineId,
      body,
    }: {
      distributionRunId: string;
      distributionLineId: string;
      body: RecordPaymentBody;
    }) =>
      api.recordDistributionPayment(
        distributionRunId,
        distributionLineId,
        body,
      ),
    onSuccess: (run) =>
      Promise.all([
        invalidate(profitShareKeys.run(run.id)),
        invalidate(profitShareKeys.runs(profitEntityId ?? "none")),
      ]),
  });
}

export function useCreateAdjustmentDistribution(
  profitEntityId: string | undefined,
) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      distributionRunId,
      body,
    }: {
      distributionRunId: string;
      body: CreateAdjustmentBody;
    }) => api.createAdjustmentDistribution(distributionRunId, body),
    onSuccess: (run) =>
      Promise.all([
        invalidate(profitShareKeys.run(run.id)),
        invalidate(profitShareKeys.runs(profitEntityId ?? "none")),
      ]),
  });
}
