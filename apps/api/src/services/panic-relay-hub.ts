// In-process fan-out of panic frames (bead legend-bod; FAC-08). Subscribers
// are the staff sockets of panic-relay-realtime.ts, keyed per tenant and
// outlet and registered with the staff member's user id, so a frame can be
// limited to the staff on duty. Nothing here touches the network or the
// database, so a press still reaches the staff of the outlet while the
// internet is down.

export type PanicHubKey = { tenantId: string; outletId: string };
export type PanicHubSend = (frame: unknown) => void;

type Subscriber = { send: PanicHubSend; userId: string | null };

const subscribers = new Map<string, Set<Subscriber>>();

const keyOf = ({ tenantId, outletId }: PanicHubKey) =>
  `${tenantId.toLowerCase()}:${outletId.toLowerCase()}`;

/**
 * Registers `send` for an outlet as `userId`; the returned function removes
 * it. A subscriber without a user id only receives frames published without a
 * `userIds` filter (hub level use); it never gets an on-duty alert.
 */
export function subscribe(
  key: PanicHubKey,
  send: PanicHubSend,
  userId: string | null = null,
): () => void {
  const id = keyOf(key);
  const entry: Subscriber = { send, userId };
  const set = subscribers.get(id) ?? new Set<Subscriber>();
  set.add(entry);
  subscribers.set(id, set);
  return () => {
    const current = subscribers.get(id);
    if (!current) return;
    current.delete(entry);
    if (current.size === 0) subscribers.delete(id);
  };
}

/**
 * Delivers `frame` to the subscribers of the outlet and returns how many
 * sockets got it. With `userIds`, only sockets of those users receive it
 * (the on-duty staff); without it every subscriber of the outlet does.
 */
export function publish(
  key: PanicHubKey,
  frame: unknown,
  options: { userIds?: readonly string[] } = {},
): number {
  const set = subscribers.get(keyOf(key));
  if (!set) return 0;
  const allowed = options.userIds ? new Set(options.userIds) : null;
  let delivered = 0;
  // Copy: a subscriber may unsubscribe while it is being called.
  for (const entry of [...set]) {
    if (allowed && (entry.userId === null || !allowed.has(entry.userId)))
      continue;
    try {
      entry.send(frame);
      delivered += 1;
    } catch {
      // One broken socket must not stop the alert for the others.
    }
  }
  return delivered;
}
