import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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
const [outletA, outletB] = cafeLegendFixtures.outlets.map((o) => o.id);
const cashierContext = establishScopedTenantContext(tenant, {
  kind: "outlets",
  outletIds: [outletA],
});
const otherTenantId = "99999999-9999-4999-8999-999999999999";
const otherContext = establishScopedTenantContext(
  establishTenantContext({
    tenantId: otherTenantId,
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);
const fx = a.adapterFixtures;
const rejectsCode = (promise, code) =>
  assert.rejects(promise, (error) => error?.code === code);
const refOf = (input) => ({
  tenantId: input.tenantId,
  outletId: input.outletId,
  reference: input.reference,
});

test("Cafe Legend adapter fixtures parse and preserve rupiah and scope", () => {
  for (const [name, schema] of Object.entries(a.fixtureSchemas))
    schema.parse(fx[name]);
  assert.equal(fx.payment.amountIdr, 56000);
  assert.equal(
    a.paymentRequestSchema.safeParse({ ...fx.payment, amountIdr: 1.5 }).success,
    false,
  );
  assert.equal(
    a.paymentRequestSchema.safeParse({ ...fx.payment, amountIdr: 0 }).success,
    false,
  );
});

test("payment idempotency key follows the core rule (8-100 safe characters)", () => {
  for (const idempotencyKey of ["short", "has space 123", "x".repeat(101)])
    assert.equal(
      a.paymentRequestSchema.safeParse({ ...fx.payment, idempotencyKey })
        .success,
      false,
      idempotencyKey,
    );
});

test("every provider call needs a server-minted context", async () => {
  const fake = new a.FakePaymentProvider();
  await assert.rejects(() => fake.createPayment({}, fx.payment), TypeError);
  await assert.rejects(
    () => fake.createPayment(undefined, fx.payment),
    TypeError,
  );
  // Body tenant must equal the context tenant.
  await assert.rejects(
    () => fake.createPayment(otherContext, fx.payment),
    /Tenant mismatch/,
  );
  // Outlet-scoped caller cannot act on another outlet.
  await rejectsCode(
    fake.createPayment(cashierContext, { ...fx.payment, outletId: outletB }),
    "OUTLET_OUT_OF_SCOPE",
  );
  await fake.createPayment(cashierContext, fx.payment);
});

test("payment: idempotent per key, conflicting reuse is rejected", async () => {
  const fake = new a.FakePaymentProvider();
  const first = await fake.createPayment(context, fx.payment);
  assert.deepEqual(first, await fake.createPayment(context, fx.payment));
  assert.equal(first.status, "pending");
  await rejectsCode(
    fake.createPayment(context, { ...fx.payment, amountIdr: 1000 }),
    "IDEMPOTENCY_KEY_REUSED",
  );
  // Same key in another tenant is a different payment.
  const other = await fake.createPayment(otherContext, {
    ...fx.payment,
    tenantId: otherTenantId,
  });
  assert.equal(other.status, "pending");
});

test("payment: status lookup, simulated settlement, refund rules", async () => {
  const fake = new a.FakePaymentProvider();
  const ref = refOf(fx.payment);
  await rejectsCode(fake.getPayment(context, ref), "NOT_FOUND");
  await fake.createPayment(context, fx.payment);
  assert.equal((await fake.getPayment(context, ref)).status, "pending");
  const refund = {
    ...ref,
    idempotencyKey: "refund-legend-001",
    amountIdr: 56000,
  };
  await rejectsCode(fake.refund(context, refund), "CONFLICT");
  fake.simulate(ref, "paid");
  assert.equal((await fake.getPayment(context, ref)).status, "paid");
  await rejectsCode(
    fake.refund(context, { ...refund, amountIdr: 56001 }),
    "CONFLICT",
  );
  const refunded = await fake.refund(context, refund);
  assert.equal(refunded.status, "refunded");
  assert.deepEqual(await fake.refund(context, refund), refunded);
  await rejectsCode(
    fake.refund(context, { ...refund, amountIdr: 1000 }),
    "IDEMPOTENCY_KEY_REUSED",
  );
  assert.throws(() => fake.simulate(ref, "failed"), /pending/);
});

test("payment: data is isolated by tenant and outlet", async () => {
  const fake = new a.FakePaymentProvider();
  await fake.createPayment(context, fx.payment);
  await rejectsCode(
    fake.getPayment(otherContext, {
      ...refOf(fx.payment),
      tenantId: otherTenantId,
    }),
    "NOT_FOUND",
  );
  await rejectsCode(
    fake.getPayment(context, { ...refOf(fx.payment), outletId: outletB }),
    "NOT_FOUND",
  );
});

test("a failed payment may be retried under a new key and the same reference", async () => {
  const fake = new a.FakePaymentProvider();
  await fake.createPayment(context, fx.payment);
  await rejectsCode(
    fake.createPayment(context, {
      ...fx.payment,
      idempotencyKey: "pay-other-1",
    }),
    "CONFLICT",
  );
  fake.simulate(refOf(fx.payment), "failed");
  const retry = await fake.createPayment(context, {
    ...fx.payment,
    idempotencyKey: "pay-other-1",
  });
  assert.equal(retry.status, "pending");
});

test("inbound messaging: no automatic reply, duplicates flagged, never create twice", async () => {
  const fake = new a.FakeMessagingProvider();
  const first = await fake.receive(context, fx.inboundMessage);
  assert.deepEqual(first, { message: fx.inboundMessage, duplicate: false });
  const again = await fake.receive(context, fx.inboundMessage);
  assert.equal(again.duplicate, true);
  // A retry with altered text is still the same provider message.
  assert.equal(
    (await fake.receive(context, { ...fx.inboundMessage, text: "OTHER" }))
      .duplicate,
    true,
  );
  assert.equal(fake.sent.length, 0);
  // Same wamid for another tenant is not a duplicate.
  assert.equal(
    (
      await fake.receive(otherContext, {
        ...fx.inboundMessage,
        tenantId: otherTenantId,
      })
    ).duplicate,
    false,
  );
});

test("messaging input: digits-only numbers, WhatsApp text limit, no header-name field", () => {
  for (const sender of ["+628123456789", "0812 3456", "abc", "1"])
    assert.equal(
      a.inboundMessageSchema.safeParse({ ...fx.inboundMessage, sender })
        .success,
      false,
      sender,
    );
  assert.equal(
    a.inboundMessageSchema.safeParse({
      ...fx.inboundMessage,
      text: "x".repeat(4097),
    }).success,
    false,
  );
  assert.equal(
    a.inboundMessageSchema.safeParse({
      ...fx.inboundMessage,
      signatureHeader: "X-Kirim-Signature",
    }).success,
    false,
  );
  assert.equal(
    a.messageRequestSchema.safeParse({ ...fx.message, recipient: "08123" })
      .success,
    false,
  );
});

test("outbound messages are idempotent per reference", async () => {
  const fake = new a.FakeMessagingProvider();
  const first = await fake.send(context, fx.message);
  assert.deepEqual(first, await fake.send(context, fx.message));
  assert.equal(fake.sent.length, 1);
  await rejectsCode(
    fake.send(context, { ...fx.message, text: "Lain" }),
    "IDEMPOTENCY_KEY_REUSED",
  );
  assert.equal(fake.sent.length, 1);
});

// --- KirimDev webhook (AUTH-02, owner-approved X-Kirim-Signature) -----------
const secret = "whsec_test_secret";
const body = JSON.stringify({
  type: "message.received",
  text: "LEGEND 123456",
});
const now = 1_790_000_000;
const sign = (payload, key, t) =>
  createHmac("sha256", key).update(`${t}.${payload}`).digest("hex");
const header = (t = now, key = secret, payload = body) =>
  `t=${t},v1=${sign(payload, key, t)}`;
const headers = (over = {}) => ({
  "x-kirim-signature": header(),
  "x-kirim-event-id": "wamid.HBgL123",
  "x-kirim-delivery-id": "wbd_01",
  ...over,
});
const verify = (over = {}, extra = {}) =>
  a.verifyKirimWebhook({
    rawBody: body,
    headers: headers(over),
    secrets: [secret],
    nowSeconds: now,
    ...extra,
  });

test("KirimDev webhook: valid signature yields the dedupe event id", async () => {
  assert.deepEqual(await verify(), {
    eventId: "wamid.HBgL123",
    deliveryId: "wbd_01",
    signedAt: now,
  });
  assert.equal(a.KIRIM_SIGNATURE_HEADER, "X-Kirim-Signature");
  // Signature helper used by route tests matches the verifier.
  const signed = await a.signKirimWebhook({
    rawBody: body,
    secret,
    timestamp: now,
  });
  assert.equal(signed, header());
  assert.equal(
    (
      await verify({
        "x-kirim-signature": signed,
        "x-kirim-delivery-id": undefined,
      })
    ).deliveryId,
    null,
  );
});

test("KirimDev webhook: bytes, Headers-like objects and header case", async () => {
  const bytes = new TextEncoder().encode(body);
  assert.ok(await verify({}, { rawBody: bytes }));
  const map = new Map(Object.entries(headers()));
  const headerLike = { get: (name) => map.get(name.toLowerCase()) ?? null };
  assert.ok(
    await a.verifyKirimWebhook({
      rawBody: body,
      headers: headerLike,
      secrets: [secret],
      nowSeconds: now,
    }),
  );
  const mixed = { "X-Kirim-Signature": header(), "X-Kirim-Event-Id": "e1" };
  assert.equal(
    (
      await a.verifyKirimWebhook({
        rawBody: body,
        headers: mixed,
        secrets: [secret],
        nowSeconds: now,
      })
    ).eventId,
    "e1",
  );
});

test("KirimDev webhook: forgery, tampering and replay are rejected uniformly", async () => {
  const bad = async (over, extra) =>
    rejectsCode(verify(over, extra), "UNAUTHORIZED");
  await bad({ "x-kirim-signature": header(now, "wrong-secret") });
  await bad({}, { rawBody: body + " " });
  await bad({}, { rawBody: body.replace("123456", "654321") });
  await bad({ "x-kirim-signature": undefined });
  // Replay: outside the 5 minute window in either direction.
  await bad({ "x-kirim-signature": header(now - 301) });
  await bad({ "x-kirim-signature": header(now + 301) });
  assert.ok(await verify({ "x-kirim-signature": header(now - 300) }));
  assert.ok(await verify({ "x-kirim-signature": header(now + 300) }));
  assert.equal(a.KIRIM_TOLERANCE_SECONDS, 300);
  await bad(
    { "x-kirim-signature": header(now - 301) },
    { toleranceSeconds: 300 },
  );
  assert.ok(
    await verify(
      { "x-kirim-signature": header(now - 400) },
      { toleranceSeconds: 600 },
    ),
  );
  // The timestamp is part of the signed string: swapping it breaks the tag.
  const v1 = sign(body, secret, now);
  await bad({ "x-kirim-signature": `t=${now + 1},v1=${v1}` });
});

test("KirimDev webhook: malformed headers never verify", async () => {
  const v1 = sign(body, secret, now);
  for (const value of [
    "",
    "garbage",
    `v1=${v1}`,
    `t=${now}`,
    `t=${now},v1=`,
    `t=${now},v1=zz${v1.slice(2)}`,
    `t=${now},v1=${v1.slice(2)}`,
    `t=${now},v1=${v1}00`,
    `t=abc,v1=${v1}`,
    `t=-5,v1=${v1}`,
    `t=1e9,v1=${v1}`,
    `t=0x10,v1=${v1}`,
    `t=${now} ,v2=${v1}`,
    "t=".padEnd(5000, "9"),
  ])
    await rejectsCode(verify({ "x-kirim-signature": value }), "UNAUTHORIZED");
  // Ambiguous duplicated header values fail closed.
  await rejectsCode(
    verify({ "x-kirim-signature": [header(), header()] }),
    "UNAUTHORIZED",
  );
  assert.ok(await verify({ "x-kirim-signature": [header()] }));
});

test("KirimDev webhook: secret rotation accepts any active secret", async () => {
  const oldSecret = "whsec_old";
  const rotated = `t=${now},v1=${sign(body, oldSecret, now)},v1=${sign(body, secret, now)}`;
  assert.ok(await verify({ "x-kirim-signature": rotated }));
  assert.ok(
    await verify({ "x-kirim-signature": rotated }, { secrets: [oldSecret] }),
  );
  assert.ok(
    await verify(
      { "x-kirim-signature": header(now, oldSecret) },
      { secrets: [secret, oldSecret] },
    ),
  );
  await rejectsCode(
    verify({ "x-kirim-signature": header(now, oldSecret) }),
    "UNAUTHORIZED",
  );
  // Unknown future scheme entries are ignored but cannot satisfy verification.
  assert.ok(await verify({ "x-kirim-signature": `${header()},v2=abcd` }));
  await rejectsCode(
    verify({ "x-kirim-signature": `t=${now},v2=${sign(body, secret, now)}` }),
    "UNAUTHORIZED",
  );
  await assert.rejects(() => verify({}, { secrets: [] }), TypeError);
  await assert.rejects(() => verify({}, { secrets: [""] }), TypeError);
});

test("KirimDev webhook: a signed delivery still needs an event id", async () => {
  await rejectsCode(
    verify({ "x-kirim-event-id": undefined }),
    "VALIDATION_ERROR",
  );
  await rejectsCode(verify({ "x-kirim-event-id": "" }), "VALIDATION_ERROR");
  await rejectsCode(
    verify({ "x-kirim-event-id": "x".repeat(256) }),
    "VALIDATION_ERROR",
  );
});

test("FakeMessagingProvider verifies webhooks with its configured secrets", async () => {
  const fake = new a.FakeMessagingProvider(["fake-a", "fake-b"]);
  const signature = await a.signKirimWebhook({
    rawBody: body,
    secret: "fake-b",
    timestamp: now,
  });
  const result = await fake.verifyWebhook({
    rawBody: body,
    headers: { "x-kirim-signature": signature, "x-kirim-event-id": "e9" },
    nowSeconds: now,
  });
  assert.equal(result.eventId, "e9");
  await rejectsCode(
    fake.verifyWebhook({
      rawBody: body,
      headers: { "x-kirim-event-id": "e9" },
      nowSeconds: now,
    }),
    "UNAUTHORIZED",
  );
});

// --- remaining providers ----------------------------------------------------
test("EDC: idempotent, status, cancel only while pending, simulated outcomes", async () => {
  const edc = new a.FakeEdcProvider();
  const ref = refOf(fx.edc);
  const first = await edc.transact(context, fx.edc);
  assert.deepEqual(first, await edc.transact(context, fx.edc));
  await rejectsCode(
    edc.transact(context, { ...fx.edc, bank: "bni" }),
    "IDEMPOTENCY_KEY_REUSED",
  );
  assert.equal((await edc.cancel(context, ref)).status, "cancelled");
  assert.equal((await edc.status(context, ref)).status, "cancelled");
  assert.deepEqual(
    await edc.transact(context, fx.edc),
    await edc.status(context, ref),
  );
  const paid = { ...fx.edc, reference: "pos-002" };
  await edc.transact(context, paid);
  edc.simulate(refOf(paid), "paid");
  assert.equal((await edc.status(context, refOf(paid))).status, "paid");
  await rejectsCode(edc.cancel(context, refOf(paid)), "CONFLICT");
  await rejectsCode(
    edc.status(context, { ...ref, reference: "nope" }),
    "NOT_FOUND",
  );
  await rejectsCode(
    edc.status(otherContext, { ...ref, tenantId: otherTenantId }),
    "NOT_FOUND",
  );
  await rejectsCode(
    edc.cancel(cashierContext, { ...ref, outletId: outletB }),
    "OUTLET_OUT_OF_SCOPE",
  );
});

test("Wi-Fi: bounded input, idempotent authorize, revoke is final for that voucher", async () => {
  const wifi = new a.FakeWifiProvider();
  for (const patch of [
    { durationSeconds: 0 },
    { durationSeconds: 1.5 },
    { bandwidthKbps: 0 },
    {
      walledGarden: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`),
    },
  ])
    assert.equal(
      a.wifiRequestSchema.safeParse({ ...fx.wifi, ...patch }).success,
      false,
    );
  assert.equal((await wifi.authorize(context, fx.wifi)).authorized, true);
  assert.equal((await wifi.authorize(context, fx.wifi)).authorized, true);
  await rejectsCode(
    wifi.authorize(context, { ...fx.wifi, durationSeconds: 60 }),
    "IDEMPOTENCY_KEY_REUSED",
  );
  const ref = refOf(fx.wifi);
  assert.equal((await wifi.revoke(context, ref)).authorized, false);
  assert.equal((await wifi.authorize(context, fx.wifi)).authorized, false);
});

test("lock: validity window, idempotent issue, revoke", async () => {
  const lock = new a.FakeLockProvider();
  for (const patch of [
    { validUntil: fx.lock.validFrom },
    { validUntil: "2026-11-01T09:00:00Z" },
    { validFrom: "yesterday" },
  ])
    assert.equal(
      a.lockRequestSchema.safeParse({ ...fx.lock, ...patch }).success,
      false,
    );
  const first = await lock.issue(context, fx.lock);
  assert.deepEqual(first, await lock.issue(context, fx.lock));
  await rejectsCode(
    lock.issue(context, { ...fx.lock, credential: "999999" }),
    "IDEMPOTENCY_KEY_REUSED",
  );
  assert.equal((await lock.revoke(context, refOf(fx.lock))).accepted, true);
  await rejectsCode(
    lock.revoke(context, { ...refOf(fx.lock), reference: "none" }),
    "NOT_FOUND",
  );
});

test("lock credentials never leak through schema errors or fake results", async () => {
  const result = await new a.FakeLockProvider().issue(context, fx.lock);
  assert.equal(JSON.stringify(result).includes(fx.lock.credential), false);
  const parsed = a.lockRequestSchema.safeParse({
    ...fx.lock,
    validFrom: "bad",
  });
  assert.equal(
    JSON.stringify(parsed.error?.issues ?? []).includes(fx.lock.credential),
    false,
  );
});

test("delivery channel: idempotent per reference, JSON payload only", async () => {
  const channel = new a.FakeDeliveryChannel();
  const first = await channel.execute(context, fx.delivery);
  assert.deepEqual(first, await channel.execute(context, fx.delivery));
  // Key order does not matter for the idempotency comparison.
  assert.deepEqual(
    first,
    await channel.execute(context, {
      ...fx.delivery,
      payload: { priceIdr: 28000, item: "Kopi Susu Legend" },
    }),
  );
  await rejectsCode(
    channel.execute(context, { ...fx.delivery, payload: { item: "Lain" } }),
    "IDEMPOTENCY_KEY_REUSED",
  );
  assert.equal(
    a.deliveryRequestSchema.safeParse({
      ...fx.delivery,
      payload: { at: new Date() },
    }).success,
    false,
  );
});

test("object storage: safe keys, tenant isolation, tenant-level objects need tenant scope", async () => {
  for (const key of [
    "../etc/passwd",
    "/abs",
    "a//b",
    "a/./b",
    "a/../b",
    "a\\b",
    "",
    "a b",
    "x".repeat(513),
    "a/",
  ])
    assert.equal(
      a.storageRequestSchema.safeParse({ ...fx.storage, key }).success,
      false,
      key,
    );
  for (const key of ["menu/kopi.webp", "reports/2026-11/receipt_01.pdf"])
    assert.equal(
      a.storageRequestSchema.safeParse({ ...fx.storage, key }).success,
      true,
      key,
    );
  const storage = new a.FakeObjectStorage();
  await storage.put(context, fx.storage);
  const lookup = { ...refOf(fx.storage), key: fx.storage.key };
  assert.equal((await storage.get(context, lookup)).content, "fixture");
  await rejectsCode(
    storage.get(context, { ...lookup, key: "menu/none.webp" }),
    "NOT_FOUND",
  );
  await rejectsCode(
    storage.get(otherContext, { ...lookup, tenantId: otherTenantId }),
    "NOT_FOUND",
  );
  // Tenant-level object: outletId null.
  const shared = { ...fx.storage, outletId: null, key: "brand/logo.webp" };
  await storage.put(context, shared);
  assert.equal(
    (await storage.get(context, { ...refOf(shared), key: shared.key })).key,
    shared.key,
  );
  await rejectsCode(storage.put(cashierContext, shared), "OUTLET_OUT_OF_SCOPE");
});

test("email: single-line subject (no header injection), valid recipient, idempotent", async () => {
  for (const subject of ["Hi\r\nBcc: x@y.id", "Hi\nthere", ""])
    assert.equal(
      a.emailRequestSchema.safeParse({ ...fx.email, subject }).success,
      false,
    );
  assert.equal(
    a.emailRequestSchema.safeParse({ ...fx.email, to: "not-an-email" }).success,
    false,
  );
  const email = new a.FakeEmailProvider();
  const first = await email.send(context, fx.email);
  assert.deepEqual(first, await email.send(context, fx.email));
  assert.equal(email.sent.length, 1);
  await rejectsCode(
    email.send(context, { ...fx.email, body: "Lain" }),
    "IDEMPOTENCY_KEY_REUSED",
  );
});

test("push endpoint must be a public https URL (SSRF guard)", () => {
  const ok = (endpoint) =>
    a.pushRequestSchema.safeParse({ ...fx.push, endpoint }).success;
  assert.equal(ok("https://fcm.googleapis.com/fcm/send/abc"), true);
  for (const endpoint of [
    "http://push.example.com/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://10.0.0.5/x",
    "https://192.168.1.1/x",
    "https://172.16.0.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "https://[fd00::1]/x",
    "https://printer.local/x",
    "https://db.internal/x",
    "https://user:pass@push.example.com/x",
    "https://2130706433/x",
    "ftp://push.example.com/x",
    "javascript:alert(1)",
  ])
    assert.equal(ok(endpoint), false, endpoint);
});

test("LLM config: https only, secret never printed, usage reported", async () => {
  const config = {
    baseUrl: "https://llm.example.com/v1",
    apiKey: "sk-live-123",
    model: "gpt-x",
  };
  assert.ok(a.llmConfigSchema.parse(config));
  for (const baseUrl of [
    "http://llm.example.com/v1",
    "https://localhost:11434/v1",
    "https://10.1.1.1/v1",
    "https://metadata.google.internal/v1",
  ])
    assert.equal(
      a.llmConfigSchema.safeParse({ ...config, baseUrl }).success,
      false,
      baseUrl,
    );
  const redacted = a.redactLlmConfig(config);
  assert.equal(JSON.stringify(redacted).includes("sk-live-123"), false);
  assert.equal(redacted.model, "gpt-x");
  assert.equal(
    JSON.stringify(
      a.llmConfigSchema.safeParse({ ...config, baseUrl: "bad" }).error?.issues,
    ).includes("sk-live-123"),
    false,
  );
  const llm = new a.FakeLlmProvider();
  const result = await llm.complete(context, fx.llm);
  assert.deepEqual(result.usage, { promptTokens: 8, completionTokens: 6 });
  assert.deepEqual(result, await llm.complete(context, fx.llm));
  await rejectsCode(
    llm.complete(context, {
      ...fx.llm,
      messages: [{ role: "user", content: "Lain" }],
    }),
    "IDEMPOTENCY_KEY_REUSED",
  );
});

test("tenant-level calls (outletId null) need a tenant-wide scope", async () => {
  const email = new a.FakeEmailProvider();
  const tenantLevel = { ...fx.email, outletId: null };
  assert.ok(await email.send(context, tenantLevel));
  await rejectsCode(
    email.send(cashierContext, { ...tenantLevel, reference: "email-002" }),
    "OUTLET_OUT_OF_SCOPE",
  );
  // Outlet-bound providers still require an outlet.
  assert.equal(
    a.paymentRequestSchema.safeParse({ ...fx.payment, outletId: null }).success,
    false,
  );
  assert.equal(
    a.messageRequestSchema.safeParse({ ...fx.message, outletId: null }).success,
    false,
  );
});

test("adapter events use catalogued names", async () => {
  const { eventCatalogByName } =
    await import("../packages/shared/src/events/index.ts");
  for (const name of a.adapterEventNames)
    assert.equal(eventCatalogByName.get(name)?.workstream, "WS-00", name);
  assert.ok(a.adapterEventNames.length >= 12);
});
