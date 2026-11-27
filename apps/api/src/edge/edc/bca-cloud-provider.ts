// EdcProvider over the BCA ECR cloud API (B5a legend-wasr7.23): the server
// calls BCA's gateway, BCA reaches the terminal, no bridge tablet. The agent
// (agent.ts, E1-E7) keeps every money rule; this file maps one sale, inquiry
// or void to one SNAP request (bca-snap-client.ts) and BCA's reply back.
//
// Money rules (docs/design/edc-bridge-protocol.md "Provider bca_cloud"):
// - `partnerReferenceNo` = the agent's trace: fixed per payment attempt, so an
//   inquiry names the same sale. `X-EXTERNAL-ID` is new on every request.
// - The amount comes only from `request.amountIdr` (the server-side bill).
//   An approval counts only with BCA's amount echo (the agent compares).
// - Nothing sent (no usable token): `sale` rejects with `edcNotSentError()`
//   and the agent records `failed` "never sent".
// - Sent, then any doubt = `EcrTransportError` (the agent records `unknown`
//   and inquires; never `failed`): `202IS00` (in process), `504IS00`
//   (BCA timeout), our timeout, a network error, 5xx, an unreadable reply,
//   a reply for another reference. `409IS00` (external id reused) is a bug
//   here: `unknown` plus an ops alert.
// - Only a 4xx that BCA answers before processing (400, 401, 403, 404, 429,
//   HTTP status and response code agreeing) ends a sale `declined`, with
//   BCA's code as evidence. A 401 also drops the cached token.
// - Void (`transType` 08) resolves `cancelled` only on BCA's success; any
//   other answer is an `EcrTransportError`. There is no cancel: a sale
//   waiting for the customer cannot be cancelled here (`cancelInProgress`
//   false), so `cancel` always throws.
// - An inquiry `not_found` carries no batch: the agent keeps a dispatched
//   sale `unknown` and flags it for reconciliation (X2), never `failed`.
// - Logs carry the terminal row, trace, HTTP status and BCA code only: no
//   token, secret, signature, PAN or body.
//
// BCA-DOC: body fields, `transType`/`partnerType` values and the status codes
// follow the public summary and the SNAP standard, not BCA's ECR document
// (not received yet). Each guess is marked `BCA-DOC`.
import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema } from "@starter/shared/core";
import {
  EcrTransportError,
  ecrInquiryResultSchema,
  ecrResultSchema,
  maskedPanSchema,
  type EcrInquiryResult,
  type EcrResult,
  type EcrSaleRequest,
  type EcrTerminal,
  type EcrTraceRequest,
  type EdcProviderCapabilities,
} from "@starter/shared/edc";
import { db as defaultDb } from "../../db/index.ts";
import { paymentEdcTerminals } from "../../db/schema/index.ts";
import { withTenant } from "../../db/tenant.ts";
import { logger } from "../../lib/logger.ts";
import { edcNotSentError, type Database } from "./agent.ts";
import {
  BcaSnapClient,
  BcaSnapTransportError,
  snapResponseCodeOf,
  type BcaSnapClientOptions,
  type BcaSnapConfig,
  type BcaSnapReply,
} from "./bca-snap-client.ts";
import type { CloudEdcProvider } from "./cloud-runtime.ts";
import { EDC_SALE_TIMEOUT_MS } from "./runtime.ts";

export const BCA_ECR_PAYMENT_PATH = "/openapi/v1.0/ecr/payment";
export const BCA_ECR_INQUIRY_PATH = "/openapi/v1.0/ecr/inquiry-status";

// BCA-DOC: `transType` per method (sale) and of a void; `partnerType`.
export const BCA_ECR_TRANS_TYPE = {
  card: "01",
  qris: "31",
  void: "08",
} as const;
const BCA_ECR_PARTNER_TYPE = "1";
const TRACE_TIMEOUT_MS = 15_000;

/** 4xx answered before BCA processed anything: the sale is not charged. */
const REJECTED_BEFORE_PROCESSING = new Set([400, 401, 403, 404, 429]);

// BCA-DOC: SNAP transaction status (`transactionStatus` of a payment,
// `latestTransactionStatus` of an inquiry).
type BcaStatus =
  "approved" | "in_progress" | "cancelled" | "declined" | "not_found";
const BCA_STATUS: Readonly<Record<string, BcaStatus>> = {
  "00": "approved",
  "01": "in_progress",
  "02": "in_progress",
  "03": "in_progress",
  "05": "cancelled",
  "06": "declined",
  "07": "not_found",
};

