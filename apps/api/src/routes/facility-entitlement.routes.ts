// Staff entitlement routes (PRD v1.7 §3 F25; bead legend-fjk5; FAC-04).
// Paths, params, bodies and queries come from the WS-09 contract
// (`@starter/shared/facility`). Mount at `/api/facility` after `facilityRouter`.
//
// The customer contract `GET /entitlements/current` is NOT mounted here: the
// customer resolver belongs to bead legend-bj5m, which calls
// `getCurrentEntitlements` of the service directly.
//
// The request names a facility, not an outlet, so the gate is
// `requireMenuPermission("facility.access.assist")` and the handler re-checks
// the permission on the facility's own outlet inside the tenant transaction
// (TEN-03); RLS hides other outlets.
import { Router } from "express";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  entitlementLedgerEntrySchema,
  getCustomerEntitlements as getCustomerEntitlementsEndpoint,
  staffIssueEntitlement as staffIssueEntitlementEndpoint,
  type EntitlementLedgerEntry,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as entitlements from "../services/facility-entitlement.service.ts";
import {
  assertFacilityPermission,
  auditFacility,
  loadFacility,
} from "../services/facility-shared.ts";

const assist = requireMenuPermission("facility.access.assist");

export const facilityEntitlementRouter = Router();
facilityEntitlementRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
);

function toEntry(row: entitlements.LedgerRow): EntitlementLedgerEntry {
  return entitlementLedgerEntrySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    facilityId: row.facilityId,
    customerProfileId: row.customerProfileId,
    type: row.type,
    sessions: row.sessions,
    sourceType: row.sourceType,
    sourceRef: row.sourceRef,
    accessTicketId: row.accessTicketId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    occurredAt: row.occurredAt.toISOString(),
    actorUserId: row.actorUserId,
    reason: row.reason,
  });
}

facilityEntitlementRouter.get(
  "/customers/:customerProfileId/entitlements",
  assist,
  async (req, res) => {
    const { customerProfileId } = getCustomerEntitlementsEndpoint.params.parse(
      req.params,
    );
    const { facilityId } = getCustomerEntitlementsEndpoint.query.parse(
      req.query,
    );
    const context: ScopedTenantContext = getScopedTenantContext(req);
    const actor = getAuth(req).user.id;
    const data = await withTenant(db, context, async (tx) => {
      const facility = await loadFacility(tx, context, facilityId);
      await assertFacilityPermission(
        tx,
        context,
        actor,
        "facility.access.assist",
        facility.outletId,
      );
      return entitlements.getCurrentEntitlements(tx, context, {
        customerProfileId,
        facilityId,
      });
    });
    res.json({ data });
  },
);

facilityEntitlementRouter.post(
  "/entitlements/staff-issue",
  assist,
  jsonBody,
  async (req, res) => {
    const input = staffIssueEntitlementEndpoint.body.parse(req.body);
    const context: ScopedTenantContext = getScopedTenantContext(req);
    const actor = getAuth(req).user.id;
    const now = new Date();
    const data = await withTenant(db, context, async (tx) => {
      const facility = await loadFacility(tx, context, input.facilityId);
      await assertFacilityPermission(
        tx,
        context,
        actor,
        "facility.access.assist",
        facility.outletId,
      );
      // Staff grants need no payment and no rule (FAC-04); the request id is
      // the idempotency key (ledger `sourceRef`).
      const result = await entitlements.issueEntitlement(tx, context, {
        facilityId: input.facilityId,
        customerProfileId: input.customerProfileId,
        source: "staff_issue",
        sourceRef: input.requestId,
        ruleId: null,
        sessions: input.sessions,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        paid: true,
        conditionsMet: true,
        actorUserId: actor,
        reason: input.reason,
        occurredAt: now,
      });
      if (result.status === "rejected")
        throw new HttpError(
          422,
          "ENTITLEMENT_REJECTED",
          "Hak akses tidak dapat diterbitkan.",
        );
      if (result.status === "issued")
        await auditFacility(tx, context, actor, now, {
          action: "entitlement.staff_issue",
          objectType: "entitlement_ledger",
          objectId: result.entry.id,
          outletId: result.entry.outletId,
          before: null,
          after: {
            id: result.entry.id,
            facilityId: result.entry.facilityId,
            source: "staff_issue",
            quota: result.entry.sessions,
          },
        });
      return { status: result.status, entry: toEntry(result.entry) };
    });
    res.status(data.status === "issued" ? 201 : 200).json({ data });
  },
);
