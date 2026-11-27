// Duitku wire format (sub-brief 302, Slice W).
//
// From the official docs (https://docs.duitku.com/api/en/):
//   - Sandbox  https://sandbox.duitku.com/webapi/api/merchant/
//     Production https://passport.duitku.com/webapi/api/merchant/
//   - POST JSON: paymentmethod/getpaymentmethod, v2/inquiry, transactionStatus.
//   - Signatures are HMAC-SHA256 keyed by the API key, lowercase hex (MD5 and
//     plain SHA256 are marked obsolete and are not implemented):
//       getpaymentmethod  merchantcode + amount + datetime
//       inquiry           merchantCode + merchantOrderId + paymentAmount
//       transactionStatus merchantCode + merchantOrderId
//       callback          merchantCode + amount + merchantOrderId
//   - The callback (form-urlencoded POST) signature does NOT cover resultCode,
//     so a callback alone never proves payment: confirm with transactionStatus.
//   - transactionStatus statusCode: 00 success, 01 process, 02 failed/expired.
//
// Pure: no DB, `fetch` is injected. Nothing here logs or throws a response
// body, header or secret.

import { createHmac, timingSafeEqual } from "node:crypto";
import { CoreError } from "@starter/shared/core";
import { DUITKU_METHOD_CATEGORY_CODES } from "@starter/shared/platform";
import { z } from "zod";

export type DuitkuEnvironment = "sandbox" | "production";

export type DuitkuCredentials = {
  merchantCode: string;
  apiKey: string;
  environment: DuitkuEnvironment;
};

type DuitkuFetch = typeof fetch;

const REQUEST_TIMEOUT_MS = 15_000;
const MERCHANT_BASE_PATH = "/webapi/api/merchant/";
const BASE_HOSTS: Record<DuitkuEnvironment, string> = {
  sandbox: "https://sandbox.duitku.com",
  production: "https://passport.duitku.com",
};

/** Base URL (trailing slash) of the merchant API for an environment. */
export function duitkuBaseUrl(environment: DuitkuEnvironment): string {
  return `${BASE_HOSTS[environment]}${MERCHANT_BASE_PATH}`;
}

// -- Signatures --------------------------------------------------------------

function hmacHex(message: string, apiKey: string): string {
  return createHmac("sha256", apiKey).update(message).digest("hex");
}

type SigningCredentials = Pick<DuitkuCredentials, "merchantCode" | "apiKey">;

export const signGetPaymentMethod = (
  creds: SigningCredentials,
  amountIdr: number,
  datetime: string,
) => hmacHex(`${creds.merchantCode}${amountIdr}${datetime}`, creds.apiKey);

export const signInquiry = (
  creds: SigningCredentials,
  merchantOrderId: string,
  amountIdr: number,
) =>
  hmacHex(`${creds.merchantCode}${merchantOrderId}${amountIdr}`, creds.apiKey);

export const signTransactionStatus = (
  creds: SigningCredentials,
  merchantOrderId: string,
) => hmacHex(`${creds.merchantCode}${merchantOrderId}`, creds.apiKey);

/** `amount` is the exact text Duitku sent: the signature covers its text. */
export const signCallback = (
  creds: SigningCredentials,
  amount: string,
  merchantOrderId: string,
) => hmacHex(`${creds.merchantCode}${amount}${merchantOrderId}`, creds.apiKey);

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase());
  const y = Buffer.from(b.toLowerCase());
  return x.length === y.length && timingSafeEqual(x, y);
}

// -- Errors and amounts ------------------------------------------------------

export function duitkuUnavailable(): CoreError {
  return new CoreError(
    "SERVICE_UNAVAILABLE",
    "Gateway pembayaran tidak tersedia atau memberi jawaban yang tidak dikenali. Bayar di kasir.",
  );
}

function assertAmountIdr(amountIdr: number): void {
  if (!Number.isSafeInteger(amountIdr) || amountIdr <= 0)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Nominal harus bilangan bulat rupiah.",
    );
}

/** Whole rupiah from Duitku text or number: "150000", or "100000.00"-style
 * decimals with only zero fractions. Anything else is unreadable (null). */
function readAmount(value: string | number): number | null {
  const match = /^(\d{1,12})(\.0{1,2})?$/.exec(String(value));
  return match ? Number(match[1]) : null;
}

const amountField = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const amount = readAmount(value);
    if (amount === null) {
      ctx.addIssue({ code: "custom", message: "Not a rupiah amount" });
      return z.NEVER;
    }
    return amount;
  });

const optionalString = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

// -- HTTP --------------------------------------------------------------------

