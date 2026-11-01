// Tenant RBAC administration (bead legend-4f9; PRD v1.7 §3.7, §6 B). Thin
// routes: identity, tenant and origin are checked first, the route names its
// permission, the service owns the rules and the audit/event writes.
//
// Endpoints match @starter/shared/identity/endpoints.ts exactly (roles,
// role-assignments, approval-policies). Re-authentication for grants is read
// from the verified session (`lib/mfa.ts` fails closed today; legend-6xf owns
// the factor store), so a grant without a recent second factor answers
// REAUTH_REQUIRED.

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
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import { verifiedMfaAt } from "../lib/mfa";
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

accessRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

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
    res.json({
      data: await updateCustomRole(
        getScopedTenantContext(req),
        roleId,
        input,
        getAuth(req).user.id,
      ),
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
    // PRD §3.7 Pemberian Role: re-authentication within 5 minutes. Until the
    // factor store lands this is null, so the service answers REAUTH_REQUIRED.
    const reauthenticatedAt = await verifiedMfaAt(req);
    const assignment = await grantRoleAssignment(
      getScopedTenantContext(req),
      input,
      {
        actorUserId: getAuth(req).user.id,
        reauthenticatedAt:
          reauthenticatedAt === null ? null : new Date(reauthenticatedAt),
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
