// Customer password reset by email (legend-1255). Better Auth issues the token
// (single use, `resetPasswordTokenExpiresIn`); this module only builds and
// sends the mail. It never logs the token, the link or the address: a log line
// is not a mailbox, and the sender's own error text carries a code only.

import { getEmailSender, resolveAccountEmailFrom } from "./email-sender";
import { env } from "../config/env";
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
  data: { user: { email: string }; token: string },
  request?: Request,
): Promise<void> {
  const sender = getEmailSender();
  const to = data.user.email;
  if (sender === null || isReservedAddress(to)) return Promise.resolve();
  const link = `${linkOrigin(request)}/reset-password?token=${encodeURIComponent(data.token)}`;
  void (async () => {
    try {
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
