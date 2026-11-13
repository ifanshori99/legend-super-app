# Brief legend-52tdq: WhatsApp inbound routing only via kirimdev_sender_mappings

Tier K (access). Branch `fix/kirimdev-inbound-routing` (from fix/kirimdev-sender-mapping c61845cb). No new migration (0471 only if unavoidable). Context: docs/briefs/legend-nqxtb.md.

## Problem

`resolveWhatsAppChannel` (`apps/api/src/services/identity-login.service.ts:108`) builds `routingNumber` from tenant-written
`tenant_integrations.config.phoneNumberId ?? receivingNumber`. That routingNumber is stored on login/proof challenges
(identity-login.service.ts:319, identity-wa-proof.service.ts:196) and compared to the inbound `phone_number_id`
(identity-wa-inbound.service.ts:781, :870; identity-wa-proof.service.ts:510). A tenant can claim a not-yet-claimed
number and receive inbound WhatsApp (login, PIN reset).

## Fix (decided)

- `resolveWhatsAppChannel`: `routingNumber` = `kirimdev_sender_mappings.phone_number_id` of the tenant-wide row
  (`outlet_id IS NULL`) for `context.tenant.tenantId`, read in the same `tx` (tenant RLS allows own row).
  `config.phoneNumberId` is ignored entirely; no fallback to `receivingNumber`.
  No mapping -> `CoreError("SERVICE_UNAVAILABLE", "Masuk dengan WhatsApp belum tersedia untuk tenant ini.")` (fail closed).
  `receivingNumber` (MSISDN shown to the guest) and `keyword` still come from config.
- Every inbound "unrouted"/reject point in identity-wa-inbound.service.ts and identity-wa-proof.service.ts that is caused by
  channel/routing mismatch logs one `warn` with tenantId + reason code only, never a number, sender, or text.
- Do not touch migrations, `platform-integrations.custom.sql`, or the `whatsapp_routing_key` index.

## Test helper (shared by all test writers)

`apps/api/src/test/helpers/kirimdev-sender.ts` exports
`mapKirimdevSender(tenantId: string, phoneNumberId: string, outletId: string | null = null): Promise<void>` — inserts
(or replaces) the mapping in one transaction as the test superuser/admin db used by other helpers, with
`select set_config('app.kirimdev_sender_write','on',true)` first (the table has a write-guard trigger), and
`unmapKirimdevSender(tenantId)`. Existing tests that configure a WhatsApp integration must call
`mapKirimdevSender(tenantId, <the phone_number_id their webhook payloads send>)`; if a test relied on the
receivingNumber fallback, map the receiving-number digits it sends.

## Ownership

- implementer: identity-login.service.ts, identity-wa-inbound.service.ts, identity-wa-proof.service.ts only.
- test-writer NEW: `apps/api/src/test/wa-inbound-sender-mapping.test.ts` (new) + the helper file.
- test-writer FIX-1: wa-login-reply, whatsapp-number-claim, identity-wa-masked-login, identity-login-audit, wa-webhook-replay, ipv6-rate-limit-key, wa-proof.
- test-writer FIX-2: identity-login, identity-merge, login-challenge-rate-limit, member-signin, payslip-pin-wa-reset, identity-wa-login-confirm-required, helpers/identity-isolation.ts.
  (all under apps/api/src/test/). FIX writers import the helper; if it does not exist yet, write against the signature above.

## New tests (fail-first)

1. Tenant A config.phoneNumberId = X, no mapping for A: login challenge issue -> SERVICE_UNAVAILABLE; an inbound webhook message to X is not routed to A (no challenge completed / no session).
2. A mapped to M, config.phoneNumberId = X: inbound to X not routed; inbound to M routed (happy path still works).
3. Same for WA proof flow (identity-wa-proof :510) and PIN reset if it uses the channel.
4. Reject log line contains no number (spy/capture logger if the repo has a pattern; else skip and say so).

## Rules

Heavy only via `heavy`; only the engineer's test-runner runs tests/tsc. Never call real Kirimdev. No pkill.
