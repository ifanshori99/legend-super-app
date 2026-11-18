import {
  deviceSchema,
  edgeNodeSchema,
  heartbeatSchema,
  revocationListSchema,
  syncBatchSchema,
  syncAckSchema,
  printJobSchema,
  agentRpcRequestSchema,
  agentRpcResponseSchema,
} from "./schemas.ts";
import { eventFixture } from "../events/fixtures.ts";
const tenantId = "11111111-1111-4111-8111-111111111111";
const outletId = "22222222-2222-4222-8222-222222222222";
const deviceId = "44444444-4444-4444-8444-444444444444";
const time = "2026-11-01T12:00:00.000Z";
const scope = { tenantId, outletId };
export const deviceFixture = {
  ...scope,
  id: deviceId,
  type: "pos",
  stationId: null,
  label: "Kasir Cafe Legend",
  version: "1.0.0",
  capabilities: ["cash", "edc"],
  lastSeenAt: time,
  revokedAt: null,
  status: "active",
  trainingMode: false,
  sharedMode: false,
};
export const syncBatchFixture = {
  ...scope,
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  peerId: deviceId,
  direction: "edge_to_cloud",
  fromCursor: null,
  toCursor: "cursor-42",
  events: [eventFixture],
};
export const agentRpcFixture = {
  ...scope,
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  deviceId,
  operation: "edc.status",
  idempotencyKey: "edc-status-001",
  requestedAt: time,
  payload: { reference: "POS-001" },
};
export const edgeFixtures: ReadonlyArray<
  readonly [{ safeParse: (value: unknown) => { success: boolean } }, unknown]
> = [
  [deviceSchema, deviceFixture],
  [
    edgeNodeSchema,
    {
      ...scope,
      id: deviceId,
      role: "primary",
      version: "1.0.0",
      lastHeartbeatAt: time,
      lastSyncCursor: "cursor-42",
    },
  ],
  [
    heartbeatSchema,
    {
      ...scope,
      deviceId,
      version: "1.0.0",
      capabilities: ["cash"],
      occurredAt: time,
    },
  ],
  [
    revocationListSchema,
    { ...scope, updatedAt: time, devices: [{ deviceId, revokedAt: time }] },
  ],
  [syncBatchSchema, syncBatchFixture],
  [
    syncAckSchema,
    {
      ...scope,
      batchId: syncBatchFixture.id,
      peerId: deviceId,
      direction: "edge_to_cloud",
      cursor: "cursor-42",
      lastEventId: eventFixture.id,
      acknowledgedAt: time,
    },
  ],
  [
    printJobSchema,
    {
      ...scope,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      printerId: deviceId,
      kind: "receipt",
      format: "esc_pos",
      content: "Cafe Legend - Rp90.000",
      status: "queued",
      createdAt: time,
      reprintOf: null,
    },
  ],
  [agentRpcRequestSchema, agentRpcFixture],
  [
    agentRpcResponseSchema,
    {
      ...scope,
      requestId: agentRpcFixture.id,
      status: "success",
      result: { status: "pending" },
    },
  ],
];

// Connectivity kit fixtures (bead legend-diq, PRD §3 F5, §4 Alur F, EDG-05).
// A POS, two printers and a KDS of one outlet; the kitchen printer stopped
// sending heartbeats, which is what a supervisor alert looks like.
const edgeNodeId = "33333333-3333-4333-8333-333333333333";
const printerBarId = "44444444-4444-4444-8444-444444444445";
const printerKitchenId = "44444444-4444-4444-8444-444444444446";
const kdsBarId = "44444444-4444-4444-8444-444444444447";

/** Stable ids for mocks, tests and screenshots of the connectivity kit. */
export const edgeFixtureIds = {
  edgeNodeId,
  posId: deviceId,
  printerBarId,
  printerKitchenId,
  kdsBarId,
} as const;

export const edgeNodeFixture = {
  ...scope,
  id: edgeNodeId,
  role: "primary",
  version: "1.0.0",
  lastHeartbeatAt: time,
  lastSyncCursor: "cursor-42",
};

export const deviceFixtures = [
  deviceFixture,
  {
    ...scope,
    id: printerBarId,
    type: "printer",
    stationId: null,
    label: "Printer Bar",
    version: "1.0.0",
    capabilities: ["receipt", "station_ticket"],
    lastSeenAt: "2026-11-01T11:59:50.000Z",
    revokedAt: null,
    status: "active",
    trainingMode: false,
    sharedMode: false,
  },
  {
    ...scope,
    id: kdsBarId,
    type: "kds",
    stationId: null,
    label: "KDS Bar",
    version: "1.0.0",
    capabilities: ["display"],
    lastSeenAt: "2026-11-01T11:59:52.000Z",
    revokedAt: null,
    status: "active",
    trainingMode: false,
    sharedMode: false,
  },
  {
    ...scope,
    id: printerKitchenId,
    type: "printer",
    stationId: null,
    label: "Printer Dapur",
    version: "1.0.0",
    capabilities: ["station_ticket"],
    lastSeenAt: "2026-11-01T11:47:00.000Z",
    revokedAt: null,
    status: "active",
    trainingMode: false,
    sharedMode: false,
  },
] as const;

export const printJobFixtures = [
  {
    ...scope,
    id: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    printerId: printerBarId,
    kind: "receipt",
    format: "esc_pos",
    content: "CAFE LEGEND\nMeja 12 - 3 tamu\nTotal Rp 90.000",
    status: "queued",
    createdAt: "2026-11-01T11:59:40.000Z",
    reprintOf: null,
  },
  {
    ...scope,
    id: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
    printerId: printerBarId,
    kind: "station_ticket",
    format: "esc_pos",
    content: "TIKET BAR\n2x Es Kopi Susu\nMeja 12",
    status: "printing",
    createdAt: "2026-11-01T11:59:30.000Z",
    reprintOf: null,
  },
  {
    ...scope,
    id: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
    printerId: printerKitchenId,
    kind: "station_ticket",
    format: "esc_pos",
    content: "TIKET DAPUR\n1x Nasi Goreng Legend\nMeja 12",
    status: "failed",
    createdAt: "2026-11-01T11:51:00.000Z",
    reprintOf: null,
  },
  {
    ...scope,
    id: "01ARZ3NDEKTSV4RRFFQ69G5FB4",
    printerId: printerBarId,
    kind: "receipt",
    format: "esc_pos",
    content: "CAFE LEGEND\nMeja 7 - 2 tamu\nTotal Rp 55.000",
    status: "printed",
    createdAt: "2026-11-01T11:20:00.000Z",
    reprintOf: null,
  },
  {
    ...scope,
    id: "01ARZ3NDEKTSV4RRFFQ69G5FB5",
    printerId: printerBarId,
    kind: "receipt",
    format: "esc_pos",
    content: "CAFE LEGEND\nMeja 7 - 2 tamu\nTotal Rp 55.000\nCETAK ULANG",
    status: "printed",
    createdAt: "2026-11-01T11:25:00.000Z",
    reprintOf: "01ARZ3NDEKTSV4RRFFQ69G5FB4",
  },
] as const;

export const edgeStatusFixture = {
  ...scope,
  cloudLink: "connected",
  edgeNode: edgeNodeFixture,
  pendingEventCount: 0,
  lastSyncedAt: time,
  deviceRegistry: { lastPulledAt: time, stale: false },
  thisDevice: deviceFixture,
};
