import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createPgBoss } from "../worker/runtime";
import { createRelayScheduler, createWakeListener } from "../worker/relay";
import { assertQueueRole, createAppPool, verifyQueueConnection } from "./role";

describe("application database role", () => {
  it("rejects an owner or bypass-capable login before handing out a connection", async () => {
    const pool = createAppPool(process.env.STARTER_TEST_DATABASE_URL!);
    try {
      await expect(pool.query("SELECT 1")).rejects.toThrow(
        "Unsafe database role",
      );
    } finally {
      await pool.end();
    }
  });
  it("allows the provisioned non-bypass application login", async () => {
    const pool = createAppPool(process.env.DATABASE_URL!);
    try {
      const result = await pool.query("SELECT current_user, session_user");
      expect(result.rows[0].current_user).toBe(result.rows[0].session_user);
    } finally {
      await pool.end();
    }
  });
});

describe("queue database role", () => {
  const unsafe = "Unsafe database role for queue access";
  const queuePool = (url: string) =>
    new Pool({ connectionString: url, max: 1, verify: verifyQueueConnection });

  it("rejects the migration owner and the application login on the queue verify", async () => {
    for (const url of [
      process.env.STARTER_TEST_DATABASE_URL!,
      process.env.DATABASE_URL!,
    ]) {
      const pool = queuePool(url);
      try {
        await expect(pool.query("SELECT 1")).rejects.toThrow(unsafe);
      } finally {
        await pool.end();
      }
    }
  });
  it("refuses a privileged login in the pool built by createPgBoss", async () => {
    const boss = createPgBoss(process.env.STARTER_TEST_DATABASE_URL!);
    try {
      await expect(boss.start()).rejects.toThrow(unsafe);
    } finally {
      await boss.stop().catch(() => {});
    }
  });
  it("refuses a privileged login in the relay scheduler's pg-boss pool", async () => {
    const scheduler = createRelayScheduler(
      process.env.STARTER_TEST_DATABASE_URL!,
    );
    try {
      await expect(scheduler.start()).rejects.toThrow(unsafe);
    } finally {
      await scheduler.stop().catch(() => {});
    }
  });
  it("refuses a privileged login in the wake listener before LISTEN", async () => {
    const listener = createWakeListener(process.env.STARTER_TEST_DATABASE_URL!);
    try {
      await expect(listener.start(() => {})).rejects.toThrow(unsafe);
    } finally {
      await listener.stop().catch(() => {});
    }
  });
  it("allows a restricted login that is not a legend_app member", async () => {
    const admin = new Pool({
      connectionString: process.env.STARTER_TEST_DATABASE_URL!,
      max: 1,
    });
    const role = `legend_queue_test_${randomBytes(6).toString("hex")}`;
    const password = randomBytes(16).toString("hex");
    try {
      await admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
      );
      const url = new URL(process.env.STARTER_TEST_DATABASE_URL!);
      url.username = role;
      url.password = password;
      const pool = queuePool(url.toString());
      try {
        const result = await pool.query("SELECT current_user");
        expect(result.rows[0].current_user).toBe(role);
      } finally {
        await pool.end();
      }
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });
});

describe("role guards ignore search_path shadowing", () => {
  const unsafeApp = "Unsafe database role for application access";
  const unsafeQueue = "Unsafe database role for queue access";

  /**
   * Shadow schema owned by the test superuser. `legendAppMember` is what the
   * shadow pg_has_role says about legend_app; every other role check says
   * false, and the shadow catalog views are empty.
   */
  async function withShadow(
    legendAppMember: boolean,
    run: (shadowedUrl: string) => Promise<void>,
  ) {
    const schema = `shadow_${randomBytes(6).toString("hex")}`;
    const admin = new Pool({
      connectionString: process.env.STARTER_TEST_DATABASE_URL!,
      max: 1,
    });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      for (const [a, b] of [
        ["name", "name"],
        ["name", "oid"],
        ["oid", "name"],
        ["oid", "oid"],
      ])
        await admin.query(
          `CREATE FUNCTION ${schema}.pg_has_role(${a}, ${b}, text) RETURNS boolean
           LANGUAGE sql AS $$ SELECT ${a === "name" && b === "name" ? legendAppMember : false} $$`,
        );
      for (const view of ["pg_roles", "pg_class", "pg_namespace"])
        await admin.query(
          `CREATE VIEW ${schema}.${view} AS SELECT * FROM pg_catalog.${view} WHERE false`,
        );
      const url = new URL(process.env.STARTER_TEST_DATABASE_URL!);
      url.searchParams.set("options", `-c search_path=${schema},pg_catalog`);
      await run(url.toString());
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  }

  it("createAppPool refuses a superuser whose search_path shadows the catalog", async () => {
    await withShadow(true, async (url) => {
      const pool = createAppPool(url);
      try {
        await expect(pool.query("SELECT 1")).rejects.toThrow(unsafeApp);
      } finally {
        await pool.end();
      }
    });
  });
  it("the queue verify, createPgBoss and assertQueueRole refuse a shadowed search_path", async () => {
    await withShadow(false, async (url) => {
      const pool = new Pool({
        connectionString: url,
        max: 1,
        verify: verifyQueueConnection,
      });
      try {
        await expect(pool.query("SELECT 1")).rejects.toThrow(unsafeQueue);
      } finally {
        await pool.end();
      }
      const boss = createPgBoss(url);
      try {
        await expect(boss.start()).rejects.toThrow(unsafeQueue);
      } finally {
        await boss.stop().catch(() => {});
      }
      const raw = new Pool({ connectionString: url, max: 1 });
      try {
        await expect(assertQueueRole(raw)).rejects.toThrow(unsafeQueue);
        const path = await raw.query("SHOW search_path");
        expect(path.rows[0].search_path).toMatch(/^shadow_\w+,pg_catalog$/);
      } finally {
        await raw.end();
      }
    });
  });
  it("passes a restricted login and leaves its search_path and transaction state alone", async () => {
    const admin = new Pool({
      connectionString: process.env.STARTER_TEST_DATABASE_URL!,
      max: 1,
    });
    const role = `legend_queue_test_${randomBytes(6).toString("hex")}`;
    const password = randomBytes(16).toString("hex");
    try {
      await admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
      );
      const url = new URL(process.env.STARTER_TEST_DATABASE_URL!);
      url.username = role;
      url.password = password;
      url.searchParams.set("options", "-c search_path=public,pg_catalog");
      const pool = new Pool({
        connectionString: url.toString(),
        max: 1,
        verify: verifyQueueConnection,
      });
      try {
        const result = await pool.query(
          "SELECT current_setting('search_path') AS path, now() = statement_timestamp() AS own_statement",
        );
        expect(result.rows[0].path).toBe("public,pg_catalog");
        expect(result.rows[0].own_statement).toBe(true);
        await assertQueueRole(pool);
        const after = await pool.query("SHOW search_path");
        expect(after.rows[0].search_path).toBe("public,pg_catalog");
      } finally {
        await pool.end();
      }
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });
});
