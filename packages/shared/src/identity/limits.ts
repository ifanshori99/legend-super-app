// Identity policy numbers (PRD v1.7 §3 F6/F7; AUTH-01..07). Constants only, no
// dependencies, so schemas, machines and inputs can all read them.
//
// Numbers the PRD names are cited inline. Numbers the PRD leaves open are the
// safest defaults we picked; they are configuration for a later settings bead,
// never hard-coded per tenant in feature code (TEN-07).

/** AUTH-01: a WhatsApp login code is valid for five minutes. */
export const LOGIN_CODE_TTL_MINUTES = 5;

/**
 * PRD is silent on the email link. 15 minutes matches the 119connect flow and
 * is short enough that a forwarded mailbox copy goes stale quickly.
 */
export const MAGIC_LINK_TTL_MINUTES = 15;

/**
 * PRD is silent on the Google OAuth state window. The round trip is immediate,
 * so 10 minutes is generous without keeping an abandoned state alive.
 */
export const GOOGLE_CHALLENGE_TTL_MINUTES = 10;

/** AUTH-04: at most 5 active challenges per device or IP in a 15-minute window. */
export const CHALLENGE_RATE_LIMIT = 5;
export const CHALLENGE_RATE_WINDOW_MINUTES = 15;

/** AUTH-04: at most 10 login messages per WhatsApp number per hour. */
export const LOGIN_MESSAGE_RATE_LIMIT = 10;
export const LOGIN_MESSAGE_RATE_WINDOW_MINUTES = 60;

/** §3 F6 "Sesi & Perangkat": a customer session lasts 90 days. */
export const CUSTOMER_SESSION_DAYS = 90;

/** §3 F6 "Sesi & Perangkat": a management session ends after 30 idle minutes. */
export const MANAGEMENT_IDLE_MINUTES = 30;

/** How long before the idle end the web app warns the user ("Sesi akan berakhir"). */
export const SESSION_IDLE_WARNING_MINUTES = 2;

/**
 * Activity is written to the session at most once per minute, so a busy screen
 * does not cost one database write per request. A background poll never counts
 * as activity and can only make a session end sooner.
 */
export const SESSION_ACTIVITY_WRITE_SECONDS = 60;

/** §3 F6 "Staf — PIN Perangkat": a personal 6-digit pin, locked after 5 misses. */
export const STAFF_PIN_LENGTH = 6;
export const MAX_STAFF_PIN_ATTEMPTS = 5;

/**
 * PRD says the pin locks but names no release. 15 minutes is the default;
 * a supervisor override (AUTH-06) may clear it immediately, which is the path
 * a cashier mid-shift uses.
 */
export const STAFF_PIN_LOCK_MINUTES = 15;

/**
 * §3 F7 "Kotak Approval" asks for a deadline but names no number. Every request
 * carries `deadlineAt`; the service stamps `createdAt + this` unless tenant
 * settings provide a value. An expired request blocks the action (fail closed).
 */
export const APPROVAL_DEADLINE_MINUTES = 60;

/**
 * AUTH-03: the system sends no WhatsApp reply by default. If a tenant turns
 * replies on, the service counts them against the provider's free monthly
 * quota and stops at the cap; the counter lives in tenant settings.
 */
export const WHATSAPP_LOGIN_REPLY_ENABLED_DEFAULT = false;

/** 90 * 24 * 60 * 60 * 1000; named so session maths reads as days, not magic. */
export const DAY_MS = 86_400_000;

/** 60 * 1000, the unit of the minute constants above. */
export const MINUTE_MS = 60_000;
