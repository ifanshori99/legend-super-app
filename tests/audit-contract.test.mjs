import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditEventSchema,
  cafeLegendAuditFixtures,
  maskAuditChanges,
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
