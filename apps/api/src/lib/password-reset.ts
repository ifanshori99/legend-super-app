// Customer password reset by email (legend-1255). Better Auth issues the token
// (single use, `resetPasswordTokenExpiresIn`); this module only builds and
// sends the mail. It never logs the token, the link or the address: a log line
// is not a mailbox, and the sender's own error text carries a code only.

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { DEFAULT_ROLE } from "@starter/shared/permissions";
import { env } from "../config/env";
import { db } from "../db";
import { account, user } from "../db/schema";
import { isPlatformAdmin } from "../services/platform-support.service";
import { getEmailSender, resolveAccountEmailFrom } from "./email-sender";
import { logger } from "./logger";

const resetLog = logger.child({ module: "password-reset" });

/** One hour, the lifetime the founder asked for (card 1255). */
export const PASSWORD_RESET_TOKEN_SECONDS = 60 * 60;

/** The reserved placeholder domain (WhatsApp-only accounts) is never a mailbox. */
function isReservedAddress(email: string): boolean {
  return email.toLowerCase().endsWith(".invalid");
}

/**
 * Where the emailed link points: the requesting page's own origin when it is
 * a trusted one (a tenant on its own domain), otherwise WEB_URL. The Origin
 * header is only a pick from `env.trustedOrigins`, never echoed as-is.
 */
function linkOrigin(request: Request | undefined): string {
  const origin = request?.headers.get("origin");
  if (origin && env.trustedOrigins.includes(origin)) return origin;
  return new URL(env.WEB_URL).origin;
}

/**
 * True when the account is linked to staff in ANY tenant: a role assignment
 * that has not ended (a future `valid_from` counts: the person is about to be
 * staff, so the stricter reading wins) or an `employees` row (any status).
 * Both tables force row level security, so each tenant is probed under its own
 * scope in one transaction (same walk as app.user_has_role_assignment, 0221,
 * which ignores assignments that start later and so is not enough here).
 */
async function hasStaffLink(userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const tenantRows = await tx.execute(sql`SELECT id FROM public.tenants`);
    for (const tenant of tenantRows.rows) {
      await tx.execute(
        sql`SELECT set_config('app.tenant_id', ${String(tenant.id)}, true), set_config('app.outlet_ids', '*', true)`,
      );
      const found = await tx.execute(sql`
        SELECT (
          EXISTS (SELECT 1 FROM public.role_assignments
                  WHERE user_id = ${userId}
                    AND (valid_until IS NULL OR valid_until > now()))
          OR EXISTS (SELECT 1 FROM public.employees WHERE user_id = ${userId})
        ) AS linked
      `);
      if (found.rows[0]?.linked !== false) return true;
    }
    return false;
  });
}

/**
 * Reset by email is for customers only (CTO decision, card 1255). A staff,
 * management or admin account is never mailed, and neither is an account with
 * no password credential (Google only): a mailbox must not be a way into the
 * back office, and there is no password to reset. The caller answers the same
 * either way, so this never shows in the response. Fails closed: any error
 * reading the facts means "not a customer". The reset step asks again (a
 * token asked for before a promotion must not outlive it).
 */
export async function isCustomerPasswordAccount(
  userId: string,
): Promise<boolean> {
  try {
    const [row] = await db
      .select({ role: user.role })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .where(
        and(
          eq(account.userId, userId),
          eq(account.providerId, "credential"),
          isNotNull(account.password),
        ),
      )
      .limit(1);
    if (!row) return false;
    const roles = (row.role ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "" && part !== DEFAULT_ROLE);
    if (roles.length > 0) return false;
    if (await isPlatformAdmin(userId)) return false;
    return !(await hasStaffLink(userId));
  } catch (error) {
    resetLog.error(
      { err: error instanceof Error ? error.message : "check failed" },
      "password reset eligibility could not be read",
    );
    return false;
  }
}

const pendingMail = new Set<Promise<void>>();

/** Resolves when every reset mail started so far has been sent or dropped. */
export async function flushPasswordResetMail(): Promise<void> {
  while (pendingMail.size > 0) await Promise.all([...pendingMail]);
}

/** True when this deployment can send the reset mail at all. */
export function passwordResetAvailable(): boolean {
  return getEmailSender() !== null;
}

/**
 * Better Auth `sendResetPassword`. It resolves without waiting for the mail:
 * the caller must answer a known and an unknown address in the same time, so
 * a slow SMTP server never tells which addresses have an account. A failed
 * send is logged without the address and never reaches the caller.
 */
export function sendPasswordResetEmail(
  data: { user: { id: string; email: string }; token: string },
  request?: Request,
): Promise<void> {
  const sender = getEmailSender();
  const to = data.user.email;
  if (sender === null || isReservedAddress(to)) return Promise.resolve();
  const link = `${linkOrigin(request)}/reset-password?token=${encodeURIComponent(data.token)}`;
  const job = (async () => {
    try {
      if (!(await isCustomerPasswordAccount(data.user.id))) return;
      const from = await resolveAccountEmailFrom();
      if (from === null) return;
      await sender.send({
        from,
        to,
        subject: "Atur ulang kata sandi",
        text: [
          "Halo,",
          "",
          "Kami menerima permintaan untuk mengatur ulang kata sandi akunmu.",
          "Buka tautan ini dalam 1 jam untuk memilih kata sandi baru:",
          link,
          "",
          "Tautan hanya bisa dipakai sekali. Kalau bukan kamu yang meminta, abaikan email ini; kata sandimu tidak berubah.",
        ].join("\n"),
        html: [
          "<p>Halo,</p>",
          "<p>Kami menerima permintaan untuk mengatur ulang kata sandi akunmu.</p>",
          `<p><a href="${link}">Pilih kata sandi baru</a> (berlaku 1 jam, hanya bisa dipakai sekali).</p>`,
          "<p>Kalau bukan kamu yang meminta, abaikan email ini; kata sandimu tidak berubah.</p>",
        ].join(""),
      });
    } catch (error) {
      resetLog.error(
        { err: error instanceof Error ? error.message : "send failed" },
        "password reset mail could not be sent",
      );
    }
  })();
  pendingMail.add(job);
  void job.finally(() => pendingMail.delete(job));
  return Promise.resolve();
}
