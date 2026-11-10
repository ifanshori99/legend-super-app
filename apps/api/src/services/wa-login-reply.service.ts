// legend-dn4 (AUTH-03, PRD §3 F6): optional WhatsApp reply to a login message.
//
// Default off: a tenant without an enabled `wa_login_reply_policies` row never
// sends anything. When enabled, each reply takes one slot of the tenant's
// monthly free quota (provider free quota 1.000 messages/month; the tenant may
// only lower it). The slot is claimed by ONE conditional UPDATE, so parallel
// replies can never exceed the quota, and the month rolls over inside that
// same statement (Asia/Jakarta month, `usageMonth`).
//
// There is no real WhatsApp send adapter yet: the sender is an injected
// function. No sender means nothing is claimed and nothing is sent.

import { sql } from "drizzle-orm";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { logger } from "../lib/logger";
import { mergedReplyText } from "./identity-merge.service.ts";
import { usageMonth } from "./platform-usage.service.ts";

/** Default time limit around the sender call. */
export const LOGIN_REPLY_SEND_TIMEOUT_MS = 5000;

export type LoginReplyKind = "success" | "error" | "merged";

export type LoginReplySender = (input: {
  tenantId: string;
  receivingNumber: string;
  to: string;
  reference: string;
  text: string;
}) => Promise<void>;

/**
 * Reply wording. The error text is the same for every refusal cause: it never
 * says whether a number or an account exists (§3 F6).
 */
export function loginReplyText(
  kind: LoginReplyKind,
  maskedEmail?: string | null,
): string {
  if (kind === "merged") return mergedReplyText(maskedEmail ?? null);
  if (kind === "success")
    return "Login berhasil. Silakan kembali ke browser Anda untuk melanjutkan.";
  return "Login gagal. Kode tidak valid, sudah kedaluwarsa, atau sudah dipakai. Silakan minta kode baru dari halaman login.";
}

function replyContext(tenantId: string, brandId: string | null) {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId, source: "webhook" }),
    { kind: "tenant" },
  );
}

async function claimSlot(
  tenantId: string,
  brandId: string | null,
  now: Date,
): Promise<boolean> {
  const { month } = usageMonth(now);
  return withTenant(db, replyContext(tenantId, brandId), async (tx) => {
    const result = await tx.execute(sql`
      UPDATE wa_login_reply_policies
      SET replies_this_month = CASE
            WHEN replies_month IS NOT DISTINCT FROM ${month}
              THEN replies_this_month + 1
            ELSE 1
          END,
          replies_month = ${month},
          updated_at = ${now.toISOString()}::timestamptz
      WHERE tenant_id = ${tenantId}::uuid
        AND enabled
        AND (
          CASE
            WHEN replies_month IS NOT DISTINCT FROM ${month}
              THEN replies_this_month
            ELSE 0
          END
        ) < free_monthly_quota
      RETURNING tenant_id
    `);
    return result.rows.length === 1;
  });
}

/** Atomic: one UPDATE ... WHERE enabled AND (month-aware count) < quota RETURNING. true = a slot was taken. */
export async function claimLoginReplySlot(
  tenantId: string,
  now: Date,
): Promise<boolean> {
  return claimSlot(tenantId, null, now);
}

/** Claim then send. Never throws; send failure is swallowed (slot stays used). false = nothing sent. */
export async function sendLoginReply(input: {
  sender: LoginReplySender | undefined;
  tenantId: string;
  brandId: string | null;
  receivingNumber: string;
  to: string;
  eventId: string;
  kind: LoginReplyKind;
  maskedEmail?: string | null;
  now: Date;
  /** Send time limit in ms; default LOGIN_REPLY_SEND_TIMEOUT_MS. */
  sendTimeoutMs?: number;
}): Promise<boolean> {
  // No sender: return before claiming, so no quota is used.
  if (!input.sender) return false;
  try {
    if (!(await claimSlot(input.tenantId, input.brandId, input.now)))
      return false;
  } catch (error) {
    logger.warn(
      { err: error, tenantId: input.tenantId },
      "login reply slot claim failed",
    );
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A hung sender must not hold the caller: time out like any send failure.
    await Promise.race([
      input.sender({
        tenantId: input.tenantId,
        receivingNumber: input.receivingNumber,
        to: input.to,
        reference: `login-reply:${input.eventId}`,
        text: loginReplyText(input.kind, input.maskedEmail),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("login reply send timed out")),
          input.sendTimeoutMs ?? LOGIN_REPLY_SEND_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch (error) {
    // The slot stays used: the provider may have accepted the message.
    logger.warn(
      { err: error, tenantId: input.tenantId },
      "login reply send failed",
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}
