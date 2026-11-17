// Kartu B (bead legend-vl93z): PII scan of (1) answers read back from the AI
// response cache and (2) the output of AI drafts (AI-12 promo copy).
//
// Written from the brief and the PRD (R17, AIG-02), not from the implementation.
// Background: the AIG-02 output scan (legend-39d.4) only runs on fresh model
// answers. An answer cached BEFORE that scan existed is served as is, and the
// text returned by draftPromoCopy is never scanned.
//
// ASSUMPTIONS (listed in the report):
//  - Cache: the orchestrator is exercised with the injected `cacheGet` returning
//    an old entry `{ text, sources, tools }` that carries PII. Either fix (scan
//    on read, or serve nothing and re-ask the model) satisfies the tests: the
//    raw value must not reach the caller or the stored turn. A versioned cache
//    key cannot be seen through the injected `cacheGet`, so only scan-on-read
//    passes here (the brief allows "scan on read").
//  - Masked, not blocked: the clean part of the text survives, and the audit
//    hook `auditOutputPii(access, { feature, kinds })` is used the same way as
//    for a fresh answer (kinds only, never the matched text).
//  - Drafts: PII in a draft is masked in place (same masking as the chat
//    output); the response keeps its shape and the clean drafts are unchanged.
//    A draft has no payslip tool, so a salary amount is always masked there. The
//    own-payslip salary exemption (TL-09/TL-12 turn) stays in the chat path;
//    one control below proves it still works.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AiToolCode } from "@starter/shared/ai";
import type { ScopedTenantContext } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createFakeProvider, type FakeAiResponder } from "../lib/ai/fake.ts";
import { setAiProviderForTests } from "../lib/ai/provider-factory.ts";
import { scanPii } from "../lib/ai/pii.ts";
import { draftPromoCopy } from "../services/ai-drafts.service.ts";
import {
  askAi,
  type OrchestratorDeps,
} from "../services/ai-orchestrator.service.ts";
import type { AccessSnapshot } from "../services/permission-resolver.ts";

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

describe("scanner sanity: the samples are PII the existing scanner knows", () => {
  it.each(SAMPLES)("$kind sample is found by scanPii", ({ kind, text }) => {
    expect(scanPii(text).found).toContain(kind);
  });
});

// ---------------------------------------------------------------------------
// (3) Old cached answer with PII is masked when read.
// ---------------------------------------------------------------------------
const tenantId = randomUUID();
const userId = randomUUID();
const access = {
  tenant: { tenantId },
  userId,
  permissions: ["ai.ask"],
  allows: () => true,
} as unknown as AccessSnapshot;
const context = {} as ScopedTenantContext;

const salesSource = {
  label: "Penjualan",
  period: { from: "2026-11-01", to: "2026-11-07" },
  finality: "final",
  link: "/reports/sales",
};

type CachedEntry = {
  text: string;
  sources: unknown[];
  tools: { toolCode: string; text: string; sources: unknown[] }[];
};

function cacheHarness(
  cached: CachedEntry,
  cleanFallback = "Jawaban baru yang bersih.",
  overrides: Record<string, unknown> = {},
) {
  // Fallback when the implementation chooses to ignore the stale entry and
  // ask the model again: a clean answer, so the test stays about masking.
  const provider = createFakeProvider(() => ({
    content: [{ type: "text", text: cleanFallback }],
    stopReason: "end_turn",
  }));
  const persisted: { answer: string }[] = [];
  const cachePut = vi.fn(async () => undefined);
  const auditOutputPii = vi.fn<(...args: unknown[]) => Promise<void>>(
    async () => undefined,
  );
  const deps = {
    preflight: vi.fn(async () => ({ settings: {} as never })),
    complete: (_access: unknown, request: never) => provider.complete(request),
    listTools: vi.fn(async () => [{ code: "TL-01" }]),
    toSpecs: vi.fn(() => []),
    invoke: vi.fn(),
    cacheGet: vi.fn(async () => ({ ...cached })),
    cachePut,
    loadHistory: vi.fn(async () => []),
    persist: vi.fn(async (_a: unknown, _c: unknown, turn: never) => {
      const t = turn as { feature: string; title: string; question: string };
      const answer = (turn as { answer: string }).answer;
      persisted.push({ answer });
      const conversationId = randomUUID();
      const stamp = "2026-11-09T01:00:00.000Z";
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
          content: answer,
          toolCode: null,
          sources: [],
          aiAssisted: true,
          createdAt: stamp,
        },
      } as never;
    }),
    now: () => new Date(),
    auditOutputPii,
    ...overrides,
  } as unknown as OrchestratorDeps;
  return { deps, persisted, provider, cachePut, auditOutputPii };
}

const askCached = (h: ReturnType<typeof cacheHarness>) =>
  askAi(
    access,
    context,
    { feature: "AI-01", question: "Berapa penjualan minggu ini?" } as never,
    h.deps,
  );

const oldEntry = (text: string): CachedEntry => ({
  text,
  sources: [salesSource],
  tools: [{ toolCode: "TL-01", text: "{}", sources: [salesSource] }],
});

