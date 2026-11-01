import { test } from "node:test";
import assert from "node:assert/strict";
import * as a from "../packages/shared/src/adapters/index.ts";
import {
  establishTenantContext,
  establishScopedTenantContext,
} from "../packages/shared/src/core/server.ts";
import { cafeLegendFixtures } from "../packages/shared/src/core/index.ts";

const tenant = establishTenantContext({
  tenantId: cafeLegendFixtures.tenant.id,
  brandId: null,
  source: "session",
});
const context = establishScopedTenantContext(tenant, { kind: "tenant" });

test("Cafe Legend adapter fixtures parse and preserve rupiah and scope", () => {
  for (const [name, schema] of Object.entries(a.fixtureSchemas))
    schema.parse(a.adapterFixtures[name]);
  assert.equal(a.adapterFixtures.payment.amountIdr, 56000);
  assert.equal(
    a.paymentRequestSchema.safeParse({
      ...a.adapterFixtures.payment,
      amountIdr: 1.5,
    }).success,
    false,
  );
});
test("fake payment is deterministic and enforces trusted outlet scope", async () => {
  const fake = new a.FakePaymentProvider();
  assert.deepEqual(
    await fake.createPayment(context, a.adapterFixtures.payment),
    await fake.createPayment(context, a.adapterFixtures.payment),
  );
  await assert.rejects(
    () => fake.createPayment({}, a.adapterFixtures.payment),
    TypeError,
  );
});
test("inbound messaging never sends an automatic reply", async () => {
  const fake = new a.FakeMessagingProvider();
  assert.deepEqual(
    await fake.receive(context, a.adapterFixtures.inboundMessage),
    a.adapterFixtures.inboundMessage,
  );
  assert.equal(fake.sent.length, 0);
});
test("fake providers return schema-valid deterministic results", async () => {
  for (const [provider, method, fixture, schema] of [
    [
      new a.FakeEdcProvider(),
      "transact",
      a.adapterFixtures.edc,
      a.edcResultSchema,
    ],
    [
      new a.FakeWifiProvider(),
      "authorize",
      a.adapterFixtures.wifi,
      a.wifiResultSchema,
    ],
    [
      new a.FakeDeliveryChannel(),
      "execute",
      a.adapterFixtures.delivery,
      a.operationResultSchema,
    ],
    [
      new a.FakeLockProvider(),
      "issue",
      a.adapterFixtures.lock,
      a.operationResultSchema,
    ],
    [
      new a.FakeObjectStorage(),
      "put",
      a.adapterFixtures.storage,
      a.operationResultSchema,
    ],
    [
      new a.FakeEmailProvider(),
      "send",
      a.adapterFixtures.email,
      a.operationResultSchema,
    ],
    [
      new a.FakePushProvider(),
      "send",
      a.adapterFixtures.push,
      a.operationResultSchema,
    ],
    [
      new a.FakeLlmProvider(),
      "complete",
      a.adapterFixtures.llm,
      a.llmResultSchema,
    ],
  ]) {
    const first = await provider[method](context, fixture);
    schema.parse(first);
    assert.deepEqual(await provider[method](context, fixture), first);
  }
});

test("EDC cancellation and status, Wi-Fi revocation, and storage round trip are available", async () => {
  const edc = new a.FakeEdcProvider();
  const ref = {
    tenantId: a.adapterFixtures.edc.tenantId,
    outletId: a.adapterFixtures.edc.outletId,
    reference: a.adapterFixtures.edc.reference,
  };
  await edc.transact(context, a.adapterFixtures.edc);
  assert.equal((await edc.cancel(context, ref)).status, "cancelled");
  assert.equal((await edc.status(context, ref)).status, "cancelled");
  const wifi = new a.FakeWifiProvider();
  await wifi.authorize(context, a.adapterFixtures.wifi);
  assert.equal(
    (
      await wifi.revoke(context, {
        ...ref,
        reference: a.adapterFixtures.wifi.reference,
      })
    ).authorized,
    false,
  );
  const storage = new a.FakeObjectStorage();
  await storage.put(context, a.adapterFixtures.storage);
  assert.equal(
    (
      await storage.get(context, {
        ...ref,
        reference: a.adapterFixtures.storage.reference,
        key: a.adapterFixtures.storage.key,
      })
    ).content,
    "fixture",
  );
});
