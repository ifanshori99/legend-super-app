// Cafe Legend Tanya AI & MCP fixtures for FE mock mode and contract tests
// (bead legend-1zxo, WS-12). Realistic but illustrative: seven action requests
// (one per status, both sources), two conversations with sourced answers, AI
// jobs including blocked ones, MCP tool-call audit rows, tenant governance
// settings, three MCP clients (pending / approved / revoked) with hash-only
// tokens, and one valid input + output sample for every tool TL-01..TL-20.
//
// Cross-contract references point at the real fixtures: people from the access
// contract, outlets from core, menu items, inventory items and suppliers from
// their contracts, employees from HRIS, facilities from the facility contract,
// and the AI/MCP approval requests from the identity contract. Ids are fixed so
// screens and tests can address rows. Tokens appear only as hash + prefix.

import { fixtureTimeAfter } from "../core/fixture-clock.ts";
import { cafeLegendFixtures, isoDateTimeSchema, z } from "../core/index.ts";
import { cafeLegendAccessFixtures } from "../access/fixtures.ts";
import { cafeLegendFacilityFixtures } from "../facility/fixtures.ts";
import { cafeLegendHrisFixtures } from "../hris/fixtures.ts";
import { cafeLegendPayrollFixtures } from "../hris/payroll/fixtures.ts";
import { cafeLegendIdentityFixtures } from "../identity/fixtures.ts";
import {
  cafeLegendInventoryFixtures,
  cafeLegendPurchasingFixtures,
} from "../inventory/index.ts";
import { cafeLegendMenuFixtures } from "../menu/index.ts";
import { AI_TOOL_CODES } from "./ids.ts";
import type { AiToolCode } from "./ids.ts";
import {
  actionRequestSchema,
  aiConversationSchema,
  aiGovernanceSettingsSchema,
  aiJobSchema,
  aiMessageSchema,
  aiToolCallRecordSchema,
  mcpClientSchema,
  mcpTokenSchema,
} from "./schemas.ts";
import { AI_TOOL_IO } from "./tool-io.ts";

const { tenant, outlets } = cafeLegendFixtures;
const bandung = outlets[0];
const bandung2 = outlets[1];
const people = cafeLegendAccessFixtures.users;

