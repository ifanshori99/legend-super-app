// Edge -> cloud device heartbeat sender (bead legend-2lp.10). Unit test over an
// injected fetch: the request shape, the credential in the header only, errors
// surfaced as EdgeCloudHttpError (status/code only, no body or credential), and
// the abort signal. The runtime's `upsyncDeviceHeartbeats` wrapper is a closure
// inside runtime.ts (not exported), so its log-and-never-throw behaviour is not
// tested here; the sender must reject so that wrapper can catch and log.
import { describe, expect, it } from "vitest";
import {
  createDeviceHeartbeatSender,
  EdgeCloudHttpError,
} from "../edge/cloud-http.ts";

const CLOUD_URL = "wss://cloud.example.test/api/edge-link";
const CREDENTIAL = "edge-secret-credential";
const DEVICES = [
  {
    id: "0192f3a0-1111-7000-8000-000000000001",
    lastSeenAt: "2026-11-19T08:00:00.000Z",
  },
  {
    id: "0192f3a0-2222-7000-8000-000000000002",
    lastSeenAt: "2026-11-19T08:01:30.000Z",
  },
];

type Seen = { url: string; init: RequestInit };

function stubSender(reply: (init: RequestInit) => Promise<Response>) {
  const seen: Seen[] = [];
  const send = createDeviceHeartbeatSender({
    cloudUrl: CLOUD_URL,
    credential: CREDENTIAL,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = init ?? {};
      seen.push({ url: String(input), init: request });
      return reply(request);
    }) as typeof fetch,
  });
  return { send, seen };
}

const jsonOk = () =>
  Promise.resolve(
    new Response(JSON.stringify({ updated: 2 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );

describe("legend-2lp.10 edge device heartbeat sender", () => {
  it("POSTs the devices to the cloud heartbeat path with the Bearer credential", async () => {
    const { send, seen } = stubSender(jsonOk);

    const answer = await send(DEVICES);

    expect(answer).toEqual({ updated: 2 });
    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect(call!.url).toBe(
      "https://cloud.example.test/api/edge-sync/device-heartbeats",
    );
    expect(call!.init.method).toBe("POST");
    const headers = call!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(call!.init.body))).toEqual({ devices: DEVICES });
    // The credential travels in the header only, never in the URL or body.
    expect(call!.url).not.toContain(CREDENTIAL);
    expect(String(call!.init.body)).not.toContain(CREDENTIAL);
  });

  it("surfaces a non-2xx answer as EdgeCloudHttpError carrying the status only", async () => {
    const { send } = stubSender(() =>
      Promise.resolve(
        new Response(JSON.stringify({ secret: "do-not-leak" }), {
          status: 503,
        }),
      ),
    );

    const error = await send(DEVICES).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeCloudHttpError);
    expect((error as EdgeCloudHttpError).code).toBe("HTTP_503");
    expect((error as Error).message).not.toContain("do-not-leak");
    expect((error as Error).message).not.toContain(CREDENTIAL);
  });

  it("surfaces a network failure as a NETWORK EdgeCloudHttpError", async () => {
    const { send } = stubSender(() =>
      Promise.reject(new TypeError("fetch failed")),
    );

    const error = await send(DEVICES).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeCloudHttpError);
    expect((error as EdgeCloudHttpError).code).toBe("NETWORK");
  });

  it("stops a request in flight when the caller's signal aborts", async () => {
    const { send } = stubSender(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const controller = new AbortController();

    const pending = send(DEVICES, controller.signal).catch((e: unknown) => e);
    controller.abort();
    const error = await pending;

    expect(error).toBeInstanceOf(EdgeCloudHttpError);
    expect((error as EdgeCloudHttpError).code).toBe("ABORTED");
  });

  it("does not send when the signal is already aborted", async () => {
    const { send } = stubSender(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          if (init.signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
          }
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const controller = new AbortController();
    controller.abort();

    const error = await send(DEVICES, controller.signal).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(EdgeCloudHttpError);
    expect((error as EdgeCloudHttpError).code).toBe("ABORTED");
  });

  it("rejects an invalid cloud URL before any request", async () => {
    let called = false;
    const send = createDeviceHeartbeatSender({
      cloudUrl: "https://cloud.example.test/api/edge-link",
      credential: CREDENTIAL,
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as typeof fetch,
    });

    await expect(send(DEVICES)).rejects.toThrow(
      "EDGE_CLOUD_URL must be a ws:// or wss:// URL",
    );
    expect(called).toBe(false);
  });
});
