// Cafe Legend notification fixtures (FE mock mode + contract tests). The
// policy mirrors PRD §3.15 defaults: free channels on, WhatsApp off. Names,
// times and the illustrative WhatsApp price are sample data.

import { cafeLegendFixtures } from "../core/index.ts";
import {
  deliveryAttemptSchema,
  notificationDedupeKey,
  notificationOutboxRowSchema,
  notificationPolicySchema,
  notificationPreferenceSchema,
  notificationSchema,
  notificationTemplateSchema,
} from "./schemas.ts";

const { tenant, outlets } = cafeLegendFixtures;
const outlet = outlets[0];
const uid = (n: number) =>
  `7b000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Sample staff (barista on the evening shift) and a customer. */
export const BARISTA_USER_ID = uid(1);
export const CUSTOMER_USER_ID = uid(2);

const policy = notificationPolicySchema.parse({
  tenantId: tenant.id,
  webPushEnabled: true,
  emailEnabled: true,
  whatsapp: {
    enabled: false,
    allowedCategories: [],
    monthlyCap: 0,
    costPerMessageIdr: 0,
  },
  maxAttempts: 5,
  retryBackoffSeconds: [30, 120, 600, 3600],
  updatedAt: "2026-11-01T02:00:00.000Z",
});

const baristaPreference = notificationPreferenceSchema.parse({
  tenantId: tenant.id,
  userId: BARISTA_USER_ID,
  categories: {
    order_ready: { web_push: true, email: false, whatsapp: false },
    daily_summary: { web_push: false, email: true, whatsapp: false },
  },
  quietHours: { start: "22:00", end: "07:00" },
  timeZone: "Asia/Jakarta",
  updatedAt: "2026-11-01T03:00:00.000Z",
});

const templates = [
  {
    id: uid(100),
    tenantId: null,
    category: "order_ready",
    channel: "web_push",
    locale: "id",
    title: "Pesanan {{orderNumber}} siap",
    body: "{{itemCount}} item untuk meja {{tableName}} siap diantar.",
    link: "/staf/pesanan/{{orderId}}",
    whatsappTemplateName: null,
    variables: ["orderNumber", "itemCount", "tableName", "orderId"],
    version: 1,
    isActive: true,
  },
  {
    id: uid(101),
    tenantId: null,
    category: "order_status",
    channel: "in_app",
    locale: "id",
    title: "Maaf, {{itemName}} sedang tidak tersedia",
    body: "Pilih ganti menu atau terima voucher senilai pesanan Anda.",
    link: "/pesanan/{{orderId}}/pemulihan",
    whatsappTemplateName: null,
    variables: ["itemName", "orderId"],
    version: 1,
    isActive: true,
  },
  {
    id: uid(102),
    tenantId: tenant.id,
    category: "subscription_billing",
    channel: "whatsapp",
    locale: "id",
    title: "Tagihan langganan {{planName}}",
    body: "Tagihan {{planName}} periode {{period}} siap dibayar.",
    link: "/member/langganan",
    whatsappTemplateName: "tagihan_langganan_v1",
    variables: ["planName", "period"],
    version: 1,
    isActive: false,
  },
].map((t) => notificationTemplateSchema.parse(t));

const sourceEventId = "01JBR2M4N5P6Q7R8S9T0V1W2X3";
const notifications = [
  {
    id: "01JBR2M4Q0A1B2C3D4E5F6G7H8",
    tenantId: tenant.id,
    outletId: outlet.id,
    userId: BARISTA_USER_ID,
    category: "order_ready",
    title: "Pesanan A-042 siap",
    body: "3 item untuk meja Private Room 2 siap diantar.",
    link: "/staf/pesanan/01JBQ7Z8K0A1B2C3D4E5F6G7H8",
    readAt: null,
    createdAt: "2026-11-02T05:12:30.000Z",
    sourceEventId,
    dedupeKey: notificationDedupeKey(
      sourceEventId,
      BARISTA_USER_ID,
      "order_ready",
    ),
  },
  {
    id: "01JBR2M4Q0A1B2C3D4E5F6G7H9",
    tenantId: tenant.id,
    outletId: outlet.id,
    userId: BARISTA_USER_ID,
    category: "printer_offline",
    title: "Printer stasiun Kopi offline",
    body: "Tiket dialihkan ke KDS. Periksa kabel daya dan jaringan printer.",
    link: "/staf/perangkat",
    readAt: "2026-11-02T04:02:00.000Z",
    createdAt: "2026-11-02T04:01:10.000Z",
    sourceEventId: null,
    dedupeKey: "printer-offline:BDG-01:2026-11-02T04:01",
  },
].map((n) => notificationSchema.parse(n));

const deliveryAttempts = [
  {
    id: "01JBR2M4R0A1B2C3D4E5F6G7H8",
    tenantId: tenant.id,
    notificationId: notifications[0].id,
    channel: "web_push",
    status: "sent",
    attempts: 1,
    nextAttemptAt: null,
    costIdr: 0,
    providerRef: "push-7f3a",
    errorCode: null,
    skipReason: null,
    createdAt: "2026-11-02T05:12:30.000Z",
    updatedAt: "2026-11-02T05:12:31.000Z",
  },
  {
    id: "01JBR2M4R0A1B2C3D4E5F6G7H9",
    tenantId: tenant.id,
    notificationId: notifications[0].id,
    channel: "whatsapp",
    status: "skipped",
    attempts: 0,
    nextAttemptAt: null,
    costIdr: 0,
    providerRef: null,
    errorCode: null,
    skipReason: "policy_disabled",
    createdAt: "2026-11-02T05:12:30.000Z",
    updatedAt: "2026-11-02T05:12:30.000Z",
  },
].map((a) => deliveryAttemptSchema.parse(a));

const outboxRow = notificationOutboxRowSchema.parse({
  id: "01JBR2M4S0A1B2C3D4E5F6G7H8",
  tenantId: tenant.id,
  sourceEventId,
  eventType: "kitchen_ticket.updated",
  payload: { ticketId: "01JBR2M4K0A1B2C3D4E5F6G7H8", status: "ready" },
  status: "done",
  attempts: 1,
  availableAt: "2026-11-02T05:12:29.000Z",
  lastErrorCode: null,
  createdAt: "2026-11-02T05:12:29.000Z",
});

/** Sample VAPID public key (P-256, base64url, 87 chars); not a real tenant key. */
const pushPublicKey =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

export const cafeLegendNotificationFixtures = {
  policy,
  pushPublicKey,
  baristaPreference,
  templates,
  notifications,
  notificationsPage: {
    data: notifications,
    meta: { limit: 25, nextCursor: null },
  },
  deliveryAttempts,
  outboxRow,
};
