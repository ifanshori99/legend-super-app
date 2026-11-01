import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PgBoss } from "pg-boss";
import { expect, it } from "vitest";

it("provisions an isolated queue role that can only read the active tenant registry", async () => {
  if (
    !process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-") ||
    !process.env.STARTER_TEST_DATABASE_URL
  )
    throw new Error("Requires the disposable test database");
  const adminUrl = process.env.STARTER_TEST_DATABASE_URL;
  const suffix = randomBytes(8).toString("hex");
  const database = `worker_fixture_${suffix}`;
  const role = `legend_worker_${suffix}`;
  const maintenance = new Client({ connectionString: adminUrl });
  await maintenance.connect();
  let fixture: Client | undefined;
  let worker: Client | undefined;
  let boss: PgBoss | undefined;
  try {
    await maintenance.query(`CREATE DATABASE "${database}"`);
    const fixtureUrl = new URL(adminUrl);
    fixtureUrl.pathname = `/${database}`;
    fixture = new Client({ connectionString: fixtureUrl.toString() });
    await fixture.connect();
    await fixture.query(
      `CREATE SCHEMA app; CREATE TABLE public.registry_fixture (id uuid, active boolean); INSERT INTO public.registry_fixture VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',false); CREATE VIEW app.active_tenant_registry AS SELECT id FROM public.registry_fixture WHERE active;`,
    );
    const workerUrl = new URL(fixtureUrl);
    workerUrl.username = role;
    workerUrl.password = randomBytes(24).toString("hex");
    const moduleUrl = new URL(
      "../../../../scripts/provision-app-role.mjs",
      import.meta.url,
    ).href;
    const { provisionWorkerRole } = await import(moduleUrl);
    await provisionWorkerRole(fixtureUrl.toString(), workerUrl.toString());
    worker = new Client({ connectionString: workerUrl.toString() });
    await worker.connect();
    expect(
      (await worker.query("SELECT id FROM app.active_tenant_registry")).rows,
    ).toEqual([{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]);
    await expect(
      worker.query("SELECT * FROM public.registry_fixture"),
    ).rejects.toMatchObject({ code: "42501" });
    const attributes = await worker.query(
      "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user",
    );
    expect(attributes.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    boss = new PgBoss({
      connectionString: workerUrl.toString(),
      createSchema: false,
    });
    boss.on("error", () => {});
    await boss.start();
    await boss.createQueue("fixture-queue");
  } finally {
    await boss?.stop().catch(() => {});
    await worker?.end().catch(() => {});
    await fixture?.end().catch(() => {});
    await maintenance.query(
      `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
    );
    await maintenance.query(`DROP ROLE IF EXISTS "${role}"`);
    await maintenance.end();
  }
}, 30000);
