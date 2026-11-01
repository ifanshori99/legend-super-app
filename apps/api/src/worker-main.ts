import "./load-env";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { databaseUrl } from "./db/connection";
import {
  createPgBoss,
  createWorkerRuntime,
  type OutboxJob,
} from "./worker/runtime";

// This module is a deployment-owned adapter, never supplied by an HTTP request.
// It must resolve tenants from a trusted registry and recheck each job's permissions.
const modulePath = process.env.WORKER_CONFIG_MODULE;
if (!modulePath)
  throw new Error(
    "WORKER_CONFIG_MODULE is required; no tenant resolver or consumer is configured",
  );
const config: unknown = await import(pathToFileURL(resolve(modulePath)).href);
if (
  typeof config !== "object" ||
  config === null ||
  !("resolveContext" in config) ||
  typeof config.resolveContext !== "function" ||
  !("authorize" in config) ||
  typeof config.authorize !== "function" ||
  !("deliver" in config) ||
  typeof config.deliver !== "function"
) {
  throw new Error(
    "Worker configuration must export resolveContext, authorize, and deliver functions",
  );
}
const handlers = config as {
  resolveContext: (tenantId: OutboxJob["tenantId"]) => Promise<unknown>;
  authorize: (context: unknown, job: OutboxJob) => Promise<boolean>;
  deliver: (context: unknown, job: OutboxJob) => Promise<void>;
};
const runtime = createWorkerRuntime({
  boss: createPgBoss(
    databaseUrl(process.env.WORKER_DATABASE_URL ?? process.env.DATABASE_URL),
  ),
  ...handlers,
});
await runtime.start();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runtime.stop();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
