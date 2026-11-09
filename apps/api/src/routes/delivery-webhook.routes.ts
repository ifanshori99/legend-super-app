// Delivery platform webhook route (bead legend-5bn3; PRD v1.7 §3.23).
// Stub from D1: `POST /:platform` lands in slice D3.
//
// Server-to-server like routes/identity-wa-webhook.routes.ts: no session, no
// Origin, no tenant middleware. The tenant and outlet come from the platform's
// store id on `delivery_channels`, after the HMAC signature verifies over the
// raw bytes. Mounted in app.ts at /api/webhooks/delivery, before /api.
import { Router } from "express";

export const deliveryWebhookRouter = Router();
