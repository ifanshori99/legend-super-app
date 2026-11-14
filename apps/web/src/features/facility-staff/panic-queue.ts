// Pure state of the staff panic alert screen (bead legend-alovk, Arah A).
// No React: the reducer keeps alerts in arrival order (FIFO by `order`, not by
// `receivedAt`), de-duplicates by alertId and tracks the ack of each alert.
import type {
  PanicAcknowledgedFrame,
  PanicRealtimeFrame,
} from "@starter/shared/facility";

export type PanicAckState =
  "idle" | "sending" | "mine" | "taken" | "failed" | "session";

export type PanicQueueItem = {
  alertId: string;
  outletId: string;
  unitId: string | null;
  unitCode: string | null;
  areaName: string | null;
  receivedAt: string;
  kind: "press" | "test";
  /** Arrival order, starts at 1. */
  order: number;
  ack: PanicAckState;
  dismissed: boolean;
  /** Colleague who answered first (null: unknown, shown as "rekan lain"). */
  takenBy: string | null;
  takenAt: string | null;
};

export type PanicConnection =
  | "connecting"
  | "open"
  | "reconnecting"
  | "unreachable"
  | "revoked"
  | "stopped";

export type PanicQueueState = {
  items: PanicQueueItem[];
  connection: PanicConnection;
  nextOrder: number;
  /** Alerts known to be handled by a colleague before they showed up here. */
  closedIds: string[];
};

export type PanicQueueAction =
  | { type: "alert"; frame: PanicRealtimeFrame }
  | { type: "acknowledged"; frame: PanicAcknowledgedFrame }
  | { type: "sync"; alerts: PanicRealtimeFrame[]; knownBefore: string[] }
  | { type: "status"; status: PanicConnection }
  | {
      type: "ack-taken";
      alertId: string;
      byName?: string | null;
      at?: string | null;
    }
  | {
      type: "ack-start" | "ack-ok" | "ack-failed" | "ack-session" | "dismiss";
      alertId: string;
    };

export const initialPanicQueue: PanicQueueState = {
  items: [],
  connection: "connecting",
  nextOrder: 1,
  closedIds: [],
};

function updateItem(
  state: PanicQueueState,
  alertId: string,
  allowed: readonly PanicAckState[] | null,
  change: (item: PanicQueueItem) => PanicQueueItem,
): PanicQueueState {
  let changed = false;
  const items = state.items.map((item) => {
    if (item.alertId !== alertId) return item;
    if (allowed && !allowed.includes(item.ack)) return item;
    changed = true;
    return change(item);
  });
  return changed ? { ...state, items } : state;
}

function addAlert(
  state: PanicQueueState,
  frame: PanicRealtimeFrame,
): PanicQueueState {
  if (
    state.items.some((item) => item.alertId === frame.alertId) ||
    state.closedIds.includes(frame.alertId)
  )
    return state;
  const item: PanicQueueItem = {
    alertId: frame.alertId,
    outletId: frame.outletId,
    unitId: frame.unitId,
    unitCode: frame.unitCode,
    areaName: frame.areaName,
    receivedAt: frame.receivedAt,
    kind: frame.kind,
    order: state.nextOrder,
    ack: "idle",
    dismissed: false,
    takenBy: null,
    takenAt: null,
  };
  return {
    ...state,
    items: [...state.items, item],
    nextOrder: state.nextOrder + 1,
  };
}

export function panicQueueReducer(
  state: PanicQueueState,
  action: PanicQueueAction,
): PanicQueueState {
  switch (action.type) {
    case "alert":
      return addAlert(state, action.frame);
    case "acknowledged": {
      const { frame } = action;
      const existing = state.items.find(
        (item) => item.alertId === frame.alertId,
      );
      if (!existing) {
        if (state.closedIds.includes(frame.alertId)) return state;
        return { ...state, closedIds: [...state.closedIds, frame.alertId] };
      }
      if (
        existing.ack === "idle" ||
        existing.ack === "failed" ||
        existing.ack === "session"
      )
        return updateItem(state, frame.alertId, null, (item) => ({
          ...item,
          ack: "taken",
          takenBy: frame.byName,
          takenAt: frame.acknowledgedAt,
        }));
      if (existing.ack === "taken" && existing.takenBy === null)
        return updateItem(state, frame.alertId, ["taken"], (item) => ({
          ...item,
          takenBy: frame.byName,
          takenAt: frame.acknowledgedAt,
        }));
      return state;
    }
    case "sync": {
      let next = state;
      for (const frame of action.alerts) next = addAlert(next, frame);
      const open = new Set(action.alerts.map((frame) => frame.alertId));
      for (const alertId of action.knownBefore) {
        if (open.has(alertId)) continue;
        next = updateItem(
          next,
          alertId,
          ["idle", "failed", "session"],
          (item) => ({ ...item, ack: "taken" }),
        );
      }
      return next;
    }
    case "status": {
      if (state.connection === "revoked") return state;
      if (state.connection === action.status) return state;
      return { ...state, connection: action.status };
    }
    case "ack-start":
      return updateItem(
        state,
        action.alertId,
        ["idle", "failed", "session"],
        (item) => ({
          ...item,
          ack: "sending",
        }),
      );
    case "ack-ok":
      return updateItem(state, action.alertId, null, (item) => ({
        ...item,
        ack: "mine",
      }));
    case "ack-taken":
      return updateItem(state, action.alertId, null, (item) => ({
        ...item,
        ack: "taken",
        takenBy: action.byName ?? item.takenBy,
        takenAt: action.at ?? item.takenAt,
      }));
    case "ack-failed":
      return updateItem(state, action.alertId, null, (item) => ({
        ...item,
        ack: "failed",
      }));
    case "ack-session":
      return updateItem(state, action.alertId, null, (item) => ({
        ...item,
        ack: "session",
      }));
    case "dismiss":
      return updateItem(state, action.alertId, ["mine", "taken"], (item) => ({
        ...item,
        dismissed: true,
      }));
  }
}

function byOrder(a: PanicQueueItem, b: PanicQueueItem): number {
  return a.order - b.order;
}

/** Alerts still waiting for this staff member, oldest arrival first. */
export function pendingAlerts(state: PanicQueueState): PanicQueueItem[] {
  return state.items
    .filter(
      (item) =>
        !item.dismissed &&
        (item.ack === "idle" ||
          item.ack === "sending" ||
          item.ack === "failed" ||
          item.ack === "session"),
    )
    .sort(byOrder);
}

/** Alerts answered (by me or a colleague) that are not yet closed. */
export function settledAlerts(state: PanicQueueState): PanicQueueItem[] {
  return state.items
    .filter(
      (item) =>
        !item.dismissed && (item.ack === "mine" || item.ack === "taken"),
    )
    .sort(byOrder);
}

export type PanicView =
  "idle" | "alert" | "queue" | "settled" | "unreachable" | "revoked";

export function panicView(state: PanicQueueState): PanicView {
  if (state.connection === "revoked") return "revoked";
  const pending = pendingAlerts(state).length;
  if (pending >= 2) return "queue";
  if (pending === 1) return "alert";
  if (state.connection === "unreachable") return "unreachable";
  if (settledAlerts(state).length > 0) return "settled";
  return "idle";
}