/** BCA-DOC: partner reference of the void of `trace` (fixed, so a repeated
 * void names the same request). */
export const bcaVoidReference = (trace: string) => `V${trace}`;

export type BcaCloudProviderOptions = BcaSnapClientOptions & {
  db?: Database;
  /** Wait for BCA's reply to a payment request. */
  saleTimeoutMs?: number;
  /** Same for inquiry and void. */
  traceTimeoutMs?: number;
};

type Reply =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "rejected"; responseCode: string }
  | { kind: "doubt" };

const orNull = (value: unknown, pattern: RegExp): string | null =>
  typeof value === "string" && pattern.test(value) ? value : null;

/** BCA-DOC: `amount: { value: "33000.00", currency: "IDR" }`. Null unless
 * whole rupiah in IDR. */
function amountOf(value: unknown): number | null {
  const amount = value as { value?: unknown; currency?: unknown } | null;
  if (!amount || amount.currency !== "IDR") return null;
  const text = orNull(amount.value, /^\d{1,15}\.00$/);
  return text === null ? null : Number(text.slice(0, -3));
}

export class BcaCloudProvider implements CloudEdcProvider {
  readonly bank = "bca" as const;
  readonly capabilities: EdcProviderCapabilities = {
    inquiry: "by_trace",
    cancelInProgress: false,
  };
  readonly #client: BcaSnapClient;
  readonly #db: Database;
  readonly #saleTimeoutMs: number;
  readonly #traceTimeoutMs: number;

  constructor(config: BcaSnapConfig, options: BcaCloudProviderOptions = {}) {
    this.#client = new BcaSnapClient(config, options);
    this.#db = options.db ?? defaultDb;
    this.#saleTimeoutMs = options.saleTimeoutMs ?? EDC_SALE_TIMEOUT_MS;
    this.#traceTimeoutMs = options.traceTimeoutMs ?? TRACE_TIMEOUT_MS;
  }

  /** Ready while an access token is cached: `sale` can then write at once. */
  ready(): boolean {
    return this.#client.hasToken();
  }

  prepare(): Promise<void> {
    return this.#client.prepare();
  }

