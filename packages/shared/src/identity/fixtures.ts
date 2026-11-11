// Cafe Legend identity & access mock data (FE mock mode + contract tests).
// Tenant, brand and outlets come from the core fixtures; staff user ids match
// the access fixtures so a session, role assignment and approval request point
// at the same person across modules. Customer names, phone numbers, device
// labels and reasons are illustrative sample data, not PRD facts.
//
// Roles, role assignments and the approval matrix are owned by the access
// contract and re-exported here (same objects, not copies), so one fixture set
// drives the login, inbox and RBAC screens.

import { fixtureTimeAfter } from "../core/fixture-clock.ts";
import { cafeLegendFixtures } from "../core/index.ts";
import { accessUserSchema, cafeLegendAccessFixtures } from "../access/index.ts";
import {
  maskEmail,
  maskWhatsAppNumber,
  whatsAppLoginDeepLink,
} from "./login-code.ts";
import {
  approvalRequestSchema,
  currentAuthViewSchema,
  loginChallengeIssuedSchema,
  loginChallengeSchema,
  loginReplyPolicySchema,
  mfaFactorSchema,
  sessionSchema,
  staffPinStatusSchema,
  userIdentitySchema,
  userSchema,
} from "./schemas.ts";
import type {
  ApprovalRequest,
  CurrentAuthView,
  LoginChallenge,
  LoginChallengeIssued,
  LoginReplyPolicy,
  MfaFactor,
  Session,
  StaffPinStatus,
  User,
  UserIdentity,
  UserIdentityType,
} from "./schemas.ts";

