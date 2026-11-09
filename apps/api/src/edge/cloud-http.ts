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
  type ReceiptRunReport,
} from "@starter/shared/edge";
import { logger } from "../lib/logger.ts";

const DEVICE_RECORDS_PATH = "/api/edge-sync/device-records";
const STAFF_PIN_RECORDS_PATH = "/api/edge-sync/staff-pin-records";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 100;

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

/** code: HTTP_<status>, TIMEOUT, NETWORK, ABORTED or BAD_JSON. */
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
};

/**
 * One authenticated GET of `path` (may carry a query string) on the cloud,
 * returning the parsed JSON body. Errors are EdgeCloudHttpError only.
 */
export async function cloudGetJson(
  options: CloudGetOptions & { path: string; signal?: AbortSignal },
): Promise<unknown> {
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
        Authorization: `Bearer ${options.credential}`,
        Accept: "application/json",
      },
      redirect: "error",
      cache: "no-store",
      signal: request.signal,
    };
    const response = await fetchImpl(`${base}${options.path}`, init);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new EdgeCloudHttpError(`HTTP_${response.status}`);
    }
    try {
      return (await response.json()) as unknown;
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw new EdgeCloudHttpError("BAD_JSON");
    }
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
) => Promise<unknown> {
  // Fail fast on a bad URL when the fetcher is built, as before.
  cloudHttpBaseUrl(options.cloudUrl);
  const limit = options.limit ?? DEFAULT_LIMIT;

  const pathFor = (
    since: string | null,
    withSequences: boolean,
    receiptRuns?: ReceiptRunReport,
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
    }
    return `${DEVICE_RECORDS_PATH}?${query.toString()}`;
  };

  return async (since, signal, receiptRuns) => {
    try {
      return await cloudGetJson({
        ...options,
        path: pathFor(since, true, receiptRuns),
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
  options: DeviceRecordsFetcherOptions,
): (since: string | null, signal: AbortSignal) => Promise<unknown> {
  cloudHttpBaseUrl(options.cloudUrl);
  const limit = options.limit ?? DEFAULT_LIMIT;

  return (since, signal) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (since !== null) query.set("since", since);
    return cloudGetJson({
      ...options,
      path: `${STAFF_PIN_RECORDS_PATH}?${query.toString()}`,
      signal,
    });
  };
}
