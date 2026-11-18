// EDC-02/03/05 building blocks: registry + ECR simulator behavior (pure).
import { describe, expect, it } from "vitest";
import { EcrTransportError, EdcError } from "@starter/shared/edc";
import type { EcrSaleRequest, EcrTerminal } from "@starter/shared/edc";
import type { Idr } from "@starter/shared/core";
import {
  EdcProviderRegistry,
  createDefaultEdcRegistry,
} from "../edge/edc/registry.ts";
import { EcrSimulator } from "../edge/edc/simulator.ts";

const terminal: EcrTerminal = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  outletId: "00000000-0000-4000-8000-000000000002",
  id: "00000000-0000-4000-8000-000000000003",
  bank: "bca",
  terminalId: "TID001",
  merchantId: "MID001",
  connection: "lan",
  ipAddress: "192.168.1.20",
};

function saleRequest(
  trace: string,
  options: {
    amountIdr?: number;
    method?: "card" | "qris";
    signal?: AbortSignal;
  } = {},
): EcrSaleRequest {
  return {
    terminal,
    trace,
    amountIdr: (options.amountIdr ?? 50_000) as Idr,
    method: options.method ?? "card",
    reference: "BILL-1",
    signal: options.signal ?? new AbortController().signal,
  };
}

const traceRequest = (trace: string) => ({
  terminal,
  trace,
  signal: new AbortController().signal,
});

describe("EdcProviderRegistry", () => {
  it("EDC-05 resolves a registered bank and lists banks", () => {
    const registry = new EdcProviderRegistry();
    const bca = new EcrSimulator("bca");
    registry.register(bca);
    expect(registry.get("bca")).toBe(bca);
    expect(registry.banks()).toEqual(["bca"]);
  });

  it("EDC-05 refuses a duplicate bank", () => {
    const registry = new EdcProviderRegistry();
    registry.register(new EcrSimulator("bca"));
    expect(() => registry.register(new EcrSimulator("bca"))).toThrow();
  });

  it("EDC-05 unknown or unregistered bank throws EDC_PROVIDER_UNKNOWN", () => {
    const registry = new EdcProviderRegistry();
    registry.register(new EcrSimulator("bca"));
    for (const bank of ["bni", "nope", "__proto__", "constructor", ""]) {
      try {
        registry.get(bank);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(EdcError);
        expect((error as EdcError).reason).toBe("EDC_PROVIDER_UNKNOWN");
      }
    }
  });

  it("EDC-05 default registry has simulators for 4 banks only when enabled", () => {
    expect(
      createDefaultEdcRegistry({ simulator: true }).banks().sort(),
    ).toEqual(["bca", "bjb", "bni", "mandiri"]);
    expect(createDefaultEdcRegistry({ simulator: false }).banks()).toEqual([]);
  });
});

