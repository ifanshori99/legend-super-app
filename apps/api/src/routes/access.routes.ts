// Tenant RBAC administration (bead legend-4f9; PRD v1.7 §3.7, §6 B). Thin
// routes: identity, tenant and origin are checked first, the route names its
// permission, the service owns the rules and the audit/event writes.
//
// Endpoints match @starter/shared/identity/endpoints.ts exactly (roles,
// role-assignments, approval-policies). Re-authentication for grants is the
// session's verified second factor (legend-6xf `session.mfa_verified_at`),
// which the service requires to be within ROLE_GRANT_REAUTH_MAX_AGE_MS
// (5 minutes, @starter/shared/access); an older or absent verification answers
// REAUTH_REQUIRED. The strict body schema carries no code, so the session is
// the only source (legend-ma2v).

import { Router } from "express";
import {
  createCustomRoleSchema,
  endRoleAssignmentSchema,
  grantRoleSchema,
  listRoleAssignmentsQuerySchema,
  updateCustomRoleSchema,
} from "@starter/shared/access";
import {
  replaceApprovalMatrixSchema,
  roleAssignmentParamsSchema,
  roleParamsSchema,
} from "@starter/shared/identity";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireBackOfficeSurface } from "../middleware/identity-surface";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import { loadSessionRow } from "../services/identity-session.service";
import {
  createCustomRole,
  endRoleAssignment,
  getApprovalMatrix,
  grantRoleAssignment,
  listRoleAssignments,
  listRoles,
  replaceApprovalMatrix,
  updateCustomRole,
} from "../services/access.service";

export const accessRouter = Router();

// AUTH-05: role administration is back office; an MFA role needs a verified
// second factor on this session (legend-qfvu).
accessRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
);

// ------------------------------------------------------------------- roles

accessRouter.get(
  "/roles",
  requireTenantPermission("access.role.view"),
  async (req, res) => {
    res.json(
      await listRoles(getScopedTenantContext(req), getAuth(req).user.id),
    );
  },
);

accessRouter.post(
  "/roles",
  requireTenantPermission("access.role.manage"),
  jsonBody,
  async (req, res) => {
    const input = createCustomRoleSchema.parse(req.body);
    const role = await createCustomRole(
      getScopedTenantContext(req),
      input,
      getAuth(req).user.id,
    );
    res
      .status(201)
      .location(`/api/access/roles/${role.id}`)
      .json({ data: role });
  },
);

accessRouter.patch(
  "/roles/:roleId",
  requireTenantPermission("access.role.manage"),
  jsonBody,
  async (req, res) => {
    const { roleId } = roleParamsSchema.parse(req.params);
    const input = updateCustomRoleSchema.parse(req.body);
    // A custom-role edit may add permissions only when they are held or when
    // the editor is a re-authenticated Owner/Admin Tenant (PRD §3.7). Same
    // pattern as the grant path below: the session's second factor is the
    // re-authentication (legend-6xf `session.mfa_verified_at`), and the service
    // rejects one older than ROLE_GRANT_REAUTH_MAX_AGE_MS (legend-ma2v).
    const session = await loadSessionRow(getAuth(req).session.id);
    const reauthenticatedAt = session?.mfaVerifiedAt ?? null;
    res.json({
      data: await updateCustomRole(getScopedTenantContext(req), roleId, input, {
        actorUserId: getAuth(req).user.id,
        reauthenticatedAt,
        mfaVerified: reauthenticatedAt !== null,
      }),
    });
  },
);

// ------------------------------------------------------- role assignments

accessRouter.get(
  "/role-assignments",
  requireTenantPermission("access.role.view"),
  async (req, res) => {
    const query = listRoleAssignmentsQuerySchema.parse(req.query);
    res.json(
      await listRoleAssignments(
        getScopedTenantContext(req),
        query,
        getAuth(req).user.id,
      ),
    );
  },
);

accessRouter.post(
  "/role-assignments",
  requireTenantPermission("access.role.assign"),
  jsonBody,
  async (req, res) => {
    const input = grantRoleSchema.parse(req.body);
    // PRD §3.7 Pemberian Role: re-authentication within 5 minutes. The
    // verification is the session's second factor (legend-6xf) — the strict
    // grant body has no field to carry a code — and the service rejects a
    // verification older than ROLE_GRANT_REAUTH_MAX_AGE_MS.
    const session = await loadSessionRow(getAuth(req).session.id);
    const reauthenticatedAt = session?.mfaVerifiedAt ?? null;
    const assignment = await grantRoleAssignment(
      getScopedTenantContext(req),
      input,
      {
        actorUserId: getAuth(req).user.id,
        reauthenticatedAt,
        mfaVerified: reauthenticatedAt !== null,
      },
    );
    res
      .status(201)
      .location(`/api/access/role-assignments/${assignment.id}`)
      .json({ data: assignment });
  },
);

accessRouter.post(
  "/role-assignments/:assignmentId/end",
  requireTenantPermission("access.role.assign"),
  jsonBody,
  async (req, res) => {
    const { assignmentId } = roleAssignmentParamsSchema.parse(req.params);
    const input = endRoleAssignmentSchema.parse(req.body);
    res.json({
      data: await endRoleAssignment(
        getScopedTenantContext(req),
        assignmentId,
        input,
        getAuth(req).user.id,
      ),
    });
  },
);

// --------------------------------------------------------- approval matrix

accessRouter.get(
  "/approval-policies",
  requireTenantPermission("access.approval_policy.manage"),
  async (req, res) => {
    res.json(
      await getApprovalMatrix(
        getScopedTenantContext(req),
        getAuth(req).user.id,
      ),
    );
  },
);

accessRouter.put(
  "/approval-policies",
  requireTenantPermission("access.approval_policy.manage"),
  jsonBody,
  async (req, res) => {
    const input = replaceApprovalMatrixSchema.parse(req.body);
    res.json(
      await replaceApprovalMatrix(
        getScopedTenantContext(req),
        input,
        getAuth(req).user.id,
      ),
    );
  },
);
