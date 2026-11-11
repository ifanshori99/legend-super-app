// Cafe Legend facility fixtures (FE mock mode + contract tests, PRD v1.7 §3
// F22/F23/F39). PRD facts used here: 4 shower booths, 2 in Area Pria and 2 in
// Area Wanita, 20-minute sessions, 10-minute cleaning buffer, 06:00–10:00
// operating hours, Wi-Fi 2 free hours + 1 hour per Rp30.000, 2 devices per
// account, grace period 3 days.
//
// Prices, plan quotas, overtime fees and policy values are illustrative: the
// owner's price list (PRD A19/A23) is still pending, so nothing here may be
// treated as a confirmed rupiah amount except the Wi-Fi spend step, which the
// owner fixed. `facilityFixtureSchema` proves the whole set parses.

import { fixtureTimeAfter } from "../core/fixture-clock.ts";
import { z, encodeCursor } from "../core/index.ts";
import { cafeLegendFixtures } from "../core/index.ts";
import {
  accessEventSchema,
  accessTicketCredentialSchema,
  accessTicketCredentialDigestSchema,
  accessTicketSchema,
  accessTicketViewSchema,
  cleaningTaskSchema,
  entitlementLedgerEntrySchema,
  entitlementRuleSchema,
  facilityAddonSchema,
  facilityAreaSchema,
  facilityAvailabilitySchema,
  facilityConfigSchema,
  facilityIncidentSchema,
  facilityLinkedOrderSchema,
  facilityProductSchema,
  facilityQueueEntrySchema,
  facilitySchema,
  facilitySlotOptionSchema,
  facilitySubscriptionSchema,
  facilitySubscriptionViewSchema,
  facilityUnitBoardRowSchema,
  facilityUnitSchema,
  lockCredentialSchema,
  subscriptionInvoiceSchema,
  subscriptionPlanSchema,
  wifiPolicySchema,
  wifiQuotaViewSchema,
  wifiSessionSchema,
} from "./schemas.ts";
import {
  CLEANING_CHECKLIST_KEYS,
  type AccessTicket,
  type FacilitySlotOption,
} from "./schemas.ts";
import { slotFromStart } from "./slots.ts";

const { tenant, brand, outlets } = cafeLegendFixtures;
const outlet = outlets[0];
const uid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Crockford base32 body + a 2-character suffix, all ULID-legal. */
const ulid = (suffix: string) => `01JBQ7Z8K3M4N5P6Q7R8S9T0${suffix}`;
const digest = (n: number) => n.toString(16).padStart(64, "0");
const scopeFixture = { tenantId: tenant.id, outletId: outlet.id };
/** Config rows of the seed share one version stamp (bead legend-6jms). */
const configStampFixture = { updatedAt: "2026-11-01T00:00:00.000Z" };

const showerFacilityId = uid(9001);
const wfcFacilityId = uid(9002);
const areaPriaId = uid(9011);
const areaWanitaId = uid(9012);
const areaWfcId = uid(9013);
const unitP1 = uid(9101);
const unitP2 = uid(9102);
const unitW1 = uid(9103);
const unitW2 = uid(9104);
const unitS1 = uid(9105);
const unitS2 = uid(9106);
const lockP1 = uid(9201);
const lockP2 = uid(9202);
const lockW1 = uid(9203);
const panicP1 = uid(9301);
const panicW1 = uid(9303);
const menuPackageId = uid(7001);
const inventoryAmenityId = uid(7101);
const taxRuleId = uid(7201);
const staffUserId = uid(8000);
const customerC1 = uid(8101);
const customerC2 = uid(8102);
const customerC3 = uid(8103);
const customerC4 = uid(8104);
const zoneWfcId = uid(9401);
const providerDeviceId = uid(9501);

// Monday 2026-11-02, 06:00 WIB (UTC+7) = 2026-11-01T23:00:00.000Z.
const monday0600 = "2026-11-01T23:00:00.000Z";
const sunday0600 = "2026-10-31T23:00:00.000Z";
const sunday0700 = "2026-11-01T00:00:00.000Z";
const mondayDate = "2026-11-02";

const ticketA = ulid("VW");
const ticketB = ulid("VX");
const ticketC = ulid("VY");
const ticketD = ulid("VZ");
const ticketE = ulid("W0");
const breakfastOrderId = ulid("W1");
const dinnerOrderId = ulid("W2");

// ---- Configuration ----------------------------------------------------------

export const cafeLegendFacilities = [
  facilitySchema.parse({
    id: showerFacilityId,
    ...scopeFixture,
    ...configStampFixture,
    name: "Shower Room Legend",
    type: "shower",
    sessionMinutes: 20,
    cleaningMinutes: 10,
    arrivalGraceMinutes: 10,
    operatingHours: [
      {
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        opensAt: "06:00",
        closesAt: "10:00",
      },
    ],
    overtimePolicy: {
      graceMinutes: 5,
      blockMinutes: 10,
      feePerBlockIdr: 10_000,
    },
    cancellationPolicy: {
      freeCancelMinutesBefore: 60,
      lateCancelResolution: "no_refund",
      lateCancelFeeIdr: 0,
      noShowResolution: "no_refund",
    },
  }),
  facilitySchema.parse({
    id: wfcFacilityId,
    ...scopeFixture,
    ...configStampFixture,
    name: "Zona WFC Legend",
    type: "coworking",
    sessionMinutes: 60,
    cleaningMinutes: 0,
    arrivalGraceMinutes: 15,
    operatingHours: [
      {
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        opensAt: "08:00",
        closesAt: "22:00",
      },
    ],
    overtimePolicy: {
      graceMinutes: 10,
      blockMinutes: 30,
      feePerBlockIdr: 15_000,
    },
    cancellationPolicy: {
      freeCancelMinutesBefore: 120,
      lateCancelResolution: "refund_partial",
      lateCancelFeeIdr: 10_000,
      noShowResolution: "no_refund",
    },
  }),
];

