// QR order journey texts, part: orders (legend-woz). Composed from one file
// per screen group so parallel workers never edit the same file.
import { qrOrdersBillMessages } from "./qr-orders-bill.ts";
import { qrOrdersStatusMessages } from "./qr-orders-status.ts";

export const qrOrdersMessages = {
  status: qrOrdersStatusMessages,
  bill: qrOrdersBillMessages,
} as const;
