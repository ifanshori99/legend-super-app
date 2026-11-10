import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintEdgeCredential } from "../edge/credential.ts";

// Attendance selfie sealing keys and edge QR lookahead in config/env.ts.
// Same approach as env.test.ts: config/env.ts validates process.env once, at
// import, and exits on failure, so each case loads it in a fresh process
// (cwd: apps/api).

const KEYS = "ATTENDANCE_SELFIE_SEAL_KEYS";
const ACTIVE = "ATTENDANCE_SELFIE_SEAL_ACTIVE_KID";
const DAYS = "EDGE_QR_KEY_DAYS_AHEAD";

function loadEnv(overrides: Record<string, string> = {}) {
  const env = { ...process.env };
  // Start from "unset" so a developer's shell cannot leak into a case.
  delete env[KEYS];
  delete env[ACTIVE];
  delete env[DAYS];
  return spawnSync(process.execPath, ["--import", "tsx", "src/config/env.ts"], {
    cwd: new URL("../..", import.meta.url),
    env: { ...env, ...overrides },
    encoding: "utf8",
  });
}

const pkcs8 = (key: ReturnType<typeof generateKeyPairSync>["privateKey"]) =>
  key.export({ type: "pkcs8", format: "pem" }).toString();

// Generated once per file; 3072-bit generation is slow.
const rsa3072a = pkcs8(
  generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey,
);
const rsa3072b = pkcs8(
  generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey,
);
const rsa2048 = pkcs8(
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
);
const ecP256 = pkcs8(
  generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
);
const rsa3072Public = generateKeyPairSync("rsa", { modulusLength: 3072 })
  .publicKey.export({ type: "spki", format: "pem" })
  .toString();

const pemBody = (pem: string) =>
  pem
    .split("\n")
    .filter((line) => line && !line.startsWith("-----"))
    .join("");

/** A failed boot exits 1, names the variable, and never echoes key text. */
function expectRejected(
  result: ReturnType<typeof loadEnv>,
  variable: string | RegExp,
  secrets: string[] = [],
) {
  expect(result.status).toBe(1);
  if (typeof variable === "string") {
    expect(result.stderr).toContain(variable);
  } else {
    expect(result.stderr).toMatch(variable);
  }
  for (const output of [result.stderr, result.stdout]) {
    expect(output).not.toContain("-----BEGIN");
    for (const secret of secrets) {
      const body = pemBody(secret);
      expect(output).not.toContain(body.slice(0, 40));
      expect(output).not.toContain(body.slice(-40));
    }
  }
}

const keysJson = (value: unknown) => JSON.stringify(value);