export const cafeLegendFacilityAreas = [
  facilityAreaSchema.parse({
    id: areaPriaId,
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    name: "Area Pria",
    entranceLockDeviceId: uid(9209),
    sortOrder: 0,
  }),
  facilityAreaSchema.parse({
    id: areaWanitaId,
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    name: "Area Wanita",
    entranceLockDeviceId: uid(9210),
    sortOrder: 1,
  }),
  facilityAreaSchema.parse({
    id: areaWfcId,
    ...scopeFixture,
    ...configStampFixture,
    facilityId: wfcFacilityId,
    name: "Zona WFC",
    entranceLockDeviceId: null,
    sortOrder: 0,
  }),
];

export const cafeLegendFacilityUnits = [
  facilityUnitSchema.parse({
    id: unitP1,
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    areaId: areaPriaId,
    code: "P1",
    lockDeviceId: lockP1,
    panicDeviceId: panicP1,
    status: "available",
    sortOrder: 0,
  }),
  facilityUnitSchema.parse({
    id: unitP2,
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    areaId: areaPriaId,
    code: "P2",
    lockDeviceId: lockP2,
    panicDeviceId: uid(9302),
    status: "in_use",
    sortOrder: 1,
  }),
  facilityUnitSchema.parse({
    id: unitW1,
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    areaId: areaWanitaId,
    code: "W1",
    lockDeviceId: lockW1,
    panicDeviceId: panicW1,
    status: "needs_cleaning",
    sortOrder: 0,
  }),
  facilityUnitSchema.parse({
    id: unitW2,
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    areaId: areaWanitaId,
    code: "W2",
    lockDeviceId: uid(9204),
    panicDeviceId: uid(9304),
    status: "maintenance",
    sortOrder: 1,
  }),
  facilityUnitSchema.parse({
    id: unitS1,
    ...scopeFixture,
    ...configStampFixture,
    facilityId: wfcFacilityId,
    areaId: areaWfcId,
    code: "S1",
    lockDeviceId: null,
    panicDeviceId: null,
    status: "available",
    sortOrder: 0,
  }),
  facilityUnitSchema.parse({
    id: unitS2,
    ...scopeFixture,
    ...configStampFixture,
    facilityId: wfcFacilityId,
    areaId: areaWfcId,
    code: "S2",
    lockDeviceId: null,
    panicDeviceId: null,
    status: "available",
    sortOrder: 1,
  }),
];

export const cafeLegendFacilityProducts = [
  facilityProductSchema.parse({
    id: uid(9601),
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    name: "Shower Sekali Pakai",
    type: "single",
    priceIdr: 25_000,
    taxRuleId,
    sessions: 1,
    maxPerDay: null,
    menuItemId: null,
    isActive: true,
  }),
  facilityProductSchema.parse({
    id: uid(9602),
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    name: "Paket Sarapan + Shower",
    type: "package_component",
    priceIdr: 55_000,
    taxRuleId,
    sessions: 1,
    maxPerDay: null,
    menuItemId: menuPackageId,
    isActive: true,
  }),
  facilityProductSchema.parse({
    id: uid(9603),
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    name: "Langganan Shower 10 Sesi",
    type: "subscription_plan",
    priceIdr: 250_000,
    taxRuleId,
    sessions: 10,
    maxPerDay: 1,
    menuItemId: null,
    isActive: true,
  }),
  facilityProductSchema.parse({
    id: uid(9604),
    ...scopeFixture,
    ...configStampFixture,
    facilityId: wfcFacilityId,
    name: "Day Pass WFC",
    type: "single",
    priceIdr: 75_000,
    taxRuleId,
    sessions: 1,
    maxPerDay: 1,
    menuItemId: null,
    isActive: true,
  }),
  facilityProductSchema.parse({
    id: uid(9605),
    ...scopeFixture,
    ...configStampFixture,
    facilityId: wfcFacilityId,
    name: "Reservasi Kursi WFC per Jam",
    type: "single",
    priceIdr: 30_000,
    taxRuleId,
    sessions: 1,
    maxPerDay: 4,
    menuItemId: null,
    isActive: true,
  }),
];

export const cafeLegendFacilityAddons = [
  facilityAddonSchema.parse({
    id: uid(9701),
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    name: "Handuk",
    priceIdr: 10_000,
    inventoryItemId: null,
    isEnabled: true,
    sortOrder: 0,
  }),
  facilityAddonSchema.parse({
    id: uid(9702),
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    name: "Amenities Kit",
    priceIdr: 15_000,
    inventoryItemId: inventoryAmenityId,
    isEnabled: true,
    sortOrder: 1,
  }),
  facilityAddonSchema.parse({
    id: uid(9703),
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    name: "Locker",
    priceIdr: 5_000,
    inventoryItemId: null,
    isEnabled: false,
    sortOrder: 2,
  }),
  facilityAddonSchema.parse({
    id: uid(9704),
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    name: "Hair Dryer",
    priceIdr: 5_000,
    inventoryItemId: null,
    isEnabled: true,
    sortOrder: 3,
  }),
];

const ruleMinSpend = uid(9801);
const ruleTier = uid(9802);
const rulePackage = uid(9803);

export const cafeLegendEntitlementRules = [
  entitlementRuleSchema.parse({
    id: ruleMinSpend,
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    type: "min_spend",
    condition: { minSpendIdr: 50_000 },
    sessions: 1,
    validity: { kind: "operating_day" },
    isEnabled: true,
  }),
  entitlementRuleSchema.parse({
    id: ruleTier,
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    type: "tier_benefit",
    condition: { tierKeys: ["gold", "platinum"] },
    sessions: 2,
    validity: { kind: "billing_period" },
    isEnabled: true,
  }),
  entitlementRuleSchema.parse({
    id: rulePackage,
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    type: "package",
    condition: { menuItemId: menuPackageId },
    sessions: 1,
    validity: { kind: "duration_hours", hours: 24 },
    isEnabled: true,
  }),
];

