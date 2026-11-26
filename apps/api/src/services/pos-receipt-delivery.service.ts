// POS receipt delivery (bead legend-93a, WS-04; PRD v1.7 §3 F11 "Struk &
// Kuitansi"; POS-06, POS-07): issue/reprint of the receipt of a completed or
// voided order, print/link/email deliveries, the e-receipt link, invoices, PDF
// output and the public e-receipt lookup.
//
// - The receipt number is allocated in the sale's transaction by
//   pos-receipt.service.ts; this file never allocates one, it only delivers.
// - Idempotency: a delivery is unique per (receipt, idempotencyKey, channel),
//   a link per (receipt, idempotencyKey), an invoice per (order, key). A replay
//   returns the stored rows.
// - E-receipt link: the token is an HMAC of (tenant, receipt, key), so a replay
//   recomputes the same URL; only its SHA-256 is stored (D-RECEIPT-7).
// - Email: the raw address is sealed for the worker; DTOs carry the mask only.

import { createHash, createHmac, scryptSync } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  assertOutletInScope,
  CoreError,
  toIsoDateTime,
  type OutletId,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  posReceiptIssueResultSchema,
  receiptDeliverySchema,
  RECEIPT_DELIVERY_CHANNELS,
  type InvoiceDocument,
  type PosReceipt,
  type PosReceiptIssueResult,
  type PrintPaperWidth,
  type PrintPayload,
  type ReceiptDelivery,
  type ReceiptDocument,
  type ReceiptLink,
  type ReceiptPrintResult,
} from "@starter/shared/pos";
import { env } from "../config/env.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { db } from "../db/index.ts";
import {
  posInvoices,
  posReceiptDeliveries,
  posReceiptLinks,
} from "../db/schema/pos-receipt.ts";
import { withTenant } from "../db/tenant.ts";
import { openSecret, sealSecret } from "../lib/secrets.ts";
import type { Tx } from "./permission-resolver.ts";
import {
  lockPosOrder,
  notFound as orderNotFound,
} from "./pos-order-support.ts";
import {
  buildInvoiceDocument,
  buildReceiptDocument,
} from "./pos-receipt-document.ts";
import { maskEmail } from "./pos-receipt-email.ts";
import { renderDocumentPdf } from "./pos-receipt-pdf.ts";
import {
  TABLET_PRINT_DESTINATION,
  enqueueReceiptOnEdge,
  receiptPrintPayload,
  receiptPrintResult,
} from "./pos-receipt-edge-print.ts";
import {
  findReceiptById,
  findReceiptByNumber,
  findReceiptForOrder,
  markReceiptReprinted,
} from "./pos-receipt.service.ts";

type DeliveryRow = typeof posReceiptDeliveries.$inferSelect;
type LinkRow = typeof posReceiptLinks.$inferSelect;
type InvoiceRow = typeof posInvoices.$inferSelect;
type Channel = (typeof RECEIPT_DELIVERY_CHANNELS)[number];
type DocumentKind = "receipt" | "kuitansi";

export const RECEIPT_LINK_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_REPRINT_COUNT = 99;
const NOT_PRINTED = "not_printed" satisfies ReceiptPrintResult;
const LINK_KEY_CONTEXT = "legend:receipt-link:v1";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

const receiptNotFound = () =>
  new CoreError("NOT_FOUND", "Struk tidak ditemukan.");

// ---- Link token ------------------------------------------------------------------

let cachedLinkKey: Buffer | undefined;

function linkKey(): Buffer {
  if (cachedLinkKey) return cachedLinkKey;
  cachedLinkKey = scryptSync(
    env.DATA_ENCRYPTION_KEY ?? env.BETTER_AUTH_SECRET,
    LINK_KEY_CONTEXT,
    32,
  );
  return cachedLinkKey;
}

