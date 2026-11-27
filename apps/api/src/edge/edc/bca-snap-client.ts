// SNAP (Standar Nasional Open API Pembayaran) client for the BCA ECR cloud
// API (B5a legend-wasr7.23; docs/design/edc-auto-cloud.md "Temuan
// dokumentasi ECR online", docs/design/edc-bridge-protocol.md "Provider
// bca_cloud").
//
// - Access token: OAuth2 client_credentials, asymmetric signature (RSA
//   SHA-256 over `clientId|timestamp`). Cached until it expires minus 60 s.
// - Transaction: symmetric signature (HMAC-SHA512 with the client secret over
//   `METHOD:path:token:sha256(minified body):timestamp`), a new
//   `X-EXTERNAL-ID` per request, `X-PARTNER-ID`, `CHANNEL-ID`, `ORIGIN`.
// - `post` starts the HTTPS request in the tick it is called (the agent's
//   "sale on the wire when `sale` is called" rule): the token must already be
//   cached. Without one nothing is sent and `post` returns null.
// - Nothing secret is logged: no token, secret, signature, private key or
//   body. Errors carry only the HTTP status and BCA response code.
//
// BCA-DOC: the string-to-sign, header names, timestamp format, token path and
// token response fields follow the public SNAP BI standard. They are NOT yet
// checked against BCA's ECR document (founder: partnership form, B0). Every
// such point is marked `BCA-DOC` and pinned by a test vector labelled
// "belum diverifikasi bank" (src/test/edc-bca-cloud.test.ts).
import {
  createHash,
  createHmac,
  createSign,
  randomInt,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import { logger } from "../../lib/logger.ts";

export type BcaSnapConfig = {
  /** `https://` origin (and optional path prefix) of the BCA gateway. */
  readonly baseUrl: string;
  /** `X-CLIENT-KEY` of the token request. */
  readonly clientId: string;
  /** HMAC key of the transaction signature. */
  readonly clientSecret: string;
  /** RSA private key of the token signature. */
  readonly privateKey: KeyObject;
  readonly partnerId: string;
  readonly channelId: string;
  /** `ORIGIN` header: the merchant domain registered with BCA. */
  readonly origin: string;
};

// BCA-DOC: SNAP B2B token path.
export const BCA_SNAP_TOKEN_PATH = "/openapi/v1.0/access-token/b2b";
/** A token is used only while it has more than this left. */
export const BCA_SNAP_TOKEN_MARGIN_MS = 60_000;
const TOKEN_TIMEOUT_MS = 15_000;
/** After a failed token request, wait this long before a background retry. */
const TOKEN_RETRY_MS = 5_000;

// ------------------------------------------------------------ signatures

/** BCA-DOC: SNAP `X-TIMESTAMP`, ISO 8601 with offset, shown in WIB (+07:00). */
export function snapTimestamp(at: Date): string {
  const wib = new Date(at.getTime() + 7 * 3_600_000);
  return `${wib.toISOString().slice(0, 19)}+07:00`;
}

/** BCA-DOC: the body as sent, minified (JSON.stringify has no whitespace). */
export const minifyJson = (body: unknown): string => JSON.stringify(body);

/** BCA-DOC: string-to-sign of the access token request. */
export const tokenStringToSign = (clientId: string, timestamp: string) =>
  `${clientId}|${timestamp}`;

/** BCA-DOC: asymmetric signature (SHA256withRSA, base64) of the token
 * request. */
export function tokenSignature(
  privateKey: KeyObject,
  clientId: string,
  timestamp: string,
): string {
  return createSign("RSA-SHA256")
    .update(tokenStringToSign(clientId, timestamp), "utf8")
    .sign(privateKey, "base64");
}

/** BCA-DOC: string-to-sign of a transaction request. */
export function transactionStringToSign(input: {
  method: string;
  path: string;
  accessToken: string;
  body: string;
  timestamp: string;
}): string {
  const bodyHash = createHash("sha256")
    .update(input.body, "utf8")
    .digest("hex")
    .toLowerCase();
  return `${input.method.toUpperCase()}:${input.path}:${input.accessToken}:${bodyHash}:${input.timestamp}`;
}

/** BCA-DOC: symmetric signature (HMAC-SHA512 with the client secret,
 * base64) of a transaction request. */
export function transactionSignature(
  clientSecret: string,
  input: Parameters<typeof transactionStringToSign>[0],
): string {
  return createHmac("sha512", clientSecret)
    .update(transactionStringToSign(input), "utf8")
    .digest("base64");
}

/** BCA-DOC: `X-EXTERNAL-ID`, numeric, unique per request (a repeat is
 * `409IS00`). 32 digits: milliseconds plus 19 random digits. */
export function newExternalId(now: Date = new Date()): string {
  let random = "";
  while (random.length < 19) random += String(randomInt(0, 10));
  return `${String(now.getTime()).padStart(13, "0")}${random}`.slice(0, 32);
}

// --------------------------------------------------------------- client

/** BCA's reply: the HTTP status and the body (null when not JSON). */
export type BcaSnapReply = {
  readonly httpStatus: number;
  readonly body: unknown;
};

/** No reply was read: the request may or may not have reached BCA. */
export class BcaSnapTransportError extends Error {
  readonly kind: "timeout" | "disconnected";
  constructor(kind: BcaSnapTransportError["kind"], message: string) {
    super(message);
    this.name = "BcaSnapTransportError";
    this.kind = kind;
  }
}

// BCA-DOC: token response fields (SNAP standard).
const tokenReplySchema = z.object({
  accessToken: z.string().min(1).max(4096),
  expiresIn: z.union([z.string().regex(/^\d{1,7}$/), z.number().int()]),
});

/** SNAP response code `HHHSSCC`: HTTP status, service code, case code. */
export const snapResponseCodeOf = (body: unknown): string | null => {
  const code = (body as { responseCode?: unknown } | null)?.responseCode;
  return typeof code === "string" && /^\d{3}[A-Za-z0-9]{2}\d{2}$/.test(code)
    ? code
    : null;
};

export type BcaSnapClientOptions = {
  fetch?: typeof fetch;
  now?: () => Date;
};

export class BcaSnapClient {
  readonly #config: BcaSnapConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  #token: { value: string; expiresAtMs: number } | null = null;
  #refreshing: Promise<void> | null = null;
  #lastFailureMs = Number.NEGATIVE_INFINITY;

  constructor(config: BcaSnapConfig, options: BcaSnapClientOptions = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  #usable(): string | null {
    const token = this.#token;
    if (!token) return null;
    return token.expiresAtMs - BCA_SNAP_TOKEN_MARGIN_MS > this.#now().getTime()
      ? token.value
      : null;
  }

  /** A token is usable now. When not, a background refresh starts (at most
   * one, and not within 5 s of a failed one). */
  hasToken(): boolean {
    if (this.#usable() !== null) return true;
    if (
      this.#refreshing === null &&
      this.#now().getTime() - this.#lastFailureMs >= TOKEN_RETRY_MS
    )
      void this.prepare();
    return false;
  }

  /** Fetches a token unless one is usable. Concurrent calls share one
   * request. Never throws (a failure is logged without secrets). */
  prepare(): Promise<void> {
    if (this.#usable() !== null) return Promise.resolve();
    this.#refreshing ??= this.#fetchToken().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  /** BCA refused the token (`401`): it is not used again. */
  dropToken(): void {
    this.#token = null;
  }

  async #fetchToken(): Promise<void> {
    const at = this.#now();
    const timestamp = snapTimestamp(at);
    let httpStatus: number | undefined;
    let responseCode: string | null = null;
    try {
      const res = await this.#fetch(this.#url(BCA_SNAP_TOKEN_PATH), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-TIMESTAMP": timestamp,
          "X-CLIENT-KEY": this.#config.clientId,
          "X-SIGNATURE": tokenSignature(
            this.#config.privateKey,
            this.#config.clientId,
            timestamp,
          ),
        },
        body: minifyJson({ grantType: "client_credentials" }),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
      httpStatus = res.status;
      const body = parseJson(await res.text());
      responseCode = snapResponseCodeOf(body);
      const parsed = tokenReplySchema.safeParse(body);
      if (res.status !== 200 || !parsed.success)
        throw new Error("token refused");
      const expiresInMs = Number(parsed.data.expiresIn) * 1_000;
      this.#token = {
        value: parsed.data.accessToken,
        expiresAtMs: at.getTime() + expiresInMs,
      };
    } catch {
      this.#lastFailureMs = this.#now().getTime();
      logger.warn(
        { httpStatus, responseCode },
        "BCA ECR cloud: no access token; ECR sales on bca_cloud terminals wait",
      );
    }
  }

  #url(path: string) {
    return `${this.#config.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  /** Signs and sends `body` to `path` in this tick. Null when nothing was
   * sent (no usable token). Resolves with BCA's reply; rejects with
   * `BcaSnapTransportError` when no reply was read (timeout, network). */
  post(
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<BcaSnapReply> | null {
    const accessToken = this.#usable();
    if (accessToken === null) return null;
    const timestamp = snapTimestamp(this.#now());
    const text = minifyJson(body);
    const signal = AbortSignal.timeout(timeoutMs);
    let request: Promise<Response>;
    try {
      request = this.#fetch(this.#url(path), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "X-TIMESTAMP": timestamp,
          "X-SIGNATURE": transactionSignature(this.#config.clientSecret, {
            method: "POST",
            path,
            accessToken,
            body: text,
            timestamp,
          }),
          ORIGIN: this.#config.origin,
          "X-PARTNER-ID": this.#config.partnerId,
          "X-EXTERNAL-ID": newExternalId(this.#now()),
          "CHANNEL-ID": this.#config.channelId,
        },
        body: text,
        signal,
      });
    } catch {
      // fetch threw before it returned a promise: nothing left this process.
      return null;
    }
    return request.then(
      async (res) => {
        let raw: string;
        try {
          raw = await res.text();
        } catch {
          throw transportOf(signal);
        }
        return { httpStatus: res.status, body: parseJson(raw) };
      },
      () => {
        throw transportOf(signal);
      },
    );
  }
}

function transportOf(signal: AbortSignal) {
  return signal.aborted
    ? new BcaSnapTransportError("timeout", "BCA ECR cloud: no reply in time")
    : new BcaSnapTransportError("disconnected", "BCA ECR cloud: no reply");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