const planShower10 = uid(9901);
const planShower20 = uid(9902);
const planWfc = uid(9903);

export const cafeLegendSubscriptionPlans = [
  subscriptionPlanSchema.parse({
    id: planShower10,
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    name: "Shower 10 Sesi / Bulan",
    priceIdr: 250_000,
    quotaPerPeriod: 10,
    interval: "month",
    maxPerDay: 1,
    providerPlanId: "SHOWER-10",
    isActive: true,
  }),
  subscriptionPlanSchema.parse({
    id: planShower20,
    ...scopeFixture,
    ...configStampFixture,
    facilityId: showerFacilityId,
    name: "Shower 20 Sesi / Bulan",
    priceIdr: 400_000,
    quotaPerPeriod: 20,
    interval: "month",
    maxPerDay: 1,
    providerPlanId: "SHOWER-20",
    isActive: true,
  }),
  subscriptionPlanSchema.parse({
    id: planWfc,
    ...scopeFixture,
    ...configStampFixture,
    facilityId: wfcFacilityId,
    name: "WFC Bulanan",
    priceIdr: 400_000,
    quotaPerPeriod: 22,
    interval: "month",
    maxPerDay: 1,
    providerPlanId: "WFC-22",
    isActive: true,
  }),
];

// ---- Subscriptions ----------------------------------------------------------

const subscriptionC1 = uid(9911);
const subscriptionC2 = uid(9912);

export const cafeLegendFacilitySubscriptions = [
  facilitySubscriptionSchema.parse({
    id: subscriptionC1,
    ...scopeFixture,
    facilityId: showerFacilityId,
    customerProfileId: customerC1,
    planId: planShower10,
    providerSubscriptionId: "DOIT-SUB-0001",
    quotaPerPeriod: 10,
    currentPeriodStart: "2026-11-01",
    currentPeriodEnd: "2026-11-30",
    quotaUsed: 2,
    graceUntil: null,
    status: "active",
    startedAt: "2026-10-01T02:00:00.000Z",
    cancelledAt: null,
  }),
  facilitySubscriptionSchema.parse({
    id: subscriptionC2,
    ...scopeFixture,
    facilityId: showerFacilityId,
    customerProfileId: customerC2,
    planId: planShower20,
    providerSubscriptionId: "DOIT-SUB-0002",
    quotaPerPeriod: 20,
    currentPeriodStart: "2026-11-01",
    currentPeriodEnd: "2026-11-30",
    quotaUsed: 5,
    // Bill unpaid; still inside the 3-day grace window (FAC-07).
    graceUntil: "2026-11-04T01:00:00.000Z",
    status: "past_due",
    startedAt: "2026-09-01T02:00:00.000Z",
    cancelledAt: null,
  }),
];

export const cafeLegendSubscriptionInvoices = [
  subscriptionInvoiceSchema.parse({
    id: uid(9921),
    ...scopeFixture,
    subscriptionId: subscriptionC1,
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    amountIdr: 250_000,
    hostedUrl: "https://pay.doit.co.id/inv/LEG-SUB-0001",
    status: "paid",
    paidAt: "2026-10-31T10:00:00.000Z",
  }),
  subscriptionInvoiceSchema.parse({
    id: uid(9922),
    ...scopeFixture,
    subscriptionId: subscriptionC2,
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    amountIdr: 400_000,
    hostedUrl: "https://pay.doit.co.id/inv/LEG-SUB-0002",
    status: "pending",
    paidAt: null,
  }),
];

// ---- Entitlement ledger -----------------------------------------------------

const ledgerTierGrant = uid(9931);
const ledgerTierRedeem = uid(9932);
const ledgerSubscriptionGrant = uid(9933);
const ledgerSubscriptionRedeem = uid(9934);
const ledgerMinSpendGrant = uid(9935);
const ledgerMinSpendRedeem = uid(9936);

