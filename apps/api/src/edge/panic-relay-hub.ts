// In-process hub of the emergency button (bead legend-bod; design
// docs/design/edge-emergency.md D-05, D-10). The staff sockets of
// panic-relay-realtime.ts register here, keyed by tenant and outlet, with the
// receiver session they belong to. Nothing here touches the network or the
// database, so a press still reaches the staff of the outlet while the
// internet is down.
//
// Per socket the hub remembers, for each open alert, when the frame was last
// sent and whether the phone confirmed it (`received`). The relay service
// (services/panic-relay.service.ts) drives sending, resending and receipts.
import type {
  PanicRealtimeFrame,
  PanicServerFrame,
} from "@starter/shared/facility";
import type { ReceiverSession } from "../services/panic-receiver-session.ts";

export type HubKey = { tenantId: string; outletId: string };

/** What the hub remembers of one alert on one socket. */
export type SocketAlertState = {
  /** The frame sent for this alert (resent as it is). */
  frame: PanicRealtimeFrame;
  /** Edge clock of the alert (`received_at`), epoch ms. */
  alertReceivedAt: number;
  lastSentAt: number;
  /** The phone sent `received` for this alert (D-05). */
  received: boolean;
};

export type HubSubscriber = {
  /** The receiver session of the socket (tenant, outlet, device, staff). */
  readonly session: ReceiverSession;
  /** Sends one frame; false when the socket is not open. */
  send(frame: PanicServerFrame): boolean;
  /** Closes the socket with a WebSocket close code. */
  close(code: number): void;
  readonly alerts: Map<string, SocketAlertState>;
};

const subscribers = new Map<string, Set<HubSubscriber>>();

const keyOf = ({ tenantId, outletId }: HubKey) =>
  `${tenantId.toLowerCase()}:${outletId.toLowerCase()}`;

/** Registers a socket; the returned function removes it. */
export function subscribe(subscriber: HubSubscriber): () => void {
  const id = keyOf(subscriber.session);
  const set = subscribers.get(id) ?? new Set<HubSubscriber>();
  set.add(subscriber);
  subscribers.set(id, set);
  return () => {
    const current = subscribers.get(id);
    if (!current) return;
    current.delete(subscriber);
    if (current.size === 0) subscribers.delete(id);
  };
}

/** The sockets of one outlet (a copy: a socket may leave while it is used). */
export function subscribersOf(key: HubKey): HubSubscriber[] {
  return [...(subscribers.get(keyOf(key)) ?? [])];
}

/** Every socket of every outlet (the resend loop). */
export function allSubscribers(): HubSubscriber[] {
  return [...subscribers.values()].flatMap((set) => [...set]);
}

export function hasSubscribers(key: HubKey): boolean {
  return (subscribers.get(keyOf(key))?.size ?? 0) > 0;
}

/** Closes every socket of a session (logout, replaced, revoked): code 4401. */
export function closeSessionSockets(
  tenantId: string,
  sessionId: string,
  code: number,
): number {
  let closed = 0;
  for (const subscriber of [...allSubscribers()])
    if (
      subscriber.session.id === sessionId &&
      subscriber.session.tenantId.toLowerCase() === tenantId.toLowerCase()
    ) {
      subscriber.close(code);
      closed += 1;
    }
  return closed;
}
