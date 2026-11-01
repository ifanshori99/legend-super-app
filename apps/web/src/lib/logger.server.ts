import { createRequire } from "node:module";
import pino from "pino";
import { getRequestContext } from "@/lib/request-context.server";

const production = process.env.NODE_ENV === "production";

// Injected by vite.config.ts: true only for `vite dev`. Pretty output needs
// pino's transport, which runs pino-pretty on a worker thread (thread-stream);
// a bundled server cannot load it, because thread-stream uses `__dirname` and
// Nitro emits ES modules. Gating on NODE_ENV would depend on which NODE_ENV
// built the bundle (`pnpm test:e2e` used to build with NODE_ENV=test), and
// import.meta.env.DEV stays true in this app's SSR build.
declare const __WEB_DEV_SERVER__: boolean;

// The web server's structured logger: JSON lines in production, pino-pretty in
// development. Every line written during a request carries its reqId — the
// same one forwarded to the API — so one ID traces an SSR render end to end.
export const logger = pino({
  level: process.env.LOG_LEVEL || (production ? "info" : "debug"),
  base: { service: "web", env: process.env.NODE_ENV ?? "development" },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const context = getRequestContext();
    return context ? { reqId: context.reqId } : {};
  },
  redact: {
    paths: ["*.cookie", "*.authorization", '*["set-cookie"]'],
    censor: "[redacted]",
  },
  ...(__WEB_DEV_SERVER__
    ? {
        transport: {
          // Absolute path: under pnpm, pino itself cannot see this package's
          // devDependency, and Vite's SSR runner hides the calling file.
          target: createRequire(import.meta.url).resolve("pino-pretty"),
          options: {
            colorize: true,
            singleLine: true,
            translateTime: "SYS:HH:MM:ss.l",
            ignore: "pid,hostname,service,env",
            messageFormat: "[web] {msg}",
          },
        },
      }
    : {}),
});
