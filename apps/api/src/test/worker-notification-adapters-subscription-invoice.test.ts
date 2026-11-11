// subscription.invoice_created (bead 6c6, Part D): the customer behind the
// profile is notified with category subscription_billing; the hosted pay link
// rides in the body (notification links must be in-app paths). Runs the
// recipient resolver against the disposable PostgreSQL (RLS on, app role).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendFixtures,
  createUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema, eventFixture } from "@starter/shared/events";
import { subscriptionInvoiceCreatedEvent } from "@starter/shared/notification";
import * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createNotificationRecipientResolver } from "../worker/notification-adapters.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });
const tenantId = cafeLegendFixtures.tenant.id;
const outletId = cafeLegendFixtures.outlets[0].id;
const context: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "job" }),
  { kind: "tenant" },
);

const customerUserId = randomUUID();
const profileId = randomUUID();
const mergedProfileId = randomUUID();
const mergedTargetId = randomUUID();
const userlessProfileId = randomUUID();
const hostedUrl = "https://pay.doit.example/invoices/inv_6c6";

const payloadFor = (customerProfileId: string) => ({
  subscriptionInvoiceId: randomUUID(),
  subscriptionId: randomUUID(),
  customerProfileId,
  planName: "Shower Bulanan",
  amountIdr: 150000,
  periodStart: "2030-01-01",
  periodEnd: "2030-01-31",
  hostedUrl,
});

function invoiceCreated(payload: Record<string, unknown>) {
  return eventEnvelopeSchema.parse({
    ...eventFixture,
    id: createUlid(),
    tenantId,
    outletId,
    name: "subscription.invoice_created",
    aggregateType: "subscription",
    aggregateId: createUlid(),
    idempotencyKey: `subscription.invoice_created-${randomUUID()}`,
    payloadSchemaRef: "subscription.invoice_created.v1",
    payload,
  });
}

const resolve = (event: ReturnType<typeof invoiceCreated>) =>
  withTenant(database, context, (tx) =>
    createNotificationRecipientResolver({ email: true, push: true })(
      context,
      event,
      tx,
    ),
  );

async function insertProfile(
  id: string,
  userId: string | null,
  mergedInto: string | null,
  status: string,
) {
  await owner.query(
    `INSERT INTO customer_profiles
       (id, tenant_id, user_id, name, membership_status, merged_into_profile_id)
     VALUES ($1, $2, $3, 'Pelanggan uji', $4, $5)`,
    [id, tenantId, userId, status, mergedInto],
  );
}

describe("6c6 subscription.invoice_created notification rule", () => {
  beforeAll(async () => {
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Pelanggan', $2, true)`,
      [customerUserId, `${customerUserId}@example.test`],
    );
    await insertProfile(
      profileId,
      customerUserId,
      null,
      "pending_verification",
    );
    await insertProfile(mergedTargetId, null, null, "pending_verification");
    await insertProfile(
      mergedProfileId,
      randomUUID(),
      mergedTargetId,
      "closed",
    );
    await insertProfile(userlessProfileId, null, null, "pending_verification");
  });

  afterAll(async () => {
    await owner.query(
      `DELETE FROM customer_profiles WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [
        tenantId,
        [mergedProfileId, mergedTargetId, userlessProfileId, profileId],
      ],
    );
    await owner.query(`DELETE FROM "user" WHERE id = $1`, [customerUserId]);
    await owner.end();
    await appPool.end();
  });

  it("6c6 notifies the profile's user with the pay link in the body and no in-app link", async () => {
    const recipients = await resolve(invoiceCreated(payloadFor(profileId)));
    expect(recipients).toHaveLength(1);
    const [recipient] = recipients;
    expect(recipient.userId).toBe(customerUserId);
    expect(recipient.category).toBe("subscription_billing");
    expect(recipient.link).toBeNull();
    expect(recipient.body).toContain(hostedUrl);
    expect(recipient.body).toContain("Shower Bulanan");
    expect(recipient.body).toContain("2030-01-01");
    expect(recipient.body).toContain("150.000");
    expect(recipient.reachability.hasVerifiedEmail).toBe(true);
  });

  it("6c6 an unknown, merged or user-less profile pages nobody (fail closed)", async () => {
    for (const id of [randomUUID(), mergedProfileId, userlessProfileId])
      expect(await resolve(invoiceCreated(payloadFor(id)))).toEqual([]);
  });

  it("6c6 a payload that breaks the strict schema throws so the outbox retries", async () => {
    await expect(
      resolve(
        invoiceCreated({ ...payloadFor(profileId), userId: customerUserId }),
      ),
    ).rejects.toThrow();
  });
});

describe("6c6 subscription.invoice_created event definition", () => {
  it("6c6 accepts an https pay link and rejects http or a non-positive amount", () => {
    const schemaOf = subscriptionInvoiceCreatedEvent.payloadSchema;
    expect(schemaOf.safeParse(payloadFor(profileId)).success).toBe(true);
    expect(
      schemaOf.safeParse({
        ...payloadFor(profileId),
        hostedUrl: "http://pay.doit.example/x",
      }).success,
    ).toBe(false);
    expect(
      schemaOf.safeParse({ ...payloadFor(profileId), amountIdr: 0 }).success,
    ).toBe(false);
    expect(subscriptionInvoiceCreatedEvent.entry.workstream).toBe("WS-05");
  });
});
