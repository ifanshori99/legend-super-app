import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  sentryDsn,
} from "@starter/shared/sentry";

// legend-17az7: browser error monitoring, opt-in. Without VITE_SENTRY_DSN the
// SDK is never even downloaded. A DSN is a public ingest key by design.
type SentryModule = {
  init: (options: Record<string, unknown>) => unknown;
};

export async function initWebSentry(options: {
  dsn: string | undefined;
  environment?: string;
  /** Injected by tests; defaults to a dynamic import of the SDK. */
  load?: () => Promise<SentryModule>;
}): Promise<boolean> {
  const dsn = sentryDsn(options.dsn);
  if (!dsn) return false;
  const sdk = await (options.load ?? (() => import("@sentry/react")))();
  sdk.init({
    dsn,
    environment: options.environment,
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
  });
  return true;
}
