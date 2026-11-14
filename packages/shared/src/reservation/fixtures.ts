// Cafe Legend reservation, waitlist and event pre-order fixtures: the outlet
// policies (regular zone and private room), a week of reservations in every
// state, their table slots, today's waitlist, two event packages and the
// matching pre-orders, plus one availability answer for the website form.
//
// Menu items and prices come from `cafeLegendMenuFixtures` and zones/tables
// from `cafeLegendQrOrderFixtures`, so ids stay consistent across contracts.
// The seated fixture points at the open A03 table session of the QR fixtures;
// customer profiles come from the CRM fixtures. Sample data, not the owner's
// confirmed policy or prices.
//
// Instants are ISO 8601 with offset. `reservedFor` uses WIB (+07:00), the
// fixture outlet time zone; slot ends are computed with the same helper the
// service uses so back-to-back slots share one convention.

import { cafeLegendFixtures, idr, z } from "../core/index.ts";
import { cafeLegendMenuFixtures } from "../menu/index.ts";
import { cafeLegendQrOrderFixtures } from "../qr-order/fixtures.ts";
import { cafeLegendCrmFixtures } from "../crm/index.ts";
import { reservationEndsAt } from "./machines.ts";
import { reservationEventSchema } from "./events.ts";
import {
  reservationAvailabilitySchema,
  reservationPackageSchema,
  reservationPolicySnapshotSchema,
  reservationPreOrderSchema,
  reservationSchema,
  reservationTableSlotSchema,
  waitlistEntrySchema,
} from "./schemas.ts";
import type {
  ReservationPackage,
  ReservationPolicySnapshot,
  ReservationPreOrder,
  Reservation,
  ReservationTableSlot,
  WaitlistEntry,
} from "./schemas.ts";

const { tenant, outlets } = cafeLegendFixtures;
const outlet = outlets[0];
const scope = { tenantId: tenant.id, outletId: outlet.id };
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const menuItem = (name: string) => {
  const item = cafeLegendMenuFixtures.items.find(
    (entry) => entry.name === name,
  );
  if (!item) throw new RangeError(`Unknown menu fixture item: ${name}`);
  return item;
};

const zoneOf = (name: string) => {
  const zone = cafeLegendQrOrderFixtures.zones.find(
    (entry) => entry.name === name,
  );
  if (!zone) throw new RangeError(`Unknown zone fixture: ${name}`);
  return zone;
};
const tableOf = (code: string) => {
  const table = cafeLegendQrOrderFixtures.tables.find(
    (entry) => entry.code === code,
  );
  if (!table) throw new RangeError(`Unknown table fixture: ${code}`);
  return table;
};

const indoor = zoneOf("Indoor Reguler");
const privateRoom = zoneOf("Private Room Nusantara");
const captureAt = "2026-10-28T02:00:00.000Z";

/** Regular zone: Rp50.000 DP, free cancellation until 24 h before. */
const regularPolicy: ReservationPolicySnapshot =
  reservationPolicySnapshotSchema.parse({
    version: "2026-11.1",
    depositRequirement: "required",
    depositAmountIdr: idr(50_000),
    paymentWindowMinutes: 30,
    freeCancellationHours: 24,
    lateCancellationRefundBp: 5_000,
    noShowRefundBp: 0,
    minimumSpendIdr: idr(0),
    capturedAt: captureAt,
  });

/** Private room: Rp100.000 DP, 48 h window and a Rp500.000 minimum spend. */
const privateRoomPolicy: ReservationPolicySnapshot =
  reservationPolicySnapshotSchema.parse({
    version: "2026-11.1",
    depositRequirement: "required",
    depositAmountIdr: idr(100_000),
    paymentWindowMinutes: 30,
    freeCancellationHours: 48,
    lateCancellationRefundBp: 0,
    noShowRefundBp: 0,
    minimumSpendIdr: idr(500_000),
    capturedAt: captureAt,
  });

/** Walk-ins and small parties without a DP. */
const noDepositPolicy: ReservationPolicySnapshot =
  reservationPolicySnapshotSchema.parse({
    version: "2026-11.1",
    depositRequirement: "none",
    depositAmountIdr: idr(0),
    paymentWindowMinutes: 30,
    freeCancellationHours: 24,
    lateCancellationRefundBp: 0,
    noShowRefundBp: 0,
    minimumSpendIdr: idr(0),
    capturedAt: captureAt,
  });

// Opaque fixture digests; the real hash is SHA-256 of the normalized number.
const contactHash =
  "9f2c0b3a4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8";
