// Shared setup for the so-885 card D tests (force release reconciliation
// queue, legend-adiov). A POS QRIS is issued, hidden by the cashier, backdated
// past the 30 minute release gate and force released by a manager (founder
// Q93), with a scripted provider answer at the moment of release.
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { setStaffPin } from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, signUp } from "./helpers.ts";
import {
  HOLD_RELEASE_AFTER_MIN,
  issueQris,
  newSubmittedOrder,
  postCancel,
  postRelease,
  readHold,
  tryImport,
  type HoldFixture,
  type IssuedQris,
  type ManagerApproval,
  type ProviderAnswer,
} from "./pos-qris-hold-test-helpers.ts";

export const BILL_IDR = 33_000;
const SUPERVISOR_PIN = "582914";
export const OPENED_ALERT_TITLE = "QRIS dirilis, uang belum terkonfirmasi";
export const UNRECORDED_ALERT_TITLE = "QRIS dibayar, uang belum tercatat";
export const FUNDS_ALERT_TITLE = "Uang QRIS perlu dikembalikan";

export function releaseKit(fx: HoldFixture) {
  let supervisorUserId: string | null = null;
  const supervisor = async (): Promise<string> => {
    if (supervisorUserId) return supervisorUserId;
    const client = agent(fx.app);
    await signUp(client, "Manajer Rekonsiliasi QRIS");
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    const roleId = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Manajer QRIS Uji D', true, 'supervisor', $3, false, '["tenant"]')`,
      [
        roleId,
        fx.tenant.tenantId,
        JSON.stringify(["order.view", "pos.void.approve"]),
      ],
    );
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [fx.tenant.tenantId, userId, roleId],
    );
    await setStaffPin(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      userId,
      { outletId: fx.tenant.outletId, userId },
      { pin: SUPERVISOR_PIN },
    );
    supervisorUserId = userId;
    return userId;
  };

  const managerApproval = async (
    orderId: string,
    valueIdr: number,
  ): Promise<ManagerApproval> => {
    const approver = await supervisor();
    const { override } = await createPosOverride(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      fx.staff.userId,
      {
        outletId: fx.tenant.outletId,
        action: "void",
        valueIdr,
        reason: "Penyedia QRIS tidak merespons",
        objectType: "order",
        objectId: orderId,
        approval: {
          method: "supervisor_pin",
          approverUserId: userIdSchema.parse(approver),
          pin: SUPERVISOR_PIN,
        },
      } as Parameters<typeof createPosOverride>[2],
      { idempotencyKey: randomUUID() },
    );
    expect(override.status).toBe("approved");
    return { approvedBy: approver, overrideId: override.id };
  };

  /** Issue the QR on a fresh bill, hide it, script the provider, backdate the
   * expiry past the 30 minute gate and force release it. */
  const forceRelease = async (
    providerAtRelease: ProviderAnswer,
    orderId?: string,
  ) => {
    const order = orderId ? { id: orderId } : await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    fx.gateway.script(qr.intentId, providerAtRelease);
    expect((await postCancel(fx, order.id)).status).toBe(202);
    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - $3::int * interval '1 minute'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, qr.intentId, HOLD_RELEASE_AFTER_MIN + 1],
    );
    const approval = await managerApproval(order.id, BILL_IDR);
    const released = await postRelease(fx, order.id, approval);
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    const hold = await readHold(fx, order.id);
    expect(hold?.state).toBe("closed");
    expect(hold?.closeReason).toBe("force_released");
    return { orderId: order.id, qr, releasedAt: new Date() };
  };

  return { supervisor, managerApproval, forceRelease };
}

export type ReleasedQr = {
  orderId: string;
  qr: IssuedQris;
  releasedAt: Date;
};

/** Rows of the reconciliation queue, oldest first. */
export async function reconRows(fx: HoldFixture, intentId?: string) {
  const { rows } = await owner.query<{
    id: string;
    outlet_id: string;
    hold_id: string;
    payment_intent_id: string;
    status: string;
    reason: string;
    attempts: number;
    next_check_at: Date;
    last_provider_status: string | null;
    resolved_at: Date | null;
    resolution: string | null;
  }>(
    `SELECT id::text AS id, outlet_id::text AS outlet_id, hold_id::text AS hold_id,
            payment_intent_id::text AS payment_intent_id, status, reason, attempts,
            next_check_at, last_provider_status, resolved_at, resolution
       FROM pos_qris_release_reconciliations
      WHERE tenant_id=$1 AND ($2::uuid IS NULL OR payment_intent_id=$2::uuid)
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, intentId ?? null],
  );
  return rows;
}

export async function evidenceRows(fx: HoldFixture, intentId: string) {
  const { rows } = await owner.query<{ amount: number; provider_ref: string }>(
    `SELECT amount_idr::int AS amount, provider_ref FROM payment_evidence
      WHERE tenant_id=$1 AND payment_intent_id=$2`,
    [fx.tenant.tenantId, intentId],
  );
  return rows;
}

export async function outboxCountOf(
  fx: HoldFixture,
  name: string,
  intentId: string,
) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM domain_event_outbox
      WHERE tenant_id=$1 AND event->>'name'=$2
        AND event->'payload'->>'intentId'=$3`,
    [fx.tenant.tenantId, name, intentId],
  );
  return rows[0]!.n;
}

export async function notificationCount(fx: HoldFixture, title: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND title=$2`,
    [fx.tenant.tenantId, title],
  );
  return rows[0]!.n;
}

/**
 * The reconciliation worker. Assumption (the card names the pattern, not the
 * export): `worker/pos-qris-release-recon.job.ts` exports
 * `runPosQrisReleaseReconJob(context, now, { force })`, same shape as the hold
 * check job. `force` ignores `next_check_at`.
 */
export async function runRecon(
  fx: HoldFixture,
  now: Date,
  options: { force?: boolean } = { force: true },
) {
  const job = await tryImport<{
    runPosQrisReleaseReconJob?: (
      context: ScopedTenantContext,
      now?: Date,
      options?: { force?: boolean },
    ) => Promise<unknown>;
  }>(
    "../worker/pos-qris-release-recon.job.ts",
    "QRIS release reconciliation job",
  );
  if (typeof job.runPosQrisReleaseReconJob !== "function")
    throw new Error(
      "worker/pos-qris-release-recon.job.ts must export runPosQrisReleaseReconJob(context, now, { force })",
    );
  return job.runPosQrisReleaseReconJob(fx.context, now, options);
}

export const hoursAfter = (at: Date, hours: number) =>
  new Date(at.getTime() + hours * 3_600_000);
