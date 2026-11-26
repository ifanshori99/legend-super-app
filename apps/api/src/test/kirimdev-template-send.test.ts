// legend-wasr7.14: outbound WhatsApp TEMPLATE send via Kirimdev (fake fetch, no
// token) and the worker env switch NOTIFICATION_WHATSAPP_PROVIDER=kirimdev.
// Without credentials everything stays off (fail closed).
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  KirimdevSendError,
  createKirimdevMessagingProvider,
} from "../services/messaging-kirimdev";
import {
  createWorkerNotificationHandlers,
  parseNotificationProviderEnv,
} from "../worker/notification-adapters";

const API_KEY = "kdv_live_abcDEF123_-abcDEF123_-xy";
const TENANT_ID = cafeLegendFixtures.tenant.id;
const OUTLET = cafeLegendFixtures.outlets[0]!.id;
const ctx = establishScopedTenantContext(
  establishTenantContext({
    tenantId: TENANT_ID,
    brandId: null,
    source: "job",
  }),
  { kind: "tenant" },
);
const request = (o: Record<string, unknown> = {}) => ({
  tenantId: TENANT_ID,
  outletId: OUTLET,
  reference: "notif-1",
  recipient: "628123456789",
  templateName: "order_ready",
  variables: { "2": "INV-1", "1": "Budi" },
  ...o,
});
const ok = () =>
  new Response(
    JSON.stringify({
      data: { id: "msg_1", status: "queued" },
      request_id: "r",
    }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
const build = (fetchMock: typeof fetch, sender: string | null = "pn_1") =>
  createKirimdevMessagingProvider({
    apiKey: API_KEY,
    fetch: fetchMock,
    resolveSender: async () => sender,
    webhookSecrets: [],
    sleep: async () => undefined,
  });

describe("legend-wasr7.14 kirimdev template send", () => {
  it("posts a Meta-style template with ordered positional parameters", async () => {
    const f = vi.fn(async () => ok());
    const provider = build(f as unknown as typeof fetch);
    const result = await provider.sendTemplate(ctx, request());
    expect(result).toEqual({ reference: "notif-1", accepted: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.kirimdev.com/v1/pn_1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers["Idempotency-Key"]).toBe(
      createHash("sha256")
        .update(`template:${TENANT_ID}:${OUTLET}:notif-1`)
        .digest("hex"),
    );
    expect(JSON.parse(String(init.body))).toEqual({
      messaging_product: "whatsapp",
      to: "+628123456789",
      type: "template",
      template: {
        name: "order_ready",
        language: "id",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Budi" },
              { type: "text", text: "INV-1" },
            ],
          },
        ],
      },
    });
  });

  it("cleans parameters Kirimdev would reject (newline, tab, blank)", async () => {
    const f = vi.fn(async () => ok());
    await build(f as unknown as typeof fetch).sendTemplate(
      ctx,
      request({ variables: { "1": "a\nb\t c      d", "2": "   " } }),
    );
    const body = JSON.parse(
      String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body.template.components[0].parameters).toEqual([
      { type: "text", text: "a b c d" },
      { type: "text", text: "-" },
    ]);
  });

  it("refuses a bad template name and a missing sender without any HTTP call", async () => {
    const f = vi.fn(async () => ok());
    await expect(
      build(f as unknown as typeof fetch).sendTemplate(
        ctx,
        request({ templateName: "Order-Ready" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_template", retryable: false });
    await expect(
      build(f as unknown as typeof fetch, null).sendTemplate(ctx, request()),
    ).rejects.toMatchObject({ code: "no_sender" });
    expect(f).not.toHaveBeenCalled();
  });

  it("retries 503 with the same key and does not retry a 132001 template error", async () => {
    const err = (status: number, code: string) =>
      new Response(JSON.stringify({ error: { code, request_id: "r" } }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const f1 = vi
      .fn()
      .mockResolvedValueOnce(err(503, "unavailable"))
      .mockResolvedValueOnce(ok());
    await build(f1 as unknown as typeof fetch).sendTemplate(ctx, request());
    const keys = f1.mock.calls.map(
      (c) => (c[1].headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(keys[0]).toBe(keys[1]);
    const f2 = vi.fn(async () => err(400, "template_not_found"));
    await expect(
      build(f2 as unknown as typeof fetch).sendTemplate(ctx, request()),
    ).rejects.toBeInstanceOf(KirimdevSendError);
    expect(f2).toHaveBeenCalledTimes(1);
  });

  it("rejects another tenant's scope", async () => {
    const f = vi.fn(async () => ok());
    await expect(
      build(f as unknown as typeof fetch).sendTemplate(
        ctx,
        request({ tenantId: "99999999-9999-4999-8999-999999999999" }),
      ),
    ).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("legend-wasr7.14 worker env: NOTIFICATION_WHATSAPP_PROVIDER", () => {
  const base = {
    NOTIFICATION_EMAIL_PROVIDER: "disabled",
    NOTIFICATION_PUSH_PROVIDER: "disabled",
  };
  it("kirimdev without KIRIM_API_KEY fails at startup naming the key, not a value", () => {
    expect(() =>
      parseNotificationProviderEnv({
        ...base,
        NOTIFICATION_WHATSAPP_PROVIDER: "kirimdev",
      }),
    ).toThrow(/KIRIM_API_KEY is required/);
    expect(() =>
      parseNotificationProviderEnv({
        ...base,
        NOTIFICATION_WHATSAPP_PROVIDER: "kirimdev",
        KIRIM_API_KEY: "kdv_live_secret-but-short",
      }),
    ).toThrow(/KIRIM_API_KEY is not a valid/);
  });
  it("kirimdev with a valid key enables the whatsapp hook; disabled leaves it off", () => {
    const on = createWorkerNotificationHandlers({} as never, {
      ...base,
      NOTIFICATION_WHATSAPP_PROVIDER: "kirimdev",
      KIRIM_API_KEY: API_KEY,
    });
    expect(typeof on.notificationDelivery.whatsapp?.send).toBe("function");
    const off = createWorkerNotificationHandlers({} as never, {
      ...base,
      NOTIFICATION_WHATSAPP_PROVIDER: "disabled",
    });
    expect(off.notificationDelivery.whatsapp).toBeUndefined();
  });
});
