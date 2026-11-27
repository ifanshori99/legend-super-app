// The total a payer saw on the payment link (pure, no network).
import { idr, type Idr } from "@starter/shared/core";

/**
 * 1272 P2-2: the total (bill + fee) the link view shows for a method and
 * channel, sent with the create call so a price that changed since is refused
 * (409 FEE_CHANGED). Undefined for a method without a fee.
 */
export function shownChargedIdr(
  methods: readonly {
    method: string;
    guestFeeIdr: number | null;
    totalIdr: number | null;
    channels: readonly {
      code: string;
      guestFeeIdr: number | null;
      totalIdr: number | null;
    }[];
  }[],
  method: string,
  channelCode: string | null,
): Idr | undefined {
  const entry = methods.find((item) => item.method === method);
  const price =
    channelCode === null
      ? entry
      : (entry?.channels.find((item) => item.code === channelCode) ?? entry);
  return price && price.guestFeeIdr !== null && price.guestFeeIdr > 0
    ? price.totalIdr === null
      ? undefined
      : idr(price.totalIdr)
    : undefined;
}
