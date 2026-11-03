// Query keys and options of the profit-share back office. Hierarchical under
// "profit-share" so one invalidation refreshes every screen a write affects.
import { queryOptions } from "@tanstack/react-query";
import type { DistributionRunStatus } from "@starter/shared/accounting";
import {
  fetchDistributionRun,
  fetchDistributionRuns,
  fetchDistributionStatement,
  fetchProfitEntities,
  fetchShareholders,
  fetchShareVersion,
  fetchShareVersions,
} from "./api";
import { DISTRIBUTION_PAGE_LIMIT } from "./lib";

export const profitShareKeys = {
  all: ["profit-share"] as const,
  entities: () => [...profitShareKeys.all, "entities"] as const,
  shareholders: () => [...profitShareKeys.all, "shareholders"] as const,
  versions: (profitEntityId: string) =>
    [...profitShareKeys.all, "versions", profitEntityId] as const,
  version: (profitEntityId: string, version: number) =>
    [...profitShareKeys.all, "version", profitEntityId, version] as const,
  runs: (profitEntityId: string, status?: DistributionRunStatus) =>
    [...profitShareKeys.all, "runs", profitEntityId, status ?? "all"] as const,
  run: (distributionRunId: string) =>
    [...profitShareKeys.all, "run", distributionRunId] as const,
  statement: (distributionRunId: string, distributionLineId: string) =>
    [
      ...profitShareKeys.all,
      "statement",
      distributionRunId,
      distributionLineId,
    ] as const,
};

export function profitEntitiesQuery() {
  return queryOptions({
    queryKey: profitShareKeys.entities(),
    queryFn: ({ signal }) => fetchProfitEntities(signal),
    staleTime: 60 * 1000,
  });
}

export function shareholdersQuery() {
  return queryOptions({
    queryKey: profitShareKeys.shareholders(),
    queryFn: ({ signal }) => fetchShareholders(signal),
    staleTime: 60 * 1000,
  });
}

export function shareVersionsQuery(profitEntityId: string | undefined) {
  return queryOptions({
    queryKey: profitShareKeys.versions(profitEntityId ?? "none"),
    queryFn: ({ signal }) =>
      fetchShareVersions(profitEntityId ?? "", undefined, signal),
    enabled: Boolean(profitEntityId),
  });
}

export function shareVersionQuery(
  profitEntityId: string | undefined,
  version: number,
) {
  return queryOptions({
    queryKey: profitShareKeys.version(profitEntityId ?? "none", version),
    queryFn: ({ signal }) =>
      fetchShareVersion(profitEntityId ?? "", version, signal),
    enabled: Boolean(profitEntityId),
  });
}

export function distributionRunsQuery(
  profitEntityId: string | undefined,
  status?: DistributionRunStatus,
) {
  return queryOptions({
    queryKey: profitShareKeys.runs(profitEntityId ?? "none", status),
    queryFn: ({ signal }) =>
      fetchDistributionRuns(
        profitEntityId ?? "",
        {
          limit: DISTRIBUTION_PAGE_LIMIT,
          ...(status ? { status } : {}),
        },
        signal,
      ),
    enabled: Boolean(profitEntityId),
  });
}

export function distributionRunQuery(distributionRunId: string | undefined) {
  return queryOptions({
    queryKey: profitShareKeys.run(distributionRunId ?? "none"),
    queryFn: ({ signal }) =>
      fetchDistributionRun(distributionRunId ?? "", signal),
    enabled: Boolean(distributionRunId),
  });
}

export function distributionStatementQuery(
  distributionRunId: string | undefined,
  distributionLineId: string | undefined,
) {
  return queryOptions({
    queryKey: profitShareKeys.statement(
      distributionRunId ?? "none",
      distributionLineId ?? "none",
    ),
    queryFn: ({ signal }) =>
      fetchDistributionStatement(
        distributionRunId ?? "",
        distributionLineId ?? "",
        signal,
      ),
    enabled: Boolean(distributionRunId && distributionLineId),
  });
}
