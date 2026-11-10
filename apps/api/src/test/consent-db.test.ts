// Versioned, append-only consents (PRD v1.7 §2 privacy, §6 B `consents`).
// LOY-04: marketing needs a granted consent; withdrawal is a new row and the
// latest row wins; history is never rewritten.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  recordConsentInputSchema,
  type RecordConsentInput,
} from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { listConsents, recordConsent } from "../services/consent.service";
import {
  createSegment,
  refreshSegmentMembers,
} from "../services/segments.service.ts";
import {
  createTestTenant,
  owner,
  removeTestTenant,
  type TestTenant,
} from "./platform-theme-helpers";
import {
  asTenant,
  createWorld,
  owner as memberOwner,
  profileOf,
  seedProfile,
  type World,
} from "./member-loyalty-helpers.ts";

let a: TestTenant;
let b: TestTenant;
let world: World;

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
  world = await createWorld();
});

afterAll(async () => {
  await removeTestTenant(a);
  await removeTestTenant(b);
  await owner.end();
  await memberOwner.end();
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

// Staff consent keeps customer_profiles.marketing_opt_in in sync (the column the
// CRM segment rule `marketing_opt_in` reads). Written failing-first: the staff
// path (source "cashier") currently records the consent row only.
//
// Assumptions: the consent subject is the customer profile id; a staff grant or
// withdrawal of purpose "marketing" is the only thing that flips the flag.
describe("LOY-04 staff marketing consent syncs marketing_opt_in", () => {
  const optIn = async (profileId: string) =>
    (await profileOf(world.tenantId, profileId)).marketing_opt_in;
  const staff = () => randomUUID();

  async function memberIds(segmentId: string): Promise<string[]> {
    const { rows } = await asTenant(world.tenantId, (client) =>
      client.query<{ customer_profile_id: string }>(
        "SELECT customer_profile_id FROM segment_members WHERE tenant_id = $1 AND segment_id = $2",
        [world.tenantId, segmentId],
      ),
    );
    return rows.map((r) => r.customer_profile_id);
  }

  it("LOY-04 a staff marketing grant sets marketing_opt_in to true", async () => {
    const profile = await seedProfile(world.tenantId);
    expect(await optIn(profile.id)).toBe(false);
    await recordConsent(
      world.context,
      input(profile.id, "granted", "marketing"),
      staff(),
    );
    expect(await optIn(profile.id)).toBe(true);
  });

  it("LOY-04 a staff marketing withdrawal sets marketing_opt_in back to false", async () => {
    const profile = await seedProfile(world.tenantId);
    await recordConsent(
      world.context,
      input(profile.id, "granted", "marketing"),
      staff(),
    );
    // Force the flag on (as the member path would) so the withdrawal must
    // actively clear it; a default-false column cannot satisfy this by chance.
    await asTenant(world.tenantId, (client) =>
      client.query(
        "UPDATE customer_profiles SET marketing_opt_in = true WHERE tenant_id = $1 AND id = $2",
        [world.tenantId, profile.id],
      ),
    );
    expect(await optIn(profile.id)).toBe(true);
    await recordConsent(
      world.context,
      input(profile.id, "withdrawn", "marketing"),
      staff(),
    );
    expect(await optIn(profile.id)).toBe(false);
  });

  it("LOY-04 a withdrawn member drops out of the marketing_opt_in segment", async () => {
    const optedIn = await seedProfile(world.tenantId);
    const withdrawing = await seedProfile(world.tenantId);
    const neverAsked = await seedProfile(world.tenantId);
    for (const p of [optedIn, withdrawing])
      await recordConsent(
        world.context,
        input(p.id, "granted", "marketing"),
        staff(),
      );

    const segment = await createSegment(world.context, staff(), {
      name: `Opt-in ${randomUUID().slice(0, 6)}`,
      definition: {
        match: "all",
        rules: [{ kind: "marketing_opt_in", value: true }],
      },
    });
    const before = await memberIds(segment.id);
    expect(before).toContain(optedIn.id);
    expect(before).toContain(withdrawing.id);
    expect(before).not.toContain(neverAsked.id);

    await recordConsent(
      world.context,
      input(withdrawing.id, "withdrawn", "marketing"),
      staff(),
    );
    await withTenant(db, world.context, (tx) =>
      refreshSegmentMembers(tx, world.tenantId, segment.id, new Date()),
    );
    const after = await memberIds(segment.id);
    expect(after).toContain(optedIn.id);
    expect(after).not.toContain(withdrawing.id);
  });

  it("LOY-04 loyalty and ai consents never touch marketing_opt_in (stays false)", async () => {
    const profile = await seedProfile(world.tenantId);
    await recordConsent(
      world.context,
      input(profile.id, "granted", "loyalty"),
      staff(),
    );
    await recordConsent(
      world.context,
      input(profile.id, "granted", "ai"),
      staff(),
    );
    await recordConsent(
      world.context,
      input(profile.id, "withdrawn", "ai"),
      staff(),
    );
    expect(await optIn(profile.id)).toBe(false);
  });

  it("LOY-04 loyalty and ai consents never touch marketing_opt_in (stays true)", async () => {
    const profile = await seedProfile(world.tenantId);
    await recordConsent(
      world.context,
      input(profile.id, "granted", "marketing"),
      staff(),
    );
    await recordConsent(
      world.context,
      input(profile.id, "granted", "loyalty"),
      staff(),
    );
    await recordConsent(
      world.context,
      input(profile.id, "granted", "ai"),
      staff(),
    );
    await recordConsent(
      world.context,
      input(profile.id, "withdrawn", "ai"),
      staff(),
    );
    expect(await optIn(profile.id)).toBe(true);
  });
});

// Migration 0242 backfills customer_profiles.marketing_opt_in from the latest
// marketing consent (highest seq) for rows the old staff path left stale. It
// runs as the owner connection: legend_app cannot UPDATE across tenants (RLS).
//
// Assumptions: consents.seq is assigned in insert order, so the insert order
// below is the seq order; recorded_at is deliberately set against that order to
// prove seq, not time, decides.
describe("LOY-04 migration 0242 backfills marketing_opt_in from consents", () => {
  const sql0242 = readFileSync(
    new URL(
      "../../drizzle/0242_backfill_marketing_opt_in_from_consents.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const statements = sql0242
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);

  async function runMigration(): Promise<void> {
    for (const statement of statements) await memberOwner.query(statement);
  }

  async function staffConsent(
    tenantId: string,
    profileId: string,
    purpose: "loyalty" | "marketing" | "ai",
    decision: "granted" | "withdrawn",
    recordedAt: string,
  ): Promise<void> {
    await memberOwner.query(
      `INSERT INTO consents (tenant_id, subject_id, purpose, policy_version, decision, source, recorded_by, recorded_at)
       VALUES ($1, $2, $3, 'v1', $4, 'cashier', $5, $6)`,
      [tenantId, profileId, purpose, decision, randomUUID(), recordedAt],
    );
  }

  async function setFlag(
    tenantId: string,
    profileId: string,
    value: boolean,
  ): Promise<void> {
    await memberOwner.query(
      "UPDATE customer_profiles SET marketing_opt_in = $3 WHERE tenant_id = $1 AND id = $2",
      [tenantId, profileId, value],
    );
  }

  const flag = async (tenantId: string, profileId: string) =>
    (await profileOf(tenantId, profileId)).marketing_opt_in;

  it("LOY-04 0242 latest marketing withdrawn with a stale true flag becomes false", async () => {
    const p = await seedProfile(world.tenantId);
    await staffConsent(
      world.tenantId,
      p.id,
      "marketing",
      "granted",
      "2026-02-01T00:00:00Z",
    );
    await staffConsent(
      world.tenantId,
      p.id,
      "marketing",
      "withdrawn",
      "2026-03-01T00:00:00Z",
    );
    await setFlag(world.tenantId, p.id, true);
    await runMigration();
    expect(await flag(world.tenantId, p.id)).toBe(false);
  });

  it("LOY-04 0242 latest marketing granted with a stale false flag becomes true", async () => {
    const p = await seedProfile(world.tenantId);
    await staffConsent(
      world.tenantId,
      p.id,
      "marketing",
      "granted",
      "2026-02-01T00:00:00Z",
    );
    await setFlag(world.tenantId, p.id, false);
    await runMigration();
    expect(await flag(world.tenantId, p.id)).toBe(true);
  });

  it("LOY-04 0242 leaves a profile with no marketing consent row unchanged (loyalty and ai ignored)", async () => {
    const off = await seedProfile(world.tenantId);
    const on = await seedProfile(world.tenantId);
    const none = await seedProfile(world.tenantId);
    await staffConsent(
      world.tenantId,
      off.id,
      "loyalty",
      "granted",
      "2026-02-01T00:00:00Z",
    );
    await staffConsent(
      world.tenantId,
      on.id,
      "ai",
      "withdrawn",
      "2026-02-01T00:00:00Z",
    );
    await setFlag(world.tenantId, off.id, false);
    await setFlag(world.tenantId, on.id, true);
    await setFlag(world.tenantId, none.id, true);
    await runMigration();
    expect(await flag(world.tenantId, off.id)).toBe(false);
    expect(await flag(world.tenantId, on.id)).toBe(true);
    expect(await flag(world.tenantId, none.id)).toBe(true);
  });

  it("LOY-04 0242 decides by seq (grant, withdraw, grant), not by recorded_at", async () => {
    const p = await seedProfile(world.tenantId);
    // Insert order = seq order; recorded_at runs backwards on purpose.
    await staffConsent(
      world.tenantId,
      p.id,
      "marketing",
      "granted",
      "2026-05-01T00:00:00Z",
    );
    await staffConsent(
      world.tenantId,
      p.id,
      "marketing",
      "withdrawn",
      "2026-04-01T00:00:00Z",
    );
    await staffConsent(
      world.tenantId,
      p.id,
      "marketing",
      "granted",
      "2026-03-01T00:00:00Z",
    );
    await setFlag(world.tenantId, p.id, false);
    await runMigration();
    expect(await flag(world.tenantId, p.id)).toBe(true);

    const q = await seedProfile(world.tenantId);
    await staffConsent(
      world.tenantId,
      q.id,
      "marketing",
      "granted",
      "2026-03-01T00:00:00Z",
    );
    await staffConsent(
      world.tenantId,
      q.id,
      "marketing",
      "withdrawn",
      "2026-04-01T00:00:00Z",
    );
    await staffConsent(
      world.tenantId,
      q.id,
      "marketing",
      "granted",
      "2026-05-01T00:00:00Z",
    );
    await staffConsent(
      world.tenantId,
      q.id,
      "marketing",
      "withdrawn",
      "2026-01-01T00:00:00Z",
    );
    await setFlag(world.tenantId, q.id, true);
    await runMigration();
    expect(await flag(world.tenantId, q.id)).toBe(false);
  });

  it("LOY-04 0242 backfills every tenant by its own consents, never across tenants", async () => {
    const mine = await seedProfile(world.tenantId);
    const theirs = await seedProfile(b.tenantId);
    // Same-shaped stale rows in two tenants; each follows its own consent rows.
    await staffConsent(
      world.tenantId,
      mine.id,
      "marketing",
      "granted",
      "2026-02-01T00:00:00Z",
    );
    await setFlag(world.tenantId, mine.id, false);
    await staffConsent(
      b.tenantId,
      theirs.id,
      "marketing",
      "withdrawn",
      "2026-02-01T00:00:00Z",
    );
    await setFlag(b.tenantId, theirs.id, true);
    // A consent in this tenant for a subject id that only exists in the other
    // tenant must not touch the other tenant's profile.
    const foreign = await seedProfile(b.tenantId);
    await setFlag(b.tenantId, foreign.id, false);
    await staffConsent(
      world.tenantId,
      foreign.id,
      "marketing",
      "granted",
      "2026-02-01T00:00:00Z",
    );
    await runMigration();
    expect(await flag(world.tenantId, mine.id)).toBe(true);
    expect(await flag(b.tenantId, theirs.id)).toBe(false);
    expect(await flag(b.tenantId, foreign.id)).toBe(false);
  });

  it("LOY-04 0242 a second run changes nothing and keeps the consent history", async () => {
    const p = await seedProfile(world.tenantId);
    await staffConsent(
      world.tenantId,
      p.id,
      "marketing",
      "granted",
      "2026-02-01T00:00:00Z",
    );
    await setFlag(world.tenantId, p.id, false);
    await runMigration();
    await runMigration();
    expect(await flag(world.tenantId, p.id)).toBe(true);
    const { rows } = await memberOwner.query(
      "SELECT 1 FROM consents WHERE tenant_id = $1 AND subject_id = $2",
      [world.tenantId, p.id],
    );
    expect(rows).toHaveLength(1);
  });
});
