// Mock mode for the audit log (`VITE_API_MOCK=true`), so the screen fully works
// with no API (docs/frontend.md "Typed endpoints and mock mode"). It serves
// `GET /api/audit/events` from deterministic events built with the audit
// contract (`auditEventSchema`, `maskAuditChanges`): every actor kind (user,
// AI, MCP client, system, device), tenant-wide and outlet rows, a sensitive
// access with its reason, and masked personal fields.
//
// `?mock=empty` returns an empty last page (the viewer's honest empty state);
// `?mock=slow|error|offline` are handled by the runtime.
//
// Loaded in Node by tests/ws11-audit.test.mjs: bare package imports and relative
// `.ts` paths only, no `@/` alias.
import {
  auditEventSchema,
  listAuditEventsEndpoint,
  maskAuditChanges,
  type AuditEventView,
} from "@starter/shared/audit";
import { cafeLegendFixtures } from "@starter/shared/core";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { DEFAULT_TIME_ZONE } from "./lib.ts";

const [bandung, bandung2] = cafeLegendFixtures.outlets;
const TENANT_ID = cafeLegendFixtures.tenant.id;

const ACTORS = {
  owner: {
    type: "user",
    id: "a23d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
    name: "Rina Wulandari",
  },
  manager: {
    type: "user",
    id: "a23d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d14",
    name: "Budi Santoso",
  },
  ai: {
    type: "ai",
    id: "c33d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d21",
    name: "Asisten Operasional",
  },
  mcp: {
    type: "mcp_client",
    id: "c33d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d22",
    name: "Klien MCP Laporan",
  },
  system: { type: "system", id: null, name: null },
  tablet: {
    type: "device",
    id: "b23d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
    name: "Tablet Kasir 1",
  },
} as const;
type ActorKey = keyof typeof ACTORS;

const DEVICES = {
  laptop: {
    id: "b23d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d31",
    name: "Laptop Kantor",
  },
  tablet: ACTORS.tablet,
} as const;

type Template = {
  actor: ActorKey;
  action: string;
  objectType: string;
  outlet: 0 | 1 | null;
  device: keyof typeof DEVICES | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Fields whose raw value may be shown; default: every key of the row. */
  safe?: readonly string[];
  reason?: string;
  sensitive?: boolean;
  ip?: boolean;
};

const TEMPLATES: readonly Template[] = [
  {
    actor: "owner",
    action: "settings.updated",
    objectType: "outlet",
    outlet: 0,
    device: "laptop",
    before: { status: "preopening", openingHours: "09.00-21.00" },
    after: { status: "active", openingHours: "08.00-22.00" },
    ip: true,
  },
  {
    actor: "manager",
    action: "menu.price_changed",
    objectType: "price",
    outlet: 0,
    device: "laptop",
    before: { channel: "dine_in", priceIdr: 28000 },
    after: { channel: "dine_in", priceIdr: 30000 },
    ip: true,
  },
  {
    actor: "ai",
    action: "ai.suggestion_applied",
    objectType: "stock_item",
    outlet: 0,
    device: null,
    before: { parLevel: "12.0000" },
    after: { parLevel: "15.0000" },
    reason: "Saran AI disetujui Budi Santoso",
  },
  {
    actor: "mcp",
    action: "report.exported",
    objectType: "report",
    outlet: null,
    device: null,
    before: null,
    after: { reportCode: "sales.daily", format: "csv" },
  },
  {
    actor: "system",
    action: "tax.rule_published",
    objectType: "tax_rule",
    outlet: null,
    device: null,
    before: { ratePercent: 10, version: 3 },
    after: { ratePercent: 11, version: 4 },
  },
  {
    actor: "tablet",
    action: "order.voided",
    objectType: "order",
    outlet: 0,
    device: "tablet",
    before: { status: "preparing" },
    after: { status: "voided" },
    reason: "Tamu membatalkan sebelum disajikan",
  },
  {
    actor: "owner",
    action: "role.assigned",
    objectType: "user",
    outlet: null,
    device: "laptop",
    // Personal fields go through the contract masker, never straight to a row:
    // only `roleCode` is on the safe list, everything else arrives redacted.
    before: {
      roleCode: "cashier",
      phone: "081234567890",
      Email: "budi.santoso@gmail.com",
      NIK: "3273012304900001",
      bank_account: "1234567890",
      salaryIdr: 4_500_000,
      profile: {
        homeAddress: "Jl. Dago No. 12, Bandung",
        emergencyContacts: [{ name: "Sari", mobile: "+62 812-3456-7890" }],
      },
    },
    after: {
      roleCode: "outlet_manager",
      phone: "081234567890",
      Email: "budi.santoso@gmail.com",
      NIK: "3273012304900001",
      bank_account: "1234567890",
      salaryIdr: 6_000_000,
      apiToken: "sk_live_9f8e7d6c5b4a39281706f5e4d3c2b1a0",
      profile: {
        homeAddress: "Jl. Dago No. 12, Bandung",
        emergencyContacts: [{ name: "Sari", mobile: "+62 812-3456-7890" }],
      },
    },
    safe: ["roleCode"],
    ip: true,
  },
  {
    actor: "manager",
    action: "menu.availability_changed",
    objectType: "menu_item",
    outlet: 1,
    device: "laptop",
    before: { available: true },
    after: { available: false },
  },
  {
    actor: "owner",
    action: "payment.method_disabled",
    objectType: "payment_method",
    outlet: null,
    device: "laptop",
    before: { enabled: true },
    after: { enabled: false },
    reason: "Penyedia sedang gangguan",
    ip: true,
  },
  {
    actor: "manager",
    action: "stock.adjusted",
    objectType: "stock_item",
    outlet: 0,
    device: "laptop",
    before: { onHand: "20.0000" },
    after: { onHand: "18.5000" },
    reason: "Selisih opname",
  },
  {
    actor: "owner",
    action: "journal.posted",
    objectType: "journal",
    outlet: null,
    device: "laptop",
    before: null,
    after: { status: "posted", totalIdr: 1250000 },
  },
  {
    actor: "owner",
    action: "session.revoked",
    objectType: "session",
    outlet: null,
    device: "laptop",
    before: { active: true },
    after: { active: false },
    ip: true,
  },
  {
    actor: "manager",
    action: "role.updated",
    objectType: "role",
    outlet: null,
    device: "laptop",
    before: { permissionCount: 18 },
    after: { permissionCount: 21 },
    reason: "Akses laporan untuk manajer outlet",
    sensitive: true,
    ip: true,
  },
  {
    actor: "system",
    action: "notification.rule_updated",
    objectType: "notification",
    outlet: 0,
    device: null,
    before: { threshold: 5 },
    after: { threshold: 8 },
  },
];

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function eventId(index: number): string {
  return `01JBQ7Z8K3M4N5P6Q7R8S9T0${ULID_ALPHABET[Math.floor(index / 32) % 32]}${ULID_ALPHABET[index % 32]}`;
}

