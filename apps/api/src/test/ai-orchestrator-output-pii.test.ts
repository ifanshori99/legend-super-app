// Kartu C item 4 (bead legend-39d.4): the PII scanner also runs on what the
// MODEL answers (AIG-02), not only on the question. A model answer carrying
// NIK, NPWP, bank account, email, phone or a salary amount is masked or
// blocked before it is returned, stored or cached, and the event is audited.
//
// Written from the brief and the PRD (R17, AIG-02), not from the
// implementation. Same harness as ai-orchestrator.test.ts: no database, the
// provider is the scripted fake and the gateway, tool layer and persistence
// are injected.
//
// DECIDED BEHAVIOR (from the engineer): a model answer with PII is MASKED (not
// blocked), never cached, and audited through the optional dependency
// `OrchestratorDeps.auditOutputPii(access, { feature, kinds })`, which writes the
// audit action `ai_output.pii_redacted` (kinds only, never the matched text).
//
// ASSUMPTIONS (listed in the report):
//  - Scanner kinds expected in the audit: nik, npwp, bank_account, email,
//    phone, salary (salary amounts included: restrictive choice).
//  - The audit action row itself (`ai_output.pii_redacted`) is written by
//    recordAiOutputPiiRedacted and not covered here (needs an HTTP chat run).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AiToolCode } from "@starter/shared/ai";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createFakeProvider } from "../lib/ai/fake.ts";
import { scanPii } from "../lib/ai/pii.ts";
import type { AccessSnapshot } from "../services/permission-resolver.ts";
import {
  askAi,
  type OrchestratorDeps,
} from "../services/ai-orchestrator.service.ts";

const tenantId = randomUUID();
const userId = randomUUID();
const access = {
  tenant: { tenantId },
  userId,
  permissions: ["ai.ask"],
  allows: () => true,
} as unknown as AccessSnapshot;
const context = {} as ScopedTenantContext;

type Sample = { kind: string; text: string; raw: string[] };
const SAMPLES: Sample[] = [
  {
    kind: "nik",
    text: "NIK Budi adalah 3174011501900001.",
    raw: ["3174011501900001"],
  },
  {
    kind: "npwp",
    text: "NPWP-nya 09.254.294.3-407.000.",
    raw: ["09.254.294.3-407.000"],
  },
  {
    kind: "bank_account",
    text: "Transfer ke no rek: 1234567890 atas nama Budi.",
    raw: ["1234567890"],
  },
  {
    kind: "email",
    text: "Hubungi budi.santoso@example.com untuk detail.",
    raw: ["budi.santoso@example.com"],
  },
  {
    kind: "phone",
    text: "Telepon Budi 0812-3456-7890.",
    raw: ["0812-3456-7890"],
  },
  {
    kind: "salary",
    text: "Gaji Budi Rp 8.500.000 per bulan.",
    raw: ["8.500.000"],
  },
];

const salesSource = {
  label: "Penjualan",
  period: { from: "2026-11-01", to: "2026-11-07" },
  finality: "final",
  link: "/reports/sales",
};

function harness(answer: string, overrides: Record<string, unknown> = {}) {
  const provider = createFakeProvider((request) =>
    request.messages.length === 1
      ? {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "get_sales_summary",
              input: { from: "2026-11-01", to: "2026-11-07" },
            },
          ],
          stopReason: "tool_use",
        }
      : {
          content: [{ type: "text", text: answer }],
          stopReason: "end_turn",
        },
  );
  const persisted: Parameters<OrchestratorDeps["persist"]>[2][] = [];
  const cachePut = vi.fn<OrchestratorDeps["cachePut"]>(async () => undefined);
  const auditOutputPii = vi.fn<(...args: unknown[]) => Promise<void>>(
    async () => undefined,
  );
  const deps = {
    preflight: vi.fn(async () => ({ settings: {} as never })),
    complete: (_access: unknown, request: never) => provider.complete(request),
    listTools: vi.fn(async () => []),
    toSpecs: vi.fn(() => [
      { name: "get_sales_summary", description: "d", inputSchema: {} },
    ]),
    invoke: vi.fn(async () => ({
      ok: true as const,
      toolCode: "TL-01" as AiToolCode,
      output: { totalIdr: 1_250_000, sources: [salesSource] },
      rowCount: 1,
      toolCallId: "01TOOLCALL",
    })),
    cacheGet: vi.fn(async () => null),
    cachePut,
    loadHistory: vi.fn(async () => []),
    persist: vi.fn(async (_a: unknown, _c: unknown, turn: never) => {
      persisted.push(turn);
      const conversationId = randomUUID();
      const stamp = "2026-11-09T01:00:00.000Z";
      const t = turn as {
        feature: string;
        title: string;
        question: string;
        answer: string;
        answerSources: unknown[];
      };
      return {
        conversation: {
          id: conversationId,
          tenantId,
          userId,
          feature: t.feature,
          title: t.title,
          createdAt: stamp,
          updatedAt: stamp,
          deletedAt: null,
        },
        userMessage: {
          id: randomUUID(),
          conversationId,
          role: "user",
          content: t.question,
          toolCode: null,
          sources: [],
          aiAssisted: false,
          createdAt: stamp,
        },
        assistantMessage: {
          id: randomUUID(),
          conversationId,
          role: "assistant",
          content: t.answer,
          toolCode: null,
          sources: [...t.answerSources],
          aiAssisted: true,
          createdAt: stamp,
        },
      } as never;
    }),
    now: () => new Date(),
    auditOutputPii,
    ...overrides,
  } as unknown as OrchestratorDeps;
  return { deps, persisted, cachePut, auditOutputPii };
}