export const cafeLegendEntitlementLedger = [
  entitlementLedgerEntrySchema.parse({
    id: ledgerTierGrant,
    ...scopeFixture,
    facilityId: showerFacilityId,
    customerProfileId: customerC1,
    type: "grant",
    sessions: 2,
    sourceType: "tier_benefit",
    sourceRef: ruleTier,
    accessTicketId: null,
    expiresAt: fixtureTimeAfter({ days: 29, hours: 17 }),
    occurredAt: "2026-10-31T00:00:00.000Z",
    actorUserId: null,
    reason: "Benefit tier Gold bulan November",
  }),
  entitlementLedgerEntrySchema.parse({
    id: ledgerTierRedeem,
    ...scopeFixture,
    facilityId: showerFacilityId,
    customerProfileId: customerC1,
    type: "redeem",
    sessions: 1,
    sourceType: "tier_benefit",
    sourceRef: ruleTier,
    accessTicketId: ticketC,
    expiresAt: null,
    occurredAt: "2026-10-31T22:50:00.000Z",
    actorUserId: null,
    reason: null,
  }),
  entitlementLedgerEntrySchema.parse({
    id: ledgerSubscriptionGrant,
    ...scopeFixture,
    facilityId: showerFacilityId,
    customerProfileId: customerC1,
    type: "grant",
    sessions: 10,
    sourceType: "subscription",
    sourceRef: subscriptionC1,
    accessTicketId: null,
    expiresAt: fixtureTimeAfter({ days: 29, hours: 17 }),
    occurredAt: "2026-11-01T00:00:00.000Z",
    actorUserId: null,
    reason: "Kuota langganan November",
  }),
  entitlementLedgerEntrySchema.parse({
    id: ledgerSubscriptionRedeem,
    ...scopeFixture,
    facilityId: showerFacilityId,
    customerProfileId: customerC1,
    type: "redeem",
    sessions: 1,
    sourceType: "subscription",
    sourceRef: subscriptionC1,
    accessTicketId: ticketB,
    expiresAt: null,
    occurredAt: "2026-11-01T22:55:00.000Z",
    actorUserId: null,
    reason: null,
  }),
  entitlementLedgerEntrySchema.parse({
    id: ledgerMinSpendGrant,
    ...scopeFixture,
    facilityId: showerFacilityId,
    customerProfileId: customerC2,
    type: "grant",
    sessions: 1,
    sourceType: "min_spend",
    sourceRef: dinnerOrderId,
    accessTicketId: null,
    expiresAt: fixtureTimeAfter({ hours: 3 }),
    occurredAt: "2026-10-31T23:00:00.000Z",
    actorUserId: null,
    reason: "Belanja F&B Rp 120.000 pada hari yang sama",
  }),
  entitlementLedgerEntrySchema.parse({
    id: ledgerMinSpendRedeem,
    ...scopeFixture,
    facilityId: showerFacilityId,
    customerProfileId: customerC2,
    type: "redeem",
    sessions: 1,
    sourceType: "min_spend",
    sourceRef: dinnerOrderId,
    accessTicketId: ticketD,
    expiresAt: null,
    occurredAt: "2026-10-31T23:05:00.000Z",
    actorUserId: null,
    reason: null,
  }),
];

// ---- Tickets, credentials, lock credentials, access log ---------------------

const singleProductId = uid(9601);

const slotA = slotFromStart(monday0600, {
  sessionMinutes: 20,
  cleaningMinutes: 10,
});
const slotB = slotA;
const slotC = slotFromStart(sunday0600, {
  sessionMinutes: 20,
  cleaningMinutes: 10,
});
const slotD = slotC;
const slotE = slotFromStart(sunday0700, {
  sessionMinutes: 20,
  cleaningMinutes: 10,
});

export const cafeLegendAccessTickets: AccessTicket[] = [
  accessTicketSchema.parse({
    id: ticketA,
    ...scopeFixture,
    facilityId: showerFacilityId,
    areaId: areaPriaId,
    unitId: unitP1,
    customerProfileId: customerC1,
    productId: singleProductId,
    source: "purchase",
    entitlementLedgerId: null,
    slot: slotA,
    graceMinutes: 10,
    addons: [
      {
        addonId: uid(9701),
        name: "Handuk",
        priceIdr: 10_000,
        quantity: 1,
      },
    ],
    status: "issued",
    issuedOffline: false,
    firstOpenedAt: null,
    endedAt: null,
    overtimeMinutes: 0,
    overtimeFeeIdr: 0,
    createdAt: "2026-11-01T13:30:00.000Z",
  }),
  accessTicketSchema.parse({
    id: ticketB,
    ...scopeFixture,
    facilityId: showerFacilityId,
    areaId: areaPriaId,
    unitId: unitP2,
    customerProfileId: customerC1,
    productId: uid(9603),
    source: "subscription",
    entitlementLedgerId: ledgerSubscriptionRedeem,
    slot: slotB,
    graceMinutes: 10,
    addons: [],
    status: "in_use",
    issuedOffline: false,
    firstOpenedAt: "2026-11-01T23:01:00.000Z",
    endedAt: null,
    overtimeMinutes: 0,
    overtimeFeeIdr: 0,
    createdAt: "2026-11-01T22:55:00.000Z",
  }),
  accessTicketSchema.parse({
    id: ticketC,
    ...scopeFixture,
    facilityId: showerFacilityId,
    areaId: areaWanitaId,
    unitId: unitW1,
    customerProfileId: customerC1,
    productId: singleProductId,
    source: "tier_benefit",
    entitlementLedgerId: ledgerTierRedeem,
    slot: slotC,
    graceMinutes: 10,
    addons: [],
    status: "completed",
    issuedOffline: false,
    firstOpenedAt: "2026-10-31T23:02:00.000Z",
    endedAt: "2026-10-31T23:28:00.000Z",
    // 8 minutes late, 5 minutes tolerance, 10-minute blocks, Rp10.000 a block.
    overtimeMinutes: 8,
    overtimeFeeIdr: 10_000,
    createdAt: "2026-10-31T22:40:00.000Z",
  }),
  accessTicketSchema.parse({
    id: ticketD,
    ...scopeFixture,
    facilityId: showerFacilityId,
    areaId: areaPriaId,
    unitId: unitP1,
    customerProfileId: customerC2,
    productId: singleProductId,
    source: "min_spend",
    entitlementLedgerId: ledgerMinSpendRedeem,
    slot: slotD,
    graceMinutes: 10,
    addons: [],
    status: "no_show",
    issuedOffline: false,
    firstOpenedAt: null,
    endedAt: null,
    overtimeMinutes: 0,
    overtimeFeeIdr: 0,
    createdAt: "2026-10-31T23:05:00.000Z",
  }),
  accessTicketSchema.parse({
    id: ticketE,
    ...scopeFixture,
    facilityId: showerFacilityId,
    areaId: areaWanitaId,
    unitId: unitW2,
    customerProfileId: customerC3,
    productId: singleProductId,
    source: "purchase",
    entitlementLedgerId: null,
    slot: slotE,
    graceMinutes: 10,
    addons: [],
    status: "cancelled",
    issuedOffline: true,
    firstOpenedAt: null,
    endedAt: null,
    overtimeMinutes: 0,
    overtimeFeeIdr: 0,
    createdAt: "2026-10-31T12:00:00.000Z",
  }),
];

