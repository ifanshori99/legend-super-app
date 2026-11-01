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