  /** Outlets with an active `bca_cloud` terminal, every active tenant. */
  async outlets(): Promise<
    ReadonlyArray<{ tenantId: string; outletId: string }>
  > {
    const tenants = await this.#db.execute<{ id: string }>(
      sql`SELECT id FROM app.active_tenant_registry`,
    );
    const found: Array<{ tenantId: string; outletId: string }> = [];
    for (const { id } of tenants.rows) {
      const tenantId = tenantIdSchema.parse(String(id));
      const ctx = establishScopedTenantContext(
        establishTenantContext({ tenantId, brandId: null, source: "job" }),
        { kind: "tenant" },
      );
      const rows = await withTenant(this.#db, ctx, (tx) =>
        tx
          .selectDistinct({ outletId: paymentEdcTerminals.outletId })
          .from(paymentEdcTerminals)
          .where(
            and(
              eq(paymentEdcTerminals.tenantId, tenantId),
              eq(paymentEdcTerminals.connectionKind, "bca_cloud"),
              eq(paymentEdcTerminals.bankCode, "bca"),
              eq(paymentEdcTerminals.status, "active"),
            ),
          ),
      );
      for (const row of rows) found.push({ tenantId, outletId: row.outletId });
    }
    return found;
  }

  sale(request: EcrSaleRequest): Promise<EcrResult> {
    // BCA-DOC: payment request body.
    const sent = this.#client.post(
      BCA_ECR_PAYMENT_PATH,
      {
        partnerReferenceNo: request.trace,
        merchantId: request.terminal.merchantId,
        terminalId: request.terminal.terminalId,
        transType: BCA_ECR_TRANS_TYPE[request.method],
        partnerType: BCA_ECR_PARTNER_TYPE,
        amount: { value: `${request.amountIdr}.00`, currency: "IDR" },
        additionalInfo: { reference: request.reference },
      },
      this.#saleTimeoutMs,
    );
    if (sent === null) return Promise.reject(edcNotSentError());
    return sent.then(
      (reply) => {
        const read = this.#read("sale", request, reply);
        if (read.kind === "rejected")
          return ecrResultSchema.parse({
            outcome: "declined",
            responseCode: read.responseCode,
            trace: request.trace,
          });
        if (read.kind === "doubt") throw doubt();
        const body = read.body;
        if (body.partnerReferenceNo !== request.trace)
          throw this.#mismatch("sale", request);
        const status = statusOf(body.transactionStatus);
        if (
          status === null ||
          status === "in_progress" ||
          status === "not_found"
        )
          throw doubt();
        return this.#result(status, body, request.trace);
      },
      (error: unknown) => {
        throw this.#transport("sale", request, error);
      },
    );
  }

  cancel(): Promise<EcrResult> {
    return Promise.reject(
      new EcrTransportError("protocol", "BCA ECR cloud: no cancel"),
    );
  }

  inquiry(request: EcrTraceRequest): Promise<EcrInquiryResult> {
    const sent = this.#client.post(
      BCA_ECR_INQUIRY_PATH,
      {
        merchantId: request.terminal.merchantId,
        terminalId: request.terminal.terminalId,
        // BCA-DOC: the original sale's transType is not known here; card.
        transType: BCA_ECR_TRANS_TYPE.card,
        partnerType: BCA_ECR_PARTNER_TYPE,
        originalPartnerReferenceNo: request.trace,
      },
      this.#traceTimeoutMs,
    );
    if (sent === null)
      return Promise.reject(
        new EcrTransportError("disconnected", "BCA ECR cloud: no token"),
      );
    return sent.then(
      (reply) => {
        const read = this.#read("inquiry", request, reply);
        if (read.kind !== "ok") throw doubt();
        const body = read.body;
        if (body.originalPartnerReferenceNo !== request.trace)
          throw this.#mismatch("inquiry", request);
        const status = statusOf(body.latestTransactionStatus);
        if (status === null) throw doubt();
        if (status === "in_progress" || status === "not_found")
          return ecrInquiryResultSchema.parse({
            outcome: status,
            trace: request.trace,
          });
        return ecrInquiryResultSchema.parse(
          this.#result(status, body, request.trace),
        );
      },
      (error: unknown) => {
        throw this.#transport("inquiry", request, error);
      },
    );
  }

  void(request: EcrTraceRequest): Promise<EcrResult> {
    const reference = bcaVoidReference(request.trace);
    const sent = this.#client.post(
      BCA_ECR_PAYMENT_PATH,
      {
        partnerReferenceNo: reference,
        originalPartnerReferenceNo: request.trace,
        merchantId: request.terminal.merchantId,
        terminalId: request.terminal.terminalId,
        transType: BCA_ECR_TRANS_TYPE.void,
        partnerType: BCA_ECR_PARTNER_TYPE,
      },
      this.#traceTimeoutMs,
    );
    if (sent === null)
      return Promise.reject(
        new EcrTransportError("disconnected", "BCA ECR cloud: no token"),
      );
    return sent.then(
      (reply) => {
        const read = this.#read("void", request, reply);
        if (read.kind !== "ok") throw doubt();
        if (read.body.partnerReferenceNo !== reference)
          throw this.#mismatch("void", request);
        if (statusOf(read.body.transactionStatus) !== "approved") throw doubt();
        return ecrResultSchema.parse({
          outcome: "cancelled",
          responseCode: snapResponseCodeOf(read.body),
          trace: request.trace,
        });
      },
      (error: unknown) => {
        throw this.#transport("void", request, error);
      },
    );
  }

  /** Classifies BCA's reply. Only a sale may be `rejected`. */
  #read(
    op: "sale" | "inquiry" | "void",
    request: { terminal: EcrTerminal; trace: string },
    reply: BcaSnapReply,
  ): Reply {
    const code = snapResponseCodeOf(reply.body);
    const log = {
      terminalRowId: request.terminal.id,
      trace: request.trace,
      op,
      httpStatus: reply.httpStatus,
      responseCode: code,
    };
    const codeStatus = code === null ? null : Number(code.slice(0, 3));
    if (reply.httpStatus === 401 && codeStatus === 401)
      this.#client.dropToken();
    if (reply.httpStatus === 409 || codeStatus === 409) {
      logger.error(
        { ...log, alert: "edc_bca_cloud_external_id_reused" },
        "BCA ECR cloud answered 409 (external id reused): outcome unknown",
      );
      return { kind: "doubt" };
    }
    if (
      reply.httpStatus === 200 &&
      codeStatus === 200 &&
      reply.body !== null &&
      typeof reply.body === "object"
    )
      return { kind: "ok", body: reply.body as Record<string, unknown> };
    if (
      op === "sale" &&
      code !== null &&
      codeStatus === reply.httpStatus &&
      REJECTED_BEFORE_PROCESSING.has(reply.httpStatus)
    ) {
      logger.warn(log, "BCA ECR cloud refused the sale before processing");
      return { kind: "rejected", responseCode: code };
    }
    logger.warn(log, "BCA ECR cloud reply leaves the outcome unknown");
    return { kind: "doubt" };
  }

  /** A final payment answer, every field checked (no PAN, no free text). */
  #result(
    status: "approved" | "cancelled" | "declined",
    body: Record<string, unknown>,
    trace: string,
  ): EcrResult {
    const masked = maskedPanSchema.safeParse(body.maskedPan);
    const parsed = ecrResultSchema.safeParse({
      outcome: status,
      amountIdr: amountOf(body.amount),
      // BCA-DOC: field names of the payment details.
      approvalCode: orNull(body.approvalCode, /^[A-Za-z0-9]{1,12}$/),
      rrn: orNull(body.rrn, /^[A-Za-z0-9]{1,24}$/),
      cardType: orNull(body.cardType, /^[A-Za-z0-9 _-]{1,20}$/),
      maskedPan: masked.success ? masked.data : null,
      responseCode: snapResponseCodeOf(body),
      invoiceNo: orNull(body.invoiceNo, /^[A-Za-z0-9]{1,20}$/),
      batchNo: orNull(body.batchNo, /^[A-Za-z0-9]{1,20}$/),
      trace,
    });
    if (!parsed.success)
      throw new EcrTransportError("protocol", "BCA ECR cloud: unreadable");
    return parsed.data;
  }

  #mismatch(op: string, request: { terminal: EcrTerminal; trace: string }) {
    logger.warn(
      { terminalRowId: request.terminal.id, trace: request.trace, op },
      "BCA ECR cloud reply names another reference: outcome unknown",
    );
    return doubt();
  }

  #transport(
    op: string,
    request: { terminal: EcrTerminal; trace: string },
    error: unknown,
  ): Error {
    if (error instanceof EcrTransportError) return error;
    const kind =
      error instanceof BcaSnapTransportError ? error.kind : "protocol";
    logger.warn(
      { terminalRowId: request.terminal.id, trace: request.trace, op, kind },
      "BCA ECR cloud gave no reply: outcome unknown",
    );
    return new EcrTransportError(kind, "BCA ECR cloud: no reply");
  }
}

