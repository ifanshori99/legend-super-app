// A member QR for redeeming points at the POS (weexf): a bill whose member was
// attached by a scanned QR only redeems with a token minted for that order and
// amount. Existing points tests call this so they keep proving their own rule.
// legend-0ne0z: a redeem QR also binds the member's point-ledger version.
import { ulidToUuid } from "@starter/shared/core";
import { issueMemberQrToken } from "../lib/member-qr-token.ts";
import { asTenant } from "./member-loyalty-helpers.ts";

/** The member's point-ledger version (latest posting_seq), as the mint binds it. */
export async function ledgerVersionOf(
  tenantId: string,
  profileId: string,
): Promise<number> {
  const { rows } = await asTenant(tenantId, (client) =>
    client.query<{ version: string }>(
      `SELECT coalesce(max(posting_seq), 0) AS version
         FROM point_ledger WHERE tenant_id = $1 AND customer_profile_id = $2`,
      [tenantId, profileId],
    ),
  );
  return Number(rows[0]?.version ?? 0);
}

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
      ledgerVersion: await ledgerVersionOf(tenantId, row.customer_profile_id),
    },
    new Date(),
  ).token;
}