/** Deterministic: the same (tenant, receipt, key) always yields one token. */
export function receiptLinkToken(
  tenantId: string,
  receiptId: string,
  idempotencyKey: string,
): string {
  return createHmac("sha256", linkKey())
    .update(`receipt-link:${tenantId}:${receiptId}:${idempotencyKey}`, "utf8")
    .digest("base64url");
}

export function receiptLinkTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function receiptLinkUrl(token: string): string {
  // Same precedent as the table QR (floor.service.ts): the customer lands on
  // the tenant's web host, whose /r/$token page reads the public API.
  return `${env.WEB_URL.replace(/\/+$/, "")}/r/${token}`;
}

// ---- DTO mapping -----------------------------------------------------------------

function toDelivery(row: DeliveryRow): ReceiptDelivery {
  // Cloud rows written before 1268 B2 say `sent` though nothing was printed.
  // Print rows whose bytes went to the tablet (P1) are marked and stay sent.
  const notPrinted =
    row.channel === "print" &&
    receiptPrintResult() === "not_printed" &&
    row.destinationMasked !== TABLET_PRINT_DESTINATION;
  return receiptDeliverySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    receiptId: row.receiptId,
    channel: row.channel,
    status: notPrinted ? "failed" : row.status,
    destinationMasked: row.destinationMasked,
    sentAt: row.sentAt && !notPrinted ? toIsoDateTime(row.sentAt) : null,
    failureReason: notPrinted ? NOT_PRINTED : row.failureReason,
  });
}

function toLink(row: LinkRow): ReceiptLink {
  const token = receiptLinkToken(
    row.tenantId,
    row.receiptId,
    row.idempotencyKey,
  );
  return {
    receiptId: row.receiptId,
    url: receiptLinkUrl(token),
    expiresAt: toIsoDateTime(row.expiresAt),
  } as ReceiptLink;
}

const channelRank = (channel: string) =>
  RECEIPT_DELIVERY_CHANNELS.indexOf(channel as Channel);

// ---- Loading ---------------------------------------------------------------------

async function receiptInOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: OutletId,
  receiptId: string,
): Promise<PosReceipt> {
  assertOutletInScope(context.outletScope, outletId);
  const receipt = await findReceiptById(tx, context, receiptId);
  if (!receipt || receipt.outletId !== outletId) throw receiptNotFound();
  return receipt;
}

async function deliveriesOf(
  tx: Tx,
  context: ScopedTenantContext,
  receiptId: string,
  idempotencyKey?: string,
): Promise<ReceiptDelivery[]> {
  const rows = await tx
    .select()
    .from(posReceiptDeliveries)
    .where(
      and(
        eq(posReceiptDeliveries.tenantId, context.tenant.tenantId),
        eq(posReceiptDeliveries.receiptId, receiptId),
        idempotencyKey === undefined
          ? undefined
          : eq(posReceiptDeliveries.idempotencyKey, idempotencyKey),
      ),
    )
    .orderBy(asc(posReceiptDeliveries.createdAt));
  return rows
    .sort((a, b) => channelRank(a.channel) - channelRank(b.channel))
    .map(toDelivery);
}

async function linkOf(
  tx: Tx,
  context: ScopedTenantContext,
  receiptId: string,
  idempotencyKey: string,
): Promise<LinkRow | null> {
  const [row] = await tx
    .select()
    .from(posReceiptLinks)
    .where(
      and(
        eq(posReceiptLinks.tenantId, context.tenant.tenantId),
        eq(posReceiptLinks.receiptId, receiptId),
        eq(posReceiptLinks.idempotencyKey, idempotencyKey),
      ),
    );
  return row ?? null;
}

// ---- Link ------------------------------------------------------------------------

