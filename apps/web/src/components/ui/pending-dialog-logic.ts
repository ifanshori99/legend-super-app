// Pure rules for a dialog that must not close while a request is in flight
// (Esc, outside click, and the X all go through these). Closing mid-request
// would hide the outcome of a money or schedule change, and a second attempt
// could then race the first. Kept free of React so Node tests can cover it.

type Cancelable = { preventDefault: () => void };

/** Ignore a close request while pending; opening is always allowed. */
export function guardOpenChange(
  pending: boolean,
  onOpenChange?: (open: boolean) => void,
): (open: boolean) => void {
  return (next) => {
    if (!next && pending) return;
    onOpenChange?.(next);
  };
}

/** Cancel Esc and outside-click dismissal while pending. */
export function blockWhilePending<E extends Cancelable>(
  pending: boolean,
  original?: (event: E) => void,
): (event: E) => void {
  return (event) => {
    if (pending) event.preventDefault();
    else original?.(event);
  };
}
