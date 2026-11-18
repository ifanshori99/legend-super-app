// View-model types for the back-office "Status edge" screen (legend-ph62j).
// Mapped from GET /api/edge-node-status (docs/design/edge-status-cloud.md
// section 3.4).
//
// Plain TypeScript with type-only imports: Node tests load it directly.
import type { EdgeNodeStatusList } from "@starter/shared/edge/node-status";

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
  /** One entry per node with an open receipt-run alert. */
  receiptRunAlerts: EdgeReceiptRunAlert[];
}

/**
 * Maps the cloud list to the screen's view model. Only `receipt_run_alert`
 * becomes a banner; `device_registry_hard_stale` is not shown yet.
 */
export function mapEdgeNodeStatusList(
  list: EdgeNodeStatusList,
): EdgeNodesOverview {
  const nodes: EdgeNodeRow[] = [];
  const receiptRunAlerts: EdgeReceiptRunAlert[] = [];
  for (const node of list.data) {
    nodes.push({
      id: node.id,
      name: node.label,
      outletName: node.outlet.name,
      link: node.link,
      lastUpdatedAt: node.lastHeartbeatAt,
    });
    const alert = node.alerts.find((a) => a.kind === "receipt_run_alert");
    if (alert)
      receiptRunAlerts.push({
        nodeName: node.label,
        alertAt: alert.lastSeenAt,
      });
  }
  return { nodes, receiptRunAlerts };
}
