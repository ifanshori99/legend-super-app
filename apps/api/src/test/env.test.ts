import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// config/env.ts validates process.env once, at import, and exits on failure,
// so each case loads it in a fresh process (cwd: apps/api).
// An override of undefined removes the variable.
function loadEnv(overrides: Record<string, string | undefined>) {
  const env = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(env))
    if (value === undefined) delete env[key];
  return spawnSync(process.execPath, ["--import", "tsx", "src/config/env.ts"], {
    cwd: new URL("../..", import.meta.url),
    env,
    encoding: "utf8",
  });
}

describe("API environment", () => {
  it("refuses TRUST_PROXY=true, which would trust spoofed client IPs", () => {
    const result = loadEnv({ TRUST_PROXY: "true" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TRUST_PROXY");
    // Problems name the field; values such as connection strings stay out.
    expect(result.stderr).not.toContain("postgresql://");
  });

  it("accepts a hop count or a subnet list", () => {
    expect(loadEnv({ TRUST_PROXY: "1" }).status).toBe(0);
    expect(loadEnv({ TRUST_PROXY: "loopback" }).status).toBe(0);
  });

  // legend-786te: the payout step grant login is required in production, so a
  // deploy that forgot it fails at start instead of answering 503 on every
  // trusted payout step. Development and test keep the SET LOCAL ROLE fallback.
  describe("PAYOUT_GRANTOR_DATABASE_URL", () => {
    const grantorUrl =
      "postgresql://legend_grant_0123456789abcdef:s3cret-grant-pw@localhost:5432/legend";
    // Everything else production needs, so only the grantor decides the result.
    const production = (
      overrides: Record<string, string | undefined> = {},
    ) => ({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://owner:pw@localhost:5432/legend",
      BETTER_AUTH_SECRET: "a".repeat(40),
      STAFF_PIN_PEPPER: "b".repeat(40),
      ...overrides,
    });

    it.each([
      ["unset", undefined],
      ["empty", ""],
    ])(
      "fails production start when it is %s, naming the field and no secret",
      (_name, value) => {
        const result = loadEnv(
          production({ PAYOUT_GRANTOR_DATABASE_URL: value }),
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("PAYOUT_GRANTOR_DATABASE_URL");
        expect(result.stderr).not.toContain("postgresql://");
      },
    );

    it("lets production start when it is set, without echoing it", () => {
      const result = loadEnv(
        production({ PAYOUT_GRANTOR_DATABASE_URL: grantorUrl }),
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });

    it("lets the worker start in production without it (it never gets the login)", () => {
      const result = loadEnv(
        production({
          PAYOUT_GRANTOR_DATABASE_URL: undefined,
          WORKER_DATABASE_URL:
            "postgresql://legend_worker_0123456789abcdef:pw@localhost:5432/legend",
        }),
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });

    it("lets an outlet edge node start in production without it", () => {
      const result = loadEnv(
        production({
          PAYOUT_GRANTOR_DATABASE_URL: undefined,
          EDGE_MODE: "true",
          STAFF_PIN_PEPPER: undefined,
        }),
      );
      expect(result.stderr).not.toContain("PAYOUT_GRANTOR_DATABASE_URL");
    });

    it.each(["development", "test"])("stays optional in %s", (nodeEnv) => {
      const result = loadEnv({
        NODE_ENV: nodeEnv,
        PAYOUT_GRANTOR_DATABASE_URL: undefined,
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });
  });
});
