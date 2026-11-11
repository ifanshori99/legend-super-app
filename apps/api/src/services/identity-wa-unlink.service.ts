// Audited WhatsApp unlink by staff (bead legend-7wzy; PRD v1.7 §3 F6 "Graf
// Identitas Pelanggan", §6 B audit_logs / user_identities; TEN-01..03).
//
// One number is one account across tenants, so `user_identities` is global and
// staff of one tenant must never delete it: that would end the person's WhatsApp
// login, payslip PIN and owner login in every other tenant. The unlink only
// clears the link on THIS tenant's customer profile (whatsapp_hash and
// whatsapp_verified_at). The profile then stops matching the POS phone lookup
// and frees the number for a new profile of this tenant. Deleting the global
// identity belongs to the account owner (step-up) or platform support, not here.
//
// The identity is only reachable through a customer profile of the caller's
// tenant that carries that number: anything else reads as not found, so nothing
// leaks across tenants. The profile update and the audit row share one tenant
// transaction; when the audit insert fails the unlink rolls back. The audit row
// names the actor, the customer, the outlet and the reason, and keeps only the
// masked sender (last three digits), never the number, digest or ciphertext.

import { and, eq, sql } from "drizzle-orm";
import { createUlid } from "@starter/shared/core";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db";
import { userIdentities } from "../db/schema";
import { customerProfiles } from "../db/schema/crm-member";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { openSecret } from "../lib/secrets";
import { recordAudit } from "./core-audit";
import { maskSenderForAudit } from "./identity-wa-audit";

export const IDENTITY_UNLINK_AUDIT_ACTION = "identity.unlinked";

/** The only `maskedChanges` keys the unlink row keeps. */
const UNLINK_AUDIT_SAFE_FIELDS = [
  "channel",
  "status",
  "customerUserId",
  "senderMasked",
] as const;

function notFound(): HttpError {
  return new HttpError(
    404,
    "IDENTITY_NOT_FOUND",
    "Nomor WhatsApp pelanggan tidak ditemukan.",
  );
}

export async function unlinkWhatsAppIdentity(
  context: ScopedTenantContext,
  input: {
    readonly actorUserId: string;
    readonly outletId: string;
    readonly customerUserId: string;
    readonly identityId: string;
    readonly reason: string;
  },
  now = new Date(),
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  await withTenant(db, context, async (tx) => {
    // The global identity is only read, never changed.
    const [identity] = await tx
      .select({
        valueHash: userIdentities.valueHash,
        valueEncrypted: userIdentities.valueEncrypted,
      })
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.id, input.identityId),
          eq(userIdentities.userId, input.customerUserId),
          eq(userIdentities.type, "whatsapp"),
        ),
      )
      .limit(1);
    if (!identity) throw notFound();

    // UPDATE ... RETURNING is the single winner of a double submit. Only this
    // tenant's profile of that customer, and only while it still carries this
    // number, so a second call or another tenant's profile reads as not found.
    // An active profile needs a verified number (customer_profiles_active_
    // verified_check), so it goes back to pending_verification.
    const [cleared] = await tx
      .update(customerProfiles)
      .set({
        whatsappHash: null,
        whatsappVerifiedAt: null,
        membershipStatus: sql`CASE WHEN ${customerProfiles.membershipStatus} = 'active' THEN 'pending_verification' ELSE ${customerProfiles.membershipStatus} END`,
        updatedAt: now,
      })
      .where(
        and(
          eq(customerProfiles.tenantId, tenantId),
          eq(customerProfiles.userId, input.customerUserId),
          eq(customerProfiles.whatsappHash, identity.valueHash),
        ),
      )
      .returning({ id: customerProfiles.id });
    if (!cleared) throw notFound();
    let senderMasked: string | null = null;
    if (identity.valueEncrypted) {
      try {
        senderMasked = maskSenderForAudit(
          openSecret(
            identity.valueEncrypted,
            `user_identity:whatsapp:${identity.valueHash}`,
          ),
        );
      } catch {
        senderMasked = null;
      }
    }

    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId: input.outletId,
        actorType: "user",
        actorId: input.actorUserId,
        deviceId: null,
        action: IDENTITY_UNLINK_AUDIT_ACTION,
        objectType: "user_identity",
        objectId: input.identityId,
        reason: input.reason,
        maskedChanges: {
          before: {
            channel: "whatsapp",
            status: "linked",
            customerUserId: input.customerUserId,
            senderMasked,
          },
          after: {
            channel: "whatsapp",
            status: "unlinked",
            customerUserId: input.customerUserId,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      UNLINK_AUDIT_SAFE_FIELDS,
    );
  });
}
