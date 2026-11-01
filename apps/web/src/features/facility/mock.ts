// Mock handlers for the facility endpoints the customer screens call
// (VITE_API_MOCK=true). They serve @starter/shared/facility fixtures and apply
// the contract's own rules — slot ranges (FAC-02), bookable units (FAC-06),
// cancellation policy and subscription quota (FAC-07) — so the screens behave
// like they will against the real API (docs/frontend.md, "Typed endpoints and
// mock mode").
//
// Clock: the demo lives in the facility's morning. `facilityAnchor` is the
// facility's opening time + 20 minutes of its own outlet day (Asia/Jakarta),
// fixed per calendar day so the SSR render and the browser hydration agree on
// every countdown. It is not the device clock: the contract says the ticket
// screen derives its timer from `serverTime` for exactly this reason.
import {
  cafeLegendFacilityFixtures as fx,
  accessTicketSchema,
  accessTicketViewSchema,
  assertNoSlotOverlap,
  cancellationOutcome,
  estimateWaitMinutes,
  facilityAvailabilitySchema,
  facilityQueueEntrySchema,
  facilitySubscriptionSchema,
  slotFromStart,
  subscriptionInvoiceSchema,
  subscriptionQuotaState,
  ticketCredentialWindow,
  ticketHoldsSlot,
  transitionSubscription,
  FacilityError,
  bookAccessTicket,
  cancelAccessTicket,
  getAccessTicket,
  getCurrentFacilityQueueEntry,
  getCurrentFacilitySubscription,
  getFacilityAvailability,
  getFacilityConfig,
  joinFacilityQueue,
  leaveFacilityQueue,
  listAccessTickets,
  listSubscriptionPlans,
  startFacilitySubscription,
  updateFacilitySubscription,
  type AccessTicket,
  type AccessTicketCredential,
  type AccessTicketView,
  type Facility,
  type FacilityAvailability,
  type FacilityQueueEntry,
  type FacilitySubscription,
  type FacilitySubscriptionView,
  type FacilityUnitStatus,
  type SubscriptionInvoice,
} from "@starter/shared/facility";
import {
  cafeLegendIdentityFixtures as idFx,
  cancelLoginChallenge,
  CUSTOMER_SESSION_DAYS,
  formatLoginCode,
  generateLoginCode,
  getLoginChallenge,
  LOGIN_CODE_TTL_MINUTES,
  loginChallengeSchema,
  requestWhatsAppLoginChallenge,
  whatsAppLoginDeepLink,
  type LoginChallenge,
} from "@starter/shared/identity";
import { createUlidFactory } from "@starter/shared/core";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { businessDateInOutletZone } from "./flow.ts";

const MINUTE = 60_000;
const SLOT_STEP_MINUTES = 30;
const SLOTS_PER_DAY = 8;

const { tenant, outlet } = fx;
const ME = fx.ids.customerC1;
const showerFacility = fx.facilities[0];

const nextUlid = createUlidFactory();

/** The mock outlet is in Asia/Jakarta, which has no DST: +07:00 all year. */
const OUTLET_UTC_OFFSET = "+07:00";

