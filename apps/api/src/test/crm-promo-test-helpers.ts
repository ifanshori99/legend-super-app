import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { PromoCustomer } from "@starter/shared/crm";

/** Promo customer references use persisted members, like the checkout ports. */
export async function seedPromoCustomer(
  client: PoolClient,
  tenantId: string,
  id = randomUUID(),
): Promise<PromoCustomer> {
  await client.query(
    `INSERT INTO customer_profiles
       (id, tenant_id, user_id, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, $3, 'Promo member', 'active', now())`,
    [id, tenantId, randomUUID()],
  );
  return { customerProfileId: id, tierId: null, isMember: true };
}

/** Facility rewards must refer to a product sold by the issuing outlet. */
export async function seedPromoFacilityProduct(
  client: PoolClient,
  tenantId: string,
  outletId: string,
  type: "shower" | "coworking" = "shower",
): Promise<string> {
  const facilityId = randomUUID();
  const productId = randomUUID();
  await client.query(
    `INSERT INTO facilities
       (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
        arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
     VALUES ($1, $2, $3, 'Promo shower', $4, 20, 10, 10,
       '[{"daysOfWeek":[0,1,2,3,4,5,6],"opensAt":"00:00","closesAt":"23:59"}]',
       '{"graceMinutes":5,"blockMinutes":15,"feePerBlockIdr":5000}',
       '{"freeCancelMinutesBefore":30,"lateCancelResolution":"no_refund","lateCancelFeeIdr":0,"noShowResolution":"no_refund"}')`,
    [facilityId, tenantId, outletId, type],
  );
  await client.query(
    `INSERT INTO facility_products
       (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions)
     VALUES ($1, $2, $3, $4, 'Promo shower access', 'single', 20000, 1)`,
    [productId, tenantId, outletId, facilityId],
  );
  return productId;
}
