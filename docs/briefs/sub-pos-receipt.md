# Sub-brief: legend-93a receipts (POS-06, POS-07)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-receipt` (branch `ws/pos-receipt`; do not switch). API code under `apps/api/src`. Do not read `.env*`. Do not touch `apps/web/`, `design/`, `packages/shared/` (contract is final), `drizzle/` or other domains. Edit ONLY the files of your slice.

## Already done (read, do not edit)

- Schema: `apps/api/src/db/schema/pos-receipt.ts` — `receiptSequences`, `posReceipts`, `posReceiptLinks`, `posReceiptDeliveries`, `posInvoices`. DB triggers in `pos-receipt.custom.sql` (migrations 0063/0064): receipts never deleted, number immutable, only issued→voided + reprint_count++; receipt INSERT must match its sequence (prefix, device, outlet, `sequence_number <= last_number`); sequence last_number never decreases; links/invoices append-only.
- Contract (final): `packages/shared/src/pos/receipts.ts` (formatReceiptNumber, nextReceiptNumber, mergeDeviceReceiptSequence, receiptGaps, assertGaplessReceipts), `packages/shared/src/pos/schemas.ts` (~1110-1175 receiptSequenceSchema/posReceiptSchema; ~1300-1490 document/invoice/delivery/link schemas), `packages/shared/src/pos/endpoints.ts:455-430` (issuePosReceipt, getPosReceiptDocument, getPosReceiptByNumber, createPosReceiptLink, createPosInvoice). Errors: `PosError("RECEIPT_SEQUENCE_GAP" | "RECEIPT_SEQUENCE_REGRESSION" | "RECEIPT_PREFIX_MISMATCH" | "RECEIPT_ALREADY_VOIDED")`, generic `CoreError(code, msgIndonesian)`.
- Port to implement: `PosReceiptPort` in `apps/api/src/services/pos-order-ports.ts` (issueForSale / findForOrder / voidForOrder, all `(tx, ScopedTenantContext, …)` inside the caller's order transaction). Callers: `pos-order.service.ts:1107` (completion), `pos-order-corrections.ts:211` (linked void).
- Patterns: `withTenant(db, context, tx => …)` in `db/tenant.ts`; `Tx` type from `services/permission-resolver.ts`; outlet permission middleware in `routes/pos-order.routes.ts:62-90`; public tenant-from-host routes in `routes/qr.routes.ts`; `sealSecret/openSecret(plaintext|sealed, aad)` in `lib/secrets.ts`; worker job example `worker/menu-print.job.ts`; `EmailProvider` / `emailRequestSchema` in `packages/shared/src/adapters/providers.ts`.

## Design decisions (binding)

1. One `receipt_sequences` row per (tenant, outlet, device). Sale with `deviceId === null` (cloud/back-office POS) uses `deviceId = outletId` as its device key.
2. Missing sequence is auto-provisioned on first sale: take `pg_advisory_xact_lock(hashtextextended('receipt_seq:' || tenant || ':' || outlet, 0))`, then prefix `P1`, `P2`, … first one not used in the outlet. `provisionReceiptSequence` lets a caller set an explicit prefix before the first number (refuse change once lastNumber > 0).
3. Allocation is gapless because it runs in the sale transaction: `UPDATE receipt_sequences SET last_number = last_number + 1, updated_at = now() WHERE tenant_id=… AND id=… RETURNING prefix, last_number` (row lock serializes devices), then INSERT `pos_receipts` with `formatReceiptNumber(prefix, n)`. Idempotent per order: existing receipt for order is returned unchanged. Rollback of the sale rolls back the number. Edge runs the same code on its local Postgres (offline).
4. Void never returns a number: row flips to `voided` with voided_at/void_reason/voided_by. Second void → `PosError("RECEIPT_ALREADY_VOIDED")`.
5. Cloud merge of an offline device run (`mergeDeviceReceiptRun`): lock/create cloud sequence (same prefix, else RECEIPT_PREFIX_MISMATCH), `mergeDeviceReceiptSequence`, update last_number, insert incoming receipts `ON CONFLICT DO NOTHING`, then verify any pre-existing row has the same order/number (else RECEIPT_SEQUENCE_REGRESSION); incoming voided + local issued → apply void. Replay is idempotent.
6. Email: delivery row `status='queued'`, raw address sealed with `sealSecret(email, \`pos_receipt_delivery:${tenantId}:${receiptId}\`)`, `destination_masked`like`o***@example.com`. Worker sends; WhatsApp never.
7. E-receipt link: token = base64url(HMAC-SHA256(key, `receipt-link:${tenantId}:${receiptId}:${idempotencyKey}`)) with key derived from `env.DATA_ENCRYPTION_KEY ?? env.BETTER_AUTH_SECRET` (scrypt/HMAC, like `services/qr-token.ts`), so a replay returns the same URL without storing the token. Store only sha256 hex. Expires 90 days. URL = `${env.BETTER_AUTH_URL}/api/public/receipts/${token}`.
8. Permissions: issue/reprint, link, invoice → `pos.payment.accept`; read document/by-number/pdf → `order.view`. Outlet scope via the same middleware as pos-order routes.
9. Invoice only for an order that has a receipt (contract requires receiptNumber). paymentStatus: receipt voided or any refund → `refunded`, else `paid`.
10. PDF: no new dependency. Minimal hand-written PDF 1.4 (Helvetica, WinAnsi, escaped `()\\`, page break), pure function.

## Interfaces (exact names)

`services/pos-receipt.service.ts` (slice S1):

```ts
export function toPosReceipt(row: typeof posReceipts.$inferSelect): PosReceipt;
export function createPosReceiptPort(): PosReceiptPort;
export function allocateReceipt(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    orderId: string;
    outletId: string;
    deviceId: string | null;
    at: Date;
  },
): Promise<PosReceipt>;
export function findReceiptForOrder(
  tx,
  context,
  orderId: string,
): Promise<PosReceipt | null>;
export function findReceiptById(
  tx,
  context,
  receiptId: string,
): Promise<PosReceipt | null>;
export function findReceiptByNumber(
  tx,
  context,
  outletId: string,
  number: string,
): Promise<PosReceipt | null>;
export function voidReceiptForOrder(
  tx,
  context,
  input: { orderId: string; reason: string; voidedBy: UserId; at: Date },
): Promise<PosReceipt | null>;
export function markReceiptReprinted(
  tx,
  context,
  receiptId: string,
): Promise<PosReceipt>;
export function provisionReceiptSequence(
  tx,
  context,
  input: { outletId: string; deviceId: string; prefix: string },
): Promise<ReceiptSequence>;
export function mergeDeviceReceiptRun(
  tx,
  context,
  input: {
    sequence: {
      outletId: string;
      deviceId: string;
      prefix: string;
      lastNumber: number;
    };
    receipts: PosReceipt[];
  },
): Promise<{ sequence: ReceiptSequence; inserted: number }>;
export function receiptGapsForOutlet(
  tx,
  context,
  outletId: string,
): Promise<
  {
    sequenceId: string;
    deviceId: string;
    prefix: string;
    lastNumber: number;
    missing: number[];
  }[]
>;
```

Also wire `setPosReceiptPort(createPosReceiptPort())` in `apps/api/src/app.ts` next to `setPosOrderPromoPort`.

`services/pos-receipt-document.ts` (S2):

```ts
export function buildReceiptDocument(
  tx: Tx,
  context: ScopedTenantContext,
  receipt: PosReceipt,
  kind?: "receipt" | "kuitansi",
): Promise<ReceiptDocument>;
export function buildInvoiceDocument(
  tx,
  context,
  invoice: typeof posInvoices.$inferSelect,
  receipt: PosReceipt,
): Promise<InvoiceDocument>;
```

Reads order (`orders` in schema/qr-order.ts + pos-order tables: items, tenders (only `captured`/settled ones), discounts not removed, `taxResult`, service charge), outlet name/address (`outlets` in schema/platform-org.ts), cashier name if cheap. Output must `.parse` with the contract schema (totals equal order). If outlet address is missing/short → `CoreError("CONFLICT", …)` (POS-07: never print without address).
`services/pos-receipt-pdf.ts` (S2): `export function renderDocumentPdf(doc: ReceiptDocument | InvoiceDocument): Buffer` — title by kind (STRUK / KUITANSI / INVOICE), outlet name+address, number, date, lines, discounts, service, tax lines, total, tenders, billed-to for invoice. Rupiah format `Rp 12.000`.
`services/pos-receipt-email.ts` (S2): `export function maskEmail(email: string): string`; `export function renderReceiptEmail(doc: ReceiptDocument, linkUrl: string | null): { subject: string; body: string }` (Indonesian copy).

`services/pos-receipt-delivery.service.ts` + `routes/pos-receipt.routes.ts` + `worker/pos-receipt-email.job.ts` (S3): implements the 5 contract endpoints plus

- `GET /api/outlets/:outletId/pos/receipts/:receiptId/pdf?kind=receipt|kuitansi` and `GET /api/outlets/:outletId/pos/invoices/:invoiceId/pdf` (route-local strict zod),
- public `GET /api/public/receipts/:token` (JSON document) and `GET /api/public/receipts/:token/pdf?kind=…` — tenant from host like `qr.routes.ts`, lookup by sha256 within tenant, 404 when unknown/expired (same response for both).
- Issue: order must be completed or voided with a receipt (else `CoreError("CONFLICT")`); deliveries default `["print"]`; `email` required iff `email` channel; a `print` delivery when a print delivery already exists under another idempotency key → `markReceiptReprinted`; replay with same key returns same deliveries/link; `print` and `link` rows are `sent` immediately, `email` is `queued`.
- Worker: `runPosReceiptEmailJob(contexts, deps: { email: EmailProvider }, now?)` — per tenant, `withTenant` (outlet `*`) pick queued email deliveries `FOR UPDATE SKIP LOCKED LIMIT 50`, open sealed address, build doc, create/reuse link, send (reference = delivery id), mark sent or attempts++ (failed with reason after 5). Register in worker runtime only if menu-print is registered there the same way; otherwise leave registration to the lead and say so.
- Register router in `routes/index.ts`.

## Tests (S4, test-writer): `apps/api/src/test/pos-receipt.test.ts`

Follow `apps/api/src/test/pos-order.test.ts` setup (createApp, createIsolatedTenant, roles, owner pool `asOwnerTenant`). Do NOT install `memoryReceiptPort`; use the real port. Cover: gapless numbers 1..n per device, two devices same outlet get distinct prefixes, null device uses outlet sequence, idempotent per order, rollback does not consume a number, concurrent completions (Promise.all) stay gapless/unique, void keeps number + second void refused, DB triggers refuse delete / number change / sequence regression / mismatched insert, merge of offline run (idempotent replay, regression refused, prefix mismatch refused), receiptGapsForOutlet finds a hole, document contains outlet name+address/items/tax/tenders (POS-07), invoice, link + public lookup + expired/unknown 404, email queued then sent by job with FakeEmailProvider (masked destination in DTO), PDF starts `%PDF-`, cross-tenant RLS (other tenant sees 0 rows in all 5 tables, service refuses) and outlet scope (role limited to another outlet gets 403/404).

Run one file: from repo root `pnpm test` runs all; for one file see `scripts/test.mjs` (disposable Postgres via `compose.test.yaml`). Heavy commands need `heavy` prefix.

## Review fixes (round 1)

Done by lead: trigger padding no longer truncates ordinals > 999999 (migration 0064); `pos_receipt_deliveries_email_check` now lets an email row drop `destination_sealed` once it is not `queued` (0063).

F-B (files: services/pos-receipt-delivery.service.ts, routes/pos-receipt.routes.ts, worker/pos-receipt-email.job.ts, app.ts, middleware/public-rate-limit.ts):

1. E-receipt URL = `${env.WEB_URL.replace(/\/+$/, "")}/r/${token}` (same precedent as table QR `floor.service.ts:135`; customer host = tenant domain, web page `/r/$token` is a follow-up FE bead).
2. Add `"/api/public/receipts"` to `PUBLIC_RATE_LIMIT_PATHS`.
3. `safeUrl` in app.ts: also redact the token segment of `/api/public/receipts/<token>` (and `/pdf`) → `/api/public/receipts/[redacted]…`.
4. Email job: one transaction per delivery row (claim one row `FOR UPDATE SKIP LOCKED`, send, mark, commit), loop up to 50; on `sent` or final `failed` set `destination_sealed = NULL`. Provider `reference` stays the delivery id (Brevo idempotency key).
5. Issue replay: same idempotencyKey + `email` channel with a different address (open the sealed one and compare) → `CoreError("IDEMPOTENCY_KEY_REUSED")` like invoices. If the row no longer has a sealed address (already sent), compare the mask instead.
6. Public e-receipt (JSON and PDF via token): `cashierName: null` and every tender `reference: null`. Staff routes unchanged.

F-C (file: services/pos-receipt.service.ts only), `mergeDeviceReceiptRun` hardening:

1. Refuse `deviceId === outletId` (cloud-owned sequence) → `PosError("RECEIPT_PREFIX_MISMATCH")`.
2. `sequence.lastNumber` must be ≤ max(cloud lastNumber, max incoming `sequenceNumber`) → else `RECEIPT_SEQUENCE_GAP`-free reject with `PosError("RECEIPT_SEQUENCE_REGRESSION")`… use `CoreError("VALIDATION_ERROR")` (a device cannot claim numbers it does not send).
3. Stale replay: when `device.lastNumber < cloud.lastNumber`, accept as no-op if every incoming receipt already exists identically (same order, number, status or already voided); otherwise `RECEIPT_SEQUENCE_REGRESSION`.
4. Each incoming receipt's order must exist in `pos_orders` with the same tenant AND outlet → else `RECEIPT_PREFIX_MISMATCH`.
5. Update the header comment accordingly.

F-D (file: test/pos-receipt.test.ts only): add tests for: ordinal 1,000,000 inserts with number `<prefix>-1000000` (provision, advance last_number via owner SQL to 999999, then allocate); merge refuses deviceId=outletId, refuses lastNumber beyond sent receipts, stale replay of an earlier batch is a no-op, refuses order of another outlet; email replay with another address → 409 IDEMPOTENCY_KEY_REUSED; public JSON has cashierName null and tender references null; sealed destination is NULL after job sent/failed; link URL starts with WEB_URL and contains `/r/`. Adjust existing assertions that assumed the old URL.

## Round 2 fixes (second-opinion; CTO brief `legend/docs/briefs/55-fix-pos-receipt-round2.md`)

Done by lead: `pos_receipts.outlet_snapshot` jsonb NOT NULL, type `PosReceiptOutletSnapshot = { outletName; outletAddress; legalName: string | null; npwpLast4: string | null }` exported from `db/schema/pos-receipt.ts`; migration 0063 regenerated. The retained trigger already freezes it.

R2-A (file: `services/pos-receipt.service.ts` only):

1. P1 merge. Rules for `mergeDeviceReceiptRun`:
   - Validate the batch: no duplicate ordinals, every ordinal ≤ `sequence.lastNumber`, number matches prefix, order in same tenant+outlet (existing checks stay).
   - Backfill: an incoming ordinal that is missing in the cloud is inserted, whether it is above or below the cloud `lastNumber` (late/reversed batches are fine). An ordinal already present must be identical (same order, number); else `RECEIPT_SEQUENCE_REGRESSION`. Incoming voided + cloud issued → apply void. Replays are no-ops.
   - Completeness before advancing: the cloud `lastNumber` becomes `max(cloud.last, device.last)` only if every ordinal `1..newLast` exists after this batch (cloud rows ∪ incoming). Otherwise throw `PosError("RECEIPT_SEQUENCE_GAP")` with `details: { missing: number[] }` if PosError supports details (else put them in the message) and write nothing (the device resends the full range). A stale batch (`device.last ≤ cloud.last`) never moves the sequence back and never errors when its rows are backfill/identical.
   - Order of writes: advance sequence first, then insert (trigger needs `sequence_number <= last_number`), all in the caller's tx.
2. P2 snapshot write: add `export async function outletSnapshotFor(tx, context, outletId): Promise<PosReceiptOutletSnapshot>` here (outlets.name/address + legal_entities.name/npwp_last4 via outlets.legal_entity_id, tenant-filtered). `allocateReceipt` writes it. Merge input receipts accept optional `outletSnapshot?: PosReceiptOutletSnapshot` per receipt (edge copy); missing → `outletSnapshotFor` at merge time.

R2-B (file: `services/pos-receipt-document.ts` only): P2 read side. `buildReceiptDocument` / `buildInvoiceDocument` take outlet name and address from the receipt row's `outlet_snapshot` (load the row by receipt id + tenant), never from `outlets`. Keep the POS-07 address-too-short CONFLICT on the snapshot value. Print, PDF, email, e-receipt all go through these builders.

R2-C (files: `middleware/error-handler.ts`, `app.ts`, new test `test/error-handler-decode.test.ts`): P3. A malformed percent-encoding (`/api/public/receipts/<TOKEN>%ZZ`, also any route param) must answer 400 with a fixed generic message (no path, no param echo) and the log entry must not contain the raw path, the param or the URIError message/stack. Find where Express 5 / router raises the decode error (URIError or `Failed to decode param` with status 400) and sanitize it in the error handler (and the request logger if it logs `err`). Test: capture the logger output (see how other tests capture pino, or inject a destination) and assert a secret token string never appears; assert status 400 and body has no token. The test must fail on the current code.

R2-D (file: `test/pos-receipt.test.ts` only): tests that fail on the current code:

- P1: sparse batch `lastNumber=3` with only #3 on an empty cloud → `RECEIPT_SEQUENCE_GAP`, nothing written; then batch #1,#2 `lastNumber=2` → accepted; then #3 `lastNumber=3` → accepted, gaps empty. Reversed: merge #1..#3 then a late replay batch #1,#2 `lastNumber=2` → no-op, no error. Backfill: cloud with a hole below lastNumber (seed via owner SQL bypassing service, e.g. advance last_number and insert #1,#3) → batch with #2 inserts it and `receiptGapsForOutlet` becomes empty. Conflicting ordinal (same ordinal, other order) → `RECEIPT_SEQUENCE_REGRESSION`.
- P2: issue a receipt, then rename outlet and change its address via owner SQL → staff document, PDF text, public e-receipt and email body still show the original name/address; a receipt issued after the rename shows the new one. `outlet_snapshot` UPDATE via owner SQL is refused by the trigger.

## Q4: tax-free orders print (founder decision)

A tax-free order (outlet not PPN/PB1, or every item exempt) prints with no tax
rows. Done in `apps/api/src/services/pos-receipt-document.ts`: `taxLines` is
`[]` when `order.taxIdr` is 0, and a zero-amount tax line is dropped. The
shared `receiptDocumentSchema.taxLines` no longer needs one entry.
`order.taxResult` that is null still answers 409 (tax not computed).

Q4-T test (in `apps/api/src/test/pos-receipt.test.ts`, new `describe`):

- Make a completed sale whose tax is 0 in this isolated tenant without
  changing the tenant-wide PBJT rule other tests use. Example: a menu item
  that no tax rule applies to (read `apps/api/src/db/schema/tax.ts` and the
  tax service for the item class / exemption options).
- Assert:
  - The issued receipt is 200, `document.taxLines` is `[]`, `taxIdr` is 0
    and `totalIdr` adds up.
  - The staff PDF and public PDF hold no tax label (`PBJT`, `PPN`, `PB1`,
    `Pajak`).
  - The email body has no tax row.
  - The public e-receipt's `taxLines` is `[]`.
  - An invoice for the sale is 201 with `taxLines` `[]`.
- Fail-before: the Q4 code is committed on HEAD. Write the old document over it
  with `git show e11caae:apps/api/src/services/pos-receipt-document.ts > apps/api/src/services/pos-receipt-document.ts`.
  Run the test and expect 409. Restore with
  `git checkout HEAD -- apps/api/src/services/pos-receipt-document.ts`.
- Run: `LEGEND_TEST_FILES="src/test/pos-receipt.test.ts" heavy pnpm test`
  from the repo root. Do not commit.