function minutesToClock(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60,
  ).padStart(2, "0")}`;
}

function openingMinutes(facility: Facility): number {
  const [hours, minutes] = facility.operatingHours[0].opensAt.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** Opening instant of one business date, in the outlet's fixed offset. */
function dayStartMs(date: string, facility: Facility): number {
  return Date.parse(
    `${date}T${minutesToClock(openingMinutes(facility))}:00${OUTLET_UTC_OFFSET}`,
  );
}

/**
 * The mock's "now": opening time + 20 minutes of the outlet's current business
 * date. Fixed, so two renders of the same day agree (no hydration drift).
 */
function facilityAnchor(facility: Facility): string {
  const date = businessDateInOutletZone(new Date());
  return new Date(dayStartMs(date, facility) + 20 * MINUTE).toISOString();
}

function wrapped<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    // The mock runtime maps ApiError and CoreError to the error envelope; the
    // facility contract's own errors are mapped the way the API maps them.
    if (error instanceof FacilityError)
      throw new ApiError(error.status, error.code, error.message);
    throw error;
  }
}

function facilityById(facilityId: string): Facility {
  const facility = fx.facilities.find((item) => item.id === facilityId);
  if (!facility)
    throw new ApiError(404, "NOT_FOUND", "Fasilitas tidak ditemukan.");
  return facility;
}

// ---- Ticket store -----------------------------------------------------------

/**
 * Seeded tickets of the fixture customer, anchored to the mock morning:
 * one issued ticket starting soon, one in use with four minutes left (the
 * reminder state) and one completed yesterday. Ids stay the fixture ids so the
 * contract fixtures and these rows line up.
 */
function seedTickets(): AccessTicket[] {
  const [ticketA, ticketB, ticketC] = fx.tickets;
  const anchor = facilityAnchor(showerFacility);
  const at = (offsetMinutes: number) =>
    new Date(Date.parse(anchor) + offsetMinutes * MINUTE).toISOString();
  const slot = (startOffset: number) =>
    slotFromStart(at(startOffset), {
      sessionMinutes: showerFacility.sessionMinutes,
      cleaningMinutes: showerFacility.cleaningMinutes,
    });
  return [
    accessTicketSchema.parse({
      ...ticketA,
      slot: slot(60),
      status: "issued",
      firstOpenedAt: null,
      endedAt: null,
      createdAt: at(-10),
    }),
    accessTicketSchema.parse({
      ...ticketB,
      slot: slot(-16),
      status: "in_use",
      firstOpenedAt: at(-15),
      endedAt: null,
      createdAt: at(-20),
    }),
    accessTicketSchema.parse({
      ...ticketC,
      slot: slot(-24 * 60),
      status: "completed",
      firstOpenedAt: at(-24 * 60 + 1),
      endedAt: at(-24 * 60 + 20),
      overtimeMinutes: 0,
      overtimeFeeIdr: 0,
      createdAt: at(-24 * 60 - 10),
    }),
  ];
}

const tickets = createMockStore<AccessTicket[]>(seedTickets);

/** Tickets that still hold their unit's range (FAC-02). */
function holdingTickets(facilityId: string): AccessTicket[] {
  return tickets
    .get()
    .filter(
      (ticket) =>
        ticket.facilityId === facilityId && ticketHoldsSlot(ticket.status),
    );
}

function ticketView(ticket: AccessTicket): AccessTicketView {
  return accessTicketViewSchema.parse({
    ticket,
    credentialWindow: ticketCredentialWindow(ticket),
    session: {
      startedAt: ticket.firstOpenedAt,
      scheduledEndsAt: ticket.slot.endsAt,
      endedAt: ticket.endedAt,
      overtimeMinutes: ticket.overtimeMinutes,
      overtimeFeeIdr: ticket.overtimeFeeIdr,
    },
    serverTime: facilityAnchor(facilityById(ticket.facilityId)),
  });
}

// ---- Availability -----------------------------------------------------------

function unitStatus(facility: Facility, unitId: string): FacilityUnitStatus {
  const unit = fx.units.find((item) => item.id === unitId);
  const base: FacilityUnitStatus = unit?.status ?? "available";
  if (base === "maintenance" || base === "needs_cleaning") return base;
  const busy = holdingTickets(facility.id).some(
    (ticket) => ticket.unitId === unitId && ticket.status === "in_use",
  );
  return busy ? "in_use" : "available";
}

function buildAvailability(
  facility: Facility,
  date: string,
): FacilityAvailability {
  const anchorMs = Date.parse(facilityAnchor(facility));
  const start = dayStartMs(date, facility);
  const holding = holdingTickets(facility.id);
  const grid = Array.from({ length: SLOTS_PER_DAY }, (_, index) =>
    slotFromStart(new Date(start + index * SLOT_STEP_MINUTES * MINUTE), {
      sessionMinutes: facility.sessionMinutes,
      cleaningMinutes: facility.cleaningMinutes,
    }),
  );
  const areas = fx.areas
    .filter((area) => area.facilityId === facility.id)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((area) => ({
      areaId: area.id,
      name: area.name,
      units: fx.units
        .filter(
          (unit) => unit.facilityId === facility.id && unit.areaId === area.id,
        )
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((unit) => {
          const status = unitStatus(facility, unit.id);
          // FAC-06: only a clean, available unit can be booked.
          const bookable = status === "available";
          return {
            unitId: unit.id,
            code: unit.code,
            status,
            bookable,
            slots: grid.map((slot) => ({
              ...slot,
              available:
                bookable &&
                Date.parse(slot.startsAt) > anchorMs &&
                !holding.some(
                  (ticket) =>
                    ticket.unitId === unit.id &&
                    Date.parse(ticket.slot.startsAt) <
                      Date.parse(slot.cleaningEndsAt) &&
                    Date.parse(slot.startsAt) <
                      Date.parse(ticket.slot.cleaningEndsAt),
                ),
            })),
          };
        }),
    }));
  const freeUnitsNow = areas
    .flatMap((area) => area.units)
    .filter((unit) => unit.bookable && unit.status === "available").length;
  const queueLength = queue
    .get()
    .filter(
      (entry) => entry.facilityId === facility.id && entry.status === "waiting",
    ).length;
  return facilityAvailabilitySchema.parse({
    facilityId: facility.id,
    businessDate: date,
    serverTime: new Date(anchorMs).toISOString(),
    areas,
    waitEstimate: {
      queueLength,
      freeUnitsNow,
      // PRD §3 F22 Pemesanan: the estimate is the contract's own arithmetic.
      estimatedWaitMinutes:
        freeUnitsNow > 0
          ? 0
          : estimateWaitMinutes(
              Math.max(1, queueLength),
              facility.sessionMinutes,
              1,
            ),
    },
  });
}

// ---- Wait queue -------------------------------------------------------------

const queue = createMockStore<FacilityQueueEntry[]>(() => []);

function currentQueueEntry(facilityId: string): FacilityQueueEntry | null {
  return (
    queue
      .get()
      .filter(
        (entry) =>
          entry.facilityId === facilityId &&
          (entry.status === "waiting" || entry.status === "notified"),
      )
      .at(-1) ?? null
  );
}

// ---- Subscriptions ----------------------------------------------------------

type SubscriptionState = {
  subscription: FacilitySubscription | null;
  invoices: SubscriptionInvoice[];
};

function seedSubscription(): SubscriptionState {
  const subscription =
    fx.subscriptions.find((item) => item.customerProfileId === ME) ?? null;
  return {
    subscription,
    invoices: subscription
      ? fx.subscriptionInvoices.filter(
          (invoice) => invoice.subscriptionId === subscription.id,
        )
      : [],
  };
}

const subscriptionStore = createMockStore<SubscriptionState>(seedSubscription);

function currentSubscriptionView(): FacilitySubscriptionView | null {
  const { subscription, invoices } = subscriptionStore.get();
  if (!subscription) return null;
  const plan = fx.subscriptionPlans.find(
    (item) => item.id === subscription.planId,
  );
  if (!plan)
    throw new ApiError(404, "NOT_FOUND", "Paket langganan tidak ditemukan.");
  return {
    subscription,
    plan,
    // FAC-07: the reason shown to the guest comes from the contract machine.
    quota: subscriptionQuotaState(subscription, facilityAnchor(showerFacility)),
    invoices,
    serverTime: facilityAnchor(showerFacility),
  };
}

function endOfMonth(date: string): string {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

// ---- Handlers ---------------------------------------------------------------

registerMock(getFacilityAvailability, ({ query, scenario }) => {
  const facility = facilityById(query.facilityId);
  const availability = buildAvailability(facility, query.date);
  if (scenario === "empty")
    return {
      data: {
        ...availability,
        areas: [],
        waitEstimate: {
          queueLength: 0,
          freeUnitsNow: 0,
          estimatedWaitMinutes: 0,
        },
      },
    };
  return {
    data: query.areaId
      ? {
          ...availability,
          areas: availability.areas.filter(
            (area) => area.areaId === query.areaId,
          ),
        }
      : availability,
  };
});

/**
 * Booking replies by idempotency key, like the real API: a retried request
 * with the same key gets the ticket it already issued (and its credential),
 * never a second ticket or a second quota redemption.
 */
type IssuedTicketWire = {
  data: { ticket: AccessTicket; credential: AccessTicketCredential };
};
const bookingReplies = createMockStore<Map<string, IssuedTicketWire>>(
  () => new Map(),
);

/** Opaque, unguessable door token: the lock looks it up, never parses it. */
function mockQrToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Uniform 6-digit PIN from the CSPRNG (rejection sampling, no modulo bias). */
function mockDoorPin(): string {
  const limit = 4_294_000_000; // largest multiple of 10^6 below 2^32
  for (;;) {
    const [value] = crypto.getRandomValues(new Uint32Array(1));
    if (value < limit) return String(value % 1_000_000).padStart(6, "0");
  }
}

registerMock(bookAccessTicket, ({ body }) => {
  const replay = bookingReplies.get().get(body.idempotencyKey);
  if (replay) return replay;
  const facility = facilityById(body.facilityId);
  const area = fx.areas.find(
    (item) => item.id === body.areaId && item.facilityId === facility.id,
  );
  if (!area)
    throw new ApiError(404, "NOT_FOUND", "Area fasilitas tidak ditemukan.");
  const product = fx.products.find(
    (item) => item.id === body.productId && item.facilityId === facility.id,
  );
  if (!product)
    throw new ApiError(404, "NOT_FOUND", "Produk fasilitas tidak ditemukan.");
  if (!product.isActive)
    throw new ApiError(
      409,
      "CONFLICT",
      "Produk ini sedang tidak dijual. Pilih produk lain.",
    );

  const anchor = facilityAnchor(facility);
  const anchorMs = Date.parse(anchor);
  const availability = buildAvailability(
    facility,
    businessDateInOutletZone(anchor),
  );
  const areaView = availability.areas.find((item) => item.areaId === area.id);
  if (!areaView)
    throw new ApiError(404, "NOT_FOUND", "Area fasilitas tidak ditemukan.");

  let unitId: string;
  let slot: AccessTicket["slot"];
  if (body.timing.kind === "now") {
    const candidate = slotFromStart(new Date(anchorMs + MINUTE), {
      sessionMinutes: facility.sessionMinutes,
      cleaningMinutes: facility.cleaningMinutes,
    });
    // Free right now means the whole session fits: a unit with a booking in
    // 20 minutes cannot take a session that ends after it (FAC-02).
    const free = areaView.units.find(
      (unit) =>
        unit.bookable &&
        unit.status === "available" &&
        !holdingTickets(facility.id).some(
          (ticket) =>
            ticket.unitId === unit.unitId &&
            Date.parse(ticket.slot.startsAt) <
              Date.parse(candidate.cleaningEndsAt) &&
            Date.parse(candidate.startsAt) <
              Date.parse(ticket.slot.cleaningEndsAt),
        ),
    );
    if (!free)
      throw new ApiError(
        409,
        "SLOT_UNAVAILABLE",
        "Belum ada bilik kosong. Pilih slot atau masuk antrean.",
      );
    unitId = free.unitId;
    slot = candidate;
  } else {
    const startsAt = body.timing.startsAt;
    const candidates = areaView.units.filter(
      (unit) =>
        unit.bookable &&
        unit.slots.some(
          (option) => option.startsAt === startsAt && option.available,
        ),
    );
    const unit = body.unitId
      ? candidates.find((candidate) => candidate.unitId === body.unitId)
      : candidates[0];
    if (!unit)
      throw new ApiError(
        409,
        "SLOT_UNAVAILABLE",
        "Slot ini sudah terisi. Silakan pilih slot lain.",
      );
    unitId = unit.unitId;
    slot = slotFromStart(startsAt, {
      sessionMinutes: facility.sessionMinutes,
      cleaningMinutes: facility.cleaningMinutes,
    });
  }

  // FAC-02: the same backstop the database exclusion constraint provides.
  wrapped(() =>
    assertNoSlotOverlap(
      slot,
      holdingTickets(facility.id)
        .filter((ticket) => ticket.unitId === unitId)
        .map((ticket) => ticket.slot),
    ),
  );

  let entitlementLedgerId: string | null = null;
  if (body.source === "subscription") {
    const state = subscriptionStore.get();
    const view = currentSubscriptionView();
    // FAC-04/FAC-07: the quota is only usable while the bill is paid or inside
    // its grace period; redeeming decrements it once (FAC-05).
    if (!state.subscription || !view) {
      throw new ApiError(
        403,
        "SUBSCRIPTION_QUOTA_UNAVAILABLE",
        "Langganan fasilitas ini tidak ditemukan. Pilih paket langganan dulu.",
      );
    }
    if (view.subscription.facilityId !== facility.id)
      throw new ApiError(
        403,
        "SUBSCRIPTION_QUOTA_UNAVAILABLE",
        "Langganan ini bukan untuk fasilitas tersebut.",
      );
    if (!view.quota.usable || view.quota.remaining <= 0)
      throw new ApiError(
        403,
        "SUBSCRIPTION_QUOTA_UNAVAILABLE",
        "Kuota langganan belum dapat dipakai. Selesaikan tagihan terlebih dahulu.",
      );
    subscriptionStore.set({
      ...state,
      subscription: {
        ...view.subscription,
        quotaUsed: view.subscription.quotaUsed + 1,
      },
    });
    entitlementLedgerId = crypto.randomUUID();
  }

  const addons = (body.addonIds ?? []).flatMap((addonId) => {
    const addon = fx.addons.find((item) => item.id === addonId);
    if (!addon || !addon.isEnabled) return [];
    return [
      {
        addonId: addon.id,
        name: addon.name,
        priceIdr: addon.priceIdr,
        quantity: 1,
      },
    ];
  });

  const ticket = accessTicketSchema.parse({
    id: nextUlid(),
    tenantId: tenant.id,
    outletId: outlet.id,
    facilityId: facility.id,
    areaId: area.id,
    unitId,
    customerProfileId: ME,
    productId: product.id,
    source: body.source,
    entitlementLedgerId,
    slot,
    graceMinutes: facility.arrivalGraceMinutes,
    addons,
    status: "issued",
    issuedOffline: false,
    firstOpenedAt: null,
    endedAt: null,
    overtimeMinutes: 0,
    overtimeFeeIdr: 0,
    createdAt: anchor,
  });
  tickets.set([...tickets.get(), ticket]);

  // The credential goes out once, here (see schemas.ts); the ticket view never
  // carries it again.
  const window = ticketCredentialWindow(ticket);
  const reply: IssuedTicketWire = {
    data: {
      ticket,
      credential: {
        ticketId: ticket.id,
        facilityId: facility.id,
        areaId: area.id,
        unitId: ticket.unitId,
        qrToken: mockQrToken(),
        pin: mockDoorPin(),
        validFrom: window.validFrom,
        validUntil: window.validUntil,
      },
    },
  };
  bookingReplies.set(
    new Map(bookingReplies.get()).set(body.idempotencyKey, reply),
  );
  return reply;
});

// The catalog read the customer screens use (see api.ts: the customer-facing
// catalog endpoint does not exist yet, so the admin config contract is served
// with the same fixtures).
registerMock(getFacilityConfig, ({ query }) => {
  const facility = facilityById(query.facilityId);
  return {
    data: {
      facility,
      areas: fx.areas.filter((item) => item.facilityId === facility.id),
      units: fx.units.filter((item) => item.facilityId === facility.id),
      products: fx.products.filter((item) => item.facilityId === facility.id),
      addons: fx.addons.filter((item) => item.facilityId === facility.id),
      entitlementRules: fx.entitlementRules.filter(
        (item) => item.facilityId === facility.id,
      ),
      subscriptionPlans: fx.subscriptionPlans.filter(
        (item) => item.facilityId === facility.id,
      ),
      wifiPolicies: fx.wifiPolicies,
    },
  };
});

registerMock(listAccessTickets, ({ scenario, query }) => {
  if (scenario === "empty")
    return { data: [], meta: { limit: query.limit, nextCursor: null } };
  const mine = tickets
    .get()
    .filter((ticket) => ticket.customerProfileId === ME)
    .map(ticketView);
  return { data: mine, meta: { limit: query.limit, nextCursor: null } };
});

registerMock(getAccessTicket, ({ params }) => {
  const ticket = tickets.get().find((item) => item.id === params.ticketId);
  if (!ticket || ticket.customerProfileId !== ME)
    throw new ApiError(404, "NOT_FOUND", "Tiket tidak ditemukan.");
  return { data: ticketView(ticket) };
});

registerMock(cancelAccessTicket, ({ params }) => {
  const ticket = tickets.get().find((item) => item.id === params.ticketId);
  if (!ticket || ticket.customerProfileId !== ME)
    throw new ApiError(404, "NOT_FOUND", "Tiket tidak ditemukan.");
  const facility = facilityById(ticket.facilityId);
  const outcome = wrapped(() =>
    cancellationOutcome(
      facility.cancellationPolicy,
      ticket,
      facilityAnchor(facility),
    ),
  );
  const cancelled = accessTicketSchema.parse({
    ...ticket,
    status: outcome.resolution === "refund_full" ? "refunded" : "cancelled",
  });
  tickets.set(
    tickets.get().map((item) => (item.id === ticket.id ? cancelled : item)),
  );
  return {
    data: {
      ticket: cancelled,
      resolution: outcome.resolution,
      feeIdr: outcome.feeIdr,
    },
  };
});

registerMock(getCurrentFacilityQueueEntry, ({ query, scenario }) => ({
  data: scenario === "empty" ? null : currentQueueEntry(query.facilityId),
}));

registerMock(joinFacilityQueue, ({ body }) => {
  const facility = facilityById(body.facilityId);
  if (currentQueueEntry(facility.id))
    throw new ApiError(
      409,
      "ALREADY_QUEUED",
      "Kamu sudah berada dalam antrean fasilitas ini.",
    );
  const area = fx.areas.find(
    (item) => item.id === body.areaId && item.facilityId === facility.id,
  );
  if (!area)
    throw new ApiError(404, "NOT_FOUND", "Area fasilitas tidak ditemukan.");
  const entry = facilityQueueEntrySchema.parse({
    id: crypto.randomUUID(),
    tenantId: tenant.id,
    outletId: outlet.id,
    facilityId: facility.id,
    areaId: area.id,
    customerProfileId: ME,
    joinedAt: facilityAnchor(facility),
    status: "waiting",
    notifiedAt: null,
  });
  queue.set([...queue.get(), entry]);
  return { data: entry };
});

registerMock(leaveFacilityQueue, ({ params }) => {
  queue.set(queue.get().filter((entry) => entry.id !== params.entryId));
});

registerMock(listSubscriptionPlans, ({ query, scenario }) => {
  const facility = facilityById(query.facilityId);
  const plans = fx.subscriptionPlans.filter(
    (plan) => plan.facilityId === facility.id && plan.isActive,
  );
  return { data: { plans: scenario === "empty" ? [] : plans } };
});

registerMock(getCurrentFacilitySubscription, ({ scenario }) => ({
  data: scenario === "empty" ? null : currentSubscriptionView(),
}));

registerMock(startFacilitySubscription, ({ body }) => {
  const plan = fx.subscriptionPlans.find(
    (item) => item.id === body.planId && item.isActive,
  );
  if (!plan)
    throw new ApiError(404, "NOT_FOUND", "Paket langganan tidak ditemukan.");
  if (subscriptionStore.get().subscription)
    throw new ApiError(
      409,
      "CONFLICT",
      "Kamu sudah punya langganan aktif untuk fasilitas ini.",
    );
  const facility = facilityById(plan.facilityId);
  const startedAt = facilityAnchor(facility);
  const periodStart = businessDateInOutletZone(startedAt);
  const subscription = facilitySubscriptionSchema.parse({
    id: crypto.randomUUID(),
    tenantId: tenant.id,
    outletId: outlet.id,
    facilityId: plan.facilityId,
    customerProfileId: ME,
    planId: plan.id,
    providerSubscriptionId: "DOIT-SUB-MOCK",
    quotaPerPeriod: plan.quotaPerPeriod,
    currentPeriodStart: periodStart,
    currentPeriodEnd: endOfMonth(periodStart),
    quotaUsed: 0,
    graceUntil: null,
    status: "active",
    startedAt,
    cancelledAt: null,
  });
  // The mock recurring-billing provider settles the first invoice at once, the
  // way an approved DOIT payment does (alur U langkah 2).
  const invoice = subscriptionInvoiceSchema.parse({
    id: crypto.randomUUID(),
    tenantId: tenant.id,
    outletId: outlet.id,
    subscriptionId: subscription.id,
    periodStart,
    periodEnd: subscription.currentPeriodEnd,
    amountIdr: plan.priceIdr,
    hostedUrl: null,
    status: "paid",
    paidAt: startedAt,
  });
  subscriptionStore.set({
    subscription,
    invoices: [invoice, ...subscriptionStore.get().invoices],
  });
  return { data: { subscription, invoice } };
});

registerMock(updateFacilitySubscription, ({ params, body }) => {
  const state = subscriptionStore.get();
  const current = state.subscription;
  if (!current || current.id !== params.subscriptionId)
    throw new ApiError(404, "NOT_FOUND", "Langganan tidak ditemukan.");
  const status = wrapped(() =>
    transitionSubscription(current.status, body.action),
  );
  const updated = facilitySubscriptionSchema.parse({
    ...current,
    status,
    cancelledAt: status === "cancelled" ? facilityAnchor(showerFacility) : null,
  });
  subscriptionStore.set({ ...state, subscription: updated });
  return { data: updated };
});

// ---- WhatsApp login (identity contract, AUTH-01/AUTH-03) --------------------
//
// The facility gate is the first customer screen that signs a guest in, so it
// serves the identity endpoints it calls until the customer-login FE bead owns
// them (registerMock replaces, so that bead's handlers win when it lands). The
// mock plays the KirimDev webhook: the guest "sends" the message by waiting,
// and the challenge completes on the second poll from this browser.

type MockChallenge = { challenge: LoginChallenge; polls: number };
const loginChallenges = createMockStore<Map<string, MockChallenge>>(
  () => new Map(),
);
const LOGIN_POLLS_TO_COMPLETE = 2;
/** The fixture customer session (Sari, kind "customer"). */
const customerSession = idFx.sessions.find(
  (session) => session.kind === "customer",
);

function saveChallenge(entry: MockChallenge): void {
  loginChallenges.set(
    new Map(loginChallenges.get()).set(entry.challenge.id, entry),
  );
}

registerMock(requestWhatsAppLoginChallenge, () => {
  const createdAt = new Date();
  const challenge = loginChallengeSchema.parse({
    id: crypto.randomUUID(),
    tenantId: idFx.tenantId,
    brandId: idFx.brandId,
    channel: "whatsapp_inbound",
    status: "pending",
    expiresAt: new Date(
      createdAt.getTime() + LOGIN_CODE_TTL_MINUTES * MINUTE,
    ).toISOString(),
    completedAt: null,
    matchedUserId: null,
    createdAt: createdAt.toISOString(),
  });
  saveChallenge({ challenge, polls: 0 });
  const code = generateLoginCode();
  return {
    data: {
      challenge,
      code,
      codeFormatted: formatLoginCode(code),
      whatsAppDeepLink: whatsAppLoginDeepLink({
        numberDigits: idFx.login.number,
        code,
        keyword: idFx.login.keyword,
      }),
    },
  };
});

registerMock(getLoginChallenge, ({ params }) => {
  const entry = loginChallenges.get().get(params.challengeId);
  if (!entry)
    throw new ApiError(404, "NOT_FOUND", "Permintaan masuk tidak ditemukan.");
  const now = new Date();
  let { challenge } = entry;
  const polls = entry.polls + 1;
  if (challenge.status === "pending") {
    if (now.getTime() >= Date.parse(challenge.expiresAt))
      challenge = { ...challenge, status: "expired" };
    else if (polls >= LOGIN_POLLS_TO_COMPLETE)
      challenge = loginChallengeSchema.parse({
        ...challenge,
        status: "completed",
        completedAt: now.toISOString(),
        matchedUserId: customerSession?.userId ?? null,
      });
  }
  saveChallenge({ challenge, polls });
  const session =
    challenge.status === "completed" && customerSession
      ? {
          ...customerSession,
          createdAt: challenge.completedAt ?? now.toISOString(),
          lastSeenAt: challenge.completedAt ?? now.toISOString(),
          expiresAt: new Date(
            now.getTime() + CUSTOMER_SESSION_DAYS * 24 * 60 * MINUTE,
          ).toISOString(),
        }
      : null;
  return {
    data: {
      challenge,
      session,
      mfaRequired: false,
      mfaEnrollmentRequired: false,
    },
  };
});

registerMock(cancelLoginChallenge, ({ params }) => {
  const entry = loginChallenges.get().get(params.challengeId);
  if (!entry || entry.challenge.status !== "pending") return;
  saveChallenge({
    ...entry,
    challenge: { ...entry.challenge, status: "cancelled" },
  });
});
