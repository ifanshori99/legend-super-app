import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditEventSchema,
  cafeLegendAuditFixtures,
  maskAuditChanges,
  isSensitiveAuditKey,
  hashIpForAudit,
  AUDIT_REDACTED,
} from "../packages/shared/src/audit/index.ts";

test("audit fixtures parse with all actor kinds and retention", () => {
  assert.deepEqual(
    cafeLegendAuditFixtures.map((row) => auditEventSchema.parse(row).actorType),
    ["user", "ai", "mcp_client", "system", "device"],
  );
  assert.ok(
    cafeLegendAuditFixtures.every((row) => row.retentionClass === "audit_2y"),
  );
});

test("audit events reject invalid IDs, IP hashes and unexpected fields", () => {
  const event = cafeLegendAuditFixtures[0];
  for (const patch of [
    { tenantId: "bad" },
    { id: "bad" },
    { ipHash: "127.0.0.1" },
    { extra: true },
  ]) {
    assert.equal(
      auditEventSchema.safeParse({ ...event, ...patch }).success,
      false,
    );
  }
});

test("masking recursively redacts values by default, including sensitive keys and arrays", () => {
  const source = {
    status: "active",
    email: "guest@example.com",
    nested: { phone: "081234", count: 2 },
    list: ["secret", { nik: "123456789" }],
  };
  assert.deepEqual(maskAuditChanges(source, ["status", "email"]), {
    status: "active",
    email: "[REDACTED]",
    nested: { phone: "[REDACTED]", count: "[REDACTED]" },
    list: ["[REDACTED]", { nik: "[REDACTED]" }],
  });
  assert.equal(source.email, "guest@example.com");
});

test("masking never exposes credentials or sensitive fields through naming variants", () => {
  assert.deepEqual(
    maskAuditChanges(
      {
        accessToken: "abc",
        bank_account: "123",
        password: "p",
        customerName: "A",
      },
      ["accessToken", "bank_account", "password", "customerName"],
    ),
    {
      accessToken: "[REDACTED]",
      bank_account: "[REDACTED]",
      password: "[REDACTED]",
      customerName: "[REDACTED]",
    },
  );
});

// --- legend-cyu.4 review additions -----------------------------------------
const base = cafeLegendAuditFixtures[0];
const ok = (patch) => auditEventSchema.safeParse({ ...base, ...patch }).success;
const uuid = "a23d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13";

test("actor kind decides which actor reference is required", () => {
  assert.equal(ok({ actorType: "user", actorId: null }), false);
  assert.equal(ok({ actorType: "ai", actorId: null }), false);
  assert.equal(ok({ actorType: "mcp_client", actorId: null }), false);
  assert.equal(ok({ actorType: "system", actorId: null }), true);
  assert.equal(ok({ actorType: "system", actorId: uuid }), false);
  // A device acts as itself: actorId and deviceId are the same device.
  assert.equal(
    ok({ actorType: "device", actorId: uuid, deviceId: uuid }),
    true,
  );
  assert.equal(
    ok({ actorType: "device", actorId: null, deviceId: null }),
    false,
  );
  assert.equal(
    ok({
      actorType: "device",
      actorId: uuid,
      deviceId: "b23d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
    }),
    false,
  );
});

test("sensitive access always records why (PRD support access)", () => {
  assert.equal(ok({ sensitiveAccess: true, reason: null }), false);
  assert.equal(ok({ sensitiveAccess: true, reason: "   " }), false);
  assert.equal(
    ok({ sensitiveAccess: true, reason: "Tiket dukungan LEG-12" }),
    true,
  );
  assert.equal(ok({ sensitiveAccess: false, reason: null }), true);
});

test("action and object type are lowercase snake identifiers", () => {
  assert.equal(ok({ action: "role.updated" }), true);
  assert.equal(ok({ action: "support_session.started" }), true);
  for (const action of [
    "Updated",
    "settings",
    "a b.c",
    "settings.Updated",
    ".x",
    "x.",
  ])
    assert.equal(ok({ action }), false, action);
  assert.equal(ok({ objectType: "menu_item" }), true);
  assert.equal(ok({ objectType: "MenuItem" }), false);
  assert.equal(ok({ objectType: "menu item" }), false);
});

