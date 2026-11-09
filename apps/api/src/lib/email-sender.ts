// Transactional email port for the sign-in link (legend-k2l; PRD v1.7 §3 F6
// "Email magic link", AUTH-01).
//
// The login service depends on this interface, not on a provider, so a test can
// capture the message and a deployment without email stays honest about it:
// `getEmailSender()` returns null and the route answers EMAIL_NOT_CONFIGURED
// (503) before it writes anything.
//
// Default wiring:
// - NOTIFICATION_EMAIL_PROVIDER=brevo with BREVO_API_KEY and
//   NOTIFICATION_EMAIL_FROM set -> Brevo's HTTP API. It is the same provider
//   the notification worker uses (worker/notification-adapters.ts), but the
//   worker's adapter is outbox-shaped (idempotency key, retry classes); a
//   sign-in mail is sent inline once, so this is a thin fetch with a 10 s cap.
// - otherwise, production -> null (not configured);
// - otherwise (development, test) -> a logging sender that records the masked
//   recipient and NEVER the link or the token: a log line is not a mailbox.
//
// The error text of a failed send carries the HTTP status only, never the
// provider body or the recipient.

import { maskEmail } from "@starter/shared/identity";
import { env } from "../config/env";
import { logger } from "./logger";

const emailLog = logger.child({ module: "email-sender" });

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const BREVO_TIMEOUT_MS = 10_000;

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

function createBrevoSender(config: {
  apiKey: string;
  from: string;
  fromName?: string;
}): EmailSender {
  return {
    async send(message) {
      const response = await fetch(BREVO_ENDPOINT, {
        method: "POST",
        headers: {
          "api-key": config.apiKey,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sender: {
            email: config.from,
            ...(config.fromName ? { name: config.fromName } : {}),
          },
          to: [{ email: message.to }],
          subject: message.subject,
          textContent: message.text,
          htmlContent: message.html,
        }),
        signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
      });
      if (!response.ok)
        throw new Error(
          `Brevo email request failed with status ${response.status}`,
        );
    },
  };
}

/** Development and test: proves a mail was "sent" without leaking its link. */
const loggingSender: EmailSender = {
  async send(message) {
    emailLog.info(
      { to: maskEmail(message.to) },
      "email not configured; message logged without its content",
    );
  },
};

/** `undefined` = the environment default; `null` = forced "not configured". */
let override: EmailSender | null | undefined;

/** The configured sender, or null when this deployment cannot send email. */
export function getEmailSender(): EmailSender | null {
  if (override !== undefined) return override;
  if (
    env.NOTIFICATION_EMAIL_PROVIDER === "brevo" &&
    env.BREVO_API_KEY &&
    env.NOTIFICATION_EMAIL_FROM
  )
    return createBrevoSender({
      apiKey: env.BREVO_API_KEY,
      from: env.NOTIFICATION_EMAIL_FROM,
      fromName: env.NOTIFICATION_EMAIL_FROM_NAME,
    });
  return env.isProduction ? null : loggingSender;
}

/** Test seam: a capturing sender, null for "not configured", undefined to reset. */
export function setEmailSenderForTests(
  sender: EmailSender | null | undefined,
): void {
  override = sender;
}
