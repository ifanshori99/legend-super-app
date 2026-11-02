// One typed caller per endpoint the RBAC admin screens use (docs/frontend.md
// "Typed endpoints and mock mode"). Components never call these directly; the
// hooks in ./hooks.ts own cache keys and invalidation. Read-only endpoints
// (roles, assignments, matrix, directory lookups) are called from queries.ts,
// where `endpointQueryOptions` needs the endpoint object itself.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createCustomRole as createCustomRoleEndpoint,
  endRoleAssignment as endRoleAssignmentEndpoint,
  grantRole as grantRoleEndpoint,
  replaceApprovalMatrix as replaceApprovalMatrixEndpoint,
  updateCustomRole as updateCustomRoleEndpoint,
  verifyMfaFactor as verifyMfaFactorEndpoint,
} from "@starter/shared/identity";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

export const createCustomRole = (
  body: Body<typeof createCustomRoleEndpoint>,
) => callEndpoint(createCustomRoleEndpoint, { body });

export const updateCustomRole = (
  params: Params<typeof updateCustomRoleEndpoint>,
  body: Body<typeof updateCustomRoleEndpoint>,
) => callEndpoint(updateCustomRoleEndpoint, { params, body });

/** Requires a fresh second factor on the session (PRD §3.7 "Pemberian Role"). */
export const grantRole = (body: Body<typeof grantRoleEndpoint>) =>
  callEndpoint(grantRoleEndpoint, { body });

export const endRoleAssignment = (
  params: Params<typeof endRoleAssignmentEndpoint>,
  body: Body<typeof endRoleAssignmentEndpoint>,
) => callEndpoint(endRoleAssignmentEndpoint, { params, body });

export const replaceApprovalMatrix = (
  body: Body<typeof replaceApprovalMatrixEndpoint>,
) => callEndpoint(replaceApprovalMatrixEndpoint, { body });

// ---------------------------------------------------------- re-authentication

/** Marks this session as MFA-verified; the API's grant checks the session. */
export const verifyMfaFactor = (body: Body<typeof verifyMfaFactorEndpoint>) =>
  callEndpoint(verifyMfaFactorEndpoint, { body });