/** Creates (or returns) the e-receipt link of `(receipt, idempotencyKey)`. */
export async function ensureReceiptLink(
  tx: Tx,
  context: ScopedTenantContext,
  receipt: PosReceipt,
  idempotencyKey: string,
  createdBy: string | null,
  now: Date,
): Promise<ReceiptLink> {
  const token = receiptLinkToken(
    context.tenant.tenantId,
    receipt.id,
    idempotencyKey,
  );
  await tx
    .insert(posReceiptLinks)
    .values({
      tenantId: context.tenant.tenantId,
      outletId: receipt.outletId,
      receiptId: receipt.id,
      tokenHash: receiptLinkTokenHash(token),
      idempotencyKey,
      expiresAt: new Date(now.getTime() + RECEIPT_LINK_TTL_MS),
      createdBy,
    })
    .onConflictDoNothing();
  const row = await linkOf(tx, context, receipt.id, idempotencyKey);
  if (!row) throw new CoreError("CONFLICT", "Tautan struk gagal dibuat.");
  return toLink(row);
}

export async function createReceiptLink(
  context: ScopedTenantContext,
  caller: { userId: UserId },
  outletId: OutletId,
  receiptId: string,
  idempotencyKey: string,
): Promise<ReceiptLink> {
  return withTenant(db, context, async (tx) => {
    const receipt = await receiptInOutlet(tx, context, outletId, receiptId);
    return ensureReceiptLink(
      tx,
      context,
      receipt,
      idempotencyKey,
      caller.userId,
      new Date(),
    );
  });
}

// ---- Issue / reprint -------------------------------------------------------------

type InsertDelivery = {
  channel: Channel;
  status: "queued" | "sent" | "failed";
  idempotencyKey: string;
  requestedBy: string;
  now: Date;
  email?: string;
  /** Print on the cloud with bytes for the tablet (P1). */
  tablet?: boolean;
};

/** Inserts the delivery of a channel; true when this call created the row. */
async function insertDelivery(
  tx: Tx,
  context: ScopedTenantContext,
  receipt: PosReceipt,
  input: InsertDelivery,
): Promise<boolean> {
  const tenantId = context.tenant.tenantId;
  const rows = await tx
    .insert(posReceiptDeliveries)
    .values({
      tenantId,
      outletId: receipt.outletId,
      receiptId: receipt.id,
      channel: input.channel,
      status: input.status,
      destinationMasked: input.tablet
        ? TABLET_PRINT_DESTINATION
        : input.email === undefined
          ? null
          : maskEmail(input.email),
      destinationSealed:
        input.email === undefined
          ? null
          : sealSecret(
              input.email,
              `pos_receipt_delivery:${tenantId}:${receipt.id}`,
            ),
      idempotencyKey: input.idempotencyKey,
      sentAt: input.status === "sent" ? input.now : null,
      failureReason: input.status === "failed" ? NOT_PRINTED : null,
      requestedBy: input.requestedBy,
    })
    .onConflictDoNothing()
    .returning({ id: posReceiptDeliveries.id });
  return rows.length > 0;
}

/**
 * An email replay must carry the same address. The sealed address is compared
 * once it is open; after the worker sent the row the seal is gone, so the mask
 * is compared instead.
 */
async function assertEmailReplaySame(
  tx: Tx,
  context: ScopedTenantContext,
  receipt: PosReceipt,
  idempotencyKey: string,
  email: string,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const [row] = await tx
    .select({
      destinationMasked: posReceiptDeliveries.destinationMasked,
      destinationSealed: posReceiptDeliveries.destinationSealed,
    })
    .from(posReceiptDeliveries)
    .where(
      and(
        eq(posReceiptDeliveries.tenantId, tenantId),
        eq(posReceiptDeliveries.receiptId, receipt.id),
        eq(posReceiptDeliveries.channel, "email"),
        eq(posReceiptDeliveries.idempotencyKey, idempotencyKey),
      ),
    );
  if (!row) return;
  const same = row.destinationSealed
    ? openSecret(
        row.destinationSealed,
        `pos_receipt_delivery:${tenantId}:${receipt.id}`,
      ) === email
    : row.destinationMasked === maskEmail(email);
  if (!same)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "Kunci idempotensi sudah dipakai untuk alamat email berbeda.",
    );
}