export const cafeLegendAccessTicketCredentialDigests = [
  accessTicketCredentialDigestSchema.parse({
    ticketId: ticketA,
    qrHash: digest(1),
    pinHash: digest(2),
  }),
  accessTicketCredentialDigestSchema.parse({
    ticketId: ticketB,
    qrHash: digest(3),
    pinHash: digest(4),
  }),
];

export const cafeLegendAccessTicketCredentials = [
  accessTicketCredentialSchema.parse({
    ticketId: ticketA,
    facilityId: showerFacilityId,
    areaId: areaPriaId,
    unitId: unitP1,
    qrToken: "LEG-SHOWER-01JBQ7Z8K3M4N5P6Q7R8S9T0VW-A1",
    pin: "482913",
    validFrom: "2026-11-01T22:50:00.000Z",
    validUntil: fixtureTimeAfter({ hours: 23, minutes: 20 }),
  }),
];

export const cafeLegendLockCredentials = [
  lockCredentialSchema.parse({
    id: uid(9941),
    ...scopeFixture,
    accessTicketId: ticketA,
    lockDeviceId: lockP1,
    providerRef: "LOCK-P1-0001",
    validFrom: "2026-11-01T22:50:00.000Z",
    validUntil: fixtureTimeAfter({ hours: 23, minutes: 20 }),
    pushedAt: "2026-11-01T22:44:00.000Z",
    revokedAt: null,
    status: "pushed",
  }),
  lockCredentialSchema.parse({
    id: uid(9942),
    ...scopeFixture,
    accessTicketId: ticketB,
    lockDeviceId: lockP2,
    providerRef: "LOCK-P2-0001",
    validFrom: "2026-11-01T22:50:00.000Z",
    validUntil: fixtureTimeAfter({ hours: 23, minutes: 20 }),
    pushedAt: "2026-11-01T22:45:00.000Z",
    revokedAt: null,
    status: "active",
  }),
];

export const cafeLegendAccessEvents = [
  accessEventSchema.parse({
    id: ulid("X1"),
    ...scopeFixture,
    lockDeviceId: lockP2,
    accessTicketId: ticketB,
    unitId: unitP2,
    type: "unlock",
    occurredAt: "2026-11-01T23:01:00.000Z",
    offline: false,
  }),
  accessEventSchema.parse({
    id: ulid("X2"),
    ...scopeFixture,
    lockDeviceId: lockP1,
    accessTicketId: ticketA,
    unitId: unitP1,
    type: "denied",
    // Arrived before the door window opened at 05:50 WIB.
    occurredAt: "2026-11-01T22:45:00.000Z",
    offline: false,
  }),
  accessEventSchema.parse({
    id: ulid("X3"),
    ...scopeFixture,
    lockDeviceId: lockW1,
    accessTicketId: ticketC,
    unitId: unitW1,
    type: "low_battery",
    occurredAt: "2026-10-31T23:33:00.000Z",
    offline: true,
  }),
];

// ---- Cleaning, incidents, breakfast links, queue ----------------------------

const cleaningTaskW1 = uid(9951);
const cleaningTaskP1 = uid(9952);

function checklist(done: readonly string[]) {
  return CLEANING_CHECKLIST_KEYS.map((key) => ({
    key,
    done: done.includes(key),
    note: null,
  }));
}

export const cafeLegendCleaningTasks = [
  cleaningTaskSchema.parse({
    id: cleaningTaskW1,
    ...scopeFixture,
    facilityId: showerFacilityId,
    unitId: unitW1,
    accessTicketId: ticketC,
    checklist: checklist(["floor", "drain", "supplies"]),
    mediaIds: [],
    assignedTo: staffUserId,
    startedAt: "2026-10-31T23:35:00.000Z",
    completedAt: null,
    createdAt: "2026-10-31T23:30:00.000Z",
  }),
  cleaningTaskSchema.parse({
    id: cleaningTaskP1,
    ...scopeFixture,
    facilityId: showerFacilityId,
    unitId: unitP1,
    accessTicketId: null,
    checklist: checklist(["floor", "drain", "supplies", "trash"]),
    mediaIds: [uid(9961)],
    assignedTo: staffUserId,
    startedAt: "2026-10-31T22:00:00.000Z",
    completedAt: "2026-10-31T22:20:00.000Z",
    createdAt: "2026-10-31T21:55:00.000Z",
  }),
];

export const cafeLegendFacilityIncidents = [
  facilityIncidentSchema.parse({
    id: uid(9971),
    ...scopeFixture,
    facilityId: showerFacilityId,
    unitId: unitW1,
    accessTicketId: ticketC,
    type: "panic",
    triggeredAt: "2026-11-01T23:05:00.000Z",
    offline: false,
    respondedBy: staffUserId,
    // 4 seconds: inside the FAC-08 five-second target.
    respondedAt: "2026-11-01T23:05:04.000Z",
    resolution: "Tamu dibantu dari luar, kondisi aman.",
  }),
  facilityIncidentSchema.parse({
    id: uid(9972),
    ...scopeFixture,
    facilityId: showerFacilityId,
    unitId: unitW2,
    accessTicketId: null,
    type: "damage",
    triggeredAt: "2026-11-01T12:00:00.000Z",
    offline: true,
    respondedBy: null,
    respondedAt: null,
    resolution: null,
  }),
];

export const cafeLegendFacilityLinkedOrders = [
  facilityLinkedOrderSchema.parse({
    id: uid(9981),
    ...scopeFixture,
    facilityId: showerFacilityId,
    accessTicketId: ticketA,
    orderId: breakfastOrderId,
    fireOffsetMinutes: 5,
    fireAt: "2026-11-01T23:15:00.000Z",
    firedAt: null,
  }),
];

