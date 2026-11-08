// HTTP side of the edge's device-registry pull (bead legend-2lp.7; PRD v1.7
// §3 F5). The edge already knows the cloud as a wss://<host>/api/edge-link
// URL; this derives the https:// base and fetches one page of
// GET /api/edge-sync/device-records with the edge credential as a Bearer token.
//
// The credential travels in the Authorization header only: it never reaches a
// URL, an error message or a log line. Errors carry a status/code only, the
// response body is never read into them.

const DEVICE_RECORDS_PATH = "/api/edge-sync/device-records";
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

export type DeviceRecordsFetcherOptions = {
  cloudUrl: string;
  credential: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  limit?: number;
};

export function createDeviceRecordsFetcher(
  options: DeviceRecordsFetcherOptions,
): (since: string | null, signal: AbortSignal) => Promise<unknown> {
  const base = cloudHttpBaseUrl(options.cloudUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;

  return async (since, signal) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (since !== null) query.set("since", since);

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
      const response = await fetchImpl(
        `${base}${DEVICE_RECORDS_PATH}?${query.toString()}`,
        init,
      );
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
  };
}