/**
 * Issues (or reprints) the receipt of a completed or voided order and records
 * the requested deliveries. `print` is queued on the outlet edge (the cloud
 * records it as not printed), `link` is done at once and `email` is queued for
 * the worker.
 */
export async function issueReceiptDeliveries(
  context: ScopedTenantContext,
  caller: { userId: UserId },
  outletId: OutletId,
  orderId: string,
  input: {
    deliveries?: readonly Channel[] | undefined;
    email?: string | undefined;
    idempotencyKey: string;
    /** P1: the tablet's printer width; the cloud answers with the bytes. */
    paperWidth?: PrintPaperWidth | undefined;
  },
): Promise<PosReceiptIssueResult> {
  const channels = [...new Set(input.deliveries ?? (["print"] as const))];
  const wantsEmail = channels.includes("email");
  if (wantsEmail && input.email === undefined)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Alamat email wajib diisi untuk pengiriman email.",
    );
  if (!wantsEmail && input.email !== undefined)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Alamat email hanya dipakai bila pengiriman email dipilih.",
    );

  return withTenant(db, context, async (tx) => {
    const now = new Date();
    const tenantId = context.tenant.tenantId;
    const requestedBy = caller.userId;
    const key = input.idempotencyKey;
    // The order row lock serializes two cashiers issuing the same receipt.
    const { order } = await lockPosOrder(tx, context, outletId, orderId);
    if (order.status !== "completed" && order.status !== "voided")
      throw new CoreError(
        "CONFLICT",
        "Struk hanya dapat dicetak untuk pesanan yang selesai atau dibatalkan.",
      );
    let receipt = await findReceiptForOrder(tx, context, orderId);
    if (!receipt)
      throw new CoreError("CONFLICT", "Struk pesanan ini belum diterbitkan.");
    let printDocument: ReceiptDocument | undefined;
    let tabletPrint: PrintPayload | undefined;
    const tabletWidth = getEdgeRuntimeState().edgeMode
      ? undefined
      : input.paperWidth;

    if (channels.includes("print")) {
      const printRows = await tx
        .select({
          id: posReceiptDeliveries.id,
          idempotencyKey: posReceiptDeliveries.idempotencyKey,
        })
        .from(posReceiptDeliveries)
        .where(
          and(
            eq(posReceiptDeliveries.tenantId, tenantId),
            eq(posReceiptDeliveries.receiptId, receipt.id),
            eq(posReceiptDeliveries.channel, "print"),
          ),
        );
      const hadPrint = printRows.length > 0;
      const created = await insertDelivery(tx, context, receipt, {
        channel: "print",
        status:
          receiptPrintResult(tabletWidth) === "not_printed" ? "failed" : "sent",
        idempotencyKey: key,
        requestedBy,
        now,
        tablet: tabletWidth !== undefined,
      });
      // POS-06: a print after the first one is a reprint.
      if (created && hadPrint && receipt.reprintCount < MAX_REPRINT_COUNT)
        receipt = await markReceiptReprinted(tx, context, receipt.id);
      if (created) {
        printDocument = await buildReceiptDocument(tx, context, receipt);
        await enqueueReceiptOnEdge(
          tx,
          context,
          printDocument,
          requestedBy,
          key,
        );
      }
      // The bytes are rendered on every call, also on a replay (P1).
      if (tabletWidth !== undefined) {
        printDocument ??= await buildReceiptDocument(tx, context, receipt);
        tabletPrint = receiptPrintPayload(printDocument, tabletWidth);
      }
    }
    if (channels.includes("link")) {
      await ensureReceiptLink(tx, context, receipt, key, requestedBy, now);
      await insertDelivery(tx, context, receipt, {
        channel: "link",
        status: "sent",
        idempotencyKey: key,
        requestedBy,
        now,
      });
    }
    if (wantsEmail && input.email !== undefined) {
      const created = await insertDelivery(tx, context, receipt, {
        channel: "email",
        status: "queued",
        idempotencyKey: key,
        requestedBy,
        now,
        email: input.email,
      });
      if (!created)
        await assertEmailReplaySame(tx, context, receipt, key, input.email);
    }

    const linkRow = await linkOf(tx, context, receipt.id, key);
    return posReceiptIssueResultSchema.parse({
      receipt,
      document:
        printDocument ?? (await buildReceiptDocument(tx, context, receipt)),
      deliveries: await deliveriesOf(tx, context, receipt.id, key),
      link: linkRow ? toLink(linkRow) : null,
      printResult: channels.includes("print")
        ? receiptPrintResult(tabletWidth)
        : null,
      ...(tabletPrint ? { print: tabletPrint } : {}),
    });
  });
}

