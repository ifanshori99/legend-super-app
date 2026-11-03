// Versioned, append-only consents (PRD v1.7 §2 privacy, §6 B `consents`).
// LOY-04: marketing needs a granted consent; withdrawal is a new row and the
// latest row wins; history is never rewritten.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  recordConsentInputSchema,
  type RecordConsentInput,
} from "@starter/shared/platform";
import { listConsents, recordConsent } from "../services/consent.service";
import {
  createTestTenant,
  owner,
  removeTestTenant,
  type TestTenant,
} from "./platform-theme-helpers";

let a: TestTenant;
let b: TestTenant;

function input(
  subjectId: string,
  decision: "granted" | "withdrawn",
  purpose: "loyalty" | "marketing" | "ai" = "marketing",
  policyVersion = "v1",
): RecordConsentInput {
  return recordConsentInputSchema.parse({
    subjectId,
    purpose,
    policyVersion,
    decision,
    source: "cashier",
  });
}

const latest = (t: TestTenant, subjectId: string) =>
  listConsents(t.context, { subjectId, view: "latest", limit: 50 });
const history = (t: TestTenant, subjectId: string) =>
  listConsents(t.context, { subjectId, view: "history", limit: 50 });

beforeAll(async () => {
  a = await createTestTenant("consent-a");
  b = await createTestTenant("consent-b");
});

afterAll(async () => {
  await removeTestTenant(a);
  await removeTestTenant(b);
  await owner.end();
});

describe("LOY-04 versioned consents", () => {
  it("LOY-04 rejects a submitted tenantId and unknown purposes", () => {
    expect(
      recordConsentInputSchema.safeParse({
        ...input(randomUUID(), "granted"),
        tenantId: b.tenantId,
      }).success,
    ).toBe(false);
    expect(
      recordConsentInputSchema.safeParse({
        ...input(randomUUID(), "granted"),
        purpose: "sms",
      }).success,
    ).toBe(false);
  });

  it("LOY-04 keeps consents separate per purpose and latest wins", async () => {
    const subject = randomUUID();
    await recordConsent(
      a.context,
      input(subject, "granted", "loyalty"),
      a.actorId,
    );
    await recordConsent(
      a.context,
      input(subject, "granted", "marketing"),
      a.actorId,
    );
    await recordConsent(
      a.context,
      input(subject, "withdrawn", "marketing"),
      a.actorId,
    );
    const current = (await latest(a, subject)).data;
    const byPurpose = Object.fromEntries(
      current.map((c) => [c.purpose, c.decision]),
    );
    expect(byPurpose).toEqual({ loyalty: "granted", marketing: "withdrawn" });
  });

  it("LOY-04 withdrawal appends a row and never deletes history", async () => {
    const subject = randomUUID();
    await recordConsent(
      a.context,
      input(subject, "granted", "ai", "v1"),
      a.actorId,
    );
    await recordConsent(
      a.context,
      input(subject, "withdrawn", "ai", "v1"),
      a.actorId,
    );
    await recordConsent(
      a.context,
      input(subject, "granted", "ai", "v2"),
      a.actorId,
    );
    const rows = (await history(a, subject)).data;
    expect(rows.map((r) => `${r.decision}:${r.policyVersion}`)).toEqual([
      "granted:v2",
      "withdrawn:v1",
      "granted:v1",
    ]);
    expect((await latest(a, subject)).data[0]).toMatchObject({
      decision: "granted",
      policyVersion: "v2",
    });
  });

  it("LOY-04 is idempotent for a repeated decision and refuses withdrawing nothing", async () => {
    const subject = randomUUID();
    await expect(
      recordConsent(a.context, input(subject, "withdrawn"), a.actorId),
    ).rejects.toMatchObject({ code: "NOTHING_TO_WITHDRAW" });
    const one = await recordConsent(
      a.context,
      input(subject, "granted"),
      a.actorId,
    );
    const two = await recordConsent(
      a.context,
      input(subject, "granted"),
      a.actorId,
    );
    expect(two.id).toBe(one.id);
    expect((await history(a, subject)).data).toHaveLength(1);
  });

  it("LOY-04 concurrent writes stay consistent and append-only", async () => {
    const subject = randomUUID();
    await recordConsent(a.context, input(subject, "granted"), a.actorId);
    await Promise.allSettled([
      recordConsent(a.context, input(subject, "withdrawn"), a.actorId),
      recordConsent(a.context, input(subject, "withdrawn"), a.actorId),
    ]);
    const rows = (await history(a, subject)).data;
    expect(rows.filter((r) => r.decision === "withdrawn")).toHaveLength(1);
  });

  it("LOY-04 the application role cannot update or delete consent rows", async () => {
    const subject = randomUUID();
    const row = await recordConsent(
      a.context,
      input(subject, "granted"),
      a.actorId,
    );
    const { Pool } = await import("pg");
    const app = new Pool({
      connectionString: process.env.APP_DATABASE_URL,
      max: 1,
    });
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [a.tenantId],
      );
      await expect(
        client.query(
          "UPDATE consents SET decision = 'withdrawn' WHERE id = $1",
          [row.id],
        ),
      ).rejects.toThrow();
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [a.tenantId],
      );
      await expect(
        client.query("DELETE FROM consents WHERE id = $1", [row.id]),
      ).rejects.toThrow();
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await app.end();
    }
  });

  it("TEN-01 LOY-04 consent of one tenant is invisible and unaffected by another", async () => {
    const subject = randomUUID();
    await recordConsent(
      a.context,
      input(subject, "granted", "marketing"),
      a.actorId,
    );
    // Tenant B has no consent for the same subject id: nothing leaks.
    expect((await latest(b, subject)).data).toEqual([]);
    expect((await history(b, subject)).data).toEqual([]);
    // B recording for the same subject id does not touch A's state.
    await expect(
      recordConsent(
        b.context,
        input(subject, "withdrawn", "marketing"),
        b.actorId,
      ),
    ).rejects.toMatchObject({ code: "NOTHING_TO_WITHDRAW" });
    expect((await latest(a, subject)).data[0]?.decision).toBe("granted");
    const { rows } = await owner.query(
      "SELECT count(*)::int AS n FROM consents WHERE tenant_id = $1 AND subject_id = $2",
      [b.tenantId, subject],
    );
    expect(rows[0].n).toBe(0);
  });

  it("LOY-04 consent writes are audited", async () => {
    const { rows } = await owner.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND event->>'action' LIKE 'consent.%'",
      [a.tenantId],
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });
});
