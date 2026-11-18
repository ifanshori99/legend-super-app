// A member QR for redeeming points at the POS (weexf): a bill whose member was
// attached by a scanned QR only redeems with a token minted for that order and
// amount. Existing points tests call this so they keep proving their own rule.
import { ulidToUuid } from "@starter/shared/core";
import { issueMemberQrToken } from "../lib/member-qr-token.ts";
import { asTenant } from "./member-loyalty-helpers.ts";

/**
 * A fresh token for the member on `orderId` when that member came by QR and the
 * amount is a real number of points; undefined otherwise (nothing to prove).
 */
export async function memberQrFor(
  tenantId: string,
  orderId: string,
  points: unknown,
): Promise<string | undefined> {
  if (
    typeof points !== "number" ||
    !Number.isSafeInteger(points) ||
    points <= 0
  )
    return undefined;
  const { rows } = await asTenant(tenantId, (client) =>
    client.query<{ customer_profile_id: string | null; via: string | null }>(
      `SELECT customer_profile_id, customer_attached_via AS via
         FROM orders WHERE tenant_id = $1 AND id = $2`,
      [tenantId, ulidToUuid(orderId)],
    ),
  );
  const row = rows[0];
  if (!row?.customer_profile_id || row.via !== "member_qr") return undefined;
  return issueMemberQrToken(
    {
      tenantId,
      customerProfileId: row.customer_profile_id,
      orderId,
      points,
    },
    new Date(),
  ).token;
}
