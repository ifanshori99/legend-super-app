import { randomBytes } from "node:crypto";
import { Client, Pool } from "pg";
import { expect, it } from "vitest";
import { dropTestDatabase, endTestPool } from "./helpers/database-cleanup.ts";

it.each(["XX000", "57P01"])(
  "reports an owned idle client error (%s) during close instead of swallowing it",
  async (code) => {
    const pool = new Pool({
      connectionString: process.env.STARTER_TEST_DATABASE_URL,
      max: 1,
    });
    const client = await pool.connect();
    const failure = Object.assign(new Error("Owned test client failed"), {
      code,
    });
    const ending = endTestPool(pool);
    const assertion = expect(ending).rejects.toMatchObject({
      errors: [failure],
    });
    pool.emit("error", failure, client);
    client.release();
    await assertion;
  },
);

it("waits for the idle client's socket close after Pool.end resolves", async () => {
  const pool = new Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 1,
  });
  await pool.query("SELECT 1");
  let removed = false;
  pool.once("remove", () => {
    removed = true;
  });
  await endTestPool(pool);
  expect(removed).toBe(true);
});

it("refuses to drop a fixture while its own client is still live", async () => {
  const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
  if (
    !adminUrl ||
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")
  )
    throw new Error("Requires the disposable test database");
  const name = `cleanup_${randomBytes(8).toString("hex")}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  const errors: Error[] = [];
  client.on("error", (error) => errors.push(error));
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    await client.connect();
    await expect(
      dropTestDatabase(admin, name, { timeoutMs: 50, pollIntervalMs: 5 }),
    ).rejects.toThrow();
    expect((await client.query("SELECT 1 AS alive")).rows).toEqual([
      { alive: 1 },
    ]);
    expect(errors).toEqual([]);
  } finally {
    await client.end();
    await dropTestDatabase(admin, name);
    await endTestPool(admin);
  }
});

it("drops a fixture only after its checked-out pool client is released and closed", async () => {
  const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
  if (
    !adminUrl ||
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-")
  )
    throw new Error("Requires the disposable test database");
  const name = `cleanup_${randomBytes(8).toString("hex")}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const fixture = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const client = await fixture.connect();
    let closed = false;
    const ending = endTestPool(fixture).then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    client.release();
    await ending;
    await dropTestDatabase(admin, name);
    expect(
      (
        await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
          name,
        ])
      ).rowCount,
    ).toBe(0);
  } finally {
    if (!fixture.ending) await endTestPool(fixture);
    await dropTestDatabase(admin, name);
    await endTestPool(admin);
  }
});
