import { describe, expect, it } from "vitest";
import { createAppPool } from "./role";

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
