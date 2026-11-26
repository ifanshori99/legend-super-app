// Which panel may stay open while a payment request of the bill is being sent
// (1268 W2): only the one the cashier sent it from, and only until they leave
// it. Pure: Node tests load it directly.

export type SenderLock = {
  status: "none" | "sending" | "pending" | "corrupt";
  /** The view the request was sent from; null: every panel is locked. */
  sender: string | null;
};

export function trackSender(
  previous: SenderLock,
  status: SenderLock["status"],
  view: string,
): SenderLock {
  if (status !== "sending") return { status, sender: null };
  // A request repeated from the unresolved panel is no step's own request.
  const sender =
    previous.status === "none" ||
    (previous.status === "sending" && previous.sender === view)
      ? view
      : null;
  return { status, sender };
}
