import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createPgBoss } from "../worker/runtime";
import { createAppPool, verifyQueueConnection } from "./role";

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
