// Pure rules of the offline/connectivity kit (bead legend-diq). No framework
// imports, so the root contract test can load it with plain Node ESM.
//
// PRD v1.7 §3 F5 (Print Agent, Fallback Berlapis, Mode Latihan), §4 Alur F
// (operasional saat internet putus) and EDG-05 (printer/KDS failure detected
// within 30 seconds and reported to the supervisor).
import type { CloudLink, Device, PrintJob } from "@starter/shared/edge";
import type { MessageKey } from "@starter/shared/i18n";

/**
 * EDG-05 requires detection within 30 seconds, so a printer or KDS whose last
 * heartbeat is 30 seconds old is already treated as offline. The heartbeat
 * interval itself is device configuration, never a client constant.
 */
export const DEVICE_OFFLINE_AFTER_MS = 30_000;

/** Devices the supervisor hears about when they stop reporting (EDG-05). */
const ALERT_DEVICE_TYPES: ReadonlySet<Device["type"]> = new Set([
  "printer",
  "kds",
]);

export type ConnectivityState =
  | { readonly kind: "online" }
  | { readonly kind: "syncing"; readonly pendingEventCount: number }
  | { readonly kind: "cloud_down"; readonly pendingEventCount: number }
  /** The device lost the outlet network itself (Alur F step 1). */
  | { readonly kind: "device_offline" }
  /** Browser is online but the edge node does not answer the status probe. */
  | { readonly kind: "unknown" };

/**
 * One banner state from three facts: browser connectivity, the edge node's
 * cloud link and its outbox backlog (PRD §5 Sinkronisasi). A status that is
 * still loading renders nothing; only a failed probe is "unknown".
 */
export function deriveConnectivity(input: {
  browserOnline: boolean;
  cloudLink: CloudLink | null;
  pendingEventCount: number;
  statusFailed: boolean;
}): ConnectivityState {
  if (!input.browserOnline) return { kind: "device_offline" };
  if (input.cloudLink === null) {
    return input.statusFailed ? { kind: "unknown" } : { kind: "online" };
  }
  if (input.cloudLink === "disconnected")
    return { kind: "cloud_down", pendingEventCount: input.pendingEventCount };
  if (input.pendingEventCount > 0)
    return { kind: "syncing", pendingEventCount: input.pendingEventCount };
  return { kind: "online" };
}

/**
 * The cloud connection the operations header badge reports (legend-b0l9, PRD
 * v1.7 §4 Alur F step 1). The edge node's cloud link is the truth: a LAN that
 * works while the edge lost the cloud must read "offline". Browser
 * connectivity is the secondary hint, used alone only while the edge status is
 * unknown (still loading, or no edge node on this deployment).
 */
export function cloudConnectionOnline(input: {
  browserOnline: boolean;
  cloudLink: CloudLink | null;
}): boolean {
  if (!input.browserOnline) return false;
  return input.cloudLink === null || input.cloudLink === "connected";
}

/**
 * A cloud deployment does not serve `/api/edge/*` (edge endpoints live on the
 * outlet's edge node), so a 404 means "no edge node here", not an outage: the
 * back office opened from home must not carry a permanent warning banner.
 * Any other failure (network, 5xx) stays "unknown" (review legend-cyu.12).
 */
export function edgeProbeFailed(isError: boolean, error: unknown): boolean {
  if (!isError) return false;
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status: unknown }).status
      : undefined;
  return status !== 404;
}

/** Revoked devices are a registry decision, not an outage. */
export function isDeviceOffline(device: Device, nowMs: number): boolean {
  if (device.status === "revoked") return false;
  if (device.lastSeenAt === null) return true;
  const lastSeen = Date.parse(device.lastSeenAt);
  if (Number.isNaN(lastSeen)) return true;
  return nowMs - lastSeen >= DEVICE_OFFLINE_AFTER_MS;
}

/** Printers and KDS that need the supervisor's attention (EDG-05). */
export function offlineAlertDevices(
  devices: readonly Device[],
  nowMs: number,
): Device[] {
  return devices.filter(
    (device) =>
      ALERT_DEVICE_TYPES.has(device.type) && isDeviceOffline(device, nowMs),
  );
}

export function printJobActions(job: PrintJob): {
  readonly canRetry: boolean;
  readonly canReprint: boolean;
} {
  return {
    canRetry: job.status === "failed",
    canReprint: job.status === "printed",
  };
}

export function summarizePrintJobs(jobs: readonly PrintJob[]) {
  const summary = { queued: 0, printing: 0, printed: 0, failed: 0 };
  for (const job of jobs) summary[job.status] += 1;
  return summary;
}

export const PRINT_KIND_LABEL: Record<PrintJob["kind"], MessageKey> = {
  receipt: "edge.print.kindReceipt",
  station_ticket: "edge.print.kindStationTicket",
  shift_report: "edge.print.kindShiftReport",
};

export const PRINT_STATUS_LABEL: Record<PrintJob["status"], MessageKey> = {
  queued: "edge.print.statusQueued",
  printing: "edge.print.statusPrinting",
  printed: "edge.print.statusPrinted",
  failed: "edge.print.statusFailed",
};

export const CLOUD_LINK_LABEL: Record<CloudLink, MessageKey> = {
  connected: "edge.cloudConnected",
  disconnected: "edge.cloudDisconnected",
};

export const EDGE_ROLE_LABEL: Record<"primary" | "standby", MessageKey> = {
  primary: "edge.edgeNodeRolePrimary",
  standby: "edge.edgeNodeRoleStandby",
};

/** HH.mm.ss in the device's own zone (the operator reads the wall clock). */
export function formatClock(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

/** "11 November 2026, 09.42 WIB": the alert time, read in Jakarta time. */
export function formatAlertTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const zone = { timeZone: "Asia/Jakarta" } as const;
  const day = new Intl.DateTimeFormat("id-ID", {
    ...zone,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("id-ID", {
    ...zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${day}, ${time} WIB`;
}

/**
 * Customer and public screens get the guest wording ("Silakan pesan melalui
 * waiter"), not the staff connectivity banner (PRD §4 Alur F step 2).
 */
const GUEST_PATH_PREFIXES = [
  "/t",
  "/f",
  "/member",
  "/wifi",
  "/menu",
  "/reservasi",
  "/masuk",
] as const;

export function isGuestPath(pathname: string): boolean {
  if (pathname === "/") return true;
  return GUEST_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * The cashier screen states its own offline condition (O4 banner), so the
 * device banner of the shell is not shown there as a second, separate banner.
 */
export function isCashierPath(pathname: string): boolean {
  return pathname === "/pos/kasir" || pathname.startsWith("/pos/kasir/");
}

/** Operations screens offer the way to the full status screen (Alur F). */
export function isOperationsPath(pathname: string): boolean {
  return ["/pos", "/operasional", "/fasilitas"].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