describe("attendance selfie seal keys", () => {
  it("boots when neither variable is set", () => {
    expect(loadEnv().status).toBe(0);
  });

  it("boots with one 3072-bit RSA key and its matching active kid", () => {
    const result = loadEnv({
      [KEYS]: keysJson({ k1: rsa3072a }),
      [ACTIVE]: "k1",
    });
    expect(result.status).toBe(0);
  });

  it("boots with two keys for rotation, either one active", () => {
    const keys = keysJson({ old: rsa3072a, next: rsa3072b });
    expect(loadEnv({ [KEYS]: keys, [ACTIVE]: "next" }).status).toBe(0);
    expect(loadEnv({ [KEYS]: keys, [ACTIVE]: "old" }).status).toBe(0);
  });

  it("accepts a kid of exactly 64 characters", () => {
    const kid = "k".repeat(64);
    const result = loadEnv({
      [KEYS]: keysJson({ [kid]: rsa3072a }),
      [ACTIVE]: kid,
    });
    expect(result.status).toBe(0);
  });

  it("refuses KEYS that is not valid JSON", () => {
    expectRejected(loadEnv({ [KEYS]: "{not json", [ACTIVE]: "k1" }), KEYS);
  });

  it.each([
    ["an array", "[]"],
    ["a string", '"just-a-string"'],
    ["a number", "42"],
    ["null", "null"],
    ["an empty object", "{}"],
  ])("refuses KEYS that is %s", (_name, value) => {
    expectRejected(loadEnv({ [KEYS]: value, [ACTIVE]: "k1" }), KEYS);
  });

  it("refuses an empty kid", () => {
    expectRejected(
      loadEnv({ [KEYS]: keysJson({ "": rsa3072a }), [ACTIVE]: "" }),
      KEYS,
      [rsa3072a],
    );
    expectRejected(
      loadEnv({
        [KEYS]: keysJson({ "": rsa3072a, k1: rsa3072b }),
        [ACTIVE]: "k1",
      }),
      KEYS,
      [rsa3072a, rsa3072b],
    );
  });

  it("refuses a kid longer than 64 characters", () => {
    const kid = "k".repeat(65);
    expectRejected(
      loadEnv({ [KEYS]: keysJson({ [kid]: rsa3072a }), [ACTIVE]: kid }),
      KEYS,
      [rsa3072a],
    );
  });

  it("refuses a value that is not a PKCS#8 private key, without echoing it", () => {
    const garbage = "this-is-not-a-key-SECRETTEXT";
    const result = loadEnv({
      [KEYS]: keysJson({ k1: garbage }),
      [ACTIVE]: "k1",
    });
    expectRejected(result, KEYS);
    expect(result.stderr).not.toContain(garbage);
  });

  it("refuses a public key where a private key is required", () => {
    expectRejected(
      loadEnv({ [KEYS]: keysJson({ k1: rsa3072Public }), [ACTIVE]: "k1" }),
      KEYS,
      [rsa3072Public],
    );
  });

  it("refuses a 2048-bit RSA key as too small", () => {
    expectRejected(
      loadEnv({ [KEYS]: keysJson({ k1: rsa2048 }), [ACTIVE]: "k1" }),
      KEYS,
      [rsa2048],
    );
  });

  it("refuses an EC key, only RSA is allowed", () => {
    expectRejected(
      loadEnv({ [KEYS]: keysJson({ k1: ecP256 }), [ACTIVE]: "k1" }),
      KEYS,
      [ecP256],
    );
  });

  it("refuses the whole set when only one of two keys is weak", () => {
    expectRejected(
      loadEnv({
        [KEYS]: keysJson({ good: rsa3072a, weak: rsa2048 }),
        [ACTIVE]: "good",
      }),
      KEYS,
      [rsa3072a, rsa2048],
    );
  });

  // Assumption: the spec does not say which variable the message names for a
  // missing pair, so either of the two seal variables satisfies the test.
  it("refuses KEYS without ACTIVE_KID", () => {
    expectRejected(
      loadEnv({ [KEYS]: keysJson({ k1: rsa3072a }) }),
      /ATTENDANCE_SELFIE_SEAL_(KEYS|ACTIVE_KID)/,
      [rsa3072a],
    );
  });

  it("refuses ACTIVE_KID without KEYS", () => {
    expectRejected(
      loadEnv({ [ACTIVE]: "k1" }),
      /ATTENDANCE_SELFIE_SEAL_(KEYS|ACTIVE_KID)/,
    );
  });

  it("refuses an ACTIVE_KID that is not a key of KEYS", () => {
    expectRejected(
      loadEnv({ [KEYS]: keysJson({ k1: rsa3072a }), [ACTIVE]: "k2" }),
      ACTIVE,
      [rsa3072a],
    );
  });
});

describe("EDGE_QR_KEY_DAYS_AHEAD", () => {
  it("boots when unset", () => {
    expect(loadEnv().status).toBe(0);
  });

  it("boots when empty", () => {
    expect(loadEnv({ [DAYS]: "" }).status).toBe(0);
  });

  it.each(["0", "1", "7", "14"])("accepts the integer %s", (value) => {
    expect(loadEnv({ [DAYS]: value }).status).toBe(0);
  });

  it.each(["-1", "15", "2.5", "abc"])("refuses %s", (value) => {
    const result = loadEnv({ [DAYS]: value });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(DAYS);
  });
});

// An edge node only ever holds the cloud's PUBLIC seal key (it arrives in the
// people snapshot). Holding the private keys would let a stolen edge open
// every sealed selfie (design hris-edge-replication 7).
describe("edge node and the seal private keys", () => {
  const edgeEnv = () => ({
    DEPLOYMENT_MODE: "development",
    EDGE_MODE: "true",
    EDGE_CLOUD_URL: "ws://localhost:4000/api/edge-link",
    EDGE_NODE_CREDENTIAL: mintEdgeCredential({
      tenantId: randomUUID(),
      outletId: randomUUID(),
      edgeNodeId: randomUUID(),
    }).token,
  });

  it("boots an edge node that holds no seal key", () => {
    expect(loadEnv(edgeEnv()).status).toBe(0);
  });

  it("refuses an edge node that holds the seal keys", () => {
    const result = loadEnv({
      ...edgeEnv(),
      [KEYS]: keysJson({ k1: rsa3072a }),
      [ACTIVE]: "k1",
    });
    expectRejected(result, /ATTENDANCE_SELFIE_SEAL_KEYS: .*edge/i, [rsa3072a]);
    expect(result.stderr).toMatch(/ATTENDANCE_SELFIE_SEAL_ACTIVE_KID: .*edge/i);
  });

  it("refuses an edge node that holds only the active kid", () => {
    expectRejected(
      loadEnv({ ...edgeEnv(), [ACTIVE]: "k1" }),
      /ATTENDANCE_SELFIE_SEAL_ACTIVE_KID: .*edge/i,
    );
  });

  it("still boots the cloud with the seal keys", () => {
    expect(
      loadEnv({ [KEYS]: keysJson({ k1: rsa3072a }), [ACTIVE]: "k1" }).status,
    ).toBe(0);
  });
});
