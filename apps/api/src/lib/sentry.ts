import * as Sentry from "@sentry/node";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  sentryDsn,
} from "@starter/shared/sentry";

// legend-17az7: opt-in error monitoring. Without SENTRY_DSN nothing is
// initialised and every capture below is a no-op.
let active = false;

type InitFn = (options: Record<string, unknown>) => unknown;

export function initSentry(options: {
  dsn: string | undefined;
  environment?: string;
  /** Injected by tests; defaults to the SDK. */
  init?: InitFn;
}): boolean {
  const dsn = sentryDsn(options.dsn);
  if (!dsn) return false;
  (options.init ?? (Sentry.init as InitFn))({
    dsn,
    environment: options.environment,
    // No IP, cookies, or user identity from the SDK; the filters below drop
    // whatever else reaches an event (cookies, auth headers, body, query,
    // email, phone).
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
  });
  active = true;
  return true;
}

/** Reports an unexpected server error; does nothing when monitoring is off. */
export function captureServerError(error: unknown): void {
  if (!active) return;
  Sentry.captureException(error);
}
