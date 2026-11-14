// Provisioning drift fixtures mutate cluster-wide legend_app memberships and
// attributes. Keep their entire file (including teardown) separate from other
// role audits, even though each case creates its own database.
import assert from "node:assert/strict";
import { before, after } from "node:test";
import { Client } from "pg";

export function useRoleAuditLock() {
  let client;
  before(async () => {
    const shared = process.env.STARTER_TEST_DATABASE_URL;
    assert.ok(
      shared && process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"),
      "Run pnpm test to create an isolated database.",
    );
    // Advisory locks are database-scoped: both files must use the shared
    // harness database, never their separate per-case fixture databases.
    client = new Client({ connectionString: shared });
    await client.connect();
    // Dedicated session; closing it releases the lock even on failed tests.
    await client.query("SELECT pg_advisory_lock(786, 0)");
  });
  after(async () => {
    await client?.end();
  });
}