// ---- Reads -----------------------------------------------------------------------

export async function getReceiptDocument(
  context: ScopedTenantContext,
  outletId: OutletId,
  receiptId: string,
  kind: DocumentKind = "receipt",
): Promise<ReceiptDocument> {
  return withTenant(db, context, async (tx) => {
    const receipt = await receiptInOutlet(tx, context, outletId, receiptId);
    return buildReceiptDocument(tx, context, receipt, kind);
  });
}

export async function getReceiptByNumber(
  context: ScopedTenantContext,
  outletId: OutletId,
  number: string,
): Promise<PosReceiptIssueResult> {
  return withTenant(db, context, async (tx) => {
    assertOutletInScope(context.outletScope, outletId);
    const receipt = await findReceiptByNumber(tx, context, outletId, number);
    if (!receipt) throw receiptNotFound();
    // The link is returned once, at creation; a lookup never carries it.
    return posReceiptIssueResultSchema.parse({
      receipt,
      document: await buildReceiptDocument(tx, context, receipt),
      deliveries: await deliveriesOf(tx, context, receipt.id),
      link: null,
      printResult: null,
    });
  });
}

export type PdfFile = { pdf: Buffer; filename: string };

export async function getReceiptPdf(
  context: ScopedTenantContext,
  outletId: OutletId,
  receiptId: string,
  kind: DocumentKind = "receipt",
): Promise<PdfFile> {
  const document = await getReceiptDocument(context, outletId, receiptId, kind);
  return pdfFile(document);
}

function pdfFile(document: ReceiptDocument | InvoiceDocument): PdfFile {
  const prefix =
    document.documentKind === "invoice"
      ? "invoice"
      : document.documentKind === "kuitansi"
        ? "kuitansi"
        : "struk";
  return {
    pdf: renderDocumentPdf(document),
    filename: `${prefix}-${document.receiptNumber}.pdf`,
  };
}

// ---- Invoice ---------------------------------------------------------------------