function fixedId(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const { tenant, brand, outlets } = cafeLegendFixtures;
const bandung = outlets[0].id;
const { users: staff } = cafeLegendAccessFixtures;
const NOW = "2026-11-01T05:00:00.000Z";

// ---------------------------------------------------------------- accounts

const sari = fixedId("0c0f0000", 1);
const dimas = fixedId("0c0f0000", 2);
const ayu = fixedId("0c0f0000", 3);
const superAdmin = fixedId("0c0f0000", 4);

const users: User[] = [
  userSchema.parse({
    id: sari,
    displayName: "Sari Puspita",
    kind: "customer",
    status: "active",
    mfaRequired: false,
    lastLoginAt: "2026-11-01T04:55:00.000Z",
    createdAt: "2026-08-12T02:10:00.000Z",
  }),
  userSchema.parse({
    id: dimas,
    displayName: "Dimas Aryo",
    kind: "customer",
    status: "active",
    mfaRequired: false,
    lastLoginAt: "2026-10-30T11:20:00.000Z",
    createdAt: "2026-09-03T07:40:00.000Z",
  }),
  // The account a second WhatsApp sign-in created before the link was made.
  userSchema.parse({
    id: ayu,
    displayName: "Ayu Lestari",
    kind: "customer",
    status: "active",
    mfaRequired: false,
    lastLoginAt: "2026-10-29T09:00:00.000Z",
    createdAt: "2026-10-05T08:15:00.000Z",
  }),
  userSchema.parse({
    id: staff.owner.id,
    displayName: staff.owner.displayName,
    kind: "staff",
    status: "active",
    mfaRequired: true,
    lastLoginAt: "2026-11-01T04:50:00.000Z",
    createdAt: "2026-01-10T01:00:00.000Z",
  }),
  userSchema.parse({
    id: staff.cashier.id,
    displayName: staff.cashier.displayName,
    kind: "staff",
    status: "active",
    mfaRequired: false,
    lastLoginAt: "2026-11-01T04:45:00.000Z",
    createdAt: "2026-02-01T01:00:00.000Z",
  }),
  userSchema.parse({
    id: staff.hr.id,
    displayName: staff.hr.displayName,
    kind: "staff",
    status: "active",
    mfaRequired: true,
    lastLoginAt: "2026-10-31T08:30:00.000Z",
    createdAt: "2026-02-01T01:00:00.000Z",
  }),
  userSchema.parse({
    id: staff.supervisor.id,
    displayName: staff.supervisor.displayName,
    kind: "staff",
    status: "active",
    mfaRequired: false,
    lastLoginAt: "2026-11-01T04:40:00.000Z",
    createdAt: "2026-02-01T01:00:00.000Z",
  }),
  // PRD §3 F4: the platform Super Admin (break-glass account) is Ilham.
  userSchema.parse({
    id: superAdmin,
    displayName: "Ilham",
    kind: "staff",
    status: "active",
    mfaRequired: true,
    lastLoginAt: "2026-11-01T03:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
  }),
];

const usersByKey = {
  sari: users[0] as User,
  dimas: users[1] as User,
  ayu: users[2] as User,
  owner: users[3] as User,
  cashier: users[4] as User,
  hr: users[5] as User,
  supervisor: users[6] as User,
  superAdmin: users[7] as User,
};

// ---------------------------------------------------------- identity graph

function maskedValue(type: UserIdentityType, value: string): string {
  const masked =
    type === "whatsapp" ? maskWhatsAppNumber(value) : maskEmail(value);
  if (masked === null) throw new Error(`Fixture identity is invalid: ${value}`);
  return masked;
}

function identity(seed: {
  id: string;
  userId: string;
  type: UserIdentityType;
  value: string;
  isPrimary: boolean;
  verifiedAt: string | null;
  createdAt: string;
}): UserIdentity {
  return userIdentitySchema.parse({
    id: seed.id,
    userId: seed.userId,
    type: seed.type,
    valueMasked: maskedValue(seed.type, seed.value),
    isPrimary: seed.isPrimary,
    verifiedAt: seed.verifiedAt,
    createdAt: seed.createdAt,
  });
}

const identities: UserIdentity[] = [
  identity({
    id: fixedId("1d3e0000", 1),
    userId: sari,
    type: "whatsapp",
    value: "6281234567890",
    isPrimary: true,
    verifiedAt: "2026-08-12T02:12:00.000Z",
    createdAt: "2026-08-12T02:12:00.000Z",
  }),
  identity({
    id: fixedId("1d3e0000", 2),
    userId: sari,
    type: "email",
    value: "sari.puspita@gmail.com",
    isPrimary: false,
    verifiedAt: "2026-08-12T02:20:00.000Z",
    createdAt: "2026-08-12T02:20:00.000Z",
  }),
  identity({
    id: fixedId("1d3e0000", 3),
    userId: dimas,
    type: "email",
    value: "dimas.aryo@yahoo.com",
    isPrimary: true,
    verifiedAt: "2026-09-03T07:42:00.000Z",
    createdAt: "2026-09-03T07:42:00.000Z",
  }),
  identity({
    id: fixedId("1d3e0000", 4),
    userId: dimas,
    type: "google",
    value: "dimas.aryo@gmail.com",
    isPrimary: false,
    verifiedAt: "2026-09-03T07:50:00.000Z",
    createdAt: "2026-09-03T07:50:00.000Z",
  }),
  // Dimas never linked a WhatsApp number (AUTH-07: no points yet).
  identity({
    id: fixedId("1d3e0000", 5),
    userId: ayu,
    type: "whatsapp",
    value: "6281298765432",
    isPrimary: true,
    verifiedAt: "2026-10-05T08:16:00.000Z",
    createdAt: "2026-10-05T08:16:00.000Z",
  }),
  identity({
    id: fixedId("1d3e0000", 6),
    userId: staff.owner.id,
    type: "email",
    value: "raka@cafelegend.id",
    isPrimary: true,
    verifiedAt: "2026-01-10T01:05:00.000Z",
    createdAt: "2026-01-10T01:05:00.000Z",
  }),
  identity({
    id: fixedId("1d3e0000", 7),
    userId: staff.cashier.id,
    type: "email",
    value: "nina@cafelegend.id",
    isPrimary: true,
    verifiedAt: "2026-02-01T01:05:00.000Z",
    createdAt: "2026-02-01T01:05:00.000Z",
  }),
  identity({
    id: fixedId("1d3e0000", 8),
    userId: staff.hr.id,
    type: "email",
    value: "tono@cafelegend.id",
    isPrimary: true,
    verifiedAt: "2026-02-01T01:05:00.000Z",
    createdAt: "2026-02-01T01:05:00.000Z",
  }),
];

// ------------------------------------------------------- login challenges

const loginChallenges: LoginChallenge[] = [
  // The challenge a guest just created for the desktop QR / mobile deep link.
  loginChallengeSchema.parse({
    id: fixedId("1c4a0000", 1),
    tenantId: tenant.id,
    brandId: brand.id,
    channel: "whatsapp_inbound",
    status: "pending",
    expiresAt: fixtureTimeAfter({ minutes: 2 }, NOW),
    completedAt: null,
    matchedUserId: null,
    createdAt: "2026-11-01T04:57:00.000Z",
  }),
  // This morning's successful sign-in (already used, AUTH-01 single use).
  loginChallengeSchema.parse({
    id: fixedId("1c4a0000", 2),
    tenantId: tenant.id,
    brandId: brand.id,
    channel: "whatsapp_inbound",
    status: "completed",
    expiresAt: fixtureTimeAfter({ minutes: -5 }, NOW),
    completedAt: "2026-11-01T04:51:30.000Z",
    matchedUserId: sari,
    createdAt: "2026-11-01T04:50:00.000Z",
  }),
  loginChallengeSchema.parse({
    id: fixedId("1c4a0000", 3),
    tenantId: tenant.id,
    brandId: brand.id,
    channel: "email_magic_link",
    status: "pending",
    expiresAt: fixtureTimeAfter({ minutes: 11 }, NOW),
    completedAt: null,
    matchedUserId: null,
    createdAt: "2026-11-01T04:56:00.000Z",
  }),
  loginChallengeSchema.parse({
    id: fixedId("1c4a0000", 4),
    tenantId: tenant.id,
    brandId: brand.id,
    channel: "whatsapp_inbound",
    status: "expired",
    expiresAt: fixtureTimeAfter({ minutes: -35 }, NOW),
    completedAt: null,
    matchedUserId: null,
    createdAt: "2026-11-01T04:20:00.000Z",
  }),
  loginChallengeSchema.parse({
    id: fixedId("1c4a0000", 5),
    tenantId: tenant.id,
    brandId: brand.id,
    channel: "google",
    status: "cancelled",
    expiresAt: fixtureTimeAfter({ minutes: -10 }, NOW),
    completedAt: null,
    matchedUserId: null,
    createdAt: "2026-11-01T04:40:00.000Z",
  }),
  // Platform (Super Admin) login: no tenant context yet (TEN-02).
  loginChallengeSchema.parse({
    id: fixedId("1c4a0000", 6),
    tenantId: null,
    brandId: null,
    channel: "whatsapp_inbound",
    status: "pending",
    expiresAt: fixtureTimeAfter({ minutes: 3 }, NOW),
    completedAt: null,
    matchedUserId: null,
    createdAt: "2026-11-01T04:58:00.000Z",
  }),
];

/** The receiving number and login command (tenant data, PRD §3 F6 example). */
const login = {
  number: "6281223344556",
  keyword: "MASUK LEGEND",
  demoCode: "K7Q4M2XD",
} as const;

const loginChallengeIssued: LoginChallengeIssued =
  loginChallengeIssuedSchema.parse({
    challenge: loginChallenges[0],
    code: login.demoCode,
    codeFormatted: "K7Q4-M2XD",
    whatsAppDeepLink: whatsAppLoginDeepLink({
      numberDigits: login.number,
      code: login.demoCode,
      keyword: login.keyword,
    }),
  });

// --------------------------------------------------------------------- MFA

const mfaFactors: MfaFactor[] = [
  mfaFactorSchema.parse({
    id: fixedId("1f2a0000", 1),
    userId: staff.owner.id,
    type: "totp",
    createdAt: "2026-01-11T02:00:00.000Z",
  }),
  mfaFactorSchema.parse({
    id: fixedId("1f2a0000", 2),
    userId: staff.owner.id,
    type: "passkey",
    createdAt: "2026-06-01T02:00:00.000Z",
  }),
];

const loginReplyPolicy: LoginReplyPolicy = loginReplyPolicySchema.parse({
  enabled: false,
  freeMonthlyQuota: 1_000,
  repliesThisMonth: 37,
});

// -------------------------------------------------------------- staff pins

const staffPins: StaffPinStatus[] = [
  staffPinStatusSchema.parse({
    id: fixedId("5b1c0000", 1),
    tenantId: tenant.id,
    outletId: bandung,
    userId: staff.cashier.id,
    failedAttempts: 2,
    lockedUntil: null,
    updatedAt: "2026-11-01T04:55:00.000Z",
  }),
  staffPinStatusSchema.parse({
    id: fixedId("5b1c0000", 2),
    tenantId: tenant.id,
    outletId: bandung,
    userId: staff.waiter.id,
    failedAttempts: 5,
    lockedUntil: "2026-11-01T05:10:00.000Z",
    updatedAt: "2026-11-01T04:52:00.000Z",
  }),
];

// ---------------------------------------------------------------- sessions

const sessions: Session[] = [
  sessionSchema.parse({
    id: fixedId("5e550000", 1),
    userId: sari,
    tenantId: tenant.id,
    kind: "customer",
    deviceLabel: "Chrome di Android",
    createdAt: "2026-08-20T09:00:00.000Z",
    lastSeenAt: "2026-11-01T04:55:00.000Z",
    expiresAt: fixtureTimeAfter({ days: 17, hours: 4 }, NOW),
    revokedAt: null,
    mfaVerifiedAt: null,
  }),
  sessionSchema.parse({
    id: fixedId("5e550000", 2),
    userId: staff.owner.id,
    tenantId: tenant.id,
    kind: "management",
    deviceLabel: "Safari di Mac",
    createdAt: "2026-11-01T04:50:00.000Z",
    lastSeenAt: "2026-11-01T04:58:00.000Z",
    expiresAt: fixtureTimeAfter({ minutes: 28 }, NOW),
    revokedAt: null,
    mfaVerifiedAt: "2026-11-01T04:50:00.000Z",
  }),
  // One minute from its idle end: the "Sesi akan berakhir" warning.
  sessionSchema.parse({
    id: fixedId("5e550000", 3),
    userId: staff.owner.id,
    tenantId: tenant.id,
    kind: "management",
    deviceLabel: "Chrome di iPhone",
    createdAt: "2026-11-01T04:00:00.000Z",
    lastSeenAt: "2026-11-01T04:31:30.000Z",
    expiresAt: fixtureTimeAfter({ minutes: 1, seconds: 30 }, NOW),
    revokedAt: null,
    mfaVerifiedAt: "2026-11-01T04:00:00.000Z",
  }),
  // HR must use MFA (AUTH-05); this session has not verified a factor yet.
  sessionSchema.parse({
    id: fixedId("5e550000", 4),
    userId: staff.hr.id,
    tenantId: tenant.id,
    kind: "management",
    deviceLabel: "Firefox di Windows",
    createdAt: "2026-11-01T04:40:00.000Z",
    lastSeenAt: "2026-11-01T04:56:00.000Z",
    expiresAt: fixtureTimeAfter({ minutes: 26 }, NOW),
    revokedAt: null,
    mfaVerifiedAt: null,
  }),
  sessionSchema.parse({
    id: fixedId("5e550000", 5),
    userId: dimas,
    tenantId: tenant.id,
    kind: "customer",
    deviceLabel: "Chrome di Android",
    createdAt: "2026-10-01T10:00:00.000Z",
    lastSeenAt: "2026-10-15T09:30:00.000Z",
    expiresAt: fixtureTimeAfter({ days: 59, hours: 5 }, NOW),
    revokedAt: "2026-10-15T10:00:00.000Z",
    mfaVerifiedAt: null,
  }),
  // A cashier's web session: no MFA role, so the dashboard opens directly.
  sessionSchema.parse({
    id: fixedId("5e550000", 7),
    userId: staff.cashier.id,
    tenantId: tenant.id,
    kind: "management",
    deviceLabel: "Chrome di Windows",
    createdAt: "2026-11-01T04:45:00.000Z",
    lastSeenAt: "2026-11-01T04:58:00.000Z",
    expiresAt: fixtureTimeAfter({ minutes: 28 }, NOW),
    revokedAt: null,
    mfaVerifiedAt: null,
  }),
  // Platform session: no tenant, MFA verified (PRD §3 F4).
  sessionSchema.parse({
    id: fixedId("5e550000", 6),
    userId: superAdmin,
    tenantId: null,
    kind: "management",
    deviceLabel: "Safari di Mac",
    createdAt: "2026-11-01T04:30:00.000Z",
    lastSeenAt: "2026-11-01T04:45:00.000Z",
    expiresAt: fixtureTimeAfter({ minutes: 15 }, NOW),
    revokedAt: null,
    mfaVerifiedAt: "2026-11-01T04:30:00.000Z",
  }),
];

// ---------------------------------------------------------------- approvals

const orderNumber = "LEG-BDG-20261101-0042";
const orderId = cafeLegendFixtures.orderId;
const menuItemId = fixedId("3e470000", 1);
const inventoryItemId = fixedId("3e470000", 2);

const approvalRequests: ApprovalRequest[] = [
  // Refund below the Rp500.000 tier: one supervisor level.
  approvalRequestSchema.parse({
    id: fixedId("a9c00000", 1),
    tenantId: tenant.id,
    outletId: bandung,
    actionType: "refund",
    objectType: "order",
    objectId: orderId,
    payload: { orderNumber, refundMethod: "qris" },
    requestedBy: staff.cashier.id,
    source: "user",
    level: 1,
    requiredLevels: 1,
    amountIdr: 350_000,
    status: "pending",
    requestReason:
      "Pelanggan membatalkan pesanan sebelum dapur mulai; dana dikembalikan ke QRIS.",
    decidedBy: null,
    decidedAt: null,
    reason: null,
    deadlineAt: "2026-11-01T05:20:00.000Z",
    createdAt: "2026-11-01T04:20:00.000Z",
  }),
  // Discount above Rp200.000 goes to the outlet manager.
  approvalRequestSchema.parse({
    id: fixedId("a9c00000", 2),
    tenantId: tenant.id,
    outletId: bandung,
    actionType: "discount",
    objectType: "order",
    objectId: orderId,
    payload: { orderNumber, discountIdr: 250_000 },
    requestedBy: staff.waiter.id,
    source: "user",
    level: 1,
    requiredLevels: 1,
    amountIdr: 250_000,
    status: "pending",
    requestReason:
      "Diskon member untuk rombongan 12 orang sesuai kesepakatan dengan manajer.",
    decidedBy: null,
    decidedAt: null,
    reason: null,
    deadlineAt: "2026-11-01T05:45:00.000Z",
    createdAt: "2026-11-01T04:45:00.000Z",
  }),
  // AI proposes a price change; the human it acts for is the requester.
  approvalRequestSchema.parse({
    id: fixedId("a9c00000", 3),
    tenantId: tenant.id,
    outletId: bandung,
    actionType: "ai_action",
    objectType: "menu_item",
    objectId: menuItemId,
    payload: {
      tool: "menu.price.update",
      itemName: "Kopi Susu Legend",
      fromIdr: 28_000,
      toIdr: 30_000,
    },
    requestedBy: staff.owner.id,
    source: "ai",
    level: 1,
    requiredLevels: 1,
    amountIdr: null,
    status: "pending",
    requestReason:
      "AI mengusulkan harga baru setelah kenaikan harga biji kopi bulan ini.",
    decidedBy: null,
    decidedAt: null,
    reason: null,
    deadlineAt: "2026-11-01T05:35:00.000Z",
    createdAt: "2026-11-01T04:35:00.000Z",
  }),
  // MCP client asks for a purchase-order draft (PRD §4 Q).
  approvalRequestSchema.parse({
    id: fixedId("a9c00000", 4),
    tenantId: tenant.id,
    outletId: bandung,
    actionType: "mcp_action",
    objectType: "purchase_order",
    objectId: fixedId("3e470000", 3),
    payload: {
      tool: "inventory.purchase_order.draft",
      client: "claude-desktop",
    },
    requestedBy: staff.generalManager.id,
    source: "mcp",
    level: 1,
    requiredLevels: 1,
    amountIdr: null,
    status: "pending",
    requestReason: "Agen MCP menyusun draf PO kopi untuk minggu depan.",
    decidedBy: null,
    decidedAt: null,
    reason: null,
    deadlineAt: "2026-11-01T05:47:00.000Z",
    createdAt: "2026-11-01T04:47:00.000Z",
  }),
  // Decided: purchasing asked, finance approved inside the deadline.
  approvalRequestSchema.parse({
    id: fixedId("a9c00000", 5),
    tenantId: tenant.id,
    outletId: bandung,
    actionType: "expense",
    objectType: "supplier_invoice",
    objectId: fixedId("3e470000", 4),
    payload: { supplier: "Koperasi Kopi Nusantara", invoiceNumber: "KKN-1026" },
    requestedBy: staff.purchasing.id,
    source: "user",
    level: 1,
    requiredLevels: 1,
    amountIdr: 1_500_000,
    status: "approved",
    requestReason: "Pembelian biji kopi 60 kg sesuai PO bulan ini.",
    decidedBy: staff.finance.id,
    decidedAt: "2026-11-01T04:30:00.000Z",
    reason: "Sesuai PO dan harga kontrak supplier.",
    deadlineAt: "2026-11-01T04:40:00.000Z",
    createdAt: "2026-11-01T03:40:00.000Z",
  }),
  // A Rp750.000 refund needs two levels (supervisor, then outlet manager).
  approvalRequestSchema.parse({
    id: fixedId("a9c00000", 6),
    tenantId: tenant.id,
    outletId: bandung,
    actionType: "refund",
    objectType: "order",
    objectId: orderId,
    payload: { orderNumber, refundMethod: "cash" },
    requestedBy: staff.cashier.id,
    source: "user",
    level: 1,
    requiredLevels: 2,
    amountIdr: 750_000,
    status: "approved",
    requestReason: "Pembayaran ganda dengan nomor referensi berbeda.",
    decidedBy: staff.supervisor.id,
    decidedAt: "2026-11-01T04:10:00.000Z",
    reason: "Bukti transaksi ganda terlihat jelas di mutasi.",
    deadlineAt: "2026-11-01T04:30:00.000Z",
    createdAt: "2026-11-01T03:30:00.000Z",
  }),
  approvalRequestSchema.parse({
    id: fixedId("a9c00000", 7),
    tenantId: tenant.id,
    outletId: bandung,
    actionType: "refund",
    objectType: "order",
    objectId: orderId,
    payload: { orderNumber, refundMethod: "cash" },
    requestedBy: staff.cashier.id,
    source: "user",
    level: 2,
    requiredLevels: 2,
    amountIdr: 750_000,
    status: "rejected",
    requestReason: "Pembayaran ganda dengan nomor referensi berbeda.",
    decidedBy: staff.outletManager.id,
    decidedAt: "2026-11-01T04:25:00.000Z",
    reason:
      "Kembalikan hanya satu transaksi; selisihnya sudah dikembalikan manual.",
    deadlineAt: "2026-11-01T05:11:00.000Z",
    createdAt: "2026-11-01T04:11:00.000Z",
  }),
  // Passed its deadline without a decision: the action stays blocked.
  approvalRequestSchema.parse({
    id: fixedId("a9c00000", 8),
    tenantId: tenant.id,
    outletId: bandung,
    actionType: "stock_adjustment",
    objectType: "stock_item",
    objectId: inventoryItemId,
    payload: {
      stockItemName: "Susu UHT 1L",
      differenceQty: "-4",
      reason: "pecah",
    },
    requestedBy: staff.warehouse.id,
    source: "user",
    level: 1,
    requiredLevels: 1,
    amountIdr: null,
    status: "expired",
    requestReason: "Empat karton pecah saat bongkar muat pagi ini.",
    decidedBy: null,
    decidedAt: null,
    reason: null,
    deadlineAt: "2026-11-01T03:30:00.000Z",
    createdAt: "2026-11-01T02:30:00.000Z",
  }),
];

/**
 * GET /api/access/users rows (legend-i6ff): the people the RBAC assignments
 * reference (the access fixture users, not the identity users above). Active
 * means an assignment valid at NOW; everyone else is inactive.
 */
const accessUsers = Object.values(cafeLegendAccessFixtures.users).map(
  (person) =>
    accessUserSchema.parse({
      userId: person.id,
      displayName: person.displayName,
      kind: "staff",
      status: cafeLegendAccessFixtures.assignments.some(
        (assignment) =>
          assignment.userId === person.id &&
          Date.parse(assignment.validFrom) <= Date.parse(NOW) &&
          (assignment.validUntil === null ||
            assignment.validUntil === undefined ||
            Date.parse(assignment.validUntil) > Date.parse(NOW)),
      )
        ? "active"
        : "inactive",
    }),
);

const currentAuth: CurrentAuthView = currentAuthViewSchema.parse({
  user: usersByKey.cashier,
  identities: identities.filter((row) => row.userId === staff.cashier.id),
  mfaFactors: mfaFactors.filter((row) => row.userId === staff.cashier.id),
  session: sessions.find((row) => row.userId === staff.cashier.id),
  mfaRequired: false,
  mfaEnrollmentRequired: false,
  whatsAppVerified: false,
});

export const cafeLegendIdentityFixtures = {
  tenantId: tenant.id,
  brandId: brand.id,
  outletIds: { bandung },
  /** A clock inside every fixture's validity window. */
  now: new Date(NOW),
  login,
  users,
  usersByKey,
  accessUsers,
  identities,
  loginChallenges,
  loginChallengeIssued,
  mfaFactors,
  loginReplyPolicy,
  staffPins,
  sessions,
  approvalRequests,
  currentAuth,
  /**
   * The accounts a WhatsApp link proves are the same person (PRD §3 F6):
   * Dimas signs in with Ayu's number, so the older account (Dimas, September)
   * survives and Ayu's identity moves (October).
   */
  merge: { survivorId: dimas, duplicateId: ayu },
  // Owned by the access contract (legend-0mc); exported here so one fixture set
  // drives the approval inbox and the RBAC admin screens.
  roles: cafeLegendAccessFixtures.roles,
  roleAssignments: cafeLegendAccessFixtures.assignments,
  approvalPolicies: cafeLegendAccessFixtures.approvalPolicies,
} as const;

export type CafeLegendIdentityFixtures = typeof cafeLegendIdentityFixtures;
