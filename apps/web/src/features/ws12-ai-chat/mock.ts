// Mock handlers for Tanya AI chat (VITE_API_MOCK=true): ask, own history and
// quota. Fixtures come from @starter/shared/ai; the runtime validates every
// response with the contract schema, and the schemas below build the records
// the fixtures lack (usage, a fresh answer).
//
// Scenario URLs (no backend needed):
//   ?mock=empty|slow|error|offline   global scenarios (empty history, skeleton, ...)
//   ?state=unavailable   provider down: the "AI belum tersedia" banner shows at once
//   ?state=quota|budget|off  today's quota used up / budget stopped / feature off
//   ?state=denied|pii|error  the next question fails with that refusal
import {
  aiConversationSchema,
  aiMessageSchema,
  aiUsageSummarySchema,
  askAi,
  askAiResponseSchema,
  cafeLegendAiFixtures as fixtures,
  createAiConversation,
  deleteAiConversation,
  getAiConversation,
  getAiUsageSummary,
  listAiConversations,
} from "@starter/shared/ai";
import { ApiError } from "../../lib/api/errors.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";

const tenantId = fixtures.governanceSettings.tenantId;
const ownerId = fixtures.conversations[0]!.userId;

const uuid = (n: number) =>
  `a1990000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Store = {
  conversations: ReturnType<typeof aiConversationSchema.parse>[];
  messages: ReturnType<typeof aiMessageSchema.parse>[];
  counter: number;
};

const SALES_ANSWER =
  "Penjualan bersih Cafe Legend pada **10 November 2026** tercatat **Rp18.450.000**.\n\nAngka ini mengikuti laporan penjualan untuk periode tersebut. Buka sumber untuk melihat rinciannya.";

function seed(): Store {
  const yesterday = aiConversationSchema.parse({
    id: uuid(1),
    tenantId,
    userId: ownerId,
    feature: "AI-01",
    title: "Penjualan kemarin",
    createdAt: "2026-11-11T02:00:00.000Z",
    updatedAt: "2026-11-11T02:00:05.000Z",
    deletedAt: null,
  });
  return {
    conversations: [
      yesterday,
      ...fixtures.conversations.filter(
        (c) => c.userId === ownerId && c.deletedAt === null,
      ),
    ],
    messages: [
      aiMessageSchema.parse({
        id: uuid(2),
        conversationId: yesterday.id,
        role: "user",
        content: "Bagaimana penjualan kemarin?",
        toolCode: null,
        sources: [],
        aiAssisted: false,
        createdAt: "2026-11-11T02:00:00.000Z",
      }),
      aiMessageSchema.parse({
        id: uuid(3),
        conversationId: yesterday.id,
        role: "assistant",
        content: SALES_ANSWER,
        toolCode: null,
        sources: [salesSource()],
        aiAssisted: true,
        createdAt: "2026-11-11T02:00:05.000Z",
      }),
      ...fixtures.messages.filter((m) =>
        fixtures.conversations.some(
          (c) =>
            c.id === m.conversationId &&
            c.userId === ownerId &&
            c.deletedAt === null,
        ),
      ),
    ],
    counter: 10,
  };
}

function salesSource() {
  return {
    label: "Penjualan bersih · 10 November 2026",
    link: "/reports/sales/daily",
    metricCode: "net_sales" as const,
    period: { from: "2026-11-10", to: "2026-11-10" },
  };
}

const store = createMockStore(seed);

/** `?state=` of the page URL; the mock layer may read it, components never do. */
function urlState(): string | null {
  const search = (globalThis as { location?: { search?: string } }).location
    ?.search;
  return search ? new URLSearchParams(search).get("state") : null;
}

function failure(code: string): never {
  const table: Record<string, [number, string, string]> = {
    denied: [
      403,
      "AI_TOOL_FORBIDDEN",
      "Anda tidak punya izin memakai alat AI ini.",
    ],
    pii: [
      422,
      "AI_PII_BLOCKED",
      "Permintaan ditolak karena memuat data pribadi.",
    ],
    quota: [
      429,
      "AI_QUOTA_EXCEEDED",
      "Batas pertanyaan AI hari ini sudah habis.",
    ],
    budget: [402, "AI_BUDGET_EXCEEDED", "Anggaran AI bulan ini sudah habis."],
    unavailable: [
      503,
      "AI_PROVIDER_UNAVAILABLE",
      "Layanan AI sedang tidak tersedia.",
    ],
    off: [403, "AI_FEATURE_DISABLED", "Fitur AI sedang dimatikan oleh admin."],
    error: [500, "INTERNAL_ERROR", "Terjadi kesalahan pada server."],
  };
  const [status, errorCode, message] = table[code]!;
  throw new ApiError(status, errorCode, message);
}

const FAILING_STATES = [
  "denied",
  "pii",
  "quota",
  "budget",
  "unavailable",
  "error",
  "off",
];

function answerFor(question: string) {
  const q = question.toLowerCase();
  if (/(pesan|beli|po\b|stok)/.test(q))
    return {
      content:
        "Saya sudah menyiapkan draf pesanan pembelian kopi. Draf ini diajukan dan menunggu persetujuan; belum ada yang berubah.",
      sources: [],
      actionRequestIds: [fixtures.actionRequests[0]!.id],
    };
  if (/(jual|omzet|sales|pendapatan)/.test(q))
    return {
      content: SALES_ANSWER,
      sources: [salesSource()],
      actionRequestIds: [],
    };
  return {
    content:
      "Saya belum menemukan angka untuk pertanyaan itu. Coba tanyakan penjualan, stok, atau absensi.",
    sources: [],
    actionRequestIds: [],
  };
}

registerMock(askAi, ({ body }) => {
  const state = urlState();
  if (state && FAILING_STATES.includes(state)) failure(state);
  const s = store.get();
  const now = new Date().toISOString();
  let conversation = body.conversationId
    ? s.conversations.find(
        (c) => c.id === body.conversationId && c.deletedAt === null,
      )
    : undefined;
  if (body.conversationId && !conversation)
    throw new ApiError(
      404,
      "AI_CONVERSATION_NOT_FOUND",
      "Percakapan AI tidak ditemukan.",
    );
  if (!conversation) {
    s.counter += 1;
    conversation = aiConversationSchema.parse({
      id: uuid(s.counter),
      tenantId,
      userId: ownerId,
      feature: body.feature,
      title: body.question.slice(0, 60),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    s.conversations.unshift(conversation);
  } else {
    conversation = { ...conversation, updatedAt: now };
    s.conversations = s.conversations.map((c) =>
      c.id === conversation!.id ? conversation! : c,
    );
  }
  const answer = answerFor(body.question);
  s.counter += 2;
  const userMessage = aiMessageSchema.parse({
    id: uuid(s.counter - 1),
    conversationId: conversation.id,
    role: "user",
    content: body.question,
    toolCode: null,
    sources: [],
    aiAssisted: false,
    createdAt: now,
  });
  const assistantMessage = aiMessageSchema.parse({
    id: uuid(s.counter),
    conversationId: conversation.id,
    role: "assistant",
    content: answer.content,
    toolCode: null,
    sources: answer.sources,
    aiAssisted: true,
    createdAt: now,
  });
  s.messages.push(userMessage, assistantMessage);
  return {
    data: askAiResponseSchema.parse({
      conversation,
      userMessage,
      assistantMessage,
      actionRequestIds: answer.actionRequestIds,
    }),
  };
});

registerMock(listAiConversations, ({ query, scenario }) => {
  const items = store
    .get()
    .conversations.filter((c) => c.deletedAt === null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return paginateFixture(items, query, (c) => c.id, scenario);
});

registerMock(createAiConversation, ({ body }) => {
  const s = store.get();
  s.counter += 1;
  const now = new Date().toISOString();
  const conversation = aiConversationSchema.parse({
    id: uuid(s.counter),
    tenantId,
    userId: ownerId,
    feature: body.feature,
    title: body.title ?? "Percakapan baru",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  s.conversations.unshift(conversation);
  return { data: conversation };
});

registerMock(getAiConversation, ({ params }) => {
  const s = store.get();
  const conversation = s.conversations.find(
    (c) => c.id === params.conversationId && c.deletedAt === null,
  );
  if (!conversation)
    throw new ApiError(
      404,
      "AI_CONVERSATION_NOT_FOUND",
      "Percakapan AI tidak ditemukan.",
    );
  return {
    data: {
      conversation,
      messages: s.messages
        .filter((m) => m.conversationId === conversation.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    },
  };
});

registerMock(deleteAiConversation, ({ params }) => {
  const s = store.get();
  const found = s.conversations.find((c) => c.id === params.conversationId);
  if (!found || found.deletedAt !== null)
    throw new ApiError(
      404,
      "AI_CONVERSATION_NOT_FOUND",
      "Percakapan AI tidak ditemukan.",
    );
  s.conversations = s.conversations.map((c) =>
    c.id === found.id ? { ...c, deletedAt: new Date().toISOString() } : c,
  );
});

registerMock(getAiUsageSummary, () => {
  const state = urlState();
  const limit = 100;
  return {
    data: aiUsageSummarySchema.parse({
      aiEnabled: true,
      platformLocked: false,
      ...(state === "unavailable" ? { providerAvailable: false } : {}),
      month: "2026-11",
      features: [
        {
          feature: "AI-01",
          isEnabled: state !== "off",
          dailyLimit: limit,
          usedToday: state === "quota" ? limit : 12,
        },
      ],
      budget: {
        monthlyBudgetIdr: 500_000,
        usedIdr: state === "budget" ? 500_000 : 120_000,
        warnPct: 80,
        stopPct: 100,
        state: state === "budget" ? "stopped" : "ok",
      },
    }),
  };
});
