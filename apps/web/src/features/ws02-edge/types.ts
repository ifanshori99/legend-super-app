// View-model types for the back-office "Status edge" screen (legend-ph62j).
// The cloud has no endpoint that lists edge nodes with a name yet (see
// ./CONTRACT-GAPS.md), so these types are local until it lands.
//
// Plain TypeScript with no runtime imports: Node tests load it directly.

/** Error code a call returns outside mock mode when the contract is missing. */
export const CONTRACT_PENDING = "CONTRACT_PENDING";

export type EdgeNodeLink = "connected" | "disconnected";

export interface EdgeNodeRow {
  id: string;
  /** Node name the technical admin recognises, e.g. "edge-jakarta-01". */
  name: string;
  outletName: string;
  link: EdgeNodeLink;
  /** ISO time of the last status the cloud holds; null when none yet. */
  lastUpdatedAt: string | null;
}

/** Repeated receipt number rotation reported for one node (legend-s7szu). */
export interface EdgeReceiptRunAlert {
  nodeName: string;
  alertAt: string | null;
}

export interface EdgeNodesOverview {
  nodes: EdgeNodeRow[];
  receiptRunAlert: EdgeReceiptRunAlert | null;
}