describe("EcrSimulator", () => {
  it("EDC-02 approves by default with card details", async () => {
    const sim = new EcrSimulator("bca");
    const result = await sim.sale(saleRequest("T1"));
    expect(result).toMatchObject({
      outcome: "approved",
      cardType: "VISA",
      maskedPan: "411111******1111",
      responseCode: "00",
      amountIdr: 50_000,
    });
    expect(result.approvalCode).toBeTruthy();
    expect(result.rrn).toBeTruthy();
    expect(sim.chargedCount(terminal.id)).toBe(1);
  });

  it("EDC-02 qris approval has no PAN", async () => {
    const sim = new EcrSimulator("bca");
    const result = await sim.sale(saleRequest("T1", { method: "qris" }));
    expect(result).toMatchObject({
      outcome: "approved",
      cardType: "QRIS",
      maskedPan: null,
    });
  });

  it("EDC-02 decline is declined with code 51 and charges nothing", async () => {
    const sim = new EcrSimulator("bca").next(terminal.id, "decline");
    const result = await sim.sale(saleRequest("T1"));
    expect(result).toMatchObject({ outcome: "declined", responseCode: "51" });
    expect(sim.chargedCount(terminal.id)).toBe(0);
  });

  it("EDC-03 timeout_after_charge throws but inquiry says approved", async () => {
    const sim = new EcrSimulator("bca").next(
      terminal.id,
      "timeout_after_charge",
    );
    await expect(sim.sale(saleRequest("T1"))).rejects.toMatchObject({
      name: "EcrTransportError",
      kind: "timeout",
    });
    expect(sim.chargedCount(terminal.id)).toBe(1);
    const inquiry = await sim.inquiry(traceRequest("T1"));
    expect(inquiry).toMatchObject({ outcome: "approved", amountIdr: 50_000 });
  });

  it("EDC-03 timeout_before_charge throws and inquiry says not_found", async () => {
    const sim = new EcrSimulator("bca").next(
      terminal.id,
      "timeout_before_charge",
    );
    await expect(sim.sale(saleRequest("T1"))).rejects.toBeInstanceOf(
      EcrTransportError,
    );
    expect(sim.chargedCount(terminal.id)).toBe(0);
    expect((await sim.inquiry(traceRequest("T1"))).outcome).toBe("not_found");
  });

  it("an inquiry not_found echoes the asked trace", async () => {
    const sim = new EcrSimulator("bca");
    expect(await sim.inquiry(traceRequest("T9"))).toMatchObject({
      outcome: "not_found",
      trace: "T9",
    });
  });

  it("EDC-03 disconnect throws disconnected, inquiry approved", async () => {
    const sim = new EcrSimulator("bca").next(terminal.id, "disconnect");
    await expect(sim.sale(saleRequest("T1"))).rejects.toMatchObject({
      kind: "disconnected",
    });
    expect((await sim.inquiry(traceRequest("T1"))).outcome).toBe("approved");
  });

  it("EDC-03 inquiry_timeout fails only the next inquiry", async () => {
    const sim = new EcrSimulator("bca")
      .next(terminal.id, "timeout_after_charge")
      .next(terminal.id, "inquiry_timeout");
    await expect(sim.sale(saleRequest("T1"))).rejects.toBeInstanceOf(
      EcrTransportError,
    );
    await expect(sim.inquiry(traceRequest("T1"))).rejects.toMatchObject({
      kind: "timeout",
    });
    expect((await sim.inquiry(traceRequest("T1"))).outcome).toBe("approved");
  });

  it("EDC-01 amount_mismatch approves a different amount", async () => {
    const sim = new EcrSimulator("bca").next(terminal.id, "amount_mismatch");
    const result = await sim.sale(saleRequest("T1", { amountIdr: 50_000 }));
    expect(result.amountIdr).toBe(50_001);
  });

  it("hold: cancel resolves the held sale as cancelled", async () => {
    const sim = new EcrSimulator("bca").next(terminal.id, "hold");
    const sale = sim.sale(saleRequest("T1"));
    expect((await sim.inquiry(traceRequest("T1"))).outcome).toBe("in_progress");
    expect((await sim.cancel(traceRequest("T1"))).outcome).toBe("cancelled");
    expect((await sale).outcome).toBe("cancelled");
    expect(sim.chargedCount(terminal.id)).toBe(0);
    expect((await sim.inquiry(traceRequest("T1"))).outcome).toBe("cancelled");
  });

  it("hold: complete approve/decline resolves the held sale", async () => {
    const sim = new EcrSimulator("bca")
      .next(terminal.id, "hold")
      .next(terminal.id, "hold");
    const first = sim.sale(saleRequest("T1"));
    const second = sim.sale(saleRequest("T2"));
    sim.complete(terminal.id, "T1", "approve");
    sim.complete(terminal.id, "T2", "decline");
    expect((await first).outcome).toBe("approved");
    expect((await second).outcome).toBe("declined");
    expect(sim.chargedCount(terminal.id)).toBe(1);
    expect(() => sim.complete(terminal.id, "T1", "approve")).toThrow();
  });

  it("hold: abort throws timeout and leaves the sale in progress", async () => {
    const sim = new EcrSimulator("bca").next(terminal.id, "hold");
    const sale = sim.sale(
      saleRequest("T1", { signal: AbortSignal.timeout(20) }),
    );
    await expect(sale).rejects.toMatchObject({ kind: "timeout" });
    expect((await sim.inquiry(traceRequest("T1"))).outcome).toBe("in_progress");
    sim.complete(terminal.id, "T1", "approve");
    expect((await sim.inquiry(traceRequest("T1"))).outcome).toBe("approved");
  });

  it("cancel of a final sale returns that outcome, not cancelled", async () => {
    const sim = new EcrSimulator("bca");
    await sim.sale(saleRequest("T1"));
    expect((await sim.cancel(traceRequest("T1"))).outcome).toBe("approved");
  });

  it("cancel of an unknown trace throws a protocol error", async () => {
    const sim = new EcrSimulator("bca");
    await expect(sim.cancel(traceRequest("NOPE"))).rejects.toMatchObject({
      kind: "protocol",
    });
  });

  it("EDC-02 results echo trace and carry invoiceNo and batchNo", async () => {
    const sim = new EcrSimulator("bca");
    const first = await sim.sale(saleRequest("T1"));
    const second = await sim.sale(saleRequest("T2"));
    expect(first).toMatchObject({
      trace: "T1",
      invoiceNo: "000001",
      batchNo: "000001",
    });
    expect(second).toMatchObject({ trace: "T2", invoiceNo: "000002" });
    const other = await sim.sale({
      ...saleRequest("T3"),
      terminal: { ...terminal, id: "00000000-0000-4000-8000-000000000009" },
    });
    expect(other.invoiceNo).toBe("000001");
    expect((await sim.inquiry(traceRequest("T1"))).trace).toBe("T1");
  });

  it("exposes default capabilities and accepts overrides", () => {
    expect(new EcrSimulator("bca").capabilities).toEqual({
      inquiry: "by_trace",
      cancelInProgress: true,
    });
    const capabilities = { inquiry: "none", cancelInProgress: false } as const;
    expect(new EcrSimulator("bca", { capabilities }).capabilities).toEqual(
      capabilities,
    );
  });

  it("EDC-03 last_only inquiry answers only for the last trace", async () => {
    const sim = new EcrSimulator("bca", {
      capabilities: { inquiry: "last_only", cancelInProgress: true },
    });
    await sim.sale(saleRequest("T1"));
    await sim.sale(saleRequest("T2"));
    expect((await sim.inquiry(traceRequest("T2"))).outcome).toBe("approved");
    expect((await sim.inquiry(traceRequest("T1"))).outcome).toBe("not_found");
  });

  it("EDC-01 no_amount approves without an amount", async () => {
    const sim = new EcrSimulator("bca").next(terminal.id, "no_amount");
    const result = await sim.sale(saleRequest("T1"));
    expect(result).toMatchObject({ outcome: "approved", amountIdr: null });
    expect(sim.chargedCount(terminal.id)).toBe(1);
  });

  it("EDC-01 wrong_trace approves but echoes another trace", async () => {
    const sim = new EcrSimulator("bca").next(terminal.id, "wrong_trace");
    const result = await sim.sale(saleRequest("T1"));
    expect(result).toMatchObject({ outcome: "approved", trace: "WRONG1" });
    // The terminal did record it under the real trace.
    expect((await sim.inquiry(traceRequest("T1"))).trace).toBe("WRONG1");
  });

  it("pan_in_message masks the card number in the message", async () => {
    const sim = new EcrSimulator("bca").next(terminal.id, "pan_in_message");
    const result = await sim.sale(saleRequest("T1"));
    expect(result.outcome).toBe("approved");
    expect(result.message).toBeTruthy();
    expect(result.message).not.toMatch(/\d(?:[\s/_-]*\d){11,}/);
  });

  it("ignore_abort ignores the signal and records the charge late", async () => {
    const sim = new EcrSimulator("bca", { ignoreAbortDelayMs: 40 }).next(
      terminal.id,
      "ignore_abort",
    );
    const sale = sim.sale(
      saleRequest("T1", { signal: AbortSignal.timeout(5) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(sim.chargedCount(terminal.id)).toBe(0);
    expect((await sim.inquiry(traceRequest("T1"))).outcome).toBe("in_progress");
    expect((await sale).outcome).toBe("approved");
    expect(sim.chargedCount(terminal.id)).toBe(1);
    expect((await sim.inquiry(traceRequest("T1"))).outcome).toBe("approved");
  });

  it("ignore_abort defaults to a 200ms delay", () => {
    expect(new EcrSimulator("bca").ignoreAbortDelayMs).toBe(200);
  });

  it("cancel of a held sale throws protocol when cancelInProgress is false", async () => {
    const sim = new EcrSimulator("bca", {
      capabilities: { inquiry: "by_trace", cancelInProgress: false },
    }).next(terminal.id, "hold");
    const sale = sim.sale(saleRequest("T1"));
    await expect(sim.cancel(traceRequest("T1"))).rejects.toMatchObject({
      name: "EcrTransportError",
      kind: "protocol",
    });
    expect((await sim.inquiry(traceRequest("T1"))).outcome).toBe("in_progress");
    sim.complete(terminal.id, "T1", "approve");
    expect((await sale).outcome).toBe("approved");
  });

  it("counts calls per terminal and in total", async () => {
    const sim = new EcrSimulator("bca");
    await sim.sale(saleRequest("T1"));
    await sim.inquiry(traceRequest("T1"));
    await sim.cancel(traceRequest("T1"));
    expect(sim.callsFor(terminal.id)).toEqual({
      sale: 1,
      cancel: 1,
      inquiry: 1,
      void: 0,
    });
    expect(sim.callsFor("other")).toEqual({
      sale: 0,
      cancel: 0,
      inquiry: 0,
      void: 0,
    });
    expect(sim.calls).toEqual({
      sale: 1,
      cancel: 1,
      inquiry: 1,
      void: 0,
    });
  });
});