const memberProfileId = cafeLegendCrmFixtures.profiles[0].id;
const staffUserId = cafeLegendCrmFixtures.staffUserId;
const pendingPaymentId = id(6_001);
const paidPaymentId = id(6_002);

const slot = (
  n: number,
  reservation: Pick<
    Reservation,
    "id" | "reservedFor" | "durationMinutes" | "tableIds"
  >,
  releasedAt: string | null = null,
): ReservationTableSlot =>
  reservationTableSlotSchema.parse({
    id: id(n),
    ...scope,
    reservationId: reservation.id,
    tableId: reservation.tableIds[0],
    startsAt: reservation.reservedFor,
    endsAt: reservationEndsAt(
      reservation.reservedFor,
      reservation.durationMinutes,
    ),
    releasedAt,
  });

const reservations: Reservation[] = [
  // Guest booked on the website; the DP link is open.
  reservationSchema.parse({
    id: id(5_001),
    ...scope,
    customerProfileId: null,
    guestName: "Dewi Lestari",
    contactHash,
    reservedFor: "2026-11-07T19:00:00+07:00",
    durationMinutes: 90,
    pax: 2,
    zoneId: indoor.id,
    tableIds: [],
    depositIdr: 50_000,
    depositPaymentId: pendingPaymentId,
    depositStatus: "pending",
    policy: regularPolicy,
    status: "pending_deposit",
    note: "Meja dekat jendela bila tersedia.",
    source: "website",
    seatedAt: null,
    completedAt: null,
    closedAt: null,
    closeReason: null,
    tableSessionId: null,
    createdAt: "2026-11-01T03:12:00.000Z",
    updatedAt: "2026-11-01T03:12:00.000Z",
  }),
  // Member's private-room dinner; DP paid, table P1 reserved, pre-order attached.
  reservationSchema.parse({
    id: id(5_002),
    ...scope,
    customerProfileId: memberProfileId,
    guestName: "Rangga Pratama",
    contactHash,
    reservedFor: "2026-11-07T19:30:00+07:00",
    durationMinutes: 120,
    pax: 8,
    zoneId: privateRoom.id,
    tableIds: [tableOf("P1").id],
    depositIdr: 100_000,
    depositPaymentId: paidPaymentId,
    depositStatus: "paid",
    policy: privateRoomPolicy,
    status: "confirmed",
    note: "Ulang tahun; minta kue di akhir.",
    source: "whatsapp",
    seatedAt: null,
    completedAt: null,
    closedAt: null,
    closeReason: null,
    tableSessionId: null,
    createdAt: "2026-10-29T08:40:00.000Z",
    updatedAt: "2026-10-29T09:05:00.000Z",
  }),
  // Seated now on A03; the QR order session 401 is open for this party.
  reservationSchema.parse({
    id: id(5_003),
    ...scope,
    customerProfileId: null,
    guestName: "Sari Wulandari",
    contactHash,
    reservedFor: "2026-11-01T11:30:00+07:00",
    durationMinutes: 90,
    pax: 4,
    zoneId: indoor.id,
    tableIds: [tableOf("A03").id],
    depositIdr: 50_000,
    depositPaymentId: paidPaymentId,
    depositStatus: "paid",
    policy: regularPolicy,
    status: "seated",
    note: null,
    source: "staff",
    seatedAt: "2026-11-01T04:35:00.000Z",
    completedAt: null,
    closedAt: null,
    closeReason: null,
    tableSessionId: cafeLegendQrOrderFixtures.sessions[0].id,
    createdAt: "2026-10-31T02:15:00.000Z",
    updatedAt: "2026-11-01T04:35:00.000Z",
  }),
  // Finished lunch service.
  reservationSchema.parse({
    id: id(5_004),
    ...scope,
    customerProfileId: null,
    guestName: "Bayu Anggara",
    contactHash,
    reservedFor: "2026-11-01T09:00:00+07:00",
    durationMinutes: 90,
    pax: 2,
    zoneId: indoor.id,
    tableIds: [tableOf("A05").id],
    depositIdr: 0,
    depositPaymentId: null,
    depositStatus: null,
    policy: noDepositPolicy,
    status: "completed",
    note: null,
    source: "website",
    seatedAt: "2026-11-01T02:00:00.000Z",
    completedAt: "2026-11-01T03:00:00.000Z",
    closedAt: null,
    closeReason: null,
    tableSessionId: cafeLegendQrOrderFixtures.sessions[3].id,
    createdAt: "2026-10-30T06:00:00.000Z",
    updatedAt: "2026-11-01T03:00:00.000Z",
  }),
  // Cancelled three hours out: inside the 24 h window, so half of the DP is
  // refunded under the snapshot in force at booking (RSV-03).
  reservationSchema.parse({
    id: id(5_005),
    ...scope,
    customerProfileId: null,
    guestName: "Intan Permata",
    contactHash,
    reservedFor: "2026-11-08T12:00:00+07:00",
    durationMinutes: 90,
    pax: 2,
    zoneId: indoor.id,
    tableIds: [tableOf("A01").id],
    depositIdr: 50_000,
    depositPaymentId: paidPaymentId,
    depositStatus: "paid",
    policy: regularPolicy,
    status: "cancelled",
    note: null,
    source: "website",
    seatedAt: null,
    completedAt: null,
    closedAt: "2026-11-08T03:00:00.000Z",
    closeReason: "Rencana berubah.",
    tableSessionId: null,
    createdAt: "2026-11-02T01:10:00.000Z",
    updatedAt: "2026-11-07T03:00:00.000Z",
  }),
  // No-show: the DP is forfeited (noShowRefundBp = 0).
  reservationSchema.parse({
    id: id(5_006),
    ...scope,
    customerProfileId: null,
    guestName: "Fajar Nugroho",
    contactHash,
    reservedFor: "2026-11-01T15:00:00+07:00",
    durationMinutes: 90,
    pax: 5,
    zoneId: indoor.id,
    tableIds: [tableOf("B01").id],
    depositIdr: 50_000,
    depositPaymentId: paidPaymentId,
    depositStatus: "paid",
    policy: regularPolicy,
    status: "no_show",
    note: null,
    source: "staff",
    seatedAt: null,
    completedAt: null,
    closedAt: "2026-11-01T08:45:00.000Z",
    closeReason: "Tamu tidak datang dalam 45 menit.",
    tableSessionId: null,
    createdAt: "2026-10-31T03:30:00.000Z",
    updatedAt: "2026-11-01T08:45:00.000Z",
  }),
];

