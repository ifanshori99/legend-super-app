// Props shared by the bill adjustment panels (voucher, member points). The
// server prices every discount and redemption; a panel only shows amounts
// from responses and reports back when the bill changed (brief 936).
export type AdjustmentPanelProps = {
  orderId: string;
  /** The server accepted the adjustment; the session query is refreshed. */
  onDone: () => void;
  onCancel: () => void;
};