async function post<T>(
  creds: DuitkuCredentials,
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  doFetch: DuitkuFetch,
): Promise<T> {
  let response: Response;
  try {
    response = await doFetch(`${duitkuBaseUrl(creds.environment)}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw duitkuUnavailable();
  }
  if (!response.ok) throw duitkuUnavailable();
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw duitkuUnavailable();
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw duitkuUnavailable();
  return parsed.data;
}

// -- getpaymentmethod --------------------------------------------------------

export type DuitkuPaymentMethod = {
  code: string;
  name: string;
  imageUrl: string | null;
  totalFee: number;
};

const methodsResponseSchema = z.object({
  responseCode: z.literal("00"),
  paymentFee: z.array(
    z.object({
      paymentMethod: z.string().min(1).max(8),
      paymentName: z.string().min(1).max(100),
      paymentImage: optionalString(500),
      totalFee: amountField,
    }),
  ),
});

export async function duitkuGetPaymentMethods(input: {
  creds: DuitkuCredentials;
  amountIdr: number;
  /** `yyyy-MM-dd HH:mm:ss`, the same text that is signed. */
  datetime: string;
  fetch: DuitkuFetch;
}): Promise<DuitkuPaymentMethod[]> {
  const { creds, amountIdr, datetime } = input;
  assertAmountIdr(amountIdr);
  const data = await post(
    creds,
    "paymentmethod/getpaymentmethod",
    {
      merchantcode: creds.merchantCode,
      amount: amountIdr,
      datetime,
      signature: signGetPaymentMethod(creds, amountIdr, datetime),
    },
    methodsResponseSchema,
    input.fetch,
  );
  return data.paymentFee.map((row) => ({
    code: row.paymentMethod,
    name: row.paymentName,
    imageUrl: row.paymentImage,
    totalFee: row.totalFee,
  }));
}

// -- inquiry -----------------------------------------------------------------

export type DuitkuInquiryResult = {
  reference: string;
  paymentUrl: string;
  vaNumber: string | null;
  qrString: string | null;
  amountIdr: number;
};

const inquiryResponseSchema = z.object({
  statusCode: z.literal("00"),
  reference: z.string().min(1).max(64),
  paymentUrl: z.string().min(1).max(2000),
  vaNumber: optionalString(64),
  qrString: optionalString(4000),
  amount: amountField.optional(),
});

export async function duitkuInquiry(input: {
  creds: DuitkuCredentials;
  merchantOrderId: string;
  amountIdr: number;
  paymentMethod: string;
  productDetails: string;
  email: string;
  customerVaName: string;
  callbackUrl: string;
  returnUrl: string;
  expiryPeriodMinutes?: number;
  fetch: DuitkuFetch;
}): Promise<DuitkuInquiryResult> {
  const { creds, merchantOrderId, amountIdr } = input;
  assertAmountIdr(amountIdr);
  const data = await post(
    creds,
    "v2/inquiry",
    {
      merchantCode: creds.merchantCode,
      paymentAmount: amountIdr,
      paymentMethod: input.paymentMethod,
      merchantOrderId,
      productDetails: input.productDetails.slice(0, 255),
      email: input.email,
      // string(20), required: the name the bank shows before paying.
      customerVaName: input.customerVaName.trim().slice(0, 20) || "Pembayar",
      callbackUrl: input.callbackUrl,
      returnUrl: input.returnUrl,
      ...(input.expiryPeriodMinutes !== undefined
        ? { expiryPeriod: input.expiryPeriodMinutes }
        : {}),
      signature: signInquiry(creds, merchantOrderId, amountIdr),
    },
    inquiryResponseSchema,
    input.fetch,
  );
  // The customer pays `amount`. A merchant-side fee added on top would make
  // the callback amount differ from the intent: refuse it now.
  if (data.amount !== undefined && data.amount !== amountIdr)
    throw duitkuUnavailable();
  return {
    reference: data.reference,
    paymentUrl: data.paymentUrl,
    vaNumber: data.vaNumber,
    qrString: data.qrString,
    amountIdr,
  };
}

// -- transactionStatus -------------------------------------------------------

export type DuitkuStatusCode = "00" | "01" | "02";
export type DuitkuTransactionStatus = {
  statusCode: DuitkuStatusCode;
  status: "paid" | "pending" | "failed";
  reference: string | null;
  amountIdr: number;
};

const STATUS_BY_CODE = {
  "00": "paid",
  "01": "pending",
  "02": "failed",
} as const satisfies Record<
  DuitkuStatusCode,
  DuitkuTransactionStatus["status"]
>;

const statusResponseSchema = z.object({
  merchantOrderId: z.string().min(1).max(50),
  statusCode: z.enum(["00", "01", "02"]),
  reference: optionalString(64),
  amount: amountField,
});

export async function duitkuTransactionStatus(input: {
  creds: DuitkuCredentials;
  merchantOrderId: string;
  fetch: DuitkuFetch;
}): Promise<DuitkuTransactionStatus> {
  const { creds, merchantOrderId } = input;
  const data = await post(
    creds,
    "transactionStatus",
    {
      merchantCode: creds.merchantCode,
      merchantOrderId,
      signature: signTransactionStatus(creds, merchantOrderId),
    },
    statusResponseSchema,
    input.fetch,
  );
  // An answer about another order must never move this one.
  if (data.merchantOrderId !== merchantOrderId) throw duitkuUnavailable();
  return {
    statusCode: data.statusCode,
    status: STATUS_BY_CODE[data.statusCode],
    reference: data.reference,
    amountIdr: data.amount,
  };
}

// -- Callback ----------------------------------------------------------------

const callbackText = (max: number) => z.string().max(max);
const callbackFieldsSchema = z.object({
  merchantCode: callbackText(32).min(1),
  amount: callbackText(32).min(1),
  merchantOrderId: callbackText(50).min(1),
  resultCode: callbackText(8).min(1),
  signature: callbackText(128).min(1),
  productDetail: callbackText(255).optional(),
  additionalParam: callbackText(255).optional(),
  paymentCode: callbackText(8).optional(),
  merchantUserId: callbackText(255).optional(),
  reference: callbackText(64).optional(),
});
export type DuitkuCallbackFields = z.infer<typeof callbackFieldsSchema>;

/** Form fields (all strings) -> typed callback, or null when a required field
 * is missing or any value is not a bounded string. Unknown keys are dropped. */
export function parseDuitkuCallback(
  formFields: unknown,
): DuitkuCallbackFields | null {
  const parsed = callbackFieldsSchema.safeParse(formFields);
  return parsed.success ? parsed.data : null;
}

export type DuitkuCallbackRejection =
  "wrong_merchant" | "bad_signature" | "bad_amount" | "amount_mismatch";
export type DuitkuCallbackVerdict =
  | { ok: true; amountIdr: number }
  | { ok: false; reason: DuitkuCallbackRejection };

/**
 * Checks merchantCode, signature and amount of a parsed callback. `creds` is
 * the current secret first, then a previous one still inside its rotation
 * window; any of them may match. A valid signature proves the sender knows the
 * key, not that the order was paid (resultCode is unsigned): confirm with
 * `duitkuTransactionStatus` before treating it as paid.
 */
export function verifyDuitkuCallback(input: {
  creds: readonly DuitkuCredentials[];
  fields: DuitkuCallbackFields;
  expectedAmountIdr?: number;
}): DuitkuCallbackVerdict {
  const { fields } = input;
  const candidates = input.creds.filter(
    (creds) => creds.merchantCode === fields.merchantCode,
  );
  if (candidates.length === 0) return { ok: false, reason: "wrong_merchant" };
  // Callbacks carry whole rupiah text; the signature covers that exact text.
  if (!/^\d{1,12}$/.test(fields.amount))
    return { ok: false, reason: "bad_amount" };
  const signed = candidates.map((creds) =>
    safeEqualHex(
      fields.signature,
      signCallback(creds, fields.amount, fields.merchantOrderId),
    ),
  );
  if (!signed.some(Boolean)) return { ok: false, reason: "bad_signature" };
  const amountIdr = Number(fields.amount);
  if (
    input.expectedAmountIdr !== undefined &&
    input.expectedAmountIdr !== amountIdr
  )
    return { ok: false, reason: "amount_mismatch" };
  return { ok: true, amountIdr };
}

// -- Method categories -------------------------------------------------------

export type DuitkuMethodCategory =
  "qris" | "va" | "ewallet" | "card" | "retail" | "paylater" | "other";

const CATEGORY_BY_CODE = new Map<string, DuitkuMethodCategory>(
  Object.entries(DUITKU_METHOD_CATEGORY_CODES).flatMap(([category, codes]) =>
    codes.map((code) => [code, category as DuitkuMethodCategory] as const),
  ),
);

/** Static code -> category map (docs "Payment methods"). Which codes are
 * enabled for a merchant always comes from `duitkuGetPaymentMethods`. */
export function duitkuMethodCategory(code: string): DuitkuMethodCategory {
  return CATEGORY_BY_CODE.get(code) ?? "other";
}