const tableSlots: ReservationTableSlot[] = [
  slot(5_102, reservations[1]),
  slot(5_103, reservations[2]),
  slot(5_104, reservations[3]),
  // The cancelled reservation keeps its history but no longer blocks the table.
  slot(5_105, reservations[4], "2026-11-08T03:00:00.000Z"),
  slot(5_106, reservations[5]),
];

const waitlist: WaitlistEntry[] = [
  {
    id: id(5_201),
    ...scope,
    name: "Ayu Kusuma",
    pax: 2,
    contactHash,
    zoneId: indoor.id,
    status: "waiting",
    joinedAt: "2026-11-01T05:10:00.000Z",
    calledAt: null,
    seatedAt: null,
    leftAt: null,
    estimatedWaitMinutes: 20,
  },
  {
    id: id(5_202),
    ...scope,
    name: "Hendra Wijaya",
    pax: 4,
    contactHash,
    zoneId: null,
    status: "called",
    joinedAt: "2026-11-01T04:55:00.000Z",
    calledAt: "2026-11-01T05:20:00.000Z",
    seatedAt: null,
    leftAt: null,
    estimatedWaitMinutes: 5,
  },
  {
    id: id(5_203),
    ...scope,
    name: "Maya Sari",
    pax: 3,
    contactHash,
    zoneId: indoor.id,
    status: "seated",
    joinedAt: "2026-11-01T04:20:00.000Z",
    calledAt: "2026-11-01T04:55:00.000Z",
    seatedAt: "2026-11-01T05:02:00.000Z",
    leftAt: null,
    estimatedWaitMinutes: null,
  },
  {
    id: id(5_204),
    ...scope,
    name: "Rizky Ramadhan",
    pax: 2,
    contactHash,
    zoneId: null,
    status: "left",
    joinedAt: "2026-11-01T03:40:00.000Z",
    calledAt: "2026-11-01T04:05:00.000Z",
    seatedAt: null,
    leftAt: "2026-11-01T04:18:00.000Z",
    estimatedWaitMinutes: null,
  },
].map((entry) => waitlistEntrySchema.parse(entry));

