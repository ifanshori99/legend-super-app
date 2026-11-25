// Revoking acting-cashier tokens (bead legend-aruta; docs/DECISIONS.md "Kasir
// aktif per perangkat lewat token server"). Kept apart from the issue/resolve
// service so the services that must revoke (device pin, shift close, day
// close) can import it without a cycle through device-pin.service.
//
// Every function runs on the CALLER's open transaction: the revoke commits or
// rolls back together with the change that caused it. A token that is already
// revoked is left alone (first reason wins).

import type { ActingStaffRevokeReason } from "@starter/shared/pos/acting-staff";
import { outletIdSchema, type TenantContext } from "@starter/shared/core";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { posActingStaff } from "../db/schema/pos-acting-staff.ts";
import { endEdgeStaffSessionsOfUser } from "./edge-staff-session-revoke.ts";
import type { Tx } from "./permission-resolver.ts";

async function revokeWhere(
  tx: Tx,
  tenant: TenantContext,
  reason: ActingStaffRevokeReason,
  scope: SQL | undefined,
): Promise<void> {
  await tx
    .update(posActingStaff)
    .set({ revokedAt: sql`now()`, revokeReason: reason })
    .where(
      and(
        eq(posActingStaff.tenantId, tenant.tenantId),
        isNull(posActingStaff.revokedAt),
        scope,
      ),
    );
}

/**
 * All live tokens of one staff member at one outlet (pin reset, inactive), and
 * on an edge the staff member's PIN sessions (E2, brief 1269).
 */
export async function revokeActingStaffForStaff(
  tx: Tx,
  tenant: TenantContext,
  input: {
    readonly outletId: string;
    readonly staffUserId: string;
    readonly reason: ActingStaffRevokeReason;
  },
): Promise<void> {
  await revokeWhere(
    tx,
    tenant,
    input.reason,
    and(
      eq(posActingStaff.outletId, outletIdSchema.parse(input.outletId)),
      eq(posActingStaff.staffUserId, input.staffUserId),
    ),
  );
  await endEdgeStaffSessionsOfUser(tx, {
    tenantId: tenant.tenantId,
    userId: input.staffUserId,
  });
}

/** The live token of one device (switch, end, shift close). */
export function revokeActingStaffForDevice(
  tx: Tx,
  tenant: TenantContext,
  input: {
    readonly deviceId: string;
    readonly reason: ActingStaffRevokeReason;
  },
): Promise<void> {
  return revokeWhere(
    tx,
    tenant,
    input.reason,
    eq(posActingStaff.deviceId, input.deviceId),
  );
}

/** Every live token at one outlet (day close). */
export function revokeActingStaffForOutlet(
  tx: Tx,
  tenant: TenantContext,
  input: {
    readonly outletId: string;
    readonly reason: ActingStaffRevokeReason;
  },
): Promise<void> {
  return revokeWhere(
    tx,
    tenant,
    input.reason,
    eq(posActingStaff.outletId, outletIdSchema.parse(input.outletId)),
  );
}
