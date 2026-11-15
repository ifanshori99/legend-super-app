// legend-ofq4f D4: push environment variables are validated at API boot
// (apps/api/src/config/env.ts). Written from docs/briefs/ofq4f-push-registration.md,
// not from the implementation.
//
// config/env.ts validates process.env once, at import, and exits 1 on failure,
// so each case loads it in a fresh process (same approach as env.test.ts).
//
// ASSUMPTIONS where the brief is silent:
//  - Rejection = exit status 1 and stderr naming the offending variable.
//  - A public key that does not belong to the private key (each 65/32 bytes
//    and well-formed) is rejected (architect round, v2): the push service
//    would refuse every send. The report names VAPID_PUBLIC_KEY or
//    VAPID_PRIVATE_KEY (either; the brief does not say which) and never
//    prints key material.
import { createECDH } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const PUSH_KEYS = [
  "NOTIFICATION_PUSH_PROVIDER",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
] as const;

function loadEnv(
  overrides: Partial<Record<(typeof PUSH_KEYS)[number], string>>,
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of PUSH_KEYS) delete env[key];
  Object.assign(env, overrides);
  return spawnSync(process.execPath, ["--import", "tsx", "src/config/env.ts"], {
    cwd: new URL("../..", import.meta.url),
    env,
    encoding: "utf8",
  });
}

function vapidPair() {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    publicKey: key.getPublicKey().toString("base64url"), // 65 bytes, 0x04 first
    privateKey: key.getPrivateKey().toString("base64url"), // 32 bytes
  };
}
const pair = vapidPair();
const valid = {
  NOTIFICATION_PUSH_PROVIDER: "web_push",
  VAPID_PUBLIC_KEY: pair.publicKey,
  VAPID_PRIVATE_KEY: pair.privateKey,
  VAPID_SUBJECT: "mailto:push@example.test",
} as const;

const secrets = [pair.publicKey, pair.privateKey];
function expectRejected(
  result: ReturnType<typeof loadEnv>,
  variable: (typeof PUSH_KEYS)[number],
) {
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(variable);
  // Problems name the field; key material never reaches the log.
  for (const secret of secrets) expect(result.stderr).not.toContain(secret);
}

describe("legend-ofq4f push environment", () => {
  it("defaults to disabled and boots without any VAPID setting", () => {
    expect(loadEnv({}).status).toBe(0);
    expect(loadEnv({ NOTIFICATION_PUSH_PROVIDER: "disabled" }).status).toBe(0);
  });

  it("accepts web_push with a valid key pair and a mailto: subject", () => {
    expect(loadEnv({ ...valid }).status).toBe(0);
  });

  it("accepts an https: subject", () => {
    expect(
      loadEnv({
        ...valid,
        VAPID_SUBJECT: "https://legend.example.test/contact",
      }).status,
    ).toBe(0);
  });

  it("rejects an unknown provider", () => {
    expectRejected(
      loadEnv({ ...valid, NOTIFICATION_PUSH_PROVIDER: "firebase" }),
      "NOTIFICATION_PUSH_PROVIDER",
    );
  });

  it.each(["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const)(
    "refuses web_push without %s",
    (missing) => {
      const rest: Partial<Record<(typeof PUSH_KEYS)[number], string>> = {
        ...valid,
      };
      delete rest[missing];
      expectRejected(loadEnv(rest), missing);
    },
  );

  it("rejects a public key that is not 65 bytes starting with 0x04", () => {
    const wrongLength = Buffer.concat([
      Buffer.from([4]),
      Buffer.alloc(31, 1),
    ]).toString("base64url");
    const wrongPrefix = Buffer.concat([
      Buffer.from([5]),
      Buffer.alloc(64, 1),
    ]).toString("base64url");
    for (const bad of [wrongLength, wrongPrefix, "not base64url!!"]) {
      const result = loadEnv({ ...valid, VAPID_PUBLIC_KEY: bad });
      expectRejected(result, "VAPID_PUBLIC_KEY");
    }
  });

  it("rejects a private key that is not 32 bytes of base64url", () => {
    for (const bad of [
      Buffer.alloc(31, 7).toString("base64url"),
      Buffer.alloc(33, 7).toString("base64url"),
      "not base64url!!",
    ]) {
      const result = loadEnv({ ...valid, VAPID_PRIVATE_KEY: bad });
      expectRejected(result, "VAPID_PRIVATE_KEY");
    }
  });

  it("rejects a public key that does not match the private key", () => {
    const other = vapidPair();
    const result = loadEnv({ ...valid, VAPID_PUBLIC_KEY: other.publicKey });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/VAPID_(PUBLIC|PRIVATE)_KEY/);
    for (const secret of [...secrets, other.publicKey])
      expect(result.stderr).not.toContain(secret);
  });

  it("rejects a public key that is not a point on the P-256 curve", () => {
    const offCurve = Buffer.concat([
      Buffer.from([4]),
      Buffer.alloc(64, 1),
    ]).toString("base64url");
    const result = loadEnv({ ...valid, VAPID_PUBLIC_KEY: offCurve });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/VAPID_(PUBLIC|PRIVATE)_KEY/);
  });

  it("rejects a subject that is neither mailto: nor https:", () => {
    for (const bad of [
      "push@example.test",
      "http://legend.example.test",
      "ftp://x.test",
    ])
      expectRejected(
        loadEnv({ ...valid, VAPID_SUBJECT: bad }),
        "VAPID_SUBJECT",
      );
  });
});