const packages: ReservationPackage[] = [
  reservationPackageSchema.parse({
    id: id(5_301),
    ...scope,
    name: "Paket Kopi & Pastry Rombongan",
    description:
      "Satu minuman kopi pilihan dan satu pastry untuk setiap tamu, cocok untuk arisan dan kunjungan komunitas.",
    minPax: 6,
    maxPax: 40,
    pricePerPaxIdr: 85_000,
    items: [
      { menuItemId: menuItem("Kopi Susu Aren").id, quantity: 1 },
      { menuItemId: menuItem("Croissant Mentega").id, quantity: 1 },
    ],
    leadTimeHours: 24,
    status: "active",
    sortOrder: 0,
  }),
  reservationPackageSchema.parse({
    id: id(5_302),
    ...scope,
    name: "Paket Makan Malam Keluarga",
    description:
      "Menu utama, minuman, dan hidangan penutup untuk perayaan keluarga di private room.",
    minPax: 4,
    maxPax: 20,
    pricePerPaxIdr: 135_000,
    items: [
      { menuItemId: menuItem("Nasi Goreng Kampung").id, quantity: 1 },
      { menuItemId: menuItem("Teh Tarik").id, quantity: 1 },
      { menuItemId: menuItem("Banana Bread").id, quantity: 1 },
    ],
    leadTimeHours: 48,
    status: "active",
    sortOrder: 1,
  }),
];

const preOrders: ReservationPreOrder[] = [
  reservationPreOrderSchema.parse({
    id: id(5_401),
    ...scope,
    reservationId: reservations[1].id,
    packageId: packages[1].id,
    packageName: packages[1].name,
    pax: 8,
    items: packages[1].items.map((item) => ({
      menuItemId: item.menuItemId,
      name: menuItemName(item.menuItemId),
      quantityPerPax: item.quantity,
    })),
    pricePerPaxIdr: 135_000,
    subtotalIdr: 1_080_000,
    status: "confirmed",
    orderId: null,
    createdAt: "2026-11-01T03:40:00.000Z",
  }),
  reservationPreOrderSchema.parse({
    id: id(5_402),
    ...scope,
    reservationId: reservations[3].id,
    packageId: packages[0].id,
    packageName: packages[0].name,
    pax: 3,
    items: packages[0].items.map((item) => ({
      menuItemId: item.menuItemId,
      name: menuItemName(item.menuItemId),
      quantityPerPax: item.quantity,
    })),
    pricePerPaxIdr: 85_000,
    subtotalIdr: 255_000,
    status: "served",
    orderId: cafeLegendFixtures.orderId,
    createdAt: "2026-10-31T02:00:00.000Z",
  }),
];

function menuItemName(menuItemId: string): string {
  const item = cafeLegendMenuFixtures.items.find(
    (entry) => entry.id === menuItemId,
  );
  if (!item) throw new RangeError(`Unknown menu fixture id: ${menuItemId}`);
  return item.name;
}

const availability = reservationAvailabilitySchema.parse({
  date: "2026-11-07",
  timeZone: outlet.timeZone,
  durationMinutes: 90,
  pax: 4,
  zoneId: indoor.id,
  slots: [
    {
      startsAt: "2026-11-07T11:00:00+07:00",
      tableIds: [tableOf("A01").id, tableOf("A04").id],
      seatsAvailable: 6,
    },
    {
      startsAt: "2026-11-07T11:30:00+07:00",
      tableIds: [tableOf("A01").id, tableOf("A02").id, tableOf("A04").id],
      seatsAvailable: 8,
    },
    {
      startsAt: "2026-11-07T12:00:00+07:00",
      tableIds: [tableOf("A02").id, tableOf("A04").id],
      seatsAvailable: 6,
    },
  ],
});

export const reservationFixtureSchema = z.strictObject({
  policies: z.array(reservationPolicySnapshotSchema).min(1),
  reservations: z.array(reservationSchema).min(1),
  tableSlots: z.array(reservationTableSlotSchema),
  waitlist: z.array(waitlistEntrySchema),
  packages: z.array(reservationPackageSchema),
  preOrders: z.array(reservationPreOrderSchema),
  availability: reservationAvailabilitySchema,
});
export type ReservationFixtures = z.infer<typeof reservationFixtureSchema>;

export const cafeLegendReservationFixtures: ReservationFixtures =
  reservationFixtureSchema.parse({
    policies: [regularPolicy, privateRoomPolicy, noDepositPolicy],
    reservations,
    tableSlots,
    waitlist,
    packages,
    preOrders,
    availability,
  });

/**
 * One typed event envelope per lifecycle step, validated at module load. The
 * API emits these from the transactional outbox; the FE mock and the tests read
 * the same shapes.
 */
