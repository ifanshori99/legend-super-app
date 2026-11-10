// WhatsApp inbound retention job (card w8dfz.2). Design:
// docs/design/whatsapp-inbound-verification.md section 4 "Masa simpan" and section 10 item 6:
// `wa_inbound_messages` 90 days, finished `login_challenges` 30 days. WhatsApp
// audit rows (2 years) are purged by audit-retention.job.ts, not by this job.
// Real PostgreSQL; fixtures are written as the table owner.
//
// Expected module (does not exist yet, fail-first):
//   apps/api/src/worker/wa-inbound-retention.job.ts
//   export async function runWaInboundRetention(options?: {
//     tenantId?: string;   // only this tenant's rows; omitted = every tenant
//     batchSize?: number;  // rows per DELETE statement, loops until a short batch
//   }): Promise<{ messages: number; challenges: number }>
//
// Assumptions (the design leaves them open):
// - The two WhatsApp tables are service-scoped, with no RLS (contracts.md), so
//   "tenant A never touches tenant B" is proven through the `tenantId` option
//   and the `tenant_id` column, not through an RLS policy.
// - Age is probed one day either side of each cutoff; the exact instant is not
//   asserted. The job reads the real clock, so no `now` is injected.
// - "Finished" challenge = `completed`, `expired` or `cancelled` (design: selesai,
//   kedaluwarsa, atau batal). A `pending` challenge is always kept, however old.
// - A message younger than 90 days may point at a challenge older than 30 days
//   (`wa_inbound_messages.challenge_id` FK). The job must not crash: the message
//   stays and the run still returns counts. Whether the challenge is removed or
//   kept is left open and not asserted.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWaInboundRetention } from "../worker/wa-inbound-retention.job.ts";

const owner = new Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
  max: 2,
});

const MESSAGE_PAST = "91 days";
const MESSAGE_INSIDE = "89 days";
const CHALLENGE_PAST = "31 days";
const CHALLENGE_INSIDE = "29 days";

const hex64 = () => randomBytes(32).toString("hex");
const tenants: string[] = [];

async function newTenant(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'WA retention tenant', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      id,
      `wa-ret-${id.slice(0, 8)}`,
      JSON.stringify({ modules: [], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  tenants.push(id);
  return id;
}

async function seedChallenge(
  tenantId: string,
  status: "pending" | "completed" | "expired" | "cancelled",
  age: string,
  // Signed interval from now for `expires_at`; default is created_at + 5 minutes.
  expiresFromNow?: string,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO login_challenges
       (id, tenant_id, channel, code_hash, browser_binding_hash, status,
        expires_at, completed_at, created_at)
     VALUES ($1, $2, 'whatsapp_inbound', $3, $4, $5,
             COALESCE(now() + $7::interval, now() - $6::interval + interval '5 minutes'),
             CASE WHEN $5::varchar = 'completed' THEN now() - $6::interval + interval '1 minute' END,
             now() - $6::interval)`,
    [id, tenantId, hex64(), hex64(), status, age, expiresFromNow ?? null],
  );
  return id;
}

async function seedMessages(
  tenantId: string,
  count: number,
  age: string,
  challengeId: string | null = null,
): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO wa_inbound_messages
         (id, provider_message_id, tenant_id, receiving_number, from_hash, kind,
          challenge_id, processed_at, created_at)
       VALUES ($1, $2, $3, '628111000111', $4, 'login', $5,
               now() - $6::interval, now() - $6::interval)`,
      [id, `wamid.${id}`, tenantId, hex64(), challengeId, age],
    );
    ids.push(id);
  }
  return ids;
}