/** Fixed uuid per group so AI fixture ids never collide with other contracts. */
const id = (group: number, n: number) =>
  `a1${String(group).padStart(2, "0")}0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Time-ordered ULID for tool-call audit rows (Crockford base32, no I L O U). */
const ulid = (n: number) => `01JC2A5M7Q${String(n).padStart(16, "0")}`;

const GROUP = {
  actionRequest: 1,
  approval: 2,
  conversation: 3,
  message: 4,
  job: 5,
  mcpClient: 6,
  mcpToken: 7,
  chunk: 8,
  receipt: 9,
  shiftRef: 10,
} as const;

/** A clock after every record below, so nothing is future-dated. */
const now = "2026-11-01T12:00:00.000Z";

const menuItem = (name: string) => {
  const item = cafeLegendMenuFixtures.items.find((row) => row.name === name);
  if (!item) throw new Error(`Missing menu fixture "${name}"`);
  return item.id;
};
const inventoryItem = (name: string) => {
  const item = cafeLegendInventoryFixtures.items.find(
    (row) => row.name === name,
  );
  if (!item) throw new Error(`Missing inventory fixture "${name}"`);
  return item.id;
};
const supplier = (name: string) => {
  const row = cafeLegendPurchasingFixtures.suppliers.find(
    (entry) => entry.name === name,
  );
  if (!row) throw new Error(`Missing supplier fixture "${name}"`);
  return row.id;
};
const employee = (fullName: string) => {
  const row = cafeLegendHrisFixtures.employees.find(
    (entry) => entry.fullName === fullName,
  );
  if (!row) throw new Error(`Missing employee fixture "${fullName}"`);
  return row;
};
const facility = (name: string) => {
  const row = cafeLegendFacilityFixtures.facilities.find(
    (entry) => entry.name === name,
  );
  if (!row) throw new Error(`Missing facility fixture "${name}"`);
  return row;
};
const approvalIdByActionType = (actionType: "ai_action" | "mcp_action") => {
  const row = cafeLegendIdentityFixtures.approvalRequests.find(
    (entry) => entry.actionType === actionType,
  );
  if (!row) throw new Error(`Missing approval fixture "${actionType}"`);
  return row.id;
};

const cappuccino = menuItem("Cappuccino");
const kopiSusuAren = menuItem("Kopi Susu Aren");
const coldBrew = menuItem("Cold Brew");
const croissant = menuItem("Croissant Mentega");
const gayo = inventoryItem("Kopi Arabika Gayo");
const uht = inventoryItem("Susu UHT Full Cream");
const arenCair = inventoryItem("Gula Aren Cair");
const kopiPriangan = supplier("CV Kopi Priangan");
const rizky = employee("Rizky Pratama");
const siti = employee("Siti Nurhaliza");
const showerRoom = facility("Shower Room Legend");
const wfcZone = facility("Zona WFC Legend");
const payslip = cafeLegendPayrollFixtures.payslips[0];
if (!payslip) throw new Error("Missing payslip fixture");

const octoberPeriod = { from: "2026-10-01", to: "2026-10-31" } as const;
const lastWeek = { from: "2026-10-25", to: "2026-10-31" } as const;
const salesSource = {
  metricCode: "net_sales",
  label: "Penjualan bersih",
  period: lastWeek,
  finality: "final",
  link: "/laporan/penjualan",
} as const;

// ---- Tool input samples (also the payload snapshot of the write requests) ---

const purchaseOrderInput = {
  outletId: bandung.id,
  supplierId: kopiPriangan,
  lines: [
    { inventoryItemId: gayo, qty: "20.0000", unitCostIdr: "185000.0000" },
    { inventoryItemId: arenCair, qty: "12.0000" },
  ],
  neededBy: "2026-11-05",
  note: "Stok kopi menipis sebelum akhir pekan.",
};
const stockAdjustmentInput = {
  outletId: bandung.id,
  lines: [
    {
      inventoryItemId: uht,
      qtyDelta: "-3.0000",
      reason: "Kemasan rusak saat penerimaan barang.",
    },
  ],
  note: "Selisih hasil hitung stok pagi.",
};
const promotionInput = {
  name: "Happy Hour Kopi Susu",
  outletIds: [bandung.id, bandung2.id],
  startsAt: "2026-11-10T08:00:00.000Z",
  endsAt: "2026-11-16T14:00:00.000Z",
  discount: { kind: "percent", percent: "15.0000" },
  menuItemIds: [kopiSusuAren, coldBrew],
  description: "Diskon 15 persen untuk kopi susu pukul 15:00 sampai 21:00.",
};
const shiftScheduleInput = {
  outletId: bandung.id,
  weekStart: "2026-11-09",
  shifts: [
    {
      employeeId: rizky.id,
      date: "2026-11-09",
      startTime: "07:00",
      endTime: "15:00",
      station: "Bar",
    },
    {
      employeeId: siti.id,
      date: "2026-11-09",
      startTime: "15:00",
      endTime: "23:00",
    },
  ],
};
const priceChangeInput = {
  outletIds: [bandung.id],
  changes: [{ menuItemId: cappuccino, newPriceIdr: 32_000 }],
  effectiveAt: "2026-11-08T00:00:00.000Z",
};
const menuAvailabilityInput = {
  outletId: bandung.id,
  items: [{ menuItemId: croissant, available: false }],
  until: "2026-11-02T00:00:00.000Z",
  reason: "Pasokan tepung terlambat, croissant habis hari ini.",
};

// ---- Action requests (§6 J action_requests) --------------------------------

const aiApproval = approvalIdByActionType("ai_action");
const mcpApproval = approvalIdByActionType("mcp_action");

// Client ids used below, declared early so requests can point at them.
const claudeDesktopId = id(GROUP.mcpClient, 1);
const pendingClientId = id(GROUP.mcpClient, 2);
const revokedClientId = id(GROUP.mcpClient, 3);

const actionRequests = [
  // pending, from Tanya AI: the request behind the identity ai_action approval.
  actionRequestSchema.parse({
    id: id(GROUP.actionRequest, 1),
    tenantId: tenant.id,
    outletId: bandung.id,
    toolCode: "TL-17",
    requestedByUserId: people.owner.id,
    source: "ai",
    mcpClientId: null,
    payload: priceChangeInput,
    approvalRequestId: aiApproval,
    approvalActionType: "ai_action",
    status: "pending",
    resultRef: null,
    failureReason: null,
    createdAt: "2026-11-01T04:35:00.000Z",
    executedAt: null,
    expiresAt: fixtureTimeAfter({ hours: 16, minutes: 35 }, now),
  }),
  // pending, from an approved MCP client: the identity mcp_action approval.
  actionRequestSchema.parse({
    id: id(GROUP.actionRequest, 2),
    tenantId: tenant.id,
    outletId: bandung.id,
    toolCode: "TL-13",
    requestedByUserId: people.generalManager.id,
    source: "mcp",
    mcpClientId: claudeDesktopId,
    payload: purchaseOrderInput,
    approvalRequestId: mcpApproval,
    approvalActionType: "mcp_action",
    status: "pending",
    resultRef: null,
    failureReason: null,
    createdAt: "2026-11-01T04:47:00.000Z",
    executedAt: null,
    expiresAt: fixtureTimeAfter({ hours: 16, minutes: 47 }, now),
  }),
  // approved, waiting for the executor.
  actionRequestSchema.parse({
    id: id(GROUP.actionRequest, 3),
    tenantId: tenant.id,
    outletId: bandung.id,
    toolCode: "TL-18",
    requestedByUserId: people.outletManager.id,
    source: "ai",
    mcpClientId: null,
    payload: menuAvailabilityInput,
    approvalRequestId: id(GROUP.approval, 3),
    approvalActionType: "ai_action",
    status: "approved",
    resultRef: null,
    failureReason: null,
    createdAt: "2026-11-01T08:10:00.000Z",
    executedAt: null,
    expiresAt: fixtureTimeAfter({ hours: 20, minutes: 10 }, now),
  }),
  // executed: the stock adjustment was posted after approval.
  actionRequestSchema.parse({
    id: id(GROUP.actionRequest, 4),
    tenantId: tenant.id,
    outletId: bandung.id,
    toolCode: "TL-14",
    requestedByUserId: people.warehouse.id,
    source: "ai",
    mcpClientId: null,
    payload: stockAdjustmentInput,
    approvalRequestId: id(GROUP.approval, 4),
    approvalActionType: "ai_action",
    status: "executed",
    resultRef: "stock_adjustment:SA-2026-1101-001",
    failureReason: null,
    createdAt: "2026-10-31T09:00:00.000Z",
    executedAt: "2026-10-31T09:25:00.000Z",
    expiresAt: fixtureTimeAfter({ hours: -3 }, now),
  }),
  // rejected by the approver.
  actionRequestSchema.parse({
    id: id(GROUP.actionRequest, 5),
    tenantId: tenant.id,
    outletId: null,
    toolCode: "TL-15",
    requestedByUserId: people.marketing.id,
    source: "mcp",
    mcpClientId: claudeDesktopId,
    payload: promotionInput,
    approvalRequestId: id(GROUP.approval, 5),
    approvalActionType: "mcp_action",
    status: "rejected",
    resultRef: null,
    failureReason: null,
    createdAt: "2026-10-30T10:00:00.000Z",
    executedAt: null,
    expiresAt: "2026-10-31T10:00:00.000Z",
  }),
  // failed: approved, but the schedule had a conflict at execution time.
  actionRequestSchema.parse({
    id: id(GROUP.actionRequest, 6),
    tenantId: tenant.id,
    outletId: bandung.id,
    toolCode: "TL-16",
    requestedByUserId: people.outletManager.id,
    source: "ai",
    mcpClientId: null,
    payload: shiftScheduleInput,
    approvalRequestId: id(GROUP.approval, 6),
    approvalActionType: "ai_action",
    status: "failed",
    resultRef: null,
    failureReason: "Jadwal bentrok dengan cuti yang sudah disetujui.",
    createdAt: "2026-10-29T07:00:00.000Z",
    executedAt: null,
    expiresAt: "2026-10-30T07:00:00.000Z",
  }),
  // expired: nobody decided before the deadline.
  actionRequestSchema.parse({
    id: id(GROUP.actionRequest, 7),
    tenantId: tenant.id,
    outletId: bandung.id,
    toolCode: "TL-13",
    requestedByUserId: people.purchasing.id,
    source: "mcp",
    mcpClientId: claudeDesktopId,
    payload: purchaseOrderInput,
    approvalRequestId: id(GROUP.approval, 7),
    approvalActionType: "mcp_action",
    status: "expired",
    resultRef: null,
    failureReason: null,
    createdAt: "2026-10-27T03:00:00.000Z",
    executedAt: null,
    expiresAt: "2026-10-28T03:00:00.000Z",
  }),
];

// ---- Conversations and messages (§6 J ai_conversations, ai_messages) -------

const conversations = [
  aiConversationSchema.parse({
    id: id(GROUP.conversation, 1),
    tenantId: tenant.id,
    userId: people.owner.id,
    feature: "AI-01",
    title: "Penjualan minggu lalu",
    createdAt: "2026-11-01T02:00:00.000Z",
    updatedAt: "2026-11-01T02:03:00.000Z",
    deletedAt: null,
  }),
  // Deleted by its owner: kept as a soft delete.
  aiConversationSchema.parse({
    id: id(GROUP.conversation, 2),
    tenantId: tenant.id,
    userId: people.employee.id,
    feature: "AI-02",
    title: "Aturan cuci peralatan bar",
    createdAt: "2026-10-31T06:00:00.000Z",
    updatedAt: "2026-10-31T06:01:00.000Z",
    deletedAt: "2026-10-31T07:00:00.000Z",
  }),
];

const messages = [
  aiMessageSchema.parse({
    id: id(GROUP.message, 1),
    conversationId: conversations[0]!.id,
    role: "user",
    content: "Berapa penjualan bersih minggu lalu di semua outlet?",
    toolCode: null,
    sources: [],
    aiAssisted: false,
    createdAt: "2026-11-01T02:00:00.000Z",
  }),
  aiMessageSchema.parse({
    id: id(GROUP.message, 2),
    conversationId: conversations[0]!.id,
    role: "tool",
    content: "get_sales_summary: 7 baris, total Rp 41.250.000.",
    toolCode: "TL-01",
    sources: [],
    aiAssisted: false,
    createdAt: "2026-11-01T02:00:02.000Z",
  }),
  aiMessageSchema.parse({
    id: id(GROUP.message, 3),
    conversationId: conversations[0]!.id,
    role: "assistant",
    content:
      "Penjualan bersih 25-31 Oktober 2026 sebesar Rp 41.250.000 dari 1.320 transaksi. Hari terbaik Sabtu, 31 Oktober.",
    toolCode: null,
    sources: [
      {
        label: "Penjualan bersih 25-31 Okt 2026",
        link: "/laporan/penjualan",
        metricCode: "net_sales",
        period: lastWeek,
      },
    ],
    aiAssisted: true,
    createdAt: "2026-11-01T02:00:05.000Z",
  }),
  aiMessageSchema.parse({
    id: id(GROUP.message, 4),
    conversationId: conversations[1]!.id,
    role: "user",
    content: "Bagaimana prosedur membersihkan mesin espresso setiap hari?",
    toolCode: null,
    sources: [],
    aiAssisted: false,
    createdAt: "2026-10-31T06:00:00.000Z",
  }),
  aiMessageSchema.parse({
    id: id(GROUP.message, 5),
    conversationId: conversations[1]!.id,
    role: "assistant",
    content:
      "Bilas group head, lakukan backflush dengan air, lalu lap steam wand setelah tiap pemakaian (SOP Kebersihan Bar v3).",
    toolCode: null,
    sources: [{ label: "SOP Kebersihan Bar v3", link: "/sop/kebersihan-bar" }],
    aiAssisted: true,
    createdAt: "2026-10-31T06:00:04.000Z",
  }),
];

// ---- Jobs (§6 J ai_jobs) ---------------------------------------------------

const aiJobs = [
  aiJobSchema.parse({
    id: id(GROUP.job, 1),
    tenantId: tenant.id,
    userId: people.owner.id,
    feature: "AI-01",
    channel: "app",
    toolsCalled: ["TL-01"],
    model: "claude-sonnet-5-5",
    promptVersion: "ask-v3",
    tokensIn: 2_840,
    tokensOut: 410,
    costIdr: 185,
    status: "succeeded",
    blockedReason: null,
    createdAt: "2026-11-01T02:00:00.000Z",
  }),
  aiJobSchema.parse({
    id: id(GROUP.job, 2),
    tenantId: tenant.id,
    userId: people.generalManager.id,
    feature: "AI-05",
    channel: "mcp",
    toolsCalled: ["TL-03", "TL-13"],
    model: "claude-desktop",
    promptVersion: "mcp-v1",
    tokensIn: 0,
    tokensOut: 0,
    costIdr: 0,
    status: "succeeded",
    blockedReason: null,
    createdAt: "2026-11-01T04:47:00.000Z",
  }),
  aiJobSchema.parse({
    id: id(GROUP.job, 3),
    tenantId: tenant.id,
    userId: people.finance.id,
    feature: "AI-04",
    channel: "app",
    toolsCalled: ["TL-06"],
    model: "claude-sonnet-5-5",
    promptVersion: "ask-v3",
    tokensIn: 3_950,
    tokensOut: 120,
    costIdr: 240,
    status: "failed",
    blockedReason: null,
    createdAt: "2026-10-31T10:00:00.000Z",
  }),
  aiJobSchema.parse({
    id: id(GROUP.job, 4),
    tenantId: tenant.id,
    userId: people.employee.id,
    feature: "AI-02",
    channel: "app",
    toolsCalled: [],
    model: "claude-sonnet-5-5",
    promptVersion: "ask-v3",
    tokensIn: 0,
    tokensOut: 0,
    costIdr: 0,
    status: "blocked",
    blockedReason: "quota_exceeded",
    createdAt: "2026-10-31T11:00:00.000Z",
  }),
  aiJobSchema.parse({
    id: id(GROUP.job, 5),
    tenantId: tenant.id,
    userId: people.waiter.id,
    feature: "AI-01",
    channel: "app",
    toolsCalled: [],
    model: "claude-sonnet-5-5",
    promptVersion: "ask-v3",
    tokensIn: 0,
    tokensOut: 0,
    costIdr: 0,
    status: "blocked",
    blockedReason: "pii_blocked",
    createdAt: "2026-10-31T12:00:00.000Z",
  }),
];

// ---- MCP clients and tokens (§6 J mcp_clients, mcp_tokens) -----------------

const mcpClients = [
  mcpClientSchema.parse({
    id: claudeDesktopId,
    tenantId: tenant.id,
    name: "Claude Desktop",
    clientId: "claude-desktop",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    allowedScopes: [
      "mcp:sales:read",
      "mcp:inventory:read",
      "mcp:actions:read",
      "mcp:purchasing:draft",
      "mcp:promotion:draft",
    ],
    status: "approved",
    registeredVia: "admin",
    approvedBy: people.tenantAdmin.id,
    approvedAt: "2026-10-20T03:00:00.000Z",
    createdAt: "2026-10-20T02:30:00.000Z",
    revokedAt: null,
  }),
  // Dynamic registration is off by default (MCP-05); this one waits for approval.
  mcpClientSchema.parse({
    id: pendingClientId,
    tenantId: tenant.id,
    name: "Cursor Finance Agent",
    clientId: "cursor-finance-agent",
    redirectUris: ["http://localhost:6274/oauth/callback"],
    allowedScopes: ["mcp:finance:read"],
    status: "pending",
    registeredVia: "dynamic",
    approvedBy: null,
    approvedAt: null,
    createdAt: "2026-10-31T08:00:00.000Z",
    revokedAt: null,
  }),
  mcpClientSchema.parse({
    id: revokedClientId,
    tenantId: tenant.id,
    name: "Dashboard Bot Lama",
    clientId: "dashboard-bot-legacy",
    redirectUris: ["https://bot.cafelegend.example/callback"],
    allowedScopes: ["mcp:sales:read", "mcp:menu:read"],
    status: "revoked",
    registeredVia: "admin",
    approvedBy: people.tenantAdmin.id,
    approvedAt: "2026-09-01T03:00:00.000Z",
    createdAt: "2026-09-01T02:00:00.000Z",
    revokedAt: "2026-10-15T05:00:00.000Z",
  }),
];

// Hash + prefix only: the raw token is shown once at issue time and never stored.
const mcpTokens = [
  // active, used a few minutes ago.
  mcpTokenSchema.parse({
    id: id(GROUP.mcpToken, 1),
    tenantId: tenant.id,
    clientId: claudeDesktopId,
    userId: people.generalManager.id,
    tokenHash:
      "0da62bf33733e618caf663d10a81a19085d6d6c0ef5393eb555cdf37eb3d1f54",
    tokenPrefix: "mcp_a1B2c3D4",
    scopes: ["mcp:sales:read", "mcp:inventory:read", "mcp:purchasing:draft"],
    expiresAt: fixtureTimeAfter({ hours: 4, minutes: 30 }, now),
    revokedAt: null,
    lastUsedAt: "2026-11-01T11:55:00.000Z",
    createdAt: "2026-11-01T04:30:00.000Z",
  }),
  // revoked by the user before it expired (MCP-02).
  mcpTokenSchema.parse({
    id: id(GROUP.mcpToken, 2),
    tenantId: tenant.id,
    clientId: claudeDesktopId,
    userId: people.marketing.id,
    tokenHash:
      "c55595d68a2c5f55eb1ad6a93ccee44339e204d7ca1b8078c8b139be1b3d75dd",
    tokenPrefix: "mcp_c3D4e5F6",
    scopes: ["mcp:promotion:draft"],
    expiresAt: "2026-10-30T22:00:00.000Z",
    revokedAt: "2026-10-30T12:00:00.000Z",
    lastUsedAt: "2026-10-30T10:05:00.000Z",
    createdAt: "2026-10-30T10:00:00.000Z",
  }),
  // expired and never used again.
  mcpTokenSchema.parse({
    id: id(GROUP.mcpToken, 3),
    tenantId: tenant.id,
    clientId: revokedClientId,
    userId: people.owner.id,
    tokenHash:
      "cbda6c5672640c38a9ba13d0cf78a605312fcbceed9be30ccc78c7c7c9cae356",
    tokenPrefix: "mcp_e5F6g7H8",
    scopes: ["mcp:sales:read"],
    expiresAt: "2026-10-14T20:00:00.000Z",
    revokedAt: null,
    lastUsedAt: "2026-10-14T09:00:00.000Z",
    createdAt: "2026-10-14T08:00:00.000Z",
  }),
];

// ---- Tool call audit (MCP-03) ----------------------------------------------

const toolCallRecords = [
  aiToolCallRecordSchema.parse({
    id: ulid(1),
    tenantId: tenant.id,
    outletId: null,
    userId: people.owner.id,
    channel: "app",
    mcpClientId: null,
    mcpTokenId: null,
    toolCode: "TL-01",
    redactedParams: { from: "2026-10-25", to: "2026-10-31", groupBy: "day" },
    outcome: "ok",
    rowCount: 7,
    actionRequestId: null,
    durationMs: 420,
    occurredAt: "2026-11-01T02:00:02.000Z",
  }),
  aiToolCallRecordSchema.parse({
    id: ulid(2),
    tenantId: tenant.id,
    outletId: bandung.id,
    userId: people.generalManager.id,
    channel: "mcp",
    mcpClientId: claudeDesktopId,
    mcpTokenId: id(GROUP.mcpToken, 1),
    toolCode: "TL-13",
    redactedParams: { lines: 2, supplierId: kopiPriangan, note: "[redacted]" },
    outcome: "ok",
    rowCount: 1,
    actionRequestId: id(GROUP.actionRequest, 2),
    durationMs: 610,
    occurredAt: "2026-11-01T04:47:00.000Z",
  }),
  aiToolCallRecordSchema.parse({
    id: ulid(3),
    tenantId: tenant.id,
    outletId: null,
    userId: people.waiter.id,
    channel: "app",
    mcpClientId: null,
    mcpTokenId: null,
    toolCode: "TL-06",
    redactedParams: { statement: "profit_loss" },
    outcome: "denied",
    rowCount: 0,
    actionRequestId: null,
    durationMs: 12,
    occurredAt: "2026-10-31T12:10:00.000Z",
  }),
  aiToolCallRecordSchema.parse({
    id: ulid(4),
    tenantId: tenant.id,
    outletId: null,
    userId: people.finance.id,
    channel: "app",
    mcpClientId: null,
    mcpTokenId: null,
    toolCode: "TL-06",
    redactedParams: { statement: "balance_sheet", from: "2026-10-01" },
    outcome: "error",
    rowCount: 0,
    actionRequestId: null,
    durationMs: 3_050,
    occurredAt: "2026-10-31T10:00:03.000Z",
  }),
  aiToolCallRecordSchema.parse({
    id: ulid(5),
    tenantId: tenant.id,
    outletId: null,
    userId: people.generalManager.id,
    channel: "mcp",
    mcpClientId: claudeDesktopId,
    mcpTokenId: id(GROUP.mcpToken, 1),
    toolCode: "TL-01",
    redactedParams: { groupBy: "outlet" },
    outcome: "rate_limited",
    rowCount: 0,
    actionRequestId: null,
    durationMs: 3,
    occurredAt: "2026-11-01T11:00:00.000Z",
  }),
  aiToolCallRecordSchema.parse({
    id: ulid(6),
    tenantId: tenant.id,
    outletId: null,
    userId: people.owner.id,
    channel: "app",
    mcpClientId: null,
    mcpTokenId: null,
    toolCode: "TL-07",
    redactedParams: { segmentBy: "tier" },
    outcome: "disabled",
    rowCount: 0,
    actionRequestId: null,
    durationMs: 4,
    occurredAt: "2026-10-30T09:00:00.000Z",
  }),
];

// ---- Governance (§3 Fitur 40) ----------------------------------------------

const governanceSettings = aiGovernanceSettingsSchema.parse({
  tenantId: tenant.id,
  platformLocked: false,
  aiEnabled: true,
  mcpEnabled: true,
  dynamicClientRegistrationEnabled: false,
  monthlyBudgetIdr: 500_000,
  budgetWarnPct: 80,
  budgetStopPct: 100,
  features: [
    {
      feature: "AI-01",
      isEnabled: true,
      dailyLimitByRole: { employee: 30, cashier: 30, owner: 100 },
    },
    { feature: "AI-02", isEnabled: true, dailyLimitByRole: { employee: 20 } },
    { feature: "AI-05", isEnabled: true, dailyLimitByRole: {} },
    { feature: "AI-14", isEnabled: false, dailyLimitByRole: {} },
  ],
  disabledToolCodes: ["TL-07"],
  mcpRateLimitPerMinute: 60,
  maxRowsPerResponse: 200,
  updatedAt: "2026-10-20T03:30:00.000Z",
  updatedBy: people.tenantAdmin.id,
});

// ---- One valid input + output per tool (TL-01..TL-20) ----------------------

const receipt = (n: number, toolCode: AiToolCode, summary: string) => ({
  actionRequestId: id(GROUP.receipt, n),
  approvalRequestId: id(GROUP.approval, n),
  toolCode,
  status: "pending",
  summary,
});

const toolSamples = {
  "TL-01": {
    input: { period: lastWeek, outletIds: [bandung.id], groupBy: "day" },
    output: {
      groupBy: "day",
      rows: [
        {
          key: "2026-10-30",
          label: "Jumat, 30 Okt 2026",
          netSalesIdr: 5_480_000,
          grossSalesIdr: 5_960_000,
          transactionCount: 176,
          pax: 241,
          avgSpendPerPaxIdr: 22_739,
        },
        {
          key: "2026-10-31",
          label: "Sabtu, 31 Okt 2026",
          netSalesIdr: 7_120_000,
          grossSalesIdr: 7_720_000,
          transactionCount: 231,
          pax: 318,
          avgSpendPerPaxIdr: 22_390,
        },
      ],
      totals: {
        netSalesIdr: 12_600_000,
        grossSalesIdr: 13_680_000,
        transactionCount: 407,
        pax: 559,
        avgSpendPerPaxIdr: 22_540,
      },
      truncated: false,
      sources: [salesSource],
    },
  },
  "TL-02": {
    input: { period: octoberPeriod, sortBy: "revenue", limit: 3 },
    output: {
      items: [
        {
          menuItemId: kopiSusuAren,
          name: "Kopi Susu Aren",
          qtySold: 1_840,
          revenueIdr: 55_200_000,
          marginIdr: 38_640_000,
        },
        {
          menuItemId: cappuccino,
          name: "Cappuccino",
          qtySold: 910,
          revenueIdr: 27_300_000,
          marginIdr: null,
        },
      ],
      truncated: false,
      sources: [
        {
          metricCode: "net_sales",
          label: "Penjualan per menu",
          period: octoberPeriod,
          finality: "final",
          link: "/laporan/menu",
        },
      ],
    },
  },
  "TL-03": {
    input: { outletIds: [bandung.id], onlyBelowPar: true, search: "kopi" },
    output: {
      items: [
        {
          inventoryItemId: gayo,
          name: "Kopi Arabika Gayo",
          unit: "kg",
          onHandQty: "4.5000",
          parLevelQty: "10.0000",
          status: "low",
        },
        {
          inventoryItemId: arenCair,
          name: "Gula Aren Cair",
          unit: "l",
          onHandQty: "0.0000",
          parLevelQty: null,
          status: "out",
        },
      ],
      truncated: false,
      sources: [
        {
          label: "Stok saat ini",
          period: { from: "2026-11-01", to: "2026-11-01" },
          finality: "estimate",
          link: "/inventori/stok",
        },
      ],
    },
  },
  "TL-04": {
    input: { period: octoberPeriod },
    output: {
      foodCostIdr: 38_400_000,
      netSalesIdr: 128_000_000,
      foodCostPct: "30.0000",
      rows: [
        {
          outletId: bandung.id,
          outletName: bandung.name,
          foodCostIdr: 38_400_000,
          netSalesIdr: 128_000_000,
          foodCostPct: "30.0000",
        },
      ],
      truncated: false,
      sources: [
        {
          metricCode: "food_cost_pct",
          label: "Food cost",
          period: octoberPeriod,
          finality: "final",
          link: "/laporan/food-cost",
        },
      ],
    },
  },
  "TL-05": {
    input: { period: octoberPeriod, outletIds: [bandung.id] },
    output: {
      laborCostIdr: 31_500_000,
      laborCostPct: "24.6000",
      scheduledHours: "2480.0000",
      workedHours: "2415.5000",
      overtimeHours: "62.0000",
      headcount: 32,
      sources: [
        {
          metricCode: "labor_cost_pct",
          label: "Biaya tenaga kerja",
          period: octoberPeriod,
          finality: "final",
          link: "/laporan/tenaga-kerja",
        },
      ],
    },
  },
  "TL-06": {
    input: { statement: "profit_loss", period: octoberPeriod },
    output: {
      statement: "profit_loss",
      lines: [
        {
          accountCode: "4101",
          label: "Penjualan Makanan dan Minuman",
          amountIdr: 128_000_000,
        },
        {
          accountCode: "4103",
          label: "Diskon Penjualan",
          amountIdr: -3_200_000,
        },
        {
          accountCode: "5101",
          label: "HPP Makanan dan Minuman",
          amountIdr: -38_400_000,
        },
        { accountCode: "6101", label: "Beban Gaji", amountIdr: -31_500_000 },
      ],
      periodClosed: true,
      finality: "final",
      truncated: false,
      sources: [
        {
          metricCode: "net_profit",
          label: "Laba rugi Oktober 2026",
          period: octoberPeriod,
          finality: "final",
          link: "/akuntansi/laba-rugi",
        },
      ],
    },
  },
  "TL-07": {
    input: { segmentBy: "tier" },
    output: {
      segmentBy: "tier",
      segments: [
        {
          code: "gold",
          label: "Gold",
          customerCount: 48,
          avgSpendIdr: 1_250_000,
        },
        {
          code: "silver",
          label: "Silver",
          customerCount: 190,
          avgSpendIdr: 640_000,
        },
      ],
      truncated: false,
      sources: [
        {
          label: "Segmen pelanggan",
          period: octoberPeriod,
          finality: "final",
          link: "/pelanggan/segmen",
        },
      ],
    },
  },
  "TL-08": {
    input: {
      period: { from: "2026-11-09", to: "2026-11-15" },
      outletIds: [bandung.id],
    },
    output: {
      shifts: [
        {
          shiftId: id(GROUP.shiftRef, 1),
          employeeId: rizky.id,
          employeeName: "Rizky Pratama",
          outletId: bandung.id,
          date: "2026-11-09",
          startTime: "07:00",
          endTime: "15:00",
          station: "Bar",
        },
        {
          shiftId: id(GROUP.shiftRef, 2),
          employeeId: siti.id,
          employeeName: "Siti Nurhaliza",
          outletId: bandung.id,
          date: "2026-11-09",
          startTime: "15:00",
          endTime: "23:00",
        },
      ],
      truncated: false,
    },
  },
  "TL-09": {
    input: { payrollMonth: "2026-10" },
    output: {
      payslipId: payslip.id,
      month: "2026-10",
      grossIdr: payslip.grossIdr,
      deductionsIdr: payslip.deductionsIdr,
      netIdr: payslip.netIdr,
      lines: [
        { code: "BASIC", label: "Gaji Pokok", amountIdr: 12_000_000 },
        {
          code: "POSITION_ALLOWANCE",
          label: "Tunjangan Jabatan",
          amountIdr: 1_500_000,
        },
      ],
      sources: [
        {
          label: "Slip gaji Oktober 2026",
          period: octoberPeriod,
          finality: "final",
          link: "/saya/slip-gaji",
        },
      ],
    },
  },
  "TL-10": {
    input: { query: "cuci mesin espresso", limit: 3 },
    output: {
      results: [
        {
          knowledgeChunkId: id(GROUP.chunk, 1),
          title: "Kebersihan Bar: mesin espresso",
          snippet:
            "Backflush group head dengan air setiap selesai shift, lalu lap steam wand setelah tiap pemakaian.",
          sourceVersion: "v3",
          link: "/sop/kebersihan-bar",
        },
      ],
      truncated: false,
    },
  },
  "TL-11": {
    input: { period: lastWeek, types: ["void", "cash_variance"] },
    output: {
      anomalies: [
        {
          type: "void",
          outletId: bandung.id,
          detectedAt: "2026-10-30T14:20:00.000Z",
          severity: "medium",
          observedValue: "9.0000",
          baselineValue: "3.0000",
          description: "Jumlah void Jumat sore tiga kali lipat dari rata-rata.",
          link: "/laporan/anomali",
        },
      ],
      truncated: false,
      sources: [
        {
          metricCode: "void_rate_pct",
          label: "Deteksi anomali",
          period: lastWeek,
          finality: "estimate",
          link: "/laporan/anomali",
        },
      ],
    },
  },
  "TL-12": {
    input: { year: 2026 },
    output: {
      distributions: [
        {
          periodLabel: "Kuartal 3 2026",
          sharePct: "10.0000",
          amountIdr: 4_800_000,
          status: "paid",
        },
      ],
      truncated: false,
      sources: [
        {
          label: "Bagi hasil Kuartal 3 2026",
          period: { from: "2026-07-01", to: "2026-09-30" },
          finality: "final",
          link: "/pemegang-saham/bagi-hasil",
        },
      ],
    },
  },
  "TL-13": {
    input: purchaseOrderInput,
    output: receipt(
      1,
      "TL-13",
      "Draf pesanan kopi Rp 3.700.000 ke CV Kopi Priangan menunggu persetujuan.",
    ),
  },
  "TL-14": {
    input: stockAdjustmentInput,
    output: receipt(
      2,
      "TL-14",
      "Penyesuaian stok susu UHT -3 menunggu persetujuan.",
    ),
  },
  "TL-15": {
    input: promotionInput,
    output: receipt(
      3,
      "TL-15",
      "Promo Happy Hour Kopi Susu 15% menunggu persetujuan.",
    ),
  },
  "TL-16": {
    input: shiftScheduleInput,
    output: receipt(
      4,
      "TL-16",
      "Jadwal shift minggu 9 November menunggu persetujuan.",
    ),
  },
  "TL-17": {
    input: priceChangeInput,
    output: receipt(
      5,
      "TL-17",
      "Harga Cappuccino menjadi Rp 32.000 menunggu persetujuan.",
    ),
  },
  "TL-18": {
    input: menuAvailabilityInput,
    output: receipt(
      6,
      "TL-18",
      "Croissant Mentega ditandai habis sampai besok menunggu persetujuan.",
    ),
  },
  "TL-19": {
    input: { actionRequestId: id(GROUP.actionRequest, 4) },
    output: {
      actionRequestId: id(GROUP.actionRequest, 4),
      toolCode: "TL-14",
      status: "executed",
      approvalStatus: "approved",
      decidedAt: "2026-10-31T09:20:00.000Z",
      resultRef: "stock_adjustment:SA-2026-1101-001",
      failureReason: null,
    },
  },
  "TL-20": {
    input: { period: octoberPeriod, facilityId: showerRoom.id },
    output: {
      rows: [
        {
          facilityId: showerRoom.id,
          name: showerRoom.name,
          sessions: 612,
          utilizationPct: "58.5000",
          revenueIdr: 18_360_000,
        },
        {
          facilityId: wfcZone.id,
          name: wfcZone.name,
          sessions: 340,
          utilizationPct: "41.2000",
          revenueIdr: 13_600_000,
        },
      ],
      truncated: false,
      sources: [
        {
          label: "Okupansi fasilitas",
          period: octoberPeriod,
          finality: "final",
          link: "/fasilitas/laporan",
        },
      ],
    },
  },
};

// ---- Fixture bundle --------------------------------------------------------

type ToolSampleShape = {
  [Code in AiToolCode]: z.ZodObject<{
    input: (typeof AI_TOOL_IO)[Code]["input"];
    output: (typeof AI_TOOL_IO)[Code]["output"];
  }>;
};
const toolSampleShape = Object.fromEntries(
  AI_TOOL_CODES.map((code) => [
    code,
    z.strictObject({
      input: AI_TOOL_IO[code].input,
      output: AI_TOOL_IO[code].output,
    }),
  ]),
) as ToolSampleShape;

/** One valid input and output sample per tool, keyed by tool code. */
export const toolSamplesSchema = z.strictObject(toolSampleShape);

export const aiFixtureSchema = z.strictObject({
  now: isoDateTimeSchema,
  actionRequests: z.array(actionRequestSchema),
  conversations: z.array(aiConversationSchema),
  messages: z.array(aiMessageSchema),
  aiJobs: z.array(aiJobSchema),
  toolCallRecords: z.array(aiToolCallRecordSchema),
  governanceSettings: aiGovernanceSettingsSchema,
  mcpClients: z.array(mcpClientSchema),
  mcpTokens: z.array(mcpTokenSchema),
  toolSamples: toolSamplesSchema,
});
export type AiFixtures = z.infer<typeof aiFixtureSchema>;

export const cafeLegendAiFixtures = aiFixtureSchema.parse({
  now,
  actionRequests,
  conversations,
  messages,
  aiJobs,
  toolCallRecords,
  governanceSettings,
  mcpClients,
  mcpTokens,
  toolSamples,
});
