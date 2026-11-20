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
 * Reset by email is for customers only (CTO decision, card 1255). A staff,
 * management or admin account is never mailed, and neither is an account with
 * no password credential (Google only): a mailbox must not be a way into the
 * back office, and there is no password to reset. The caller answers the same
 * either way, so this never shows in the response. Fails closed: any error
 * reading the facts means no mail.
 */
export async function isCustomerPasswordAccount(
  userId: string,
): Promise<boolean> {
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
  const assigned = await db.execute(
    sql`SELECT app.user_has_role_assignment(${userId}) AS has_role`,
  );
  return assigned.rows[0]?.has_role === false;
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
  void (async () => {
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
  return Promise.resolve();
}
