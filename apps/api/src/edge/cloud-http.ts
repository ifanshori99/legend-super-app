// HTTP side of the edge's device-registry pull (bead legend-2lp.7; PRD v1.7
// §3 F5). The edge already knows the cloud as a wss://<host>/api/edge-link
// URL; this derives the https:// base and fetches one page of
// GET /api/edge-sync/device-records with the edge credential as a Bearer token.
//
// `cloudGetJson` is the same authenticated GET for other edge-sync paths
// (the bootstrap bundle, legend-khu5).
//
// The credential travels in the Authorization header only: it never reaches a
// URL, an error message or a log line. Errors carry a status/code only, the
// response body is never read into them.

import {
  encodeReceiptRunReport,
  encodeReceiptRunRefusals,
  receiptRunReportQuerySchema,
  type ReceiptRunRefusalReport,
  type ReceiptRunReport,
} from "@starter/shared/edge";
import { logger } from "../lib/logger.ts";

const DEVICE_RECORDS_PATH = "/api/edge-sync/device-records";
const STAFF_PIN_RECORDS_PATH = "/api/edge-sync/staff-pin-records";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 100;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const RECEIPT_REFUSAL_RETRY_MS = 60 * 60 * 1000;
/** legend-rh1hk: how long a cloud that refused `receiptRunsSeq` is not asked again. */
const RECEIPT_RUNS_SEQ_RETRY_MS = 60 * 60 * 1000;
/** legend-rh1hk: the cloud's wire bound: `^(0|[1-9][0-9]{0,14})$`. */
const MAX_RECEIPT_RUNS_SEQ = 999_999_999_999_999;

// Node's fetch honours `cache`, but the Node typings omit it from RequestInit.
type EdgeRequestInit = RequestInit & { cache: "no-store" };

/** wss://h[:p]/api/edge-link -> https://h[:p]; ws:// -> http://. */
export function cloudHttpBaseUrl(linkUrl: string): string {
  let url: URL;
  try {
    url = new URL(linkUrl);
  } catch {
    throw new Error("EDGE_CLOUD_URL is not a valid URL");
  }
  if (url.protocol === "wss:") return `https://${url.host}`;
  if (url.protocol === "ws:") return `http://${url.host}`;
  throw new Error("EDGE_CLOUD_URL must be a ws:// or wss:// URL");
}

