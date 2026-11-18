import pino, { type DestinationStream, type Level } from "pino";
import { env } from "../config/env";
import pkg from "../../package.json" with { type: "json" };
import { getRequestContext } from "./request-context";
import { toLoggableError } from "./safe-error";

type LoggerOptions = {
  level?: Level | "silent";
  // A custom stream (tests capture output this way). Disables pretty printing.
  destination?: DestinationStream;
};

const CARD_FIELDS = [
  "pan",
  "cardNumber",
  "card_number",
  "track",
  "track1",
  "track2",
  "trackData",
  "track_data",
  "cvv",
  "cvc",
  "cvv2",
  "pinBlock",
  "pin_block",
];
// Top level and one level down, like the other paths (pino redact wildcards
// match a single level).
const cardFieldPaths = CARD_FIELDS.flatMap((field) => [field, `*.${field}`]);

/** pino `err` serializer: database errors are rebuilt without row values
 * first (lib/safe-error.ts). pino-http sets its own `err` serializer on the
 * request logger, so app.ts passes this one there too. pino-http wraps a
 * custom err serializer so it receives the standard serializer's output, which
 * already holds the row values in message and stack: start again from the
 * original error that output keeps on its non-enumerable `raw`. */
export const serializeError = (error: unknown) => {
  const raw =
    !(error instanceof Error) && typeof error === "object" && error !== null
      ? (error as { raw?: unknown }).raw
      : undefined;
  return pino.stdSerializers.err(
    toLoggableError(raw instanceof Error ? raw : error) as Error,
  );
};

// One structured logger for the whole API.
// - Production: one JSON object per line on stdout, ready for any collector.
// - Development: pino-pretty, colorized and single-line.
// - Tests: silent unless LOG_LEVEL says otherwise.
export function createLogger({
  level = env.logLevel,
  destination,
}: LoggerOptions = {}) {
  const pretty = !destination && !env.isProduction && !env.isTest;
  return pino(
    {
      level,
      base: { service: "api", env: env.NODE_ENV, version: pkg.version },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Request correlation without threading `req` through services.
      mixin() {
        const context = getRequestContext();
        if (!context) return {};
        return context.userId
          ? { reqId: context.reqId, userId: context.userId }
          : { reqId: context.reqId };
      },
      // Database errors are rebuilt without row values before they are
      // serialized (lib/safe-error.ts).
      serializers: { err: serializeError },
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          'req.headers["x-acting-staff"]',
          'req.headers["x-device-token"]',
          // legend-dsbqr: a browser KDS socket carries its device and cashier
          // tokens as Sec-WebSocket-Protocol entries.
          'req.headers["sec-websocket-protocol"]',
          'res.headers["set-cookie"]',
          "*.password",
          "*.newPassword",
          "*.currentPassword",
          "*.token",
          "*.secret",
          "*.payerSecret",
          "req.body.payerSecret",
          // Card data (legend-8gsj): never logged on purpose, redacted in case
          // a terminal answer or request object ever is.
          ...cardFieldPaths,
        ],
        censor: "[redacted]",
      },
      ...(pretty
        ? {
            transport: {
              target: "pino-pretty",
              options: {
                colorize: true,
                singleLine: true,
                translateTime: "SYS:HH:MM:ss.l",
                // The access-log message already says "GET /path 200 12ms".
                ignore: "pid,hostname,service,env,version,req,res,responseTime",
              },
            },
          }
        : {}),
    },
    destination,
  );
}

export const logger = createLogger();

export type Logger = ReturnType<typeof createLogger>;