export const reservationEventFixtures = {
  created: reservationEventSchema.parse({
    id: "01JBQ7Z8K0A1B2C3D4E5F60001",
    tenantId: tenant.id,
    outletId: outlet.id,
    name: "reservation.created",
    version: 1,
    aggregateType: "reservation",
    aggregateId: reservations[0].id,
    sequence: 1,
    occurredAt: "2026-11-01T03:12:00.000Z",
    actor: { type: "user", id: staffUserId },
    idempotencyKey: "reservation:5001:created",
    payloadSchemaRef: "reservation.created.v1",
    payload: {
      reservationId: reservations[0].id,
      customerProfileId: null,
      reservedFor: reservations[0].reservedFor,
      durationMinutes: reservations[0].durationMinutes,
      pax: reservations[0].pax,
      zoneId: reservations[0].zoneId,
      tableIds: [],
      depositIdr: reservations[0].depositIdr,
      depositPaymentId: reservations[0].depositPaymentId,
      policyVersion: regularPolicy.version,
      status: "pending_deposit",
    },
  }),
  seated: reservationEventSchema.parse({
    id: "01JBQ7Z8K0A1B2C3D4E5F60002",
    tenantId: tenant.id,
    outletId: outlet.id,
    name: "reservation.seated",
    version: 1,
    aggregateType: "reservation",
    aggregateId: reservations[2].id,
    sequence: 3,
    occurredAt: "2026-11-01T04:35:00.000Z",
    actor: { type: "user", id: staffUserId },
    idempotencyKey: "reservation:5003:seated",
    payloadSchemaRef: "reservation.seated.v1",
    payload: {
      reservationId: reservations[2].id,
      tableSessionId: reservations[2].tableSessionId,
      tableIds: reservations[2].tableIds,
      pax: reservations[2].pax,
      depositAllocatedIdr: reservations[2].depositIdr,
    },
  }),
  cancelled: reservationEventSchema.parse({
    id: "01JBQ7Z8K0A1B2C3D4E5F60003",
    tenantId: tenant.id,
    outletId: outlet.id,
    name: "reservation.cancelled",
    version: 1,
    aggregateType: "reservation",
    aggregateId: reservations[4].id,
    sequence: 2,
    occurredAt: "2026-11-08T03:00:00.000Z",
    actor: { type: "user", id: staffUserId },
    idempotencyKey: "reservation:5005:cancelled",
    payloadSchemaRef: "reservation.cancelled.v1",
    payload: {
      reservationId: reservations[4].id,
      closedBy: "guest",
      reason: "Rencana berubah.",
      depositPaidIdr: 50_000,
      depositRefundIdr: 25_000,
      depositForfeitedIdr: 25_000,
      policyVersion: regularPolicy.version,
    },
  }),
  rescheduled: reservationEventSchema.parse({
    id: "01JBQ7Z8K0A1B2C3D4E5F60005",
    tenantId: tenant.id,
    outletId: outlet.id,
    name: "reservation.rescheduled",
    version: 1,
    aggregateType: "reservation",
    aggregateId: reservations[1].id,
    sequence: 3,
    occurredAt: "2026-11-02T03:00:00.000Z",
    actor: { type: "user", id: staffUserId },
    idempotencyKey: "reservation:5002:rescheduled",
    payloadSchemaRef: "reservation.rescheduled.v1",
    payload: {
      reservationId: reservations[1].id,
      requestId: id(5_301),
      previousReservedFor: reservations[1].reservedFor,
      reservedFor: "2026-11-07T20:00:00+07:00",
      previousPax: reservations[1].pax,
      pax: 6,
      tableIds: reservations[1].tableIds,
    },
  }),
  waitlistCalled: reservationEventSchema.parse({
    id: "01JBQ7Z8K0A1B2C3D4E5F60004",
    tenantId: tenant.id,
    outletId: outlet.id,
    name: "waitlist_entry.called",
    version: 1,
    aggregateType: "waitlist_entry",
    aggregateId: waitlist[1].id,
    sequence: 2,
    occurredAt: "2026-11-01T05:20:00.000Z",
    actor: { type: "user", id: staffUserId },
    idempotencyKey: "waitlist:5202:called",
    payloadSchemaRef: "waitlist_entry.called.v1",
    payload: {
      waitlistEntryId: waitlist[1].id,
      pax: waitlist[1].pax,
      zoneId: waitlist[1].zoneId,
      estimatedWaitMinutes: waitlist[1].estimatedWaitMinutes,
    },
  }),
} as const;

/** Stable ids other contracts or seeders may reference. */
export const reservationFixtureIds = {
  staffUserId,
  memberProfileId,
  regularPolicyVersion: regularPolicy.version,
  privateRoomPolicyVersion: privateRoomPolicy.version,
  pendingReservationId: reservations[0].id,
  confirmedReservationId: reservations[1].id,
  seatedReservationId: reservations[2].id,
  cancelledReservationId: reservations[4].id,
  noShowReservationId: reservations[5].id,
  calledWaitlistEntryId: waitlist[1].id,
  privateRoomPackageId: packages[1].id,
} as const;