export const cafeLegendFacilityQueue = [
  facilityQueueEntrySchema.parse({
    id: uid(9991),
    ...scopeFixture,
    facilityId: showerFacilityId,
    areaId: areaPriaId,
    customerProfileId: customerC3,
    joinedAt: "2026-11-01T22:40:00.000Z",
    status: "waiting",
    notifiedAt: null,
  }),
  facilityQueueEntrySchema.parse({
    id: uid(9992),
    ...scopeFixture,
    facilityId: showerFacilityId,
    areaId: areaWanitaId,
    customerProfileId: customerC4,
    joinedAt: "2026-11-01T22:45:00.000Z",
    status: "waiting",
    notifiedAt: null,
  }),
];

// ---- Wi-Fi and WFC ----------------------------------------------------------

const zoneRegulerId = uid(9402);
const wifiPolicyWfc = uid(9411);
const wifiPolicyReguler = uid(9412);

export const cafeLegendWifiPolicies = [
  wifiPolicySchema.parse({
    id: wifiPolicyWfc,
    ...scopeFixture,
    ...configStampFixture,
    zoneId: zoneWfcId,
    freeMinutes: 120,
    peakFreeMinutes: 60,
    spendPerExtraHourIdr: 30_000,
    extraMinutes: 60,
    maxDevices: 2,
    peakSchedule: [
      { daysOfWeek: [1, 2, 3, 4, 5], startsAt: "11:30", endsAt: "14:00" },
      { daysOfWeek: [1, 2, 3, 4, 5], startsAt: "18:00", endsAt: "21:00" },
      { daysOfWeek: [0, 6], startsAt: "00:00", endsAt: "24:00" },
    ],
    baseSpeedKbps: 5_000,
    fullSpeedKbps: 20_000,
    minSpendPerHourIdr: 30_000,
    tierBonusMinutes: { gold: 60, platinum: 120 },
  }),
  wifiPolicySchema.parse({
    id: wifiPolicyReguler,
    ...scopeFixture,
    ...configStampFixture,
    zoneId: zoneRegulerId,
    freeMinutes: 120,
    peakFreeMinutes: 60,
    spendPerExtraHourIdr: 30_000,
    extraMinutes: 60,
    maxDevices: 2,
    peakSchedule: [
      { daysOfWeek: [1, 2, 3, 4, 5], startsAt: "11:30", endsAt: "14:00" },
      { daysOfWeek: [1, 2, 3, 4, 5], startsAt: "18:00", endsAt: "21:00" },
    ],
    baseSpeedKbps: 5_000,
    fullSpeedKbps: 20_000,
    minSpendPerHourIdr: null,
    tierBonusMinutes: { gold: 60, platinum: 120 },
  }),
];

export const cafeLegendWifiSessions = [
  wifiSessionSchema.parse({
    id: uid(9421),
    ...scopeFixture,
    customerProfileId: customerC1,
    zoneId: zoneWfcId,
    policyId: wifiPolicyWfc,
    deviceHash: digest(11),
    // 2 free hours + 3 hours from Rp90.000 of paid spend.
    quotaMinutes: 300,
    usedMinutes: 45,
    speedTier: "full",
    startedAt: "2026-11-01T23:10:00.000Z",
    endedAt: null,
  }),
  wifiSessionSchema.parse({
    id: uid(9422),
    ...scopeFixture,
    customerProfileId: customerC2,
    zoneId: zoneWfcId,
    policyId: wifiPolicyWfc,
    deviceHash: digest(12),
    quotaMinutes: 120,
    usedMinutes: 135,
    // Throttled, still connected (FAC-13).
    speedTier: "base",
    startedAt: "2026-11-01T22:00:00.000Z",
    endedAt: null,
  }),
  wifiSessionSchema.parse({
    id: uid(9423),
    ...scopeFixture,
    customerProfileId: customerC3,
    zoneId: zoneRegulerId,
    policyId: wifiPolicyReguler,
    deviceHash: digest(13),
    quotaMinutes: 120,
    usedMinutes: 90,
    speedTier: "full",
    startedAt: "2026-11-01T12:00:00.000Z",
    endedAt: "2026-11-01T13:30:00.000Z",
  }),
];

// ---- Read models ------------------------------------------------------------

/** Eight half-hour slots from 06:00 to 09:30 WIB on the fixture Monday. */
function mondaySlots(takenStarts: readonly string[]): FacilitySlotOption[] {
  return Array.from({ length: 8 }, (_, index) => {
    const slot = slotFromStart(
      new Date(Date.parse(monday0600) + index * 30 * 60_000),
      { sessionMinutes: 20, cleaningMinutes: 10 },
    );
    return facilitySlotOptionSchema.parse({
      ...slot,
      available: !takenStarts.includes(slot.startsAt),
    });
  });
}

export const cafeLegendFacilityAvailability = facilityAvailabilitySchema.parse({
  facilityId: showerFacilityId,
  businessDate: mondayDate,
  serverTime: "2026-11-01T22:55:00.000Z",
  areas: [
    {
      areaId: areaPriaId,
      name: "Area Pria",
      units: [
        {
          unitId: unitP1,
          code: "P1",
          status: "available",
          bookable: true,
          slots: mondaySlots([monday0600]),
        },
        {
          unitId: unitP2,
          code: "P2",
          status: "in_use",
          bookable: true,
          slots: mondaySlots([monday0600]),
        },
      ],
    },
    {
      areaId: areaWanitaId,
      name: "Area Wanita",
      units: [
        {
          unitId: unitW1,
          code: "W1",
          status: "needs_cleaning",
          bookable: false,
          slots: mondaySlots([]).map((slot) => ({
            ...slot,
            available: false,
          })),
        },
        {
          unitId: unitW2,
          code: "W2",
          status: "maintenance",
          bookable: false,
          slots: mondaySlots([]).map((slot) => ({
            ...slot,
            available: false,
          })),
        },
      ],
    },
  ],
  waitEstimate: {
    queueLength: 2,
    freeUnitsNow: 0,
    estimatedWaitMinutes: 20,
  },
});

