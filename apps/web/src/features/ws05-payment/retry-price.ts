// "Coba lagi" on the return page (1272 K3): before a new payment is made, the
// fee of the method is read again, fresh from the server, so the guest never
// reaches Duitku with a service fee they have not seen.
import { getGuestPaymentOptions } from "@starter/shared/qr-order";
import { callEndpoint } from "@/lib/api/endpoint";
import { fetchPaymentLink } from "./api";
import type { ReturnRecord } from "./return-status";

export type RetryPrice = {
  /** The bill, without the fee. */
  amountIdr: number;
  feeIdr: number;
  /** What the guest pays the gateway. */
  chargedIdr: number;
};

function priceOf(
  priced: { guestFeeIdr: number | null; chargedIdr: number | null } | undefined,
): RetryPrice | null {
  if (!priced || priced.guestFeeIdr === null || priced.chargedIdr === null)
    return null;
  return {
    amountIdr: priced.chargedIdr - priced.guestFeeIdr,
    feeIdr: priced.guestFeeIdr,
    chargedIdr: priced.chargedIdr,
  };
}

/** The method's price for the order or link now; null when it is no longer offered. */
export async function priceForRetry(
  record: ReturnRecord,
): Promise<RetryPrice | null> {
  if (record.kind === "table") {
    if (!record.orderId) return null;
    const { data } = await callEndpoint(getGuestPaymentOptions, {
      params: { sessionId: record.sessionId },
      query: { orderId: record.orderId as never },
    });
    const entry = data.methods.find((item) => item.method === record.method);
    if (!entry?.enabled) return null;
    return priceOf(
      record.method === "ewallet"
        ? entry.banks.find((bank) => bank.code === record.channelCode)
        : entry,
    );
  }
  const link = await fetchPaymentLink(record.linkToken);
  const entry = link.methods.find((item) => item.method === record.method);
  if (!entry?.enabled) return null;
  const channel =
    record.method === "ewallet"
      ? entry.channels.find((item) => item.code === record.channelCode)
      : undefined;
  return priceOf(
    record.method === "ewallet"
      ? channel && {
          guestFeeIdr: channel.guestFeeIdr,
          chargedIdr: channel.totalIdr,
        }
      : { guestFeeIdr: entry.guestFeeIdr, chargedIdr: entry.totalIdr },
  );
}