describe("AIG-02 PII in an old cached answer (legend-vl93z)", () => {
  it.each(SAMPLES)(
    "legend-vl93z $kind in a cached answer is masked when it is read",
    async ({ text, raw }) => {
      const h = cacheHarness(oldEntry(`Penjualan Rp1.250.000. ${text}`));
      const result = await askCached(h);
      for (const value of raw) {
        expect(result.assistantMessage.content).not.toContain(value);
        for (const turn of h.persisted)
          expect(JSON.stringify(turn)).not.toContain(value);
      }
      // Masked, not dropped: the business part of the answer survives. When an
      // implementation re-asks the model instead, the clean fallback is shown.
      expect(
        result.assistantMessage.content.includes("Penjualan Rp1.250.000.") ||
          result.assistantMessage.content === "Jawaban baru yang bersih.",
      ).toBe(true);
    },
  );

  it("legend-vl93z several kinds in one cached answer are all removed", async () => {
    const h = cacheHarness(
      oldEntry(SAMPLES.map((sample) => sample.text).join(" ")),
    );
    const result = await askCached(h);
    for (const sample of SAMPLES)
      for (const value of sample.raw)
        expect(result.assistantMessage.content).not.toContain(value);
  });

  it("legend-vl93z a cached answer with PII is never written back to the cache", async () => {
    const h = cacheHarness(oldEntry(`Penjualan. ${SAMPLES[0]!.text}`));
    await askCached(h);
    for (const call of h.cachePut.mock.calls)
      expect(JSON.stringify(call)).not.toContain("3174011501900001");
  });

  it("legend-vl93z audits the masked cache read with kinds only, never the raw value", async () => {
    const h = cacheHarness(
      oldEntry(`Penjualan. ${SAMPLES[0]!.text} ${SAMPLES[3]!.text}`),
    );
    await askCached(h);
    // Only meaningful when the stale entry was served masked (no model call).
    if (h.provider.calls.length === 0) {
      expect(h.auditOutputPii).toHaveBeenCalledTimes(1);
      const [, meta] = h.auditOutputPii.mock.calls[0]! as [
        unknown,
        { feature: string; kinds: string[] },
      ];
      expect(meta.feature).toBe("AI-01");
      expect(meta.kinds).toEqual(expect.arrayContaining(["nik", "email"]));
    }
    const wire = JSON.stringify(h.auditOutputPii.mock.calls);
    expect(wire).not.toContain("3174011501900001");
    expect(wire).not.toContain("budi.santoso@example.com");
  });

  it("legend-vl93z a clean cached answer is served unchanged and writes no audit", async () => {
    const clean = "Penjualan minggu ini Rp1.250.000 di outlet Senayan.";
    const h = cacheHarness(oldEntry(clean));
    const result = await askCached(h);
    expect(result.assistantMessage.content).toBe(clean);
    expect(h.provider.calls).toHaveLength(0);
    expect(h.auditOutputPii).not.toHaveBeenCalled();
    // Adjacent control: the same harness with a NIK in the cached text must
    // not serve it raw (without the read scan a NIK would pass through).
    const dirty = cacheHarness(oldEntry(`${clean} ${SAMPLES[0]!.text}`));
    const masked = await askCached(dirty);
    expect(masked.assistantMessage.content).not.toContain("3174011501900001");
  });

  it("legend-vl93z a cached salary amount is masked (cached answers never hold own-payslip data)", async () => {
    const h = cacheHarness(oldEntry(`Ringkasan. ${SAMPLES[5]!.text}`));
    const result = await askCached(h);
    expect(result.assistantMessage.content).not.toContain("8.500.000");
  });

  it("legend-vl93z control: a fresh own-payslip answer (TL-09) still keeps the caller's own salary amount", async () => {
    // Same harness as the cached case but a cache miss and a TL-09 turn: the
    // exemption for the own slip amount must survive the new read-time scan.
    const provider = createFakeProvider((request) =>
      request.messages.length === 1
        ? {
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "get_my_payslip",
                input: {},
              },
            ],
            stopReason: "tool_use",
          }
        : {
            content: [
              { type: "text", text: "Slip Anda: gaji Rp 8.500.000 bulan ini." },
            ],
            stopReason: "end_turn",
          },
    );
    const h = cacheHarness(oldEntry("unused"), "unused", {
      cacheGet: vi.fn(async () => null),
      complete: (_access: unknown, request: never) =>
        provider.complete(request),
      toSpecs: vi.fn(() => [
        { name: "get_my_payslip", description: "d", inputSchema: {} },
      ]),
      invoke: vi.fn(async () => ({
        ok: true as const,
        toolCode: "TL-09" as AiToolCode,
        output: { netIdr: 8500000, sources: [salesSource] },
        rowCount: 1,
        toolCallId: "01TOOLCALL",
      })),
    });
    const result = await askCached(h);
    expect(result.assistantMessage.content).toContain("8.500.000");
  });
});

