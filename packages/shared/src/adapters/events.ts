/** Domain events raised by the services that wrap an adapter, registered in
 * the WS-00 catalog (`../events/catalog.ts`). Providers never publish events;
 * the calling service does, inside the same transaction as its own write. */
export const adapterEventNames = [
  "provider_webhook.received",
  "wa_inbound_message.received",
  "outbound_message.sent",
  "outbound_message.failed",
  "edc_transaction.created",
  "edc_transaction.settled",
  "edc_transaction.cancelled",
  "wifi_session.authorized",
  "wifi_session.revoked",
  "lock_credential.issued",
  "lock_credential.revoked",
  "delivery_channel.action_executed",
] as const;
export type AdapterEventName = (typeof adapterEventNames)[number];
