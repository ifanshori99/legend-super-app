// The one name of an expo order, used on its card, in the runner dialog and in
// the toast: the table for dine-in, the pickup number for takeaway/delivery.
import type { ExpoTicket } from "@starter/shared/kitchen";
import type { MessageKey, Translate } from "@starter/shared/i18n";

const CHANNEL_LABELS: Record<ExpoTicket["channel"], MessageKey> = {
  dine_in: "channel.dineIn",
  takeaway: "channel.takeaway",
  gofood: "channel.gofood",
  grabfood: "channel.grabfood",
  shopeefood: "channel.shopeefood",
  reservation: "channel.reservation",
};

export function expoTargetLabel(ticket: ExpoTicket, t: Translate): string {
  if (ticket.tableLabel !== null)
    return t("expo.tableLabel", { table: ticket.tableLabel });
  if (ticket.pickupNumber !== null)
    return t("expo.pickupLabel", { number: ticket.pickupNumber });
  // An order that is neither at a table nor numbered is still identifiable by
  // its channel; the API always sends one of the three.
  return t(CHANNEL_LABELS[ticket.channel]);
}
