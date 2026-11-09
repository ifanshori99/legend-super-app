import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isBlockedIp, type HostResolver } from "./url-guard";

// fetch for tenant-owned AI base URLs. Closes the DNS-rebinding gap that
// checkAiUrl alone leaves open: the address the socket connects to is the one
// resolved here, and a blocked address (private, loopback, link-local,
// metadata) is refused at connect time with code EAI_BLOCKED. https only, no
// redirect following (a 3xx comes back as is), `undici` not needed.

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export const defaultHostResolver: HostResolver = (host) =>
  lookup(host, { all: true, verbatim: true });

/**
 * Builds the fetch Response. `new Response` throws RangeError for a status
 * outside 200-599; that is refused here as a plain network-style error.
 */
export function toFetchResponse(
  status: number,
  headers: Headers,
  body: Buffer,
): Response {
  if (!Number.isInteger(status) || status < 200 || status > 599)
    throw new Error(`Unsupported response status ${status}`);
  return new Response(NULL_BODY_STATUSES.has(status) ? null : body, {
    status,
    headers,
  });
}

function blockedError(host: string): Error {
  return Object.assign(new Error(`Blocked address for ${host}`), {
    code: "EAI_BLOCKED",
  });
}

export function createGuardedFetch(
  resolve: HostResolver = defaultHostResolver,
): typeof fetch {
  return (input, init) =>
    new Promise<Response>((resolveResponse, reject) => {
      if (typeof input !== "string" && !(input instanceof URL)) {
        reject(new TypeError("guarded fetch accepts a string or URL only"));
        return;
      }
      let url: URL;
      try {
        url = new URL(input);
      } catch (error) {
        reject(error);
        return;
      }
      if (url.protocol !== "https:") {
        reject(new TypeError("guarded fetch allows https only"));
        return;
      }
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (isIP(host) && isBlockedIp(host)) {
        reject(blockedError(host));
        return;
      }
      const signal = init?.signal ?? undefined;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const rawBody = init?.body;
      let body: Buffer | undefined;
      if (typeof rawBody === "string") body = Buffer.from(rawBody, "utf8");
      else if (rawBody instanceof Uint8Array) body = Buffer.from(rawBody);
      else if (rawBody != null) {
        reject(new TypeError("guarded fetch accepts a string body only"));
        return;
      }
      if (body) headers["content-length"] = String(body.length);

      const req = httpsRequest(
        url,
        {
          method: init?.method ?? "GET",
          headers,
          lookup: (hostname, options, callback) => {
            resolve(hostname).then(
              (addresses) => {
                if (!addresses.length) {
                  callback(
                    Object.assign(new Error(`No address for ${hostname}`), {
                      code: "ENOTFOUND",
                    }) as NodeJS.ErrnoException,
                    "",
                    0,
                  );
                  return;
                }
                if (addresses.some((entry) => isBlockedIp(entry.address))) {
                  callback(
                    blockedError(hostname) as NodeJS.ErrnoException,
                    "",
                    0,
                  );
                  return;
                }
                if (options.all) {
                  // Node's own types for the `all` callback are looser here.
                  (
                    callback as unknown as (
                      error: null,
                      list: { address: string; family: number }[],
                    ) => void
                  )(null, addresses);
                  return;
                }
                callback(null, addresses[0].address, addresses[0].family);
              },
              (error: unknown) =>
                callback(error as NodeJS.ErrnoException, "", 0),
            );
          },
        },
        (res) => {
          try {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_BODY_BYTES) {
                res.destroy(new Error("Response body too large"));
                return;
              }
              chunks.push(chunk);
            });
            res.on("error", reject);
            res.on("end", () => {
              try {
                const status = res.statusCode ?? 0;
                const responseHeaders = new Headers();
                for (const [key, value] of Object.entries(res.headers)) {
                  if (Array.isArray(value))
                    for (const item of value) responseHeaders.append(key, item);
                  else if (value !== undefined) responseHeaders.set(key, value);
                }
                if (
                  init?.redirect === "error" &&
                  status >= 300 &&
                  status < 400
                ) {
                  reject(new TypeError("Redirect refused"));
                  return;
                }
                resolveResponse(
                  toFetchResponse(
                    status,
                    responseHeaders,
                    Buffer.concat(chunks),
                  ),
                );
              } catch (error) {
                reject(error);
              }
            });
          } catch (error) {
            reject(error);
          }
        },
      );
      req.on("error", reject);
      signal?.addEventListener("abort", () => req.destroy(), { once: true });
      // Surface the abort reason (TimeoutError / AbortError), not a socket error.
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
      req.end(body);
    });
}

export const guardedFetch = createGuardedFetch();