export const cafeLegendFacilityUnitBoard = [
  facilityUnitBoardRowSchema.parse({
    unit: cafeLegendFacilityUnits[0],
    currentTicket: null,
    cleaningTask: null,
  }),
  facilityUnitBoardRowSchema.parse({
    unit: cafeLegendFacilityUnits[1],
    currentTicket: {
      ticketId: ticketB,
      startedAt: "2026-11-01T23:01:00.000Z",
      scheduledEndsAt: "2026-11-01T23:20:00.000Z",
    },
    cleaningTask: null,
  }),
  facilityUnitBoardRowSchema.parse({
    unit: cafeLegendFacilityUnits[2],
    currentTicket: null,
    cleaningTask: cafeLegendCleaningTasks[0],
  }),
  facilityUnitBoardRowSchema.parse({
    unit: cafeLegendFacilityUnits[3],
    currentTicket: null,
    cleaningTask: null,
  }),
];

export const cafeLegendAccessTicketView = accessTicketViewSchema.parse({
  ticket: cafeLegendAccessTickets[0],
  credentialWindow: {
    validFrom: "2026-11-01T22:50:00.000Z",
    validUntil: fixtureTimeAfter({ hours: 23, minutes: 20 }),
  },
  session: {
    startedAt: null,
    scheduledEndsAt: "2026-11-01T23:20:00.000Z",
    endedAt: null,
    overtimeMinutes: 0,
    overtimeFeeIdr: 0,
  },
  serverTime: "2026-11-01T22:55:00.000Z",
});

export const cafeLegendFacilityConfig = facilityConfigSchema.parse({
  facility: cafeLegendFacilities[0],
  areas: cafeLegendFacilityAreas.slice(0, 2),
  units: cafeLegendFacilityUnits.slice(0, 4),
  products: cafeLegendFacilityProducts.slice(0, 3),
  addons: cafeLegendFacilityAddons,
  entitlementRules: cafeLegendEntitlementRules,
  subscriptionPlans: cafeLegendSubscriptionPlans.slice(0, 2),
  wifiPolicies: [cafeLegendWifiPolicies[0]],
});

export const cafeLegendWifiQuotaView = wifiQuotaViewSchema.parse({
  session: cafeLegendWifiSessions[0],
  policy: cafeLegendWifiPolicies[0],
  remainingMinutes: 255,
  serverTime: "2026-11-01T23:15:00.000Z",
});

export const cafeLegendFacilitySubscriptionView =
  facilitySubscriptionViewSchema.parse({
    subscription: cafeLegendFacilitySubscriptions[0],
    plan: cafeLegendSubscriptionPlans[0],
    quota: {
      perPeriod: 10,
      used: 2,
      remaining: 8,
      usable: true,
      reason: "ok",
    },
    invoices: [cafeLegendSubscriptionInvoices[0]],
    serverTime: "2026-11-01T22:55:00.000Z",
  });

/** One event payload per catalogued WS-09 event, for the envelope test. */
export const facilityEventSamples: Record<string, Record<string, unknown>> = {
  "access_ticket.issued": {
    ticketId: ticketA,
    facilityId: showerFacilityId,
    areaId: areaPriaId,
    unitId: unitP1,
    customerProfileId: customerC1,
    productId: singleProductId,
    source: "purchase",
    startsAt: "2026-11-01T23:00:00.000Z",
    endsAt: "2026-11-01T23:20:00.000Z",
    issuedOffline: false,
  },
  "access_ticket.redeemed": {
    ticketId: ticketB,
    unitId: unitP2,
    areaId: areaPriaId,
    openedAt: "2026-11-01T23:01:00.000Z",
  },
  "access_event.recorded": {
    accessEventId: ulid("X1"),
    lockDeviceId: lockP2,
    accessTicketId: ticketB,
    unitId: unitP2,
    type: "unlock",
    occurredAt: "2026-11-01T23:01:00.000Z",
    offline: false,
  },
  "facility_session.started": {
    ticketId: ticketB,
    unitId: unitP2,
    startedAt: "2026-11-01T23:01:00.000Z",
  },
  "facility_session.ended": {
    ticketId: ticketC,
    unitId: unitW1,
    startedAt: "2026-10-31T23:02:00.000Z",
    endedAt: "2026-10-31T23:28:00.000Z",
    overtimeMinutes: 8,
    overtimeFeeIdr: 10_000,
  },
  "cleaning_task.created": {
    cleaningTaskId: cleaningTaskW1,
    facilityId: showerFacilityId,
    unitId: unitW1,
    accessTicketId: ticketC,
    createdAt: "2026-10-31T23:30:00.000Z",
  },
  "facility_entitlement.issued": {
    entitlementLedgerId: ledgerTierGrant,
    customerProfileId: customerC1,
    facilityId: showerFacilityId,
    sourceType: "tier_benefit",
    sourceRef: ruleTier,
    sessions: 2,
    expiresAt: fixtureTimeAfter({ days: 29, hours: 17 }),
  },
  "facility_entitlement.expired": {
    entitlementLedgerId: ledgerTierGrant,
    customerProfileId: customerC1,
    facilityId: showerFacilityId,
    sessions: 2,
    expiredAt: "2026-12-01T00:00:00.000Z",
  },
  "facility_entitlement.revoked": {
    entitlementLedgerId: ledgerTierGrant,
    customerProfileId: customerC1,
    facilityId: showerFacilityId,
    sourceType: "tier_benefit",
    sourceRef: ruleTier,
    sessions: 1,
    reason: "Transaksi sumber di-refund",
    revokedAt: "2026-11-02T01:00:00.000Z",
  },
  "subscription.billed": {
    subscriptionId: subscriptionC2,
    invoiceId: uid(9922),
    planId: planShower20,
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    amountIdr: 400_000,
    dueAt: "2026-11-01T01:00:00.000Z",
  },
  "wifi_quota.updated": {
    customerProfileId: customerC1,
    sessionId: uid(9421),
    zoneId: zoneWfcId,
    quotaMinutes: 300,
    usedMinutes: 45,
    speedTier: "full",
    reason: "spend",
  },
  "facility_incident.raised": {
    incidentId: uid(9971),
    facilityId: showerFacilityId,
    unitId: unitW1,
    type: "panic",
    triggeredAt: "2026-11-01T23:05:00.000Z",
    offline: false,
  },
};

