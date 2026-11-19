import { createAppPool } from "./role";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../config/env";
import { SqlLogger } from "../lib/db-logger";
import { logger } from "../lib/logger";
import * as schema from "./schema";

// One pool per process. `pnpm dev` restarts the process on change, and
// server.ts ends the pool on shutdown, so reloads never leak connections.
export const pool = createAppPool(env.APP_DATABASE_URL ?? env.DATABASE_URL, {
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  logger.error(
    { err, module: "db" },
    "An idle PostgreSQL connection was lost. Check database availability.",
  );
});

// A backend ended while its connection is checked out (pg_terminate_backend, a
// restart) emits 'error' on that client; without a listener it would crash the
// process. Log the error name only, never the message or any query data.
pool.on("connect", (client) => {
  client.on("error", (err) => {
    logger.error(
      { errorName: err.name, module: "db" },
      "A checked-out PostgreSQL connection was lost.",
    );
  });
});

export const db = drizzle(pool, {
  schema,
  logger: env.LOG_SQL ? new SqlLogger() : false,
});

export async function checkDatabase() {
  await pool.query("SELECT 1");
}
