// The KirimDev webhook secrets a request is served with (legend-lgfru).
//
// Production reads KIRIM_WEBHOOK_SECRET. createApp's `whatsappWebhookSecrets`
// test override is stored on `app.locals`, so the routes that hand out a
// WhatsApp code (login challenge, payslip PIN reset proof) see the same
// secrets as the webhook that completes it: no secret, no code (503).

import type { Express, Request } from "express";
import { env } from "../config/env";

const LOCAL_KEY = "whatsappWebhookSecrets";

/** Called once by createApp; undefined keeps KIRIM_WEBHOOK_SECRET. */
export function setWhatsAppWebhookSecrets(
  app: Express,
  secrets: readonly string[] | undefined,
): void {
  if (secrets !== undefined) app.locals[LOCAL_KEY] = secrets;
}

export function whatsAppWebhookSecretsOf(req: Request): readonly string[] {
  const override = req.app.locals[LOCAL_KEY] as readonly string[] | undefined;
  return override ?? env.KIRIM_WEBHOOK_SECRET;
}