test("maskedChanges must already be masked: sensitive keys hold only the marker", () => {
  const changes = (after) => ({ before: null, after });
  assert.equal(ok({ maskedChanges: changes({ status: "active" }) }), true);
  assert.equal(ok({ maskedChanges: changes({ email: AUDIT_REDACTED }) }), true);
  assert.equal(ok({ maskedChanges: changes({ email: "a@b.id" }) }), false);
  assert.equal(
    ok({ maskedChanges: changes({ nested: [{ customerName: "Sari" }] }) }),
    false,
  );
  assert.equal(ok({ maskedChanges: changes({ apiKey: "sk-1" }) }), false);
  assert.equal(
    ok({ maskedChanges: changes({ x: "y".repeat(70_000) }) }),
    false,
  );
  // Output of the masker always satisfies the schema.
  const masked = maskAuditChanges({ email: "a@b.id", status: "x", pin: 1 }, [
    "status",
  ]);
  assert.equal(ok({ maskedChanges: { before: masked, after: masked } }), true);
});

test("masking keeps benign fields whose names only contain risky letters", () => {
  const safe = [
    "shipping",
    "company",
    "topping",
    "spanCount",
    "expanded",
    "interface",
    "footprint",
    "mapping",
  ];
  const out = maskAuditChanges(
    Object.fromEntries(safe.map((k) => [k, 1])),
    safe,
  );
  assert.deepEqual(out, Object.fromEntries(safe.map((k) => [k, 1])));
});

test("masking redacts Indonesian and credential naming variants", () => {
  const keys = [
    "pin",
    "pinCode",
    "PIN",
    "otp",
    "nik",
    "ktp",
    "hp",
    "no_hp",
    "nohp",
    "nomorHp",
    "noTelp",
    "msisdn",
    "apiKey",
    "api_key",
    "privateKey",
    "secretKey",
    "accessToken",
    "refresh-token",
    "sessionId",
    "signature",
    "bearer",
    "cvv",
    "dob",
    "ipAddress",
    "ip",
    "photoUrl",
    "fotoSelfie",
    "faceId",
    "fingerprint",
    "latitude",
    "passwordHash",
    "bankAccount",
    "customerName",
    "namaLengkap",
    "email",
    "alamatRumah",
  ];
  const input = Object.fromEntries(keys.map((k) => [k, "v"]));
  const out = maskAuditChanges(input, keys);
  for (const key of keys) assert.equal(out[key], AUDIT_REDACTED, key);
  for (const key of keys) assert.equal(isSensitiveAuditKey(key), true, key);
});

test("masking keeps safe scalar arrays, preserves null, and ignores unsafe values", () => {
  assert.deepEqual(
    maskAuditChanges({ tags: ["a", 2], other: ["b"] }, ["tags"]),
    {
      tags: ["a", 2],
      other: [AUDIT_REDACTED],
    },
  );
  assert.equal(maskAuditChanges(null), null);
  assert.deepEqual(maskAuditChanges({ status: null, note: null }, ["status"]), {
    status: null,
    note: null,
  });
  assert.deepEqual(maskAuditChanges({ email: null }, ["email"]), {
    email: AUDIT_REDACTED,
  });
  assert.throws(() => maskAuditChanges({ at: new Date() }));
  assert.throws(() => maskAuditChanges({ big: 10n }));
  // A __proto__ key from JSON is dropped by validation and never pollutes.
  assert.deepEqual(
    maskAuditChanges(JSON.parse('{"__proto__":{"status":"x"},"status":"ok"}'), [
      "status",
    ]),
    { status: "ok" },
  );
  assert.equal({}.status, undefined);
});

test("hashIpForAudit is a keyed, deterministic, normalized HMAC", async () => {
  const secret = "audit-ip-secret-0123456789abcdef";
  const hash = await hashIpForAudit("203.0.113.9", secret);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, await hashIpForAudit(" 203.0.113.9 ", secret));
  assert.notEqual(hash, await hashIpForAudit("203.0.113.9", secret + "x"));
  assert.notEqual(hash, await hashIpForAudit("203.0.113.10", secret));
  assert.equal(
    await hashIpForAudit("2001:DB8::1", secret),
    await hashIpForAudit("2001:db8::1", secret),
  );
  // Known HMAC-SHA256 vector: key "key" is too short, so check against node's crypto.
  const { createHmac } = await import("node:crypto");
  assert.equal(
    hash,
    createHmac("sha256", secret).update("203.0.113.9").digest("hex"),
  );
  assert.ok(ok({ ipHash: hash }));
  await assert.rejects(() => hashIpForAudit("203.0.113.9", "short"), TypeError);
  await assert.rejects(() => hashIpForAudit("", secret), TypeError);
  await assert.rejects(() => hashIpForAudit("not an ip", secret), TypeError);
});
