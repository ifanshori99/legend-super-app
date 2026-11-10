// WhatsApp adapter for the payslip PIN reset code (bead legend-qih2m).
// Unit tests, no database: the adapter turns a port message into one
// MessagingProvider.send call and must never log, or leak the code or phone
// in anything it throws. Uses FakeMessagingProvider only; nothing is sent.
// Assumptions (spec silent on exact copy): the text is Indonesian, contains
// the 6-digit code, "5 menit", and a "jangan bagikan" warning.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeMessagingProvider,
  type MessageRequest,
  type MessagingProvider,
} from "@starter/shared/adapters";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createPayslipPinWhatsappSender } from "../services/payslip-pin-whatsapp-sender.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);

const CODE = "483926";
const PHONE_E164 = "+6281234567890";
const PHONE_DIGITS = "6281234567890";

const tenantContext = () =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
const outletAContext = () =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletA] },
  );

const message = (over: Partial<Record<string, string>> = {}) => ({
  employeeId: randomUUID(),
  outletId: outletA as string,
  challengeId: randomUUID(),
  phoneE164: PHONE_E164,
  code: CODE,
  ...over,
});

describe("payslip PIN WhatsApp sender", () => {
  const captured: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];

  beforeEach(() => {
    captured.length = 0;
    const grab = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
    };
    for (const method of [
      "log",
      "info",
      "warn",
      "error",
      "debug",
      "trace",
    ] as const)
      spies.push(vi.spyOn(console, method).mockImplementation(grab));
    spies.push(
      vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
        captured.push(String(c));
        return true;
      }) as never),
      vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
        captured.push(String(c));
        return true;
      }) as never),
    );
  });
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it("sends one Indonesian message with the code, validity and a do-not-share warning", async () => {
    const provider = new FakeMessagingProvider();
    const sender = createPayslipPinWhatsappSender(provider);
    const m = message();

    await sender.send(tenantContext(), m);

    expect(provider.sent).toHaveLength(1);
    const sent = provider.sent[0] as MessageRequest;
    expect(sent.tenantId).toBe(tenantId);
    expect(sent.outletId).toBe(outletA);
    expect(sent.reference).toBe(`payslip-pin-otp:${m.challengeId}`);
    // Digits only: no "+", no spaces.
    expect(sent.recipient).toBe(PHONE_DIGITS);
    expect(sent.text).toContain(CODE);
    expect(sent.text).toContain("5 menit");
    expect(sent.text.toLowerCase()).toMatch(/jangan (bagikan|beritahukan)/);
  });

  it("a replay of the same challenge sends nothing more", async () => {
    const provider = new FakeMessagingProvider();
    const sender = createPayslipPinWhatsappSender(provider);
    const m = message();

    await sender.send(tenantContext(), m);
    await sender.send(tenantContext(), m);

    expect(provider.sent).toHaveLength(1);
  });

  it("a different challenge is a separate message", async () => {
    const provider = new FakeMessagingProvider();
    const sender = createPayslipPinWhatsappSender(provider);

    await sender.send(tenantContext(), message());
    await sender.send(tenantContext(), message());

    expect(provider.sent).toHaveLength(2);
    expect(new Set(provider.sent.map((s) => s.reference)).size).toBe(2);
  });

  it("sends under the tenant of the context", async () => {
    const provider = new FakeMessagingProvider();
    const sender = createPayslipPinWhatsappSender(provider);
    const ctx = tenantContext();

    await sender.send(ctx, message());

    expect(provider.sent[0]?.tenantId).toBe(ctx.tenant.tenantId);
  });

  it("throws and sends nothing when the outlet is outside the context's scope", async () => {
    const provider = new FakeMessagingProvider();
    const sender = createPayslipPinWhatsappSender(provider);

    await expect(
      sender.send(outletAContext(), message({ outletId: outletB })),
    ).rejects.toThrow();
    expect(provider.sent).toHaveLength(0);
  });

  it("sends when the outlet is inside an outlet-scoped context", async () => {
    const provider = new FakeMessagingProvider();
    const sender = createPayslipPinWhatsappSender(provider);

    await sender.send(outletAContext(), message());

    expect(provider.sent).toHaveLength(1);
  });

  it("throws when the provider throws, without leaking the code or phone", async () => {
    let calls = 0;
    const failing: MessagingProvider = Object.assign(
      new FakeMessagingProvider(),
      {
        send: async () => {
          calls += 1;
          throw new Error("gateway timeout");
        },
      },
    );
    const sender = createPayslipPinWhatsappSender(failing);

    const error = await sender
      .send(tenantContext(), message())
      .then(() => null)
      .catch((e: unknown) => e);

    // The failure must come from the provider call, not from elsewhere.
    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(Error);
    const text = `${(error as Error).message} ${(error as Error).stack ?? ""}`;
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(PHONE_DIGITS);
    expect(text).not.toContain(PHONE_E164);
  });

  it("throws when the provider does not accept the message, without leaking the code or phone", async () => {
    let calls = 0;
    const rejecting: MessagingProvider = Object.assign(
      new FakeMessagingProvider(),
      {
        send: async (_c: unknown, input: MessageRequest) => {
          calls += 1;
          return { reference: input.reference, accepted: false };
        },
      },
    );
    const sender = createPayslipPinWhatsappSender(rejecting);

    const error = await sender
      .send(tenantContext(), message())
      .then(() => null)
      .catch((e: unknown) => e);

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(Error);
    const text = `${(error as Error).message} ${(error as Error).stack ?? ""}`;
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(PHONE_DIGITS);
    expect(text).not.toContain(PHONE_E164);
  });

  it("logs nothing while sending, on success or failure", async () => {
    const provider = new FakeMessagingProvider();
    await createPayslipPinWhatsappSender(provider).send(
      tenantContext(),
      message(),
    );

    const failing: MessagingProvider = Object.assign(
      new FakeMessagingProvider(),
      {
        send: async () => {
          throw new Error("gateway timeout");
        },
      },
    );
    await createPayslipPinWhatsappSender(failing)
      .send(tenantContext(), message())
      .catch(() => undefined);

    const output = captured.join("\n");
    expect(output).not.toContain(CODE);
    expect(output).not.toContain(PHONE_DIGITS);
    expect(captured).toEqual([]);
  });
});
