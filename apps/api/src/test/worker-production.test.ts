import { expect, it, vi } from "vitest";
import { tenantIdSchema, ulidSchema } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import {
  createProductionWorkerConfig,
  loadWorkerConfig,
} from "../worker/production-config.ts";

const tenantId = tenantIdSchema.parse("11111111-1111-4111-8111-111111111111");
const otherTenantId = tenantIdSchema.parse(
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
);
const notifications = {
  resolveNotificationRecipients: vi.fn(async () => []),
  notificationDelivery: {
    resolve: vi.fn(async () => {
      throw new Error("not used");
    }),
    email: { send: vi.fn() },
    push: { send: vi.fn() },
  },
} as never;
const route = { destination: "cloud-sync", direction: null, peerId: null };
const event = eventEnvelopeSchema.parse({
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  tenantId,
  outletId: null,
  name: "order.paid",
  version: 1,
  aggregateType: "order",
  aggregateId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  sequence: 1,
  occurredAt: "2026-11-01T12:00:00.000Z",
  actor: { type: "system" },
  idempotencyKey: "event-1",
  payloadSchemaRef: "order.paid.v1",
  payload: {},
});

it("legend-fzkl binds worker jobs and events to their trusted tenant", async () => {
  const transport = {
    deliverEvent: vi.fn(async () => {}),
    requestMissing: vi.fn(async () => {}),
  };
  const config = createProductionWorkerConfig(transport, notifications);
  const context = await config.resolveContext(tenantId);
  const other = await config.resolveContext(otherTenantId);
  const job = {
    tenantId,
    outboxId: ulidSchema.parse("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    generation: 0,
  };
  expect(await config.authorize(context, job)).toBe(true);
  expect(await config.authorize(other, job)).toBe(false);
  expect(await config.authorizeEvent(context, event)).toBe(true);
  expect(await config.authorizeEvent(other, event)).toBe(false);
  await expect(
    config.authorize({ ...context, tenant: { ...context.tenant } }, job),
  ).rejects.toThrow("Untrusted");
  await expect(
    config.deliverEvent(other, event, event.id, {} as never, route),
  ).rejects.toThrow("tenant mismatch");
  expect(transport.deliverEvent).not.toHaveBeenCalled();
});

it("legend-fzkl requires a durable transport and delegates gaps", async () => {
  expect(() =>
    createProductionWorkerConfig({} as never, notifications),
  ).toThrow("transport");
  const transport = {
    deliverEvent: vi.fn(async () => {}),
    requestMissing: vi.fn(async () => {}),
  };
  const config = createProductionWorkerConfig(transport, notifications);
  const context = await config.resolveContext(tenantId);
  const gap = {
    destination: "cloud-sync",
    aggregateType: "order",
    aggregateId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    missingSequence: 1,
  };
  await config.requestMissing(context, gap);
  expect(transport.requestMissing).toHaveBeenCalledWith(context, gap);
});

const productionEnv = {
  DEPLOYMENT_MODE: "production",
  EDGE_MODE: "false",
  WORKER_TRANSPORT: "builtin",
  NOTIFICATION_EMAIL_PROVIDER: "disabled",
  NOTIFICATION_PUSH_PROVIDER: "disabled",
  NOTIFICATION_WHATSAPP_PROVIDER: "disabled",
};

it("legend-18qw production worker starts with the built-in transport once its config is complete", async () => {
  const config = await loadWorkerConfig({
    env: productionEnv,
    database: {} as never,
  });
  for (const name of [
    "resolveContext",
    "authorize",
    "authorizeEvent",
    "deliverEvent",
    "requestMissing",
    "resolveNotificationRecipients",
  ] as const)
    expect(typeof config[name]).toBe("function");
  expect(typeof config.notificationDelivery.resolve).toBe("function");
  // Cloud: a cloud-sync event is a local sink; the consumption row is the ack.
  const context = await config.resolveContext(tenantId);
  await expect(
    config.deliverEvent(context, event, event.id, {} as never, route),
  ).resolves.toBeUndefined();
  await expect(
    config.deliverEvent(context, event, event.id, {} as never, {
      ...route,
      destination: "elsewhere",
    }),
  ).rejects.toThrow("Unsupported outbox destination");
});

it("legend-18qw production worker still fails closed while transport or notification config is missing", async () => {
  const noTransport: Record<string, string | undefined> = { ...productionEnv };
  delete noTransport.WORKER_TRANSPORT;
  await expect(
    loadWorkerConfig({ env: noTransport, database: {} as never }),
  ).rejects.toThrow("no durable sync transport");
  await expect(
    loadWorkerConfig({
      env: { ...productionEnv, WORKER_TRANSPORT: "http" },
      database: {} as never,
    }),
  ).rejects.toThrow("WORKER_TRANSPORT must be builtin");
  for (const key of [
    "NOTIFICATION_EMAIL_PROVIDER",
    "NOTIFICATION_PUSH_PROVIDER",
    "NOTIFICATION_WHATSAPP_PROVIDER",
  ] as const) {
    const env: Record<string, string | undefined> = { ...productionEnv };
    delete env[key];
    await expect(
      loadWorkerConfig({ env, database: {} as never }),
    ).rejects.toThrow(key);
  }
  await expect(
    loadWorkerConfig({
      env: { ...productionEnv, NOTIFICATION_EMAIL_PROVIDER: "brevo" },
      database: {} as never,
    }),
  ).rejects.toThrow("BREVO_API_KEY");
  // A trusted config module must also bring notification handlers.
  await expect(
    loadWorkerConfig({
      env: { WORKER_CONFIG_MODULE: "/trusted/config.mjs" },
      database: {} as never,
      load: async () =>
        createProductionWorkerConfig(
          { deliverEvent: async () => {}, requestMissing: async () => {} },
          notifications,
        ),
    }),
  ).resolves.toBeTruthy();
  await expect(
    loadWorkerConfig({
      env: { WORKER_CONFIG_MODULE: "/trusted/config.mjs" },
      database: {} as never,
      load: async () => ({
        resolveContext: async () => ({}),
        authorize: async () => true,
        authorizeEvent: async () => true,
        deliverEvent: async () => {},
        requestMissing: async () => {},
      }),
    }),
  ).rejects.toThrow("notification handlers");
});
