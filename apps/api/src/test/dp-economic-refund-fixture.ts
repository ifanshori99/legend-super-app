// Shared owner-SQL fixture for economic projections of a durable Q81 return.
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export async function seedEconomicDepositRefund(
  client: PoolClient,
  input: {
    tenantId: string;
    outletId: string;
    orderId: string;
    tenderIdr: number;
    depositIdr: number;
    requestedBy: string;
    approvedBy: string;
    refundedAt: string;
  },
) {
  const linkId = randomUUID();
  const intentId = randomUUID();
  const refundId = randomUUID();
  await client.query(
    `INSERT INTO payment_links
      (id,tenant_id,outlet_id,token_hash,reference,subtotal_idr,total_idr,paid_idr,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$6,$7)`,
    [
      linkId,
      input.tenantId,
      input.outletId,
      createHash("sha256").update(linkId).digest("hex"),
      `DP-ECON-${linkId.slice(0, 20)}`,
      input.depositIdr,
      input.requestedBy,
    ],
  );
  await client.query(
    `INSERT INTO payment_intents
      (id,tenant_id,outlet_id,payment_link_id,method,provider,amount_idr,
       idempotency_key,status,instructions,expires_at,paid_at)
     VALUES ($1,$2,$3,$4,'qris','doit',$5,$6,'paid',
       '{"method":"qris","qrPayload":"economic-fixture","issuer":null}',
       now()+interval '1 day',now())`,
    [
      intentId,
      input.tenantId,
      input.outletId,
      linkId,
      input.depositIdr,
      randomUUID(),
    ],
  );
  await client.query(
    `INSERT INTO payment_evidence
      (tenant_id,outlet_id,payment_intent_id,provider,provider_ref,method,source,amount_idr,received_at)
     VALUES ($1,$2,$3,'doit',$4,'qris','verified_webhook',$5,now())`,
    [
      input.tenantId,
      input.outletId,
      intentId,
      `DP-ECON-${intentId}`,
      input.depositIdr,
    ],
  );
  await client.query(
    `INSERT INTO pos_order_refunds
      (id,tenant_id,outlet_id,order_id,amount_idr,reason,reason_note,lines,
       requested_by,approved_by,approval_request_id,refunded_at,items)
     VALUES ($1,$2,$3,$4,$5,'customer_cancelled','Retur DP ekonomis',$6::jsonb,$7,$8,$9,$10,$11::jsonb)`,
    [
      refundId,
      input.tenantId,
      input.outletId,
      input.orderId,
      input.tenderIdr,
      JSON.stringify(
        input.tenderIdr > 0
          ? [{ method: "cash", amountIdr: input.tenderIdr, reference: null }]
          : [],
      ),
      input.requestedBy,
      input.approvedBy,
      randomUUID(),
      input.refundedAt,
      JSON.stringify(
        input.tenderIdr === 0 ? [{ itemId: randomUUID(), quantity: 1 }] : [],
      ),
    ],
  );
  await client.query(
    `INSERT INTO pos_deposit_refunds
      (tenant_id,outlet_id,order_id,pos_refund_id,payment_intent_id,amount_idr,released_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.tenantId,
      input.outletId,
      input.orderId,
      refundId,
      intentId,
      input.depositIdr,
      input.refundedAt,
    ],
  );
  return { refundId, intentId };
}
