// O4 offline detection (bead legend-wasr7.8, Keputusan CTO O4 no. 2). The
// cafe's wifi can be up while the internet is down, so the browser's own
// signal is not enough:
// - offline at once when the browser says so;
// - offline after FAILURES_TO_OFFLINE pings of the API in a row fail at the
//   network (timeout, refused, DNS). Any HTTP answer, 4xx and 5xx included,
//   proves the network reaches the API: that is online;
// - back online only after a ping succeeds, also when the browser says it is
//   online again.
// The reducer and the ping are pure over injected fetch: Node tests load them.
import { useEffect, useState } from "react";
import { API_MOCK } from "@/lib/api/mock-flag";
import { API_URL } from "@/lib/env";

/** One ping every 5 seconds: two failures in a row is about 10 seconds. */
export const PING_EVERY_MS = 5_000;
/** A ping without an answer in this time counts as a network failure. */
export const PING_TIMEOUT_MS = 4_000;
export const FAILURES_TO_OFFLINE = 2;
export const PING_PATH = "/api/health";

export type Reachability = { online: boolean; failures: number };
export type ReachEvent =
  "browser_offline" | "browser_online" | "ping_ok" | "ping_failed";

export function initialReachability(browserOnline: boolean): Reachability {
  return { online: browserOnline, failures: 0 };
}

export function nextReachability(
  state: Reachability,
  event: ReachEvent,
): Reachability {
  switch (event) {
    case "browser_offline":
      return { online: false, failures: FAILURES_TO_OFFLINE };
    // The browser's word alone never brings the tablet back: a ping must.
    case "browser_online":
      return state;
    case "ping_ok":
      return { online: true, failures: 0 };
    case "ping_failed": {
      const failures = state.failures + 1;
      return {
        online: state.online && failures < FAILURES_TO_OFFLINE,
        failures,
      };
    }
  }
}

type FetchLike = (
  input: string,
  init: {
    signal: AbortSignal;
    cache: "no-store";
    credentials: "omit";
    mode: "no-cors";
  },
) => Promise<unknown>;

/** "ok" on any HTTP answer; "failed" when the network gave none in time. */
export async function pingApi(
  fetchImpl: FetchLike,
  baseUrl: string,
  timeoutMs = PING_TIMEOUT_MS,
): Promise<"ok" | "failed"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(`${baseUrl}${PING_PATH}`, {
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      // Only reachability counts: an opaque answer is enough, and a CORS
      // refusal must not read as a network failure.
      mode: "no-cors",
    });
    return "ok";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether this tablet reaches the API now. The mock has no API to ping, so
 * there only the browser's signal counts.
 */
export function useApiReachable(): boolean {
  const [state, setState] = useState<Reachability>(() =>
    initialReachability(true),
  );
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = (event: ReachEvent) => {
      if (alive) setState((current) => nextReachability(current, event));
    };
    const ping = async () => {
      clearTimeout(timer);
      if (!navigator.onLine) apply("browser_offline");
      else if (API_MOCK) apply("ping_ok");
      else
        apply(
          (await pingApi((url, init) => fetch(url, init), API_URL)) === "ok"
            ? "ping_ok"
            : "ping_failed",
        );
      if (alive) timer = setTimeout(() => void ping(), PING_EVERY_MS);
    };
    const offline = () => apply("browser_offline");
    const online = () => {
      apply("browser_online");
      void ping();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    void ping();
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, []);
  return state.online;
}
