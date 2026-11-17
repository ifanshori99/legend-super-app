// The only way components touch RBAC data: queries keep endpoint keys,
// mutations invalidate every list a write can change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  getApprovalMatrix,
  listMfaFactors,
  listRoleAssignments,
  listRoles,
} from "@starter/shared/identity";
import type { ReplaceApprovalMatrixInput } from "@starter/shared/identity";
import type {
  CreateCustomRoleInput,
  EndRoleAssignmentInput,
  GrantRoleInput,
  RoleId,
  UpdateCustomRoleInput,
} from "@starter/shared/access";
import type { UserId } from "@starter/shared/core";
import * as api from "./api";
import {
  approvalMatrixQuery,
  assignmentsQuery,
  brandsQuery,
  mfaFactorsQuery,
  outletsQuery,
  rolesQuery,
  stationsQuery,
} from "./queries";
import { EMPTY_SCOPE_LOOKUP, type ScopeLookup } from "./lib";

/**
 * The signed-in user's id for the grant rules. Mock mode has no API session
 * (fetchSession finds none), so it falls back to the fixture Admin Tenant, the
 * same actor the mock handlers act as (mock.ts). Without it nothing is held and
 * the editor and the grant dialog fail closed (legend-sz75z).
 */
export function useViewerUserId(sessionUserId: string | undefined) {
  const mockViewer = useQuery({
    queryKey: ["ws01-access", "mock-viewer"],
    queryFn: async () => {
      // The import stays inside the flag check so a normal build compiles the
      // fixtures out (same pattern as loadAssignablePeople).
      if (import.meta.env.VITE_API_MOCK === "true") {
        const { mockViewerUserId } = await import("./mock-people");
        return mockViewerUserId();
      }
      return null;
    },
    enabled:
      import.meta.env.VITE_API_MOCK === "true" && sessionUserId === undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return sessionUserId ?? mockViewer.data ?? undefined;
}

export function useRoles() {
  return useQuery(rolesQuery());
}

export function useAssignments(query: Parameters<typeof assignmentsQuery>[0]) {
  return useQuery(assignmentsQuery(query));
}

/**
 * The viewer's own active assignments, and the tenant's active Owner
 * assignments: the screens use them to mirror the grant rules (legend-tj8o).
 * Disabled until the id is known; the API decides again on every write.
 */
export function useViewerAssignments(userId: string | undefined) {
  return useQuery({
    ...assignmentsQuery({
      userId: userId as UserId,
      activeOnly: "true",
      limit: 100,
    }),
    enabled: userId !== undefined,
  });
}

export function useRoleAssignmentsActive(roleId: string | undefined) {
  return useQuery({
    ...assignmentsQuery({
      roleId: roleId as RoleId,
      activeOnly: "true",
      limit: 100,
    }),
    enabled: roleId !== undefined,
  });
}

export function useApprovalMatrix() {
  return useQuery(approvalMatrixQuery());
}

export function useMfaFactors(enabled: boolean) {
  return useQuery({ ...mfaFactorsQuery(), enabled });
}

/**
 * Names for brand/outlet/station scope targets. Disabled when the visitor
 * lacks the owning permission; the screen then shows a short id instead of
 * failing the list.
 */
export function useScopeLookup(enabled: { org: boolean; menu: boolean }): {
  lookup: ScopeLookup;
  pending: boolean;
} {
  const brands = useQuery({ ...brandsQuery(), enabled: enabled.org });
  const outlets = useQuery({
    ...outletsQuery({ limit: 100 }),
    enabled: enabled.org,
  });
  const stations = useQuery({
    ...stationsQuery({ limit: 100 }),
    enabled: enabled.menu,
  });
  if (enabled.org ? brands.isPending || outlets.isPending : false)
    return { lookup: EMPTY_SCOPE_LOOKUP, pending: true };
  if (enabled.menu && stations.isPending)
    return { lookup: EMPTY_SCOPE_LOOKUP, pending: true };
  const lookup: ScopeLookup = {
    brands: new Map((brands.data?.data ?? []).map((row) => [row.id, row.name])),
    outlets: new Map(
      (outlets.data?.data ?? []).map((row) => [row.id, row.name]),
    ),
    stations: new Map(
      (stations.data?.data ?? []).map((row) => [row.id, row.name]),
    ),
  };
  return { lookup, pending: false };
}

/** "now" for validity badges; refreshed every minute so a scheduled grant flips. */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function useInvalidate(endpointIds: readonly string[]) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      endpointIds.map((id) =>
        queryClient.invalidateQueries({ queryKey: [id] }),
      ),
    );
}

export function useCreateCustomRole() {
  const refresh = useInvalidate([listRoles.id]);
  return useMutation({
    mutationFn: (body: CreateCustomRoleInput) => api.createCustomRole(body),
    onSuccess: () => refresh(),
  });
}

export function useUpdateCustomRole(roleId: string) {
  const refresh = useInvalidate([listRoles.id, listRoleAssignments.id]);
  return useMutation({
    mutationFn: (body: UpdateCustomRoleInput) =>
      api.updateCustomRole({ roleId }, body),
    onSuccess: () => refresh(),
  });
}

export function useGrantRole() {
  const refresh = useInvalidate([listRoleAssignments.id, listRoles.id]);
  return useMutation({
    mutationFn: (body: GrantRoleInput) => api.grantRole(body),
    onSuccess: () => refresh(),
  });
}

export function useEndRoleAssignment() {
  const refresh = useInvalidate([listRoleAssignments.id, listRoles.id]);
  return useMutation({
    mutationFn: (input: {
      assignmentId: string;
      body: EndRoleAssignmentInput;
    }) =>
      api.endRoleAssignment({ assignmentId: input.assignmentId }, input.body),
    onSuccess: () => refresh(),
  });
}

export function useReplaceApprovalMatrix() {
  const refresh = useInvalidate([getApprovalMatrix.id]);
  return useMutation({
    mutationFn: (body: ReplaceApprovalMatrixInput) =>
      api.replaceApprovalMatrix(body),
    onSuccess: () => refresh(),
  });
}

/** Verifies a TOTP code against the session, satisfying the re-auth check. */
export function useVerifyMfaFactor() {
  const refresh = useInvalidate([listMfaFactors.id]);
  return useMutation({
    mutationFn: (input: { factorId: string; code: string }) =>
      api.verifyMfaFactor(input),
    onSuccess: () => refresh(),
  });
}
