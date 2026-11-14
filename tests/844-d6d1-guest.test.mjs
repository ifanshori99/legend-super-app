import assert from "node:assert/strict";
import { after, test } from "node:test";
import { registerHooks } from "node:module";
import { registerWebAlias } from "./helpers/web-alias.mjs";

registerWebAlias();
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/api/endpoint")
      return {
        url: `data:text/javascript,${encodeURIComponent("export const callEndpoint = (...args) => globalThis.__844Transport(...args);")}`,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
after(() => {
  hook.deregister();
  delete globalThis.__844Transport;
  delete globalThis.sessionStorage;
});
const { fetchMenuItems, fetchPriceListItems } =
  await import("../apps/web/src/features/ws08-delivery/api.ts");

for (const kind of ["menu", "prices"]) {
  test(`d6d1 manual-order ${kind} includes entries beyond the first 100`, async () => {
    const calls = [];
    const options = { signal: new AbortController().signal };
    globalThis.__844Transport = async (endpoint, input, passedOptions) => {
      assert.equal(passedOptions, options);
      calls.push(input);
      const offset = input.query.cursor ? 100 : 0;
      return {
        data: Array.from({ length: offset ? 7 : 100 }, (_, index) => ({
          id: `${kind}-${offset + index}`,
        })),
        meta: { nextCursor: offset ? null : "page-2" },
      };
    };
    const page =
      kind === "menu"
        ? await fetchMenuItems(
            { limit: 100, status: "active", outletId: "outlet" },
            options,
          )
        : await fetchPriceListItems({ priceListId: "channel-prices" }, options);
    assert.equal(page.data.length, 107);
    assert.equal(page.data[106].id, `${kind}-106`);
    assert.equal(page.meta.nextCursor, null);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].query.limit, 100);
    assert.equal(calls[1].query.cursor, "page-2");
    if (kind === "menu") assert.equal(calls[1].query.status, "active");
    else assert.equal(calls[1].params.priceListId, "channel-prices");
  });
}

test("d6d1 deposit link survives booking reload, charges exact deposit once and persists paid confirmation", async (t) => {
  const storage = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  const { cafeLegendFixtures } =
    await import("../packages/shared/src/core/index.ts");
  const { findMock, clearMocks } =
    await import("../apps/web/src/lib/mock/registry.ts");
  const { resetMockStores } = await import("../apps/web/src/lib/mock/store.ts");
  const { findExternalPaymentLink } =
    await import("../apps/web/src/lib/mock/payment-link-bridge.ts");
  const { saveConfirmation, readConfirmation, depositToken } =
    await import("../apps/web/src/features/ws08-reservation-customer/lib.ts");
  await import("../apps/web/src/features/ws08-reservation-customer/mock.ts");
  const outletId = cafeLegendFixtures.outlets[0].id;
  const base = `/api/public/outlets/${outletId}`;
  const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const availabilityPath = `${base}/reservation-availability`;
  // Find by endpoint contract rather than assuming its public URL spelling.
  const { getReservationAvailability, createReservation } =
    await import("../packages/shared/src/reservation/index.ts");
  const pathOf = (endpoint) => endpoint.path.replace(":outletId", outletId);
  const available = findMock("GET", pathOf(getReservationAvailability));
  assert.ok(available, availabilityPath);
  const slots = available.entry.handler({
    params: { outletId },
    query: { date, pax: 2 },
    scenario: "normal",
  }).data.slots;
  assert.ok(slots.length > 0);
  const request = {
    params: { outletId },
    body: {
      guestName: "Tamu Regresi",
      guestPhone: "081234567890",
      reservedFor: slots[0].startsAt,
      pax: 2,
    },
    scenario: "normal",
    headers: { "Idempotency-Key": "booking-replay" },
  };
  const create = findMock("POST", pathOf(createReservation));
  const created = create.entry.handler(request).data;
  saveConfirmation(created);
  const token = depositToken(created.deposit.paymentPath);
  const amount = created.deposit.amountIdr;
  assert.equal(findExternalPaymentLink(token).subtotalIdr, amount);
  resetMockStores();
  clearMocks();
  assert.equal(findExternalPaymentLink(token), undefined);
  await import("../apps/web/src/features/ws08-reservation-customer/mock.ts?reload-844");
  const restored = findExternalPaymentLink(token);
  assert.ok(
    restored,
    "Pending booking restored at browser boot registers the payment token",
  );
  assert.equal(restored.subtotalIdr, amount);
  assert.equal(restored.taxIdr, 0);
  await import("../apps/web/src/features/ws05-payment/mock.ts");
  const { getPaymentLink, createPaymentIntent, getPaymentIntent } =
    await import("../packages/shared/src/payment/index.ts");
  const paymentPath = (endpoint, intentId = "") =>
    endpoint.path.replace(":token", token).replace(":intentId", intentId);
  const readLink = () =>
    findMock("GET", paymentPath(getPaymentLink)).entry.handler({
      params: { token },
      scenario: "normal",
    }).data;
  const payable = readLink();
  assert.equal(payable.bill.totals.taxIdr, 0);
  assert.equal(payable.bill.totals.totalIdr, amount);
  assert.equal(payable.bill.totals.outstandingIdr, amount);
  const intentRequest = {
    params: { token },
    body: {
      method: "qris",
      channelCode: null,
      idempotencyKey: "deposit-payment",
    },
  };
  const createIntent = findMock("POST", paymentPath(createPaymentIntent)).entry
    .handler;
  const intent = createIntent(intentRequest).data;
  assert.equal(intent.amountIdr, amount);
  assert.equal(
    createIntent(intentRequest).data.id,
    intent.id,
    "Retry reuses one payable intent",
  );
  const poll = findMock("GET", paymentPath(getPaymentIntent, intent.id)).entry
    .handler;
  assert.equal(
    poll({ params: { token, intentId: intent.id } }).data.status,
    "pending",
  );
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 7000 });
  const settled = poll({ params: { token, intentId: intent.id } }).data;
  assert.equal(settled.status, "paid");
  assert.equal(settled.amountIdr, amount);
  assert.equal(readLink().bill.totals.paidIdr, amount);
  assert.equal(readLink().bill.totals.outstandingIdr, 0);
  assert.throws(
    () =>
      createIntent({
        ...intentRequest,
        body: { ...intentRequest.body, idempotencyKey: "second-payment" },
      }),
    (error) => error.status === 409 && error.code === "CONFLICT",
  );
  const paid = readConfirmation();
  assert.equal(paid.reservation.id, created.reservation.id);
  assert.equal(paid.reservation.status, "confirmed");
  assert.equal(paid.reservation.depositStatus, "paid");
  assert.equal(paid.reservation.depositIdr, amount);
  const paymentId = paid.reservation.depositPaymentId;
  assert.ok(paymentId);
  assert.equal(
    poll({ params: { token, intentId: intent.id } }).data.id,
    intent.id,
  );
  assert.equal(
    readConfirmation().reservation.depositPaymentId,
    paymentId,
    "Duplicate settlement creates no second payment",
  );
});
