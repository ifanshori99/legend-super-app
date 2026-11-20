// Transactional email port for the sign-in link (legend-k2l; PRD v1.7 §3 F6
// "Email magic link", AUTH-01).
//
// The login service depends on this interface, not on a provider, so a test can
// capture the message and a deployment without email stays honest about it:
// `getEmailSender()` returns null and the route answers EMAIL_NOT_CONFIGURED
// (503) before it writes anything.
//
// Default wiring:
// - SMTP_HOST, SMTP_USER, SMTP_PASS (and EMAIL_FROM) set -> an SMTP sender
//   built once with nodemailer (SumoPod: smtp.sumopod.com, port 465, implicit
//   TLS). Port 465 uses `secure`; a non-secure port requires STARTTLS.
// - otherwise, production -> null (not configured);
// - otherwise (development, test) -> a logging sender that records the masked
//   recipient and NEVER the link or the token: a log line is not a mailbox.
//
// The error text of a failed send carries the nodemailer error code only
// (e.g. EAUTH), never the recipient, the password or the server's reply.

import { maskEmail } from "@starter/shared/identity";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { env } from "../config/env";
import { logger } from "./logger";

const emailLog = logger.child({ module: "email-sender" });

const SMTP_TIMEOUT_MS = 10_000;

export type EmailMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
};

/** The SMTP settings, or null unless host, user and password are all set. */
export function smtpConfigFromEnv(values: {
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_SECURE?: boolean;
  SMTP_USER?: string;
  SMTP_PASS?: string;
}): SmtpConfig | null {
  if (!values.SMTP_HOST || !values.SMTP_USER || !values.SMTP_PASS) return null;
  return {
    host: values.SMTP_HOST,
    port: values.SMTP_PORT ?? 465,
    secure: values.SMTP_SECURE ?? true,
    user: values.SMTP_USER,
    pass: values.SMTP_PASS,
  };
}

type SmtpTransport = {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<unknown>;
};

export function createSmtpSender(
  config: SmtpConfig,
  deps: {
    createTransport?: (options: SMTPTransport.Options) => SmtpTransport;
  } = {},
): EmailSender {
  const createTransport = deps.createTransport ?? nodemailer.createTransport;
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    requireTLS: !config.secure,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  return {
    async send(message) {
      try {
        await transport.sendMail({
          from: message.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        throw new Error(
          "SMTP send failed" +
            (typeof code === "string" && code ? ` (${code})` : ""),
        );
      }
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
let smtpSender: EmailSender | undefined;

/** The configured sender, or null when this deployment cannot send email. */
export function getEmailSender(): EmailSender | null {
  if (override !== undefined) return override;
  const smtp = smtpConfigFromEnv(env);
  if (smtp !== null) {
    smtpSender ??= createSmtpSender(smtp);
    return smtpSender;
  }
  return env.isProduction ? null : loggingSender;
}

/** Test seam: a capturing sender, null for "not configured", undefined to reset. */
export function setEmailSenderForTests(
  sender: EmailSender | null | undefined,
): void {
  override = sender;
}

type EmailFromResolver = (tenantId: string) => Promise<string | null>;

let fromResolverOverride: EmailFromResolver | undefined;

/**
 * The sender address for a tenant's mail; null = no address, so email sign-in
 * is not configured. For now one platform-wide address. The per-brand domain
 * set by Super Admin (legend-m0mch) replaces this body; keep the signature.
 */
export async function resolveTenantEmailFrom(
  tenantId: string,
): Promise<string | null> {
  if (fromResolverOverride) return fromResolverOverride(tenantId);
  return (
    env.EMAIL_FROM ?? (env.isProduction ? null : "noreply@legend.localhost")
  );
}

/**
 * The sender address for mail that belongs to no tenant (account recovery:
 * the visitor has no session and the user row carries no tenant). Same
 * platform-wide address as resolveTenantEmailFrom; null = not configured.
 */
export async function resolveAccountEmailFrom(): Promise<string | null> {
  return (
    env.EMAIL_FROM ?? (env.isProduction ? null : "noreply@legend.localhost")
  );
}

/** Test seam for the resolver; undefined resets it. */
export function setEmailFromResolverForTests(
  fn: EmailFromResolver | undefined,
): void {
  fromResolverOverride = fn;
}