// ---------------------------------------------------------------------------
// (4) ai-drafts output is scanned with the same rules.
// ---------------------------------------------------------------------------
const platformTenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const draftTenantId = randomUUID();
const draftUserId = randomUUID();

function draftAccess(): AccessSnapshot {
  const permissions = ["ai.ask", "promo.manage"];
  const tenant = establishTenantContext({
    tenantId: draftTenantId,
    brandId: null,
    source: "session",
  });
  const allows = (code: string) => permissions.includes(code);
  return {
    tenant,
    userId: draftUserId,
    permissions,
    mfaRequired: false,
    mfaVerified: true,
    templateKeys: ["employee"],
    allows,
    permissionsVia: () => permissions,
    allowsVia: (_key: string, code: string) => allows(code),
    contextFor: () => null,
    stationsFor: () => [],
  } as unknown as AccessSnapshot;
}

function scriptDrafts(drafts: string[]) {
  const responder: FakeAiResponder = () => ({
    content: [{ type: "text", text: JSON.stringify({ drafts }) }],
    stopReason: "end_turn",
  });
  const provider = createFakeProvider(responder);
  setAiProviderForTests(provider);
  return provider;
}

const promoInput = {
  kind: "menu_description" as const,
  menuItemIds: [] as string[],
  brief: "Buat deskripsi singkat yang menggoda",
};

describe("AIG-02 PII in AI drafts output (legend-vl93z)", () => {
  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, $4, plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [
        draftTenantId,
        `ai-pii-drafts-${draftTenantId.slice(0, 8)}`,
        platformTenantId,
        "AI drafts PII",
      ],
    );
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'AI drafts PII', $2)`,
      [draftUserId, `${draftUserId}@example.test`],
    );
    await owner.query(
      `INSERT INTO ai_settings (tenant_id, updated_by, ai_enabled, monthly_budget_idr,
         budget_warn_pct, budget_stop_pct, features)
       VALUES ($1, $2, true, 1000000, 80, 100, '[]'::jsonb)`,
      [draftTenantId, draftUserId],
    );
  });

  afterAll(async () => {
    setAiProviderForTests(undefined);
    for (const table of [
      "ai_usage_events",
      "ai_usage_daily",
      "ai_usage_monthly",
      "ai_settings",
    ])
      await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        draftTenantId,
      ]);
    await owner.end();
  });

  it.each(SAMPLES)(
    "legend-vl93z $kind in a draft is masked, the rest of the draft stays",
    async ({ text, raw }) => {
      scriptDrafts([`Kopi Susu segar hari ini. ${text}`]);
      const result = await draftPromoCopy(draftAccess(), promoInput);
      expect(result.drafts).toHaveLength(1);
      expect(result.drafts[0]).toContain("Kopi Susu segar hari ini.");
      for (const value of raw) expect(result.drafts[0]).not.toContain(value);
      expect(JSON.stringify(result)).not.toContain(raw[0]!);
      // The response shape is unchanged.
      expect(result.aiAssisted).toBe(true);
      expect(result.label).toBe("Dibantu AI");
    },
  );

  it("legend-vl93z every draft is scanned, not only the first", async () => {
    scriptDrafts([
      "Draf bersih: diskon 20% untuk Kopi Susu.",
      `Draf dua. ${SAMPLES[0]!.text}`,
      `Draf tiga. ${SAMPLES[3]!.text}`,
    ]);
    const result = await draftPromoCopy(draftAccess(), promoInput);
    expect(result.drafts).toHaveLength(3);
    expect(result.drafts[0]).toBe("Draf bersih: diskon 20% untuk Kopi Susu.");
    expect(result.drafts[1]).toContain("Draf dua.");
    expect(result.drafts[2]).toContain("Draf tiga.");
    const wire = JSON.stringify(result);
    expect(wire).not.toContain("3174011501900001");
    expect(wire).not.toContain("budi.santoso@example.com");
  });

  it("legend-vl93z a clean draft with a menu price passes unchanged", async () => {
    const clean = "Kopi Susu spesial, cuma Rp 25.000 sampai Jumat.";
    scriptDrafts([clean]);
    const result = await draftPromoCopy(draftAccess(), promoInput);
    expect(result.drafts).toEqual([clean]);
    // Adjacent control: the same call with a NIK appended is not returned raw.
    scriptDrafts([`${clean} ${SAMPLES[0]!.text}`]);
    const masked = await draftPromoCopy(draftAccess(), promoInput);
    expect(masked.drafts[0]).toContain(clean);
    expect(masked.drafts[0]).not.toContain("3174011501900001");
  });

  it("legend-vl93z a salary amount in a draft is masked (a draft has no payslip tool)", async () => {
    scriptDrafts(["Promo karyawan. Gaji Budi Rp 12.000.000 per bulan."]);
    const result = await draftPromoCopy(draftAccess(), promoInput);
    expect(result.drafts[0]).toContain("Promo karyawan.");
    expect(result.drafts[0]).not.toContain("12.000.000");
  });
});