const ask = (h: ReturnType<typeof harness>) =>
  askAi(
    access,
    context,
    { feature: "AI-01", question: "Berapa penjualan minggu ini?" } as never,
    h.deps,
  );

describe("scanner sanity: the samples are PII the existing scanner knows", () => {
  it.each(SAMPLES)("$kind sample is found by scanPii", ({ kind, text }) => {
    expect(scanPii(text).found).toContain(kind);
  });
});

describe("AIG-02 PII in model output (legend-39d.4)", () => {
  it.each(SAMPLES)(
    "legend-39d.4 $kind in the model answer is masked before it reaches the caller, the stored answer or the cache",
    async ({ text, raw }) => {
      const h = harness(`Penjualan Rp1.250.000. ${text}`);
      const result = await ask(h);
      const returned = result.assistantMessage.content;
      // Masked, not blocked: the business part of the answer survives.
      expect(returned).toContain("Penjualan Rp1.250.000.");
      for (const value of raw) {
        expect(returned).not.toContain(value);
        for (const turn of h.persisted)
          expect(JSON.stringify(turn)).not.toContain(value);
        for (const call of h.cachePut.mock.calls)
          expect(JSON.stringify(call)).not.toContain(value);
      }
    },
  );

  it.each(SAMPLES)(
    "legend-39d.4 an answer with $kind is never cached",
    async ({ text }) => {
      const h = harness(`Penjualan Rp1.250.000. ${text}`);
      await ask(h);
      expect(h.cachePut).not.toHaveBeenCalled();
    },
  );

  it("legend-39d.4 several kinds in one answer are all removed", async () => {
    const h = harness(SAMPLES.map((sample) => sample.text).join(" "));
    const result = await ask(h);
    for (const sample of SAMPLES)
      for (const value of sample.raw)
        expect(result.assistantMessage.content).not.toContain(value);
  });

  it("legend-39d.4 audits the event with the feature and kinds, never the raw value", async () => {
    const h = harness(
      `${SAMPLES[0]!.text} ${SAMPLES[2]!.text}`, // nik + bank account
    );
    await ask(h);
    expect(h.auditOutputPii).toHaveBeenCalledTimes(1);
    const [, meta] = h.auditOutputPii.mock.calls[0]! as [
      unknown,
      { feature: string; kinds: string[] },
    ];
    expect(meta.feature).toBe("AI-01");
    expect(meta.kinds).toEqual(expect.arrayContaining(["nik", "bank_account"]));
    const wire = JSON.stringify(h.auditOutputPii.mock.calls);
    expect(wire).not.toContain("3174011501900001");
    expect(wire).not.toContain("1234567890");
  });

  it("legend-39d.4 a failing audit never fails or unmasks the answer", async () => {
    const h = harness(SAMPLES[0]!.text, {
      auditOutputPii: vi.fn(async () => {
        throw new Error("audit down");
      }),
    });
    const result = await ask(h);
    expect(result.assistantMessage.content).not.toContain("3174011501900001");
  });

  it("legend-39d.4 a clean answer passes unchanged, is cached as before and writes no audit", async () => {
    const clean = "Penjualan minggu ini Rp1.250.000 di outlet Senayan.";
    const h = harness(clean);
    const result = await ask(h);
    expect(result.assistantMessage.content).toBe(clean);
    expect(h.cachePut).toHaveBeenCalledTimes(1);
    expect(h.auditOutputPii).not.toHaveBeenCalled();
  });
});

