// MOCK/DEMO ONLY. Lets a feature mock (breakfast from the ticket) hand the
// payment page a bill of its own: the feature registers a link here, the
// payment mock (features/ws05-payment/mock.ts) serves it on /bayar/$token and
// calls `onPaid` once when the demo payment lands. Relative imports only, so
// the node tests that load a feature mock never pull in the payment mock.
import { createMockStore } from "./store.ts";

export type MockExternalLink = {
  token: string;
  /** Shown as the bill reference on the payment page. */
  reference: string;
  /** Whole rupiah before tax; the guest pays this plus `taxIdr`, nothing owed twice. */
  subtotalIdr: number;
  /** Tax added on top of the subtotal (PB1 for breakfast). */
  taxIdr: number;
  /** App-local path of "Back" and "Selesai". */
  returnPath: string;
  /** The stand-in for the verified `payment.paid` event; runs once. */
  onPaid: () => void;
};

const externalLinks = createMockStore<Map<string, MockExternalLink>>(
  () => new Map(),
);

export function registerExternalPaymentLink(link: MockExternalLink) {
  externalLinks.get().set(link.token, link);
}

export function findExternalPaymentLink(
  token: string,
): MockExternalLink | undefined {
  return externalLinks.get().get(token);
}
