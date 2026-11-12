import { randomUUID } from "node:crypto";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createPaymentIntentInputSchema } from "@starter/shared/payment";
import {
  approveRefundInputSchema,
  createRefundInputSchema,
} from "@starter/shared/payment/admin";
import {
  approveRefund,
  createRefund,
} from "../services/payment-admin.service.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway.ts";
import {
  confirmPayment,
  createIntent,
  createPaymentLink,
} from "../services/payment.service.ts";
import { owner, seededTenantId } from "./floor-test-helpers.ts";
import { FakeRefundGateway } from "./refund-fake-gateway.ts";

const gateway: PaymentGatewayPort = {
  provider: "doit",
  async health() {
    return { status: "available" };
  },
  async createIntent(input: GatewayIntentRequest) {
    return {
      providerRef: `FAKE-${randomUUID()}`,
      instructions: { method: "qris", qrPayload: "test", issuer: null },
      expiresAt: input.expiresAt,
    };
  },
  async getStatus(input) {
    return {
      status: "pending",
      providerRef: input.providerRef,
      amountIdr: null,
    };
  },
  async channels() {
    return [];
  },
};

/** Settle and partially refund via payment services; only the provider is fake. */
export async function seedSettledDeposit(input: {
  tenantId: string;
  outletId: string;
  sessionId: string;
  requestedBy: string;
  approverId: string;
  paidIdr: number;
  refundedIdr: number;
}) {
  const {
    tenantId,
    outletId,
    sessionId,
    requestedBy,
    approverId,
    paidIdr,
    refundedIdr,
  } = input;
  if (
    requestedBy === approverId ||
    !Number.isSafeInteger(paidIdr) ||
    !Number.isSafeInteger(refundedIdr) ||
    paidIdr <= 0 ||
    refundedIdr < 0 ||
    refundedIdr >= paidIdr
  )
    throw new Error(
      "Expected distinct actors and a nonnegative refund below the paid amount",
    );
  const context = establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
    VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
    [
      roleId,
      tenantId,
      `Batch49 finance ${roleId.slice(0, 8)}`,
      JSON.stringify(["payment.reconcile", "pos.refund.approve"]),
    ],
  );
  for (const userId of [requestedBy, approverId]) {
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
      VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
      [tenantId, userId, roleId],
    );
  }
  const ownerRole = await owner.query<{ id: string }>(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT gen_random_uuid(), $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $2 AND template_key = 'owner'
     ON CONFLICT (tenant_id, template_key) DO UPDATE SET template_key = EXCLUDED.template_key
     RETURNING id`,
    [tenantId, seededTenantId],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [tenantId, approverId, ownerRole.rows[0]!.id],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
    VALUES ($1, 'refund', NULL, $2, 1)`,
    [tenantId, roleId],
  );
  const opened = await createPaymentLink(
    context,
    {
      outletId: outletIdSchema.parse(outletId),
      reference: `DP-${randomUUID().slice(0, 8)}`,
      tableLabel: null,
      pax: null,
      subtotalIdr: paidIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      taxIdr: 0,
      roundingIdr: 0,
      totalIdr: paidIdr,
      returnPath: null,
    },
    requestedBy,
  );
  setPaymentGateway(gateway);
  let intentId: string;
  try {
    const intent = await createIntent(
      context,
      opened.token,
      createPaymentIntentInputSchema.parse({
        method: "qris",
        channelCode: null,
        idempotencyKey: `batch49-intent-${randomUUID()}`,
      }),
    );
    intentId = intent.id;
    await confirmPayment(context, intentId, {
      source: "verified_webhook",
      method: "qris",
      amountIdr: paidIdr,
      providerRef: `PAID-${intentId}`,
      at: new Date().toISOString(),
    });
  } finally {
    setPaymentGateway(null);
  }
  if (refundedIdr > 0) {
    const reqKey = `batch49-refund-${randomUUID()}`;
    const refund = await createRefund(
      context,
      requestedBy,
      createRefundInputSchema.parse({
        idempotencyKey: reqKey,
        paymentIntentId: intentId,
        amountIdr: refundedIdr,
        reason: "Partial refund fixture",
      }),
      reqKey,
    );
    const aprKey = `batch49-approve-${randomUUID()}`;
    setPaymentRefundGateway(new FakeRefundGateway());
    try {
      const result = await approveRefund(
        context,
        approverId,
        { refundId: refund.id },
        approveRefundInputSchema.parse({ idempotencyKey: aprKey }),
        aprKey,
        { mfaVerified: true },
      );
      if (result.status !== "completed")
        throw new Error(`Partial refund did not complete: ${result.status}`);
    } finally {
      setPaymentRefundGateway(null);
    }
  }
  const reservationId = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query(
      `INSERT INTO reservations (id, tenant_id, outlet_id, guest_name, reserved_for, duration_minutes, pax, deposit_idr, deposit_payment_link_id, deposit_payment_id, policy_snapshot, status, source, seated_at, table_session_id)
      VALUES ($1, $2, $3, 'Race guest', now(), 90, 2, $4, $5, $6, '{}'::jsonb, 'seated', 'staff', now(), $7)`,
      [
        reservationId,
        tenantId,
        outletId,
        paidIdr,
        opened.linkId,
        intentId,
        sessionId,
      ],
    );
    await client.query(
      `INSERT INTO reservation_deposit_allocations (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, outletId, reservationId, sessionId, intentId, paidIdr],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return {
    linkId: opened.linkId,
    reservationId,
    intentId,
    paidIdr,
    refundedIdr,
    netCreditIdr: paidIdr - refundedIdr,
  };
}
