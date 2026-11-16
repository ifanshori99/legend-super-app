import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// config/env.ts validates process.env once, at import, and exits on failure,
// so each case loads it in a fresh process (cwd: apps/api).
// An override of undefined removes the variable.
function loadEnv(
  overrides: Record<string, string | undefined>,
  preload: string[] = [],
) {
  const env = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(env))
    if (value === undefined) delete env[key];
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      ...preload.flatMap((file) => ["--import", file]),
      "src/config/env.ts",
    ],
    {
      cwd: new URL("../..", import.meta.url),
      env,
      encoding: "utf8",
    },
  );
}

// legend-9n1mu: the worker marks itself in code (src/role-worker.ts, the first
// import of the worker entrypoint, sets globalThis.__LEGEND_PROCESS_ROLE =
// "worker"). Environment variables alone never exempt a process.
const WORKER_URL =
  "postgresql://legend_worker_0123456789abcdef:pw@localhost:5432/legend";

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

    it("fails the api in production when the grantor is missing even if WORKER_DATABASE_URL is set", () => {
      const result = loadEnv(
        production({
          PAYOUT_GRANTOR_DATABASE_URL: undefined,
          WORKER_DATABASE_URL: WORKER_URL,
        }),
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PAYOUT_GRANTOR_DATABASE_URL");
      expect(result.stderr).not.toContain("postgresql://");
    });

    it("lets the api start in production with the grantor set alongside WORKER_DATABASE_URL", () => {
      const result = loadEnv(
        production({
          PAYOUT_GRANTOR_DATABASE_URL: grantorUrl,
          WORKER_DATABASE_URL: WORKER_URL,
        }),
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });

    it("lets the worker entrypoint start in production without it (it never gets the login)", () => {
      const result = loadEnv(
        production({
          PAYOUT_GRANTOR_DATABASE_URL: undefined,
          WORKER_DATABASE_URL: WORKER_URL,
        }),
        ["./src/role-worker.ts"],
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });

    it("worker entrypoint marks itself first, and the api entrypoint never does", () => {
      const importsOf = (file: string) =>
        [
          ...readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .matchAll(/^\s*import\s+(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/gm),
        ].map((match) => match[1]);
      const worker = importsOf("worker-main.ts");
      const marker = worker.findIndex((spec) => /role-worker/.test(spec));
      expect(marker).toBeGreaterThanOrEqual(0);
      // Only the dotenv loader may run before the marker.
      expect(
        worker.slice(0, marker).every((spec) => /load-env/.test(spec)),
      ).toBe(true);
      expect(importsOf("server.ts").some((spec) => /role-worker/.test(spec))).toBe(
        false,
      );
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
