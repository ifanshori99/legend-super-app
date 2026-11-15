import { setTimeout as delay } from "node:timers/promises";
import type { Client, Pool } from "pg";

interface DrainOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function endTestPool(pool: Pool): Promise<void> {
  if (pool.ended) return;

  // pg-pool removes idle clients from totalCount before Client.end() finishes.
  // Its end() promise alone therefore does not mean the sockets have closed.
  const expectedRemovals = pool.totalCount;
  const removed = new Set<Client>();
  const errors: Error[] = [];
  let resolveRemoved: () => void;
  let rejectRemoved: (error: Error) => void;
  const allRemoved = new Promise<void>((resolve, reject) => {
    resolveRemoved = resolve;
    rejectRemoved = reject;
  });
  const onRemove = (client: Client) => {
    removed.add(client);
    if (removed.size >= expectedRemovals) resolveRemoved();
  };
  const onError = (error: Error) => {
    // This listener sees only errors from clients owned by this pool. In
    // particular, 57P01 is reported as a cleanup failure, never swallowed or
    // allowed to escape as an unhandled idle-client error during shutdown.
    errors.push(error);
  };
  pool.on("remove", onRemove);
  pool.on("error", onError);
  const timeout = setTimeout(() => {
    rejectRemoved(new Error("Test pool clients did not finish closing"));
  }, 10_000);
  if (expectedRemovals === 0) resolveRemoved!();
  try {
    // Checked-out clients must be released by their owners; pool.end() waits
    // for those releases, while allRemoved also waits for the close callbacks.
    await Promise.all([pool.end(), allRemoved]);
    if (errors.length > 0)
      throw new AggregateError(errors, "PostgreSQL errors closing test pool");
  } finally {
    clearTimeout(timeout);
    pool.off("remove", onRemove);
    pool.off("error", onError);
  }
}

/** Wait only for sessions in the scratch database owned by this test. */
export async function waitForNoTestDatabaseSessions(
  admin: Pool | Client,
  name: string,
  { timeoutMs = 10_000, pollIntervalMs = 10 }: DrainOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    );
    if (result.rows[0]?.count === 0) return;
    if (Date.now() >= deadline)
      throw new Error(`Test database ${name} still has open sessions`);
    await delay(pollIntervalMs);
  }
}

export async function dropTestDatabase(
  admin: Pool | Client,
  name: string,
  options: DrainOptions = {},
): Promise<void> {
  await waitForNoTestDatabaseSessions(admin, name, options);
  const identifier = `"${name.replaceAll('"', '""')}"`;
  await admin.query(`DROP DATABASE IF EXISTS ${identifier}`);
}
