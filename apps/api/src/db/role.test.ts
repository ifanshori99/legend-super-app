import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createPgBoss } from "../worker/runtime";
import { createRelayScheduler, createWakeListener } from "../worker/relay";
import { recordReadOk } from "../services/payroll-payout-recon.service";
import {
  assertQueueRole,
  createAppPool,
  verifyMaintenanceConnection,
  verifyQueueConnection,
} from "./role";

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

describe("maintenance database role", () => {
  const unsafe = "Unsafe database role for maintenance access";
  const GROUP = "legend_maintenance";
  const attributes =
    "NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION";
  const maintenancePool = (url: string) =>
    new Pool({
      connectionString: url,
      max: 1,
      verify: verifyMaintenanceConnection,
    });

  /**
   * A scratch login with the given extra SQL, as the test superuser. The group
   * comes from migration 0187; it is created here only when absent, and then
   * dropped again.
   */
  async function withLogin(
    options: {
      member?: boolean;
      role?: string;
      extra?: string;
      setup?: (role: string) => string[];
    },
    run: (url: string, role: string, admin: Pool) => Promise<void>,
  ) {
    const admin = new Pool({
      connectionString: process.env.STARTER_TEST_DATABASE_URL!,
      max: 1,
    });
    const role =
      options.role ?? `legend_maint_${randomBytes(8).toString("hex")}`;
    const password = randomBytes(16).toString("hex");
    const created = !(
      await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [GROUP])
    ).rows.length;
    try {
      if (created) await admin.query(`CREATE ROLE ${GROUP} NOLOGIN`);
      await admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' ${options.extra ?? attributes}`,
      );
      if (options.member !== false)
        await admin.query(`GRANT ${GROUP} TO ${role}`);
      for (const statement of options.setup?.(role) ?? [])
        await admin.query(statement);
      const url = new URL(process.env.STARTER_TEST_DATABASE_URL!);
      url.username = role;
      url.password = password;
      await run(url.toString(), role, admin);
    } finally {
      await admin.query("DROP TABLE IF EXISTS public.maint_rls_fixture");
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      if (created) await admin.query(`DROP ROLE IF EXISTS ${GROUP}`);
      await admin.end();
    }
  }

  async function rejects(url: string) {
    const pool = maintenancePool(url);
    try {
      await expect(pool.query("SELECT 1")).rejects.toThrow(unsafe);
    } finally {
      await pool.end();
    }
  }

  it("rejects the migration owner and the application login", async () => {
    for (const url of [
      process.env.STARTER_TEST_DATABASE_URL!,
      process.env.DATABASE_URL!,
    ])
      await rejects(url);
  });
  it("rejects a restricted login that is not a member of legend_maintenance", async () => {
    await withLogin({ member: false }, (url) => rejects(url));
  });
  it("rejects a member whose login name is not legend_maint_<16 hex>", async () => {
    for (const role of [
      "legend_maint_replace_me",
      `legend_maint_test_${randomBytes(6).toString("hex")}`,
      `legend_maint_${randomBytes(7).toString("hex")}`,
      `legend_maint_${randomBytes(8).toString("hex")}x`,
    ])
      await withLogin({ role }, (url) => rejects(url));
  });
  it("rejects a maintenance member that is also a legend_app member", async () => {
    await withLogin(
      { setup: (role) => [`GRANT legend_app TO ${role}`] },
      (url) => rejects(url),
    );
  });
  it("rejects a maintenance member with CREATEROLE, CREATEDB or BYPASSRLS", async () => {
    for (const extra of [
      "NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB NOREPLICATION",
      "NOSUPERUSER NOBYPASSRLS NOCREATEROLE CREATEDB NOREPLICATION",
      "NOSUPERUSER BYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION",
    ])
      await withLogin({ extra }, (url) => rejects(url));
  });
  it("rejects a maintenance member that owns a row-level-security table", async () => {
    await withLogin(
      {
        setup: (role) => [
          "CREATE TABLE public.maint_rls_fixture (tenant_id uuid)",
          "ALTER TABLE public.maint_rls_fixture ENABLE ROW LEVEL SECURITY",
          `ALTER TABLE public.maint_rls_fixture OWNER TO ${role}`,
        ],
      },
      (url) => rejects(url),
    );
  });
  it("allows a plain login that is a member of legend_maintenance only", async () => {
    await withLogin({}, async (url, role) => {
      const pool = maintenancePool(url);
      try {
        const result = await pool.query("SELECT current_user");
        expect(result.rows[0].current_user).toBe(role);
      } finally {
        await pool.end();
      }
    });
  });
});

