// Props shared by every payment panel (method grid excepted). The payment
// screen picks which panel shows from the payment session status.
export type PaymentPanelProps = {
  orderId: string;
  /** Nominal yang sedang dialokasikan ke metode ini (rupiah utuh). */
  amountIdr: number;
  /** Kembali ke pilihan metode. */
  onChangeMethod: () => void;
};