// ASSUMPTIONS (listed in the report): a payslip / profit-share answer must show
// the caller's OWN salary amount, so when the turn invoked TL-09 or TL-12 the
// `salary` kind is NOT masked. Only the salary kind is exempt: NIK, NPWP, bank
// account, email and phone stay masked in the same answer. Any other tool (or
// no tool) keeps the salary mask. The exempt `salary` kind is not audited as
// redacted since nothing was masked for it.
describe("AIG-02 salary amount in the caller's own payslip turn (legend-39d.4)", () => {
  const salary = SAMPLES.find((sample) => sample.kind === "salary")!;
  const nik = SAMPLES.find((sample) => sample.kind === "nik")!;
  const withTool = (toolCode: AiToolCode, extra: object = {}) => ({
    invoke: vi.fn(async () => ({
      ok: true as const,
      toolCode,
      output: { sources: [salesSource], ...extra },
      rowCount: 1,
      toolCallId: "01TOOLCALL",
    })),
  });

  it.each(["TL-09", "TL-12"] as const)(
    "legend-39d.4 salary amount is NOT masked when the turn used %s",
    async (toolCode) => {
      const h = harness(
        `Slip Anda. ${salary.text}`,
        withTool(toolCode, { netIdr: 8500000 }),
      );
      const result = await ask(h);
      expect(result.assistantMessage.content).toContain("8.500.000");
      const audited = h.auditOutputPii.mock.calls.flatMap(
        (call) => (call[1] as { kinds: string[] }).kinds,
      );
      expect(audited).not.toContain("salary");
    },
  );

  it.each(["TL-09", "TL-12"] as const)(
    "legend-39d.4 other PII is still masked in a %s turn while the salary stays",
    async (toolCode) => {
      const h = harness(
        `${salary.text} ${nik.text}`,
        withTool(toolCode, { netIdr: 8500000 }),
      );
      const result = await ask(h);
      expect(result.assistantMessage.content).toContain("8.500.000");
      expect(result.assistantMessage.content).not.toContain("3174011501900001");
    },
  );

  it.each(["TL-09", "TL-12"] as const)(
    "legend-39d.4 only the own slip amount stays in a %s turn, another amount is masked",
    async (toolCode) => {
      const h = harness(
        "Slip Anda: gaji Rp 8.500.000. Gaji Budi Rp 12.000.000 per bulan.",
        withTool(toolCode, { netIdr: 8500000 }),
      );
      const result = await ask(h);
      expect(result.assistantMessage.content).toContain("8.500.000");
      expect(result.assistantMessage.content).not.toContain("12.000.000");
      expect(result.assistantMessage.content).toContain("[salary amount]");
      const audited = h.auditOutputPii.mock.calls.flatMap(
        (call) => (call[1] as { kinds: string[] }).kinds,
      );
      expect(audited).toContain("salary");
      expect(h.cachePut).not.toHaveBeenCalled();
    },
  );

  it("legend-39d.4 own amount matches across formats (Rp 8500000, 8.500.000,00)", async () => {
    const h = harness(
      "Gaji Rp 8500000 atau gaji 8.500.000,00 sama.",
      withTool("TL-09", { netIdr: "Rp 8.500.000" }),
    );
    const result = await ask(h);
    expect(result.assistantMessage.content).toContain("Rp 8500000");
    expect(result.assistantMessage.content).toContain("8.500.000,00");
    expect(result.assistantMessage.content).not.toContain("[salary amount]");
  });

  it("legend-39d.4 salary amount is masked when the tool result holds a different amount", async () => {
    const h = harness(
      `Slip Anda. ${salary.text}`,
      withTool("TL-09", { netIdr: 7000000 }),
    );
    const result = await ask(h);
    expect(result.assistantMessage.content).not.toContain("8.500.000");
  });

  it.each(["TL-01", "TL-05"] as const)(
    "legend-39d.4 salary amount is still masked when the turn used only %s",
    async (toolCode) => {
      const h = harness(`Penjualan. ${salary.text}`, withTool(toolCode));
      const result = await ask(h);
      expect(result.assistantMessage.content).not.toContain("8.500.000");
      expect(h.auditOutputPii).toHaveBeenCalledTimes(1);
    },
  );

  it("legend-39d.4 salary amount is still masked when the turn used no tool", async () => {
    const provider = createFakeProvider(() => ({
      content: [{ type: "text", text: salary.text }],
      stopReason: "end_turn",
    }));
    const h = harness("unused", {
      complete: (_access: unknown, request: never) =>
        provider.complete(request),
    });
    const result = await ask(h);
    expect(result.assistantMessage.content).not.toContain("8.500.000");
  });
});