/** One cursor page of tickets, for list screens and the mock runtime. */
export const cafeLegendAccessTicketPage = {
  data: [cafeLegendAccessTicketView],
  meta: { limit: 25, nextCursor: encodeCursor([monday0600, ticketA]) },
};

/** Everything, bundled for the FE mock mode handlers. */
export const cafeLegendFacilityFixtures = {
  tenant,
  brand,
  outlet,
  providerDeviceId,
  facilities: cafeLegendFacilities,
  areas: cafeLegendFacilityAreas,
  units: cafeLegendFacilityUnits,
  products: cafeLegendFacilityProducts,
  addons: cafeLegendFacilityAddons,
  entitlementRules: cafeLegendEntitlementRules,
  subscriptionPlans: cafeLegendSubscriptionPlans,
  subscriptions: cafeLegendFacilitySubscriptions,
  subscriptionInvoices: cafeLegendSubscriptionInvoices,
  entitlementLedger: cafeLegendEntitlementLedger,
  tickets: cafeLegendAccessTickets,
  credentials: cafeLegendAccessTicketCredentials,
  credentialDigests: cafeLegendAccessTicketCredentialDigests,
  lockCredentials: cafeLegendLockCredentials,
  accessEvents: cafeLegendAccessEvents,
  cleaningTasks: cafeLegendCleaningTasks,
  incidents: cafeLegendFacilityIncidents,
  linkedOrders: cafeLegendFacilityLinkedOrders,
  queue: cafeLegendFacilityQueue,
  wifiPolicies: cafeLegendWifiPolicies,
  wifiSessions: cafeLegendWifiSessions,
  availability: cafeLegendFacilityAvailability,
  unitBoard: cafeLegendFacilityUnitBoard,
  ticketView: cafeLegendAccessTicketView,
  ticketPage: cafeLegendAccessTicketPage,
  config: cafeLegendFacilityConfig,
  wifiQuotaView: cafeLegendWifiQuotaView,
  subscriptionView: cafeLegendFacilitySubscriptionView,
  eventSamples: facilityEventSamples,
  ids: {
    showerFacilityId,
    wfcFacilityId,
    areaPriaId,
    areaWanitaId,
    unitP1,
    unitP2,
    unitW1,
    unitW2,
    customerC1,
    customerC2,
    customerC3,
    customerC4,
    staffUserId,
    zoneWfcId,
    wifiPolicyWfc,
    ticketA,
    ticketB,
    ticketC,
    ticketD,
    ticketE,
    subscriptionC1,
    ledgerTierGrant,
    ledgerSubscriptionRedeem,
    ledgerMinSpendGrant,
  },
};

/** Container schema: the fixture test parses this in one call. */
export const facilityFixtureSchema = z.strictObject({
  tenant: z.object({ id: z.string() }),
  brand: z.object({ id: z.string() }),
  outlet: z.object({ id: z.string() }),
  providerDeviceId: z.string(),
  facilities: z.array(facilitySchema).min(1),
  areas: z.array(facilityAreaSchema).min(1),
  units: z.array(facilityUnitSchema).min(1),
  products: z.array(facilityProductSchema).min(1),
  addons: z.array(facilityAddonSchema).min(1),
  entitlementRules: z.array(entitlementRuleSchema).min(1),
  subscriptionPlans: z.array(subscriptionPlanSchema).min(1),
  subscriptions: z.array(facilitySubscriptionSchema).min(1),
  subscriptionInvoices: z.array(subscriptionInvoiceSchema).min(1),
  entitlementLedger: z.array(entitlementLedgerEntrySchema).min(1),
  tickets: z.array(accessTicketSchema).min(1),
  credentials: z.array(accessTicketCredentialSchema).min(1),
  credentialDigests: z.array(accessTicketCredentialDigestSchema).min(1),
  lockCredentials: z.array(lockCredentialSchema).min(1),
  accessEvents: z.array(accessEventSchema).min(1),
  cleaningTasks: z.array(cleaningTaskSchema).min(1),
  incidents: z.array(facilityIncidentSchema).min(1),
  linkedOrders: z.array(facilityLinkedOrderSchema).min(1),
  queue: z.array(facilityQueueEntrySchema).min(1),
  wifiPolicies: z.array(wifiPolicySchema).min(1),
  wifiSessions: z.array(wifiSessionSchema).min(1),
  availability: facilityAvailabilitySchema,
  unitBoard: z.array(facilityUnitBoardRowSchema).min(1),
  ticketView: accessTicketViewSchema,
  ticketPage: z.object({
    data: z.array(accessTicketViewSchema),
    meta: z.object({ limit: z.number(), nextCursor: z.string().nullable() }),
  }),
  config: facilityConfigSchema,
  wifiQuotaView: wifiQuotaViewSchema,
  subscriptionView: facilitySubscriptionViewSchema,
  eventSamples: z.record(z.string(), z.record(z.string(), z.unknown())),
  ids: z.record(z.string(), z.string()),
});