// legend-qh11l F1/F3: only the recon role may record an 'ok' read of a payout
// proof (drizzle/0674). The provisioned application login (DATABASE_URL, a
// non-superuser member of legend_app) reaches legend_payout_recon with SET ROLE
// only: legend_app is a member of it WITH INHERIT FALSE, SET TRUE, so nothing
// of its EXECUTE rights is inherited. Written from docs/CONTRACT.md and the
// brief of the card, not from the migration body.
//
// Assumptions: a call of observe_ok on an operation nobody observed either
// returns or raises a business error; the tests only demand that it is NOT a
// privilege error (SQLSTATE 42501), because the fixture has no real operation.
describe("payout recon role: ok reads only through legend_payout_recon", () => {
  const OK = "app.payout_recon_evidence_observe_ok(uuid,uuid)";
  const INTERNAL =
    "app.payout_recon_evidence_observe_internal(uuid,uuid,text,text)";
  const OBSERVE = "app.payout_recon_evidence_observe(uuid,uuid,text,text)";
  const RECON = "legend_payout_recon";

  async function withLogin<T>(run: (pool: Pool) => Promise<T>) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL!,
      max: 1,
    });
    try {
      return await run(pool);
    } finally {
      await pool.end();
    }
  }
  const can = async (pool: Pool, who: string, fn: string) =>
    (
      await pool.query(
        "SELECT has_function_privilege($1, $2, 'EXECUTE') AS can",
        [who, fn],
      )
    ).rows[0].can as boolean;

  it("[payout-recon-login-can-set-role-and-call-observe-ok] the provisioned login can SET LOCAL ROLE legend_payout_recon and call observe_ok and recordReadOk without a privilege error", async () => {
    await withLogin(async (pool) => {
      const tenantId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
          [tenantId],
        );
        await client.query(`SET LOCAL ROLE ${RECON}`);
        expect((await client.query("SELECT current_user")).rows[0]).toEqual({
          current_user: RECON,
        });
        let code: string | undefined;
        await client.query("SAVEPOINT call");
        try {
          await client.query(
            "SELECT app.payout_recon_evidence_observe_ok($1::uuid, $2::uuid)",
            [tenantId, randomUUID()],
          );
        } catch (error) {
          code = (error as { code?: string }).code;
          await client.query("ROLLBACK TO SAVEPOINT call");
        }
        expect(code, "not a permission error").not.toBe("42501");
        await client.query("RESET ROLE");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }

      // The service helper, in a transaction opened by the login itself.
      const db = drizzle(pool);
      let helperCode: string | undefined;
      let roleAfter = "";
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.outlet_ids', '*', true)`,
          );
          await recordReadOk(tx as never, tenantId, randomUUID());
          const res = (await tx.execute(
            sql`SELECT current_user AS who, session_user AS own`,
          )) as unknown as { rows: { who: string; own: string }[] };
          roleAfter = `${res.rows[0]!.who}|${res.rows[0]!.own}`;
        });
      } catch (error) {
        const cause = error as { code?: string; cause?: { code?: string } };
        helperCode = cause.code ?? cause.cause?.code;
      }
      expect(helperCode, "recordReadOk: not a permission error").not.toBe(
        "42501",
      );
      if (roleAfter) {
        const [who, own] = roleAfter.split("|");
        expect(who, "recordReadOk gives the role back").toBe(own);
      }
    });
  });

  it("[payout-recon-login-cannot-execute-ok-or-internal] neither the login nor legend_app may EXECUTE observe_ok or the internal function; the recon role may run observe_ok only; the ordinary observe stays callable", async () => {
    await withLogin(async (pool) => {
      const { current_user: login } = (await pool.query("SELECT current_user"))
        .rows[0];
      for (const who of [login, "legend_app", "public"]) {
        expect(await can(pool, who, OK), `${who} on observe_ok`).toBe(false);
        expect(await can(pool, who, INTERNAL), `${who} on internal`).toBe(
          false,
        );
      }
      expect(await can(pool, RECON, OK), "recon role on observe_ok").toBe(true);
      expect(await can(pool, RECON, INTERNAL), "recon on internal").toBe(false);
      expect(await can(pool, login, OBSERVE), "control: observe").toBe(true);
    });
  });

  it("[payout-recon-login-does-not-inherit-recon-role] pg_has_role(login, legend_payout_recon, 'USAGE') is false, and so is it for legend_app: the role is reached only by SET ROLE", async () => {
    await withLogin(async (pool) => {
      const { current_user: login } = (await pool.query("SELECT current_user"))
        .rows[0];
      for (const who of [login, "legend_app"]) {
        const res = await pool.query(
          "SELECT pg_has_role($1, $2, 'USAGE') AS usage",
          [who, RECON],
        );
        expect(res.rows[0].usage, `${who} inherits ${RECON}`).toBe(false);
      }
    });
  });
});