async function existing(table: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await owner.query(
    `SELECT count(*)::int AS count FROM public.${table} WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return result.rows[0].count;
}

const messagesLeft = (ids: string[]) => existing("wa_inbound_messages", ids);
const challengesLeft = (ids: string[]) => existing("login_challenges", ids);

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  if (tenants.length > 0) {
    await owner.query(
      "DELETE FROM wa_inbound_messages WHERE tenant_id = ANY($1::uuid[])",
      [tenants],
    );
    await owner.query(
      "DELETE FROM login_challenges WHERE tenant_id = ANY($1::uuid[])",
      [tenants],
    );
  }
  await owner.end();
});

describe("w8dfz.2 WhatsApp inbound retention", () => {
  it("w8dfz.2 deletes messages past 90 days and keeps those just inside", async () => {
    const tenant = await newTenant();
    const old = await seedMessages(tenant, 3, MESSAGE_PAST);
    const fresh = await seedMessages(tenant, 2, MESSAGE_INSIDE);

    const result = await runWaInboundRetention({ tenantId: tenant });

    expect(result.messages).toBe(3);
    expect(await messagesLeft(old)).toBe(0);
    expect(await messagesLeft(fresh)).toBe(2);
  });

  it("w8dfz.2 deletes finished challenges past 30 days and keeps those just inside", async () => {
    const tenant = await newTenant();
    const oldDone = [
      await seedChallenge(tenant, "completed", CHALLENGE_PAST),
      await seedChallenge(tenant, "expired", CHALLENGE_PAST),
      await seedChallenge(tenant, "cancelled", CHALLENGE_PAST),
    ];
    const freshDone = [
      await seedChallenge(tenant, "completed", CHALLENGE_INSIDE),
      await seedChallenge(tenant, "cancelled", CHALLENGE_INSIDE),
    ];

    const result = await runWaInboundRetention({ tenantId: tenant });

    expect(result.challenges).toBe(3);
    expect(await challengesLeft(oldDone)).toBe(0);
    expect(await challengesLeft(freshDone)).toBe(2);
  });

  it("w8dfz.2 never deletes a live pending challenge", async () => {
    const tenant = await newTenant();
    const pending = [
      // Created long ago but still valid, or expired less than 30 days ago.
      await seedChallenge(tenant, "pending", CHALLENGE_PAST, "1 day"),
      await seedChallenge(tenant, "pending", CHALLENGE_PAST, "-29 days"),
      await seedChallenge(tenant, "pending", CHALLENGE_INSIDE),
    ];
    const finished = await seedChallenge(tenant, "completed", CHALLENGE_PAST);

    const result = await runWaInboundRetention({ tenantId: tenant });

    expect(result.challenges).toBe(1);
    expect(await challengesLeft(pending)).toBe(3);
    expect(await challengesLeft([finished])).toBe(0);
  });

  it("w8dfz.2 deletes an abandoned pending challenge whose expiry is past 30 days", async () => {
    const tenant = await newTenant();
    const abandoned = [
      await seedChallenge(tenant, "pending", "40 days", "-31 days"),
      await seedChallenge(tenant, "pending", CHALLENGE_PAST),
    ];
    const kept = [
      await seedChallenge(tenant, "pending", "40 days", "-29 days"),
      await seedChallenge(tenant, "pending", CHALLENGE_INSIDE, "1 day"),
    ];

    const result = await runWaInboundRetention({ tenantId: tenant });

    expect(result.challenges).toBe(2);
    expect(await challengesLeft(abandoned)).toBe(0);
    expect(await challengesLeft(kept)).toBe(2);
  });

  it("w8dfz.2 removes more rows than one batch over several loops", async () => {
    const tenant = await newTenant();
    const messages = await seedMessages(tenant, 25, MESSAGE_PAST);
    const challenges: string[] = [];
    for (let index = 0; index < 25; index += 1)
      challenges.push(await seedChallenge(tenant, "completed", CHALLENGE_PAST));

    const result = await runWaInboundRetention({
      tenantId: tenant,
      batchSize: 10,
    });

    expect(result).toMatchObject({ messages: 25, challenges: 25 });
    expect(await messagesLeft(messages)).toBe(0);
    expect(await challengesLeft(challenges)).toBe(0);
  });

  it("w8dfz.2 is idempotent: a second run deletes nothing", async () => {
    const tenant = await newTenant();
    const fresh = await seedMessages(tenant, 1, MESSAGE_INSIDE);
    await seedMessages(tenant, 4, MESSAGE_PAST);
    await seedChallenge(tenant, "completed", CHALLENGE_PAST);

    const first = await runWaInboundRetention({ tenantId: tenant });
    expect(first).toEqual({ messages: 4, challenges: 1 });

    const second = await runWaInboundRetention({ tenantId: tenant });
    expect(second).toEqual({ messages: 0, challenges: 0 });
    expect(await messagesLeft(fresh)).toBe(1);
  });

  it("w8dfz.2 empty state: nothing to purge returns zero counts", async () => {
    const tenant = await newTenant();
    await seedMessages(tenant, 1, MESSAGE_INSIDE);

    const result = await runWaInboundRetention({ tenantId: tenant });

    expect(result).toEqual({ messages: 0, challenges: 0 });
  });

  it("w8dfz.2 a run for tenant A never touches tenant B", async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const aMessages = await seedMessages(tenantA, 2, MESSAGE_PAST);
    const bMessages = await seedMessages(tenantB, 2, MESSAGE_PAST);
    const aChallenge = await seedChallenge(tenantA, "completed", CHALLENGE_PAST);
    const bChallenge = await seedChallenge(tenantB, "completed", CHALLENGE_PAST);

    const result = await runWaInboundRetention({ tenantId: tenantA });

    expect(result).toEqual({ messages: 2, challenges: 1 });
    expect(await messagesLeft(aMessages)).toBe(0);
    expect(await challengesLeft([aChallenge])).toBe(0);
    expect(await messagesLeft(bMessages)).toBe(2);
    expect(await challengesLeft([bChallenge])).toBe(1);
  });

  it("w8dfz.2 a recent message that points at an old finished challenge does not break the run", async () => {
    const tenant = await newTenant();
    const challenge = await seedChallenge(tenant, "completed", CHALLENGE_PAST);
    const fresh = await seedMessages(tenant, 1, MESSAGE_INSIDE, challenge);
    const old = await seedMessages(tenant, 1, MESSAGE_PAST, challenge);

    const result = await runWaInboundRetention({ tenantId: tenant });

    expect(result.messages).toBe(1);
    expect(await messagesLeft(old)).toBe(0);
    expect(await messagesLeft(fresh)).toBe(1);
  });
});