/** Deterministic 64-hex stand-in for the keyed IP hash (ip.ts stores HMAC-SHA256). */
function fakeIpHash(index: number): string {
  let state = (index + 1) * 2654435761;
  let hex = "";
  while (hex.length < 64) {
    state = (state * 1103515245 + 12345) % 2147483647;
    hex += state.toString(16).padStart(8, "0");
  }
  return hex.slice(0, 64);
}

function safeKeys(record: Record<string, unknown> | null): string[] {
  return record === null ? [] : Object.keys(record);
}

const NEWEST = Date.parse("2026-11-02T10:40:00.000Z");
const ROUNDS = 5;

function buildEvent(template: Template, index: number): AuditEventView {
  const actor = ACTORS[template.actor];
  const outlet =
    template.outlet === null
      ? null
      : template.outlet === 0
        ? bandung
        : bandung2;
  const device = template.device === null ? null : DEVICES[template.device];
  // The contract's deny list wins over this list (a `phone` key is redacted
  // even if listed), so the business-only demo rows can name all their keys.
  const safe = template.safe ?? [
    ...safeKeys(template.before),
    ...safeKeys(template.after),
  ];
  const event = auditEventSchema.parse({
    id: eventId(index),
    tenantId: TENANT_ID,
    outletId: outlet?.id ?? null,
    actorType: actor.type,
    actorId: actor.id,
    deviceId: device?.id ?? null,
    action: template.action,
    objectType: template.objectType,
    objectId:
      outlet?.id ?? "d44e5a91-2b84-4f6d-8e10-5a7b9c2d4e6" + (index % 10),
    reason: template.reason ?? null,
    maskedChanges: {
      before: maskAuditChanges(template.before, safe),
      after: maskAuditChanges(template.after, safe),
    },
    ipHash: template.ip ? fakeIpHash(index) : null,
    sensitiveAccess: template.sensitive === true,
    retentionClass: "audit_2y",
    // Newest first, 41 minutes apart so days and hours both vary.
    createdAt: new Date(NEWEST - index * 41 * 60_000).toISOString(),
  });
  return {
    event,
    actorName: actor.name,
    outletName: outlet?.name ?? null,
    outletTimeZone: outlet?.timeZone ?? null,
    deviceName: device?.name ?? null,
  };
}

/** 70 events (5 rounds of 14 templates), newest first. */
export const mockAuditEvents: readonly AuditEventView[] = Array.from(
  { length: TEMPLATES.length * ROUNDS },
  (_, index) => buildEvent(TEMPLATES[index % TEMPLATES.length]!, index),
);

function businessDate(instant: string, timeZone: string | null): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone ?? DEFAULT_TIME_ZONE,
  }).format(new Date(instant));
}

registerMock(listAuditEventsEndpoint, ({ query, scenario }) => {
  const rows = mockAuditEvents.filter(({ event, outletTimeZone }) => {
    if (query.actorType && event.actorType !== query.actorType) return false;
    if (query.actorId && event.actorId !== query.actorId) return false;
    if (query.objectType && event.objectType !== query.objectType) return false;
    if (query.action && event.action !== query.action) return false;
    if (query.outletId && event.outletId !== query.outletId) return false;
    const day = businessDate(event.createdAt, outletTimeZone);
    if (query.from && day < query.from) return false;
    if (query.to && day > query.to) return false;
    return true;
  });
  return paginateFixture(
    rows,
    { cursor: query.cursor, limit: query.limit },
    (row) => row.event.id,
    scenario,
  );
});
