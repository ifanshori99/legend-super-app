// Mock mode for the connectivity kit (VITE_API_MOCK=true): the screens work
// without a backend, exactly as the API will serve them (docs/frontend.md).
//
// Heartbeats are rebased on the mock's own clock so the offline printer alert
// is what a supervisor really sees once a printer stops reporting (EDG-05).
// The kitchen printer is the one that stopped.
//
// Link state for screenshots and e2e, set before load:
//   localStorage["legend-edge-mock"] = "cloud_down" | "syncing"
// or at runtime: window.__legendEdgeMock.setCloudLink("disconnected").
import {
  deviceFixtures,
  deviceSchema,
  edgeFixtureIds,
  edgeNodeFixture,
  edgeNodeSchema,
  edgeStatusSchema,
  enrollDevice,
  getEdgeStatus,
  issueDeviceToken,
  listEdgeDevices,
  listPrintJobs,
  printJobFixtures,
  printJobSchema,
  reprintPrintJob,
  retryPrintJob,
  setOutletDeviceTrainingMode,
  transitionPrintJob,
  type CloudLink,
  type Device,
  type PrintJob,
} from "@starter/shared/edge";
import { createUlid, CoreError } from "@starter/shared/core";
import { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/idempotency";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";

const OVERRIDE_KEY = "legend-edge-mock";
type LinkOverride = "cloud_down" | "syncing";

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function readOverride(): LinkOverride | null {
  try {
    const value = window.localStorage.getItem(OVERRIDE_KEY);
    return value === "cloud_down" || value === "syncing" ? value : null;
  } catch {
    return null;
  }
}

function writeOverride(value: LinkOverride | null) {
  try {
    if (value === null) window.localStorage.removeItem(OVERRIDE_KEY);
    else window.localStorage.setItem(OVERRIDE_KEY, value);
  } catch {
    // Storage can be blocked; the in-memory store still changes.
  }
}

const browser = typeof window !== "undefined";

/**
 * `?demo=offline` (the POS ordering mock seed) means the cloud is out of reach
 * while the local edge node stays up, so the header badge and the POS screens
 * agree. Read per call: the param is gone after a client-side navigation only
 * if the route drops it, and the status query refetches on its own.
 */
function demoCloudDown(): boolean {
  if (!browser) return false;
  try {
    return (
      window.location.pathname.startsWith("/pos") &&
      new URLSearchParams(window.location.search).get("demo") === "offline"
    );
  } catch {
    return false;
  }
}

/** Live heartbeats: only the kitchen printer has stopped reporting. */
const devices = createMockStore<Device[]>(() =>
  deviceFixtures.map((device) =>
    deviceSchema.parse({
      ...device,
      lastSeenAt:
        device.id === edgeFixtureIds.printerKitchenId
          ? nowIso(-13 * 60_000)
          : nowIso(-5_000),
    }),
  ),
);

/** Lets ws02-devices' revoke mock see devices enrolled in this session. */
export function findMockDevice(deviceId: string): Device | undefined {
  return devices.get().find((item) => item.id === deviceId);
}

const jobs = createMockStore<PrintJob[]>(() => {
  const offsets: Record<string, number> = {
    "01ARZ3NDEKTSV4RRFFQ69G5FB1": -30_000,
    "01ARZ3NDEKTSV4RRFFQ69G5FB2": -60_000,
    "01ARZ3NDEKTSV4RRFFQ69G5FB3": -9 * 60_000,
    "01ARZ3NDEKTSV4RRFFQ69G5FB4": -40 * 60_000,
    "01ARZ3NDEKTSV4RRFFQ69G5FB5": -35 * 60_000,
  };
  return printJobFixtures
    .map((job) =>
      printJobSchema.parse({ ...job, createdAt: nowIso(offsets[job.id] ?? 0) }),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
});

type RegistryFreshness = "fresh" | "stale" | "hardStale";

const HOUR_MS = 3_600_000;
const REGISTRY_MAX_STALE_SECONDS = 72 * 3600;

// Fresh pull, a late pull (soft) and a pull older than the hard limit.
const REGISTRY_VARIANTS: Record<
  RegistryFreshness,
  () => {
    lastPulledAt: string;
    stale: boolean;
    hardStale: boolean;
    maxStaleSeconds: number;
  }
> = {
  fresh: () => ({
    lastPulledAt: nowIso(-30_000),
    stale: false,
    hardStale: false,
    maxStaleSeconds: REGISTRY_MAX_STALE_SECONDS,
  }),
  stale: () => ({
    lastPulledAt: nowIso(-2 * HOUR_MS),
    stale: true,
    hardStale: false,
    maxStaleSeconds: REGISTRY_MAX_STALE_SECONDS,
  }),
  hardStale: () => ({
    lastPulledAt: nowIso(-80 * HOUR_MS),
    stale: true,
    hardStale: true,
    maxStaleSeconds: REGISTRY_MAX_STALE_SECONDS,
  }),
};

const status = createMockStore(() => {
  const override = browser ? readOverride() : null;
  return {
    cloudLink: (override === "cloud_down"
      ? "disconnected"
      : "connected") as CloudLink,
    pendingEventCount:
      override === "cloud_down" ? 42 : override === "syncing" ? 7 : 0,
    lastSyncedAt: override === null ? nowIso(-20_000) : nowIso(-4 * 60_000),
    thisDeviceId: edgeFixtureIds.posId as string | null,
    // legend-s7szu: a restored or cloned edge database (receipt run alert).
    receiptRunAlert: false,
    receiptRunAlertAt: null as string | null,
    // legend-2lgu: freshness of the edge's copy of the device registry.
    registry: "fresh" as RegistryFreshness,
  };
});

type IdempotentResult = { job: PrintJob; fingerprint: string };
const reprintResults = createMockStore(
  () => new Map<string, IdempotentResult>(),
);
const retryResults = createMockStore(() => new Map<string, IdempotentResult>());

function findJob(printJobId: string): PrintJob {
  const job = jobs.get().find((item) => item.id === printJobId);
  if (!job)
    throw new ApiError(404, "NOT_FOUND", "Pekerjaan cetak tidak ditemukan.");
  return job;
}

function replay(
  seen: Map<string, IdempotentResult>,
  key: string,
  fingerprint: string,
): PrintJob | null {
  const record = seen.get(key);
  if (!record) return null;
  if (record.fingerprint !== fingerprint)
    throw new ApiError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Kunci idempotensi sudah dipakai dengan isi yang berbeda.",
    );
  return record.job;
}

declare global {
  interface Window {
    __legendEdgeMock?: {
      setCloudLink: (link: CloudLink) => void;
      setPendingEvents: (count: number) => void;
      setReceiptRunAlert: (on: boolean) => void;
      setDeviceRegistry: (state: RegistryFreshness) => void;
    };
  }
}

registerMock(getEdgeStatus, ({ scenario }) => {
  if (scenario === "empty")
    return {
      data: edgeStatusSchema.parse({
        tenantId: edgeNodeFixture.tenantId,
        outletId: edgeNodeFixture.outletId,
        cloudLink: "connected",
        edgeNode: null,
        pendingEventCount: 0,
        lastSyncedAt: null,
        thisDevice: null,
      }),
    };
  const current = status.get();
  const devicesNow = devices.get();
  return {
    data: edgeStatusSchema.parse({
      tenantId: edgeNodeFixture.tenantId,
      outletId: edgeNodeFixture.outletId,
      cloudLink: demoCloudDown() ? "disconnected" : current.cloudLink,
      edgeNode: edgeNodeSchema.parse({
        ...edgeNodeFixture,
        lastHeartbeatAt: nowIso(-5_000),
      }),
      pendingEventCount: current.pendingEventCount,
      lastSyncedAt: current.lastSyncedAt,
      deviceRegistry: {
        ...REGISTRY_VARIANTS[current.registry](),
        receiptRunAlert: current.receiptRunAlert,
        receiptRunAlertAt: current.receiptRunAlertAt,
      },
      thisDevice:
        devicesNow.find((device) => device.id === current.thisDeviceId) ?? null,
    }),
  };
});

registerMock(listPrintJobs, ({ query, scenario }) =>
  paginateFixture(
    query.status
      ? jobs.get().filter((job) => job.status === query.status)
      : jobs.get(),
    query,
    (job) => job.id,
    scenario,
  ),
);

registerMock(reprintPrintJob, ({ params, body }) => {
  const original = findJob(params.printJobId);
  if (original.status !== "printed")
    throw new ApiError(
      409,
      "CONFLICT",
      "Hanya pekerjaan yang sudah tercetak yang dapat dicetak ulang.",
    );
  const seen = reprintResults.get();
  const fingerprint = `reprint:${original.id}`;
  const existing = replay(seen, body.idempotencyKey, fingerprint);
  if (existing) return { data: existing };
  const copy: PrintJob = {
    ...original,
    id: createUlid(),
    status: "queued",
    createdAt: nowIso(),
    reprintOf: original.id,
  };
  jobs.set([copy, ...jobs.get()]);
  seen.set(body.idempotencyKey, { job: copy, fingerprint });
  return { data: copy };
});

registerMock(retryPrintJob, ({ params, body }) => {
  const job = findJob(params.printJobId);
  const seen = retryResults.get();
  const fingerprint = `retry:${job.id}`;
  const existing = replay(seen, body.idempotencyKey, fingerprint);
  if (existing) return { data: existing };
  let next: PrintJob["status"];
  try {
    next = transitionPrintJob(job.status, "retry");
  } catch (error) {
    if (error instanceof CoreError)
      throw new ApiError(409, error.code, error.message);
    throw error;
  }
  const updated: PrintJob = { ...job, status: next };
  jobs.set(jobs.get().map((item) => (item.id === job.id ? updated : item)));
  seen.set(body.idempotencyKey, { job: updated, fingerprint });
  return { data: updated };
});

registerMock(listEdgeDevices, ({ query, scenario }) => {
  const page = paginateFixture(
    devices
      .get()
      .filter(
        (device) =>
          (!query.outletId || device.outletId === query.outletId) &&
          (!query.type || device.type === query.type) &&
          (!query.status || device.status === query.status),
      ),
    query,
    (device) => device.id,
    scenario,
  );
  return {
    ...page,
    meta: { ...page.meta, serverTime: new Date().toISOString() },
  };
});

registerMock(setOutletDeviceTrainingMode, ({ params, body }) => {
  const device = devices.get().find((item) => item.id === params.deviceId);
  if (!device)
    throw new ApiError(404, "NOT_FOUND", "Perangkat tidak ditemukan.");
  const updated: Device = { ...device, trainingMode: body.trainingMode };
  devices.set(
    devices.get().map((item) => (item.id === device.id ? updated : item)),
  );
  return { data: updated };
});

/** A well-formed but fake `dv1` token; mock mode never signs anything. */
function mockDeviceToken(): string {
  const part = (length: number) =>
    createUlid()
      .repeat(Math.ceil(length / 26))
      .slice(0, length);
  return `dv1.${part(60)}.${part(43)}`;
}

/** Enroll replay: same key → the first answer, like the API (EDG-03). */
const enrolled = createMockStore(
  () => new Map<string, { data: { device: Device; token: string } }>(),
);

registerMock(enrollDevice, ({ body }) => {
  const replay = enrolled.get().get(body.idempotencyKey);
  if (replay) return replay;
  const template = deviceFixtures[0];
  const device: Device = deviceSchema.parse({
    ...template,
    id: newIdempotencyKey(),
    outletId: body.outletId,
    type: body.type,
    stationId: body.stationId ?? null,
    label: body.label,
    capabilities: [],
    lastSeenAt: null,
    revokedAt: null,
    status: "active",
    trainingMode: false,
  });
  devices.set([...devices.get(), device]);
  const reply = { data: { device, token: mockDeviceToken() } };
  enrolled.get().set(body.idempotencyKey, reply);
  return reply;
});

registerMock(issueDeviceToken, ({ params }) => {
  const device = devices.get().find((item) => item.id === params.deviceId);
  if (!device)
    throw new ApiError(404, "NOT_FOUND", "Perangkat tidak ditemukan.");
  if (device.status === "revoked")
    throw new ApiError(409, "CONFLICT", "Perangkat sudah dicabut.");
  return { data: { device, token: mockDeviceToken() } };
});

// Dev-only control, same idea as window.__legendMock in lib/mock/control.ts.
if (browser)
  window.__legendEdgeMock = {
    setCloudLink: (link) => {
      status.set({ ...status.get(), cloudLink: link });
      writeOverride(link === "disconnected" ? "cloud_down" : null);
    },
    setPendingEvents: (count) => {
      status.set({ ...status.get(), pendingEventCount: Math.max(0, count) });
    },
    setDeviceRegistry: (state) => {
      status.set({ ...status.get(), registry: state });
    },
    setReceiptRunAlert: (on) => {
      status.set({
        ...status.get(),
        receiptRunAlert: on,
        receiptRunAlertAt: on ? nowIso(-60_000) : null,
      });
    },
  };