/** Contract accepts 15-25 chars; the document needs `99.999.999.9-999.999`. */
function normalizeNpwp(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 15)
    throw new CoreError(
      "VALIDATION_ERROR",
      "NPWP harus terdiri dari 15 digit.",
    );
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}.${digits.slice(8, 9)}-${digits.slice(9, 12)}.${digits.slice(12, 15)}`;
}

export async function createInvoice(
  context: ScopedTenantContext,
  caller: { userId: UserId },
  outletId: OutletId,
  orderId: string,
  input: {
    billedTo: {
      name: string;
      address: string;
      npwp?: string | null | undefined;
    };
    dueDate: string;
    notes?: string | null | undefined;
    idempotencyKey: string;
  },
): Promise<InvoiceDocument> {
  const npwp = normalizeNpwp(input.billedTo.npwp);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    await lockPosOrder(tx, context, outletId, orderId);
    const receipt = await findReceiptForOrder(tx, context, orderId);
    if (!receipt)
      throw new CoreError(
        "CONFLICT",
        "Invoice hanya dapat dibuat untuk pesanan yang sudah memiliki struk.",
      );
    const values = {
      tenantId,
      outletId,
      orderId,
      receiptId: receipt.id,
      billedToName: input.billedTo.name,
      billedToAddress: input.billedTo.address,
      billedToNpwp: npwp,
      dueDate: input.dueDate,
      notes: input.notes ?? null,
      idempotencyKey: input.idempotencyKey,
      createdBy: caller.userId,
    };
    await tx.insert(posInvoices).values(values).onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(posInvoices)
      .where(
        and(
          eq(posInvoices.tenantId, tenantId),
          eq(posInvoices.orderId, orderId),
          eq(posInvoices.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (!row) throw new CoreError("CONFLICT", "Invoice gagal dibuat.");
    if (
      row.billedToName !== values.billedToName ||
      row.billedToAddress !== values.billedToAddress ||
      row.billedToNpwp !== values.billedToNpwp ||
      row.dueDate !== values.dueDate ||
      row.notes !== values.notes
    )
      throw new CoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi sudah dipakai untuk invoice dengan isi berbeda.",
      );
    return buildInvoiceDocument(tx, context, row, receipt);
  });
}

export async function getInvoicePdf(
  context: ScopedTenantContext,
  outletId: OutletId,
  invoiceId: string,
): Promise<PdfFile> {
  const document = await withTenant(db, context, async (tx) => {
    assertOutletInScope(context.outletScope, outletId);
    const row: InvoiceRow | undefined = (
      await tx
        .select()
        .from(posInvoices)
        .where(
          and(
            eq(posInvoices.tenantId, context.tenant.tenantId),
            eq(posInvoices.id, invoiceId),
            eq(posInvoices.outletId, outletId),
          ),
        )
    )[0];
    if (!row) throw orderNotFound("Invoice tidak ditemukan.");
    const receipt = await findReceiptById(tx, context, row.receiptId);
    if (!receipt) throw receiptNotFound();
    return buildInvoiceDocument(tx, context, row, receipt);
  });
  return pdfFile(document);
}

// ---- Public e-receipt ------------------------------------------------------------

/** Unknown, malformed and expired tokens answer the same 404. */
async function receiptOfToken(
  tx: Tx,
  context: ScopedTenantContext,
  token: string,
  now: Date,
): Promise<PosReceipt> {
  if (!TOKEN_PATTERN.test(token)) throw receiptNotFound();
  const [link] = await tx
    .select()
    .from(posReceiptLinks)
    .where(
      and(
        eq(posReceiptLinks.tenantId, context.tenant.tenantId),
        eq(posReceiptLinks.tokenHash, receiptLinkTokenHash(token)),
      ),
    );
  if (!link || link.expiresAt.getTime() <= now.getTime())
    throw receiptNotFound();
  const receipt = await findReceiptById(tx, context, link.receiptId);
  if (!receipt) throw receiptNotFound();
  return receipt;
}

export async function getPublicReceiptDocument(
  context: ScopedTenantContext,
  token: string,
  kind: DocumentKind = "receipt",
  now = new Date(),
): Promise<ReceiptDocument> {
  return withTenant(db, context, async (tx) => {
    const receipt = await receiptOfToken(tx, context, token, now);
    const document = await buildReceiptDocument(tx, context, receipt, kind);
    // A bearer link reaches the customer and whoever they forward it to: no
    // staff name and no payment reference (card/EDC/transfer ids).
    return {
      ...document,
      cashierName: null,
      tenders: document.tenders.map((tender) => ({
        ...tender,
        reference: null,
      })),
    };
  });
}

export async function getPublicReceiptPdf(
  context: ScopedTenantContext,
  token: string,
  kind: DocumentKind = "receipt",
  now = new Date(),
): Promise<PdfFile> {
  return pdfFile(await getPublicReceiptDocument(context, token, kind, now));
}
