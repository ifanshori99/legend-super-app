// Tenant opt-in for WhatsApp login replies (PRD v1.7 §3 F6; AUTH-03).
//
// Default is OFF: no row means disabled (WHATSAPP_LOGIN_REPLY_ENABLED_DEFAULT).
// The tenant may only LOWER the provider's free monthly quota (1.000 pesan per
// bulan), never raise it. The counter itself is advanced by
// wa-login-reply.service.ts; this file only reads it and edits the switch.
//
// Runs inside `withTenant` under the server-minted ScopedTenantContext, so RLS
// applies on top of the explicit tenant_id filters (TEN-02). Every real change
// writes an audit row in the same transaction; a no-op writes nothing.

import { eq } from "drizzle-orm";
import { WHATSAPP_LOGIN_REPLY_ENABLED_DEFAULT } from "@starter/shared/identity";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { waLoginReplyPolicies } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit, type AuditTransaction } from "./audit-writer.ts";
import { usageMonth } from "./platform-usage.service.ts";

export type LoginReplySettings = {
  enabled: boolean;
  freeMonthlyQuota: number;
  repliesThisMonth: number;
  month: string;
};

/** Provider free quota per month; a tenant may only set a lower value. */
const FREE_MONTHLY_QUOTA_MAX = 1000;

type PolicyRow = typeof waLoginReplyPolicies.$inferSelect;

function toSettings(row: PolicyRow | undefined, now: Date): LoginReplySettings {
  const month = usageMonth(now).month;
  return {
    enabled: row?.enabled ?? WHATSAPP_LOGIN_REPLY_ENABLED_DEFAULT,
    freeMonthlyQuota: row?.freeMonthlyQuota ?? FREE_MONTHLY_QUOTA_MAX,
    // A stored count from an earlier month no longer applies.
    repliesThisMonth:
      row && row.repliesMonth === month ? row.repliesThisMonth : 0,
    month,
  };
}

export async function getLoginReplySettings(
  context: ScopedTenantContext,
  now: Date = new Date(),
): Promise<LoginReplySettings> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(waLoginReplyPolicies)
      .where(eq(waLoginReplyPolicies.tenantId, context.tenant.tenantId))
      .limit(1);
    return toSettings(row, now);
  });
}

/**
 * Upserts the policy row. `actorUserId` is the verified session user (the
 * context carries no user); null records a system actor.
 */
export async function updateLoginReplySettings(
  context: ScopedTenantContext,
  input: { enabled: boolean; freeMonthlyQuota?: number },
  now: Date = new Date(),
  actorUserId: string | null = null,
): Promise<LoginReplySettings> {
  const { freeMonthlyQuota } = input;
  if (
    freeMonthlyQuota !== undefined &&
    (!Number.isInteger(freeMonthlyQuota) ||
      freeMonthlyQuota < 0 ||
      freeMonthlyQuota > FREE_MONTHLY_QUOTA_MAX)
  )
    throw new HttpError(
      400,
      "invalid_quota",
      `freeMonthlyQuota must be an integer from 0 to ${FREE_MONTHLY_QUOTA_MAX}`,
    );
  const tenantId = context.tenant.tenantId;

  return withTenant(db, context, async (tx) => {
    // FOR UPDATE locks nothing when no row exists, so two first PUTs would both
    // read the defaults as `before`. Make sure a default row exists first (the
    // loser of a race waits on the winner's insert), then lock it.
    await tx
      .insert(waLoginReplyPolicies)
      .values({
        tenantId,
        enabled: WHATSAPP_LOGIN_REPLY_ENABLED_DEFAULT,
        freeMonthlyQuota: FREE_MONTHLY_QUOTA_MAX,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: waLoginReplyPolicies.tenantId });
    const [existing] = await tx
      .select()
      .from(waLoginReplyPolicies)
      .where(eq(waLoginReplyPolicies.tenantId, tenantId))
      .for("update");

    const before = toSettings(existing, now);
    const nextQuota = freeMonthlyQuota ?? before.freeMonthlyQuota;
    const changed =
      before.enabled !== input.enabled || before.freeMonthlyQuota !== nextQuota;
    if (!changed) return before;

    const [row] = await tx
      .insert(waLoginReplyPolicies)
      .values({
        tenantId,
        enabled: input.enabled,
        freeMonthlyQuota: nextQuota,
        updatedBy: actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: waLoginReplyPolicies.tenantId,
        set: {
          enabled: input.enabled,
          freeMonthlyQuota: nextQuota,
          updatedBy: actorUserId,
          updatedAt: now,
        },
      })
      .returning();

    await recordAudit(
      {
        tenantId,
        outletId: null,
        actorType: actorUserId ? "user" : "system",
        actorId: actorUserId,
        deviceId: null,
        action: "wa_login_reply.settings_updated",
        objectType: "wa_login_reply_policy",
        objectId: tenantId,
        reason: null,
        before: {
          enabled: before.enabled,
          freeMonthlyQuota: before.freeMonthlyQuota,
        },
        after: { enabled: input.enabled, freeMonthlyQuota: nextQuota },
        sensitiveAccess: false,
      },
      { tx: tx as AuditTransaction, context },
    );

    return toSettings(row, now);
  });
}