const doubt = () =>
  new EcrTransportError("protocol", "BCA ECR cloud: outcome not final");

function statusOf(value: unknown): BcaStatus | null {
  return typeof value === "string" ? (BCA_STATUS[value] ?? null) : null;
}

/** The `EDC_BCA_CLOUD_*` settings (config/env.ts). */
export type BcaCloudEnv = {
  EDC_BCA_CLOUD_BASE_URL?: string;
  EDC_BCA_CLOUD_CLIENT_ID?: string;
  EDC_BCA_CLOUD_CLIENT_SECRET?: string;
  EDC_BCA_CLOUD_PRIVATE_KEY_PATH?: string;
  EDC_BCA_CLOUD_PARTNER_ID?: string;
  EDC_BCA_CLOUD_CHANNEL_ID?: string;
  BETTER_AUTH_URL: string;
};

/** The provider when every credential is set (env.ts refuses a partial
 * set); null otherwise: `bca_cloud` outlets then get
 * `EDC_AGENT_NOT_READY` and use EDC manual (X1). */
export function createBcaCloudProviderFromEnv(
  values: BcaCloudEnv,
  options: BcaCloudProviderOptions = {},
): BcaCloudProvider | null {
  const {
    EDC_BCA_CLOUD_BASE_URL: baseUrl,
    EDC_BCA_CLOUD_CLIENT_ID: clientId,
    EDC_BCA_CLOUD_CLIENT_SECRET: clientSecret,
    EDC_BCA_CLOUD_PRIVATE_KEY_PATH: keyPath,
    EDC_BCA_CLOUD_PARTNER_ID: partnerId,
    EDC_BCA_CLOUD_CHANNEL_ID: channelId,
  } = values;
  if (
    !baseUrl ||
    !clientId ||
    !clientSecret ||
    !keyPath ||
    !partnerId ||
    !channelId
  )
    return null;
  return new BcaCloudProvider(
    {
      baseUrl,
      clientId,
      clientSecret,
      privateKey: createPrivateKey(readFileSync(keyPath)),
      partnerId,
      channelId,
      // BCA-DOC: ORIGIN = the merchant domain registered with BCA; the API's
      // own origin until BCA says otherwise.
      origin: new URL(values.BETTER_AUTH_URL).origin,
    },
    options,
  );
}
