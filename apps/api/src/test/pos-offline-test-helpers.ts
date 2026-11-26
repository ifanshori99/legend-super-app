// Shared fixtures of the O1 kit and O2 batch tests (bead legend-wasr7.5/.6):
// an outlet supervisor of the seeded tenant, and a real shift close (blind
// count + approved close) of a till that holds only its opening float.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import {
  idr,
  outletIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  closePosShift,
  submitPosShiftCount,
} from "../services/pos-shift.service.ts";
import { agent, signUp } from "./helpers.ts";
import { owner, seededOutletA, seededTenantId } from "./floor-test-helpers.ts";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";

/** A signed-up user holding the seeded `supervisor` role on outlet A. */
export async function outletSupervisor(
  app: Express,
  label: string,
): Promise<string> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'supervisor'",
    [seededTenantId],
  );
  if (!rows[0]) throw new Error("No supervisor role template");
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [seededTenantId, userId, rows[0].id, seededOutletA],
  );
  return userId;
}

/**
 * Closes the till's shift for real: the cashier counts exactly `drawerIdr`
 * (1.000 notes) and the supervisor's approved close override lets it close
 * (with `varianceIdr` when the count differs from the expected cash).
 */
export async function closeShiftExactly(input: {
  scope: ScopedTenantContext;
  cashierId: string;
  deviceId: string;
  shiftId: string;
  supervisorId: string;
  drawerIdr: number;
  /** |counted - expected|: the approved override carries the variance. */
  varianceIdr?: number;
}): Promise<void> {
  const overrideValueIdr = Math.abs(input.varianceIdr ?? 0);
  const outletId = outletIdSchema.parse(seededOutletA);
  const caller = {
    userId: userIdSchema.parse(input.cashierId),
    deviceId: input.deviceId,
  };
  const count = await submitPosShiftCount(
    input.scope,
    caller,
    outletId,
    input.shiftId,
    {
      counts: [
        {
          denominationIdr: idr(1_000),
          quantity: Math.round(input.drawerIdr / 1_000),
        },
      ],
      idempotencyKey: randomUUID(),
    } as Parameters<typeof submitPosShiftCount>[4],
  );
  const approvalRequestId = randomUUID();
  const reason = "Hitung kas akhir shift";
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
    );
    await client.query(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
          reason, value_idr, object_type, object_id, request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, 'cash_shift_close', 'supervisor_pin', 'approved', $4, $5,
               $6, $9, 'pos_shift_count', $7, $8,
               now() - interval '5 seconds', now() - interval '5 seconds')`,
      [
        approvalRequestId,
        seededTenantId,
        seededOutletA,
        input.cashierId,
        input.supervisorId,
        reason,
        count.id,
        pinOverrideFixtureFingerprint({
          requestedBy: input.cashierId,
          outletId: seededOutletA,
          action: "cash_shift_close",
          valueIdr: overrideValueIdr,
          reason,
          objectType: "pos_shift_count",
          objectId: count.id,
          approverUserId: input.supervisorId,
        }),
        overrideValueIdr,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await closePosShift(input.scope, caller, outletId, input.shiftId, {
    countId: count.id,
    approvedBy: userIdSchema.parse(input.supervisorId),
    approvalRequestId,
    idempotencyKey: randomUUID(),
    ...(overrideValueIdr > 0
      ? { varianceNote: "Tunai penjualan offline di laci" }
      : {}),
  } as Parameters<typeof closePosShift>[4]);
}