/** Status and local validation codes only; never response or request contents. */
export class EdgeCloudHttpError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Edge cloud request failed (${code})`);
    this.name = "EdgeCloudHttpError";
    this.code = code;
  }
}

export type CloudGetOptions = {
  cloudUrl: string;
  credential: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * The cloud's server time, read from the `Date` header of a 2xx response
   * whose body parsed (533b). Not called for a non-2xx, a 304, a missing or
   * unparseable header. A throwing callback is ignored.
   */
  onServerTime?: (serverTime: Date) => void;
};

type CloudGetResult =
  { status: 304 } | { status: 200; body: unknown; headers: Headers };

function reportServerTime(
  headers: Headers,
  onServerTime: CloudGetOptions["onServerTime"],
): void {
  if (!onServerTime) return;
  const header = headers.get("Date");
  if (header === null) return;
  const serverTime = new Date(header);
  if (Number.isNaN(serverTime.getTime())) return;
  try {
    onServerTime(serverTime);
  } catch {
    // A broken evidence sink must not fail the pull.
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  // Reject an advertised oversized response before reading it, but also count
  // the actual bytes: Content-Length can be absent, compressed, or incorrect.
  const contentLength = response.headers.get("Content-Length");
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new EdgeCloudHttpError("RESPONSE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new EdgeCloudHttpError("BAD_JSON");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new EdgeCloudHttpError("RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(
    new TextDecoder().decode(Buffer.concat(chunks, bytes)),
  ) as unknown;
}

async function cloudGet(
  options: CloudGetOptions & {
    path: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    allowNotModified?: boolean;
  },
): Promise<CloudGetResult> {
  const base = cloudHttpBaseUrl(options.cloudUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal ?? new AbortController().signal;

  const request = new AbortController();
  let timedOut = false;
  const onAbort = () => request.abort();
  if (signal.aborted) request.abort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    request.abort();
  }, timeoutMs);

  try {
    const init: EdgeRequestInit = {
      method: "GET",
      headers: {
        ...options.headers,
        Authorization: `Bearer ${options.credential}`,
        Accept: "application/json",
      },
      redirect: "error",
      cache: "no-store",
      signal: request.signal,
    };
    const response = await fetchImpl(`${base}${options.path}`, init);
    if (options.allowNotModified === true && response.status === 304) {
      await response.body?.cancel().catch(() => undefined);
      return { status: 304 };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new EdgeCloudHttpError(`HTTP_${response.status}`);
    }
    let body: unknown;
    try {
      body = await readBoundedJson(response);
    } catch (error) {
      if (error instanceof EdgeCloudHttpError) throw error;
      if (request.signal.aborted) throw error;
      throw new EdgeCloudHttpError("BAD_JSON");
    }
    reportServerTime(response.headers, options.onServerTime);
    return { status: 200, body, headers: response.headers };
  } catch (error) {
    if (error instanceof EdgeCloudHttpError) throw error;
    if (timedOut) throw new EdgeCloudHttpError("TIMEOUT");
    if (signal.aborted) throw new EdgeCloudHttpError("ABORTED");
    throw new EdgeCloudHttpError("NETWORK");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * One authenticated GET of `path` (may carry a query string) on the cloud,
 * returning the parsed JSON body. Errors are EdgeCloudHttpError only.
 */
export async function cloudGetJson(
  options: CloudGetOptions & {
    path: string;
    signal?: AbortSignal;
    /** Extra request headers (never overrides Authorization or Accept). */
    headers?: Record<string, string>;
  },
): Promise<unknown> {
  const result = await cloudGet(options);
  return result.status === 200 ? result.body : undefined;
}

export type CloudConditionalGetResult =
  | { status: 304 }
  | {
      status: 200;
      body: unknown;
      /** The ETag response header as sent, or null when absent. */
      etag: string | null;
      /** The value of `generatedAtHeader`, or null when absent. */
      generatedAt: string | null;
    };

/**
 * Same GET with `If-None-Match: <etag>` when `etag` is given (the people
 * snapshot, design 3.1). A 304 returns `{ status: 304 }` with no body; any
 * other non-2xx is an EdgeCloudHttpError as in `cloudGetJson`.
 */
export async function cloudGetJsonConditional(
  options: CloudGetOptions & {
    path: string;
    signal?: AbortSignal;
    etag: string | null;
    generatedAtHeader?: string;
  },
): Promise<CloudConditionalGetResult> {
  const result = await cloudGet({
    ...options,
    headers: options.etag === null ? {} : { "If-None-Match": options.etag },
    allowNotModified: true,
  });
  if (result.status === 304) return { status: 304 };
  return {
    status: 200,
    body: result.body,
    etag: result.headers.get("ETag"),
    generatedAt:
      options.generatedAtHeader === undefined
        ? null
        : result.headers.get(options.generatedAtHeader),
  };
}

export type DeviceRecordsFetcherOptions = CloudGetOptions & {
  limit?: number;
  /** legend-zsdd: this edge database's instance id, sent with the sequences. */
  edgeInstanceId?: string;
};

export function createDeviceRecordsFetcher(
  options: DeviceRecordsFetcherOptions,
): (
  since: string | null,
  signal: AbortSignal,
  receiptRuns?: ReceiptRunReport,
  refusals?: ReceiptRunRefusalReport,
  receiptRunsSeq?: number,
) => Promise<unknown> {
  // Fail fast on a bad URL when the fetcher is built, as before.
  cloudHttpBaseUrl(options.cloudUrl);
  const limit = options.limit ?? DEFAULT_LIMIT;
  let receiptRefusalsRetryAt = 0;
  let receiptRunsSeqRetryAt = 0;

  const pathFor = (
    since: string | null,
    withSequences: boolean,
    receiptRuns?: ReceiptRunReport,
    refusals?: ReceiptRunRefusalReport,
    withWriteoffs = false,
    receiptRunsSeq?: number,
  ) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (since !== null) query.set("since", since);
    if (withSequences) {
      // legend-3yqy: opt in to the outlet's device receipt sequences; a cloud
      // sends them only on request so older edges keep parsing their pages.
      query.set("receiptSequences", "1");
      // legend-zsdd: names this edge database so the cloud can bind sequences to it.
      if (options.edgeInstanceId !== undefined)
        query.set("edgeInstance", options.edgeInstanceId);
      // legend-yd0h8: this database's local counters, so the cloud can spot a
      // restored or cloned database. Absent = no check (an old edge).
      if (receiptRuns !== undefined)
        query.set("receiptRuns", encodeReceiptRunReport(receiptRuns));
      // legend-rh1hk: the outbox link cursor read in the same transaction as
      // the report, so the cloud can tell a report that is behind a merge from
      // a restored database. Only with `receiptRuns`; the first attempt only.
      if (receiptRuns !== undefined && receiptRunsSeq !== undefined)
        query.set("receiptRunsSeq", String(receiptRunsSeq));
      // legend-hfq3z: the clash refusals of the previous pull, so the cloud can
      // rotate a refused run. Only sent when there is something to report.
      if (refusals !== undefined && refusals.size > 0)
        query.set("receiptRefused", encodeReceiptRunRefusals(refusals));
      // legend-jcby0: opt in to the outlet's receipt number write-offs. The
      // first attempt of each page carries it, only with an edge instance id
      // (only a bound primary applies them); every retry stage drops it.
      if (withWriteoffs && options.edgeInstanceId !== undefined)
        query.set("receiptWriteoffs", "1");
    }
    return `${DEVICE_RECORDS_PATH}?${query.toString()}`;
  };

  return async (since, signal, receiptRuns, refusals, receiptRunsSeq) => {
    if (
      receiptRuns !== undefined &&
      !receiptRunReportQuerySchema.safeParse(
        encodeReceiptRunReport(receiptRuns),
      ).success
    ) {
      // A malformed local report must not masquerade as an old cloud and
      // silently disable its restored-database check. Do not log its contents.
      logger.error(
        "edge receipt run report is invalid; refusing the cloud pull",
      );
      throw new EdgeCloudHttpError("INVALID_RECEIPT_RUN_REPORT");
    }
    const pendingRefusals =
      Date.now() < receiptRefusalsRetryAt ? undefined : refusals;
    // legend-rh1hk: sent only with a report and an edge instance (the cloud
    // ignores it for any other instance), within the wire bound, and not while
    // a cloud that refused it is being left alone.
    const pendingSeq =
      receiptRuns !== undefined &&
      options.edgeInstanceId !== undefined &&
      receiptRunsSeq !== undefined &&
      Number.isSafeInteger(receiptRunsSeq) &&
      receiptRunsSeq >= 0 &&
      receiptRunsSeq <= MAX_RECEIPT_RUNS_SEQ &&
      Date.now() >= receiptRunsSeqRetryAt
        ? receiptRunsSeq
        : undefined;
    try {
      return await cloudGetJson({
        ...options,
        path: pathFor(
          since,
          true,
          receiptRuns,
          pendingRefusals,
          true,
          pendingSeq,
        ),
        signal,
      });
    } catch (error) {
      // legend-zsdd: an older cloud's strict query refuses `edgeInstance` with
      // 400. Retry the same page once without it and without the sequences
      // (the old cloud's device records and revocations keep flowing). A
      // second failure is thrown as is, so HTTP_400 recovery still sees it.
      // legend-yd0h8: staged. A request that carried `receiptRuns` first
      // retries WITH sequences and `edgeInstance` but without `receiptRuns`
      // (a zsdd cloud); only a second 400
      // drops the sequences too.
      if (
        options.edgeInstanceId === undefined ||
        !(error instanceof EdgeCloudHttpError) ||
        error.code !== "HTTP_400"
      )
        throw error;
      // legend-rh1hk: a request that carried `receiptRunsSeq` first retries the
      // same page with everything except it (writeoffs and refusals kept). If
      // that succeeds the cloud predates the parameter: leave it alone for an
      // hour. A second 400 means something else is refused: the chain below.
      if (pendingSeq !== undefined) {
        logger.warn(
          "cloud refused the receipt run cursor; retrying the page without it",
        );
        try {
          const result = await cloudGetJson({
            ...options,
            path: pathFor(since, true, receiptRuns, pendingRefusals, true),
            signal,
          });
          receiptRunsSeqRetryAt = Date.now() + RECEIPT_RUNS_SEQ_RETRY_MS;
          return result;
        } catch (second) {
          if (
            !(second instanceof EdgeCloudHttpError) ||
            second.code !== "HTTP_400"
          )
            throw second;
        }
      }
      // legend-jcby0: the first request also carried `receiptWriteoffs`. Retry
      // the same page with everything except it (an older cloud); only a
      // second 400 continues into the staged chain below, which never sends it.
      logger.warn(
        "cloud refused the receipt write-off query; retrying the page without it",
      );
      try {
        return await cloudGetJson({
          ...options,
          path: pathFor(since, true, receiptRuns, pendingRefusals),
          signal,
        });
      } catch (second) {
        if (
          !(second instanceof EdgeCloudHttpError) ||
          second.code !== "HTTP_400"
        )
          throw second;
      }
      // legend-hfq3z: a request that carried `receiptRefused` first retries
      // without it but keeps `receiptRuns` (a yd0h8 cloud); only a second 400
      // continues into the staged chain below.
      if (pendingRefusals !== undefined && pendingRefusals.size > 0) {
        logger.warn(
          "cloud refused the receipt run refusal report; retrying the page without it",
        );
        try {
          const result = await cloudGetJson({
            ...options,
            path: pathFor(since, true, receiptRuns),
            signal,
          });
          // Suppress the parameter for an hour only when dropping it succeeds;
          // re-probe after that so a cloud upgrade can resume healing runs.
          // Another failing opt-in must not suppress future refusal reports.
          receiptRefusalsRetryAt = Date.now() + RECEIPT_REFUSAL_RETRY_MS;
          return result;
        } catch (second) {
          if (
            !(second instanceof EdgeCloudHttpError) ||
            second.code !== "HTTP_400"
          )
            throw second;
        }
      }
      if (receiptRuns !== undefined) {
        logger.warn(
          "cloud refused the receipt run report; retrying the page without it",
        );
        try {
          return await cloudGetJson({
            ...options,
            path: pathFor(since, true),
            signal,
          });
        } catch (second) {
          if (
            !(second instanceof EdgeCloudHttpError) ||
            second.code !== "HTTP_400"
          )
            throw second;
        }
      }
      logger.warn(
        "cloud refused the edge instance query; retrying the page without receipt sequences",
      );
      return cloudGetJson({
        ...options,
        path: pathFor(since, false),
        signal,
      });
    }
  };
}

/**
 * One page of GET /api/edge-sync/staff-pin-records (legend-yvhw8). Same
 * credential, timeout and error type as the device records; the response is
 * parsed by the pull, never read into an error (it carries hash material).
 */
export function createStaffPinRecordsFetcher(
  options: DeviceRecordsFetcherOptions & {
    /**
     * legend-ideif, legend-jmsdx: the staff pin pepper versions this edge
     * holds (empty = none). When set, the page request lists them
     * (`peppers=2,3`, `peppers=none` = holds none) and the cloud answers with this
     * outlet's peppers it lacks. Sent only over https: a pepper never travels
     * in clear text.
     */
    pepperHave?: () => readonly number[];
  },
): (since: string | null, signal: AbortSignal) => Promise<unknown> {
  const baseUrl = cloudHttpBaseUrl(options.cloudUrl);
  const limit = options.limit ?? DEFAULT_LIMIT;

  const pathFor = (
    since: string | null,
    withRevision: boolean,
    pepperHave: readonly number[] | null,
  ) => {
    const query = new URLSearchParams({ limit: String(limit) });
    // legend-r11j7: `revision=1` opts in to the cloud attempt revision per
    // record (an older edge's strict parse would refuse it, so the cloud only
    // sends it on request).
    if (withRevision) query.set("revision", "1");
    // `none`, not an empty value: a cloud from before legend-jmsdx reads an
    // empty value as 0 held and answers its tenant-wide v1 pepper, which the
    // edge refuses. It answers 400 to `none` instead, and the fallback below
    // retries the page without the opt-in.
    if (pepperHave !== null)
      query.set(
        "peppers",
        pepperHave.length === 0 ? "none" : pepperHave.join(","),
      );
    if (since !== null) query.set("since", since);
    return `${STAFF_PIN_RECORDS_PATH}?${query.toString()}`;
  };

  return async (since, signal) => {
    const pepperHave =
      options.pepperHave !== undefined && baseUrl.startsWith("https://")
        ? options.pepperHave()
        : null;
    // legend-n758r: an older cloud's strict query refuses `revision` with
    // 400 (legend-ideif: and `peppers`), so the cloud no longer has to be
    // released first. Retry the same page with fewer opt-ins, newest first:
    // revision + peppers, revision only, none. A cloud that knows `peppers`
    // knows `revision`. Without revision the records carry no attemptRevision
    // and the edge compares the counter by value. A failure of the last
    // variant is thrown as is, so the pull's HTTP_400 cursor recovery still
    // sees it. Any other error is not retried.
    const variants: Array<{
      revision: boolean;
      peppers: readonly number[] | null;
    }> = [
      { revision: true, peppers: pepperHave },
      ...(pepperHave !== null ? [{ revision: true, peppers: null }] : []),
      { revision: false, peppers: null },
    ];
    for (const [index, variant] of variants.entries()) {
      try {
        return await cloudGetJson({
          ...options,
          path: pathFor(since, variant.revision, variant.peppers),
          signal,
        });
      } catch (error) {
        const last = index === variants.length - 1;
        if (
          last ||
          !(error instanceof EdgeCloudHttpError) ||
          error.code !== "HTTP_400"
        )
          throw error;
        logger.warn(
          "cloud refused an optional staff pin sync query; retrying the page without it",
        );
      }
    }
    throw new Error("unreachable");
  };
}
