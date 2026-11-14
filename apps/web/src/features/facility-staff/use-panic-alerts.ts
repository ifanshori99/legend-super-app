// Staff panic alerts (WS-02 client + queue reducer). The hook owns the realtime
// client for the lifetime of the component; the screens only read the queue
// state. Mock mode (VITE_API_MOCK) swaps the socket and the ack call for
// scripted ones (panic-mock-socket.ts); components never know.
import { useCallback, useEffect, useReducer, useRef } from "react";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { API_URL } from "@/lib/env";
import {
  initialPanicQueue,
  panicQueueReducer,
  type PanicQueueState,
} from "./panic-queue.ts";
import {
  createPanicRealtimeClient,
  type PanicRealtimeClient,
  type PanicRealtimeOptions,
  type PanicSocket,
} from "./panic-realtime.ts";

const EMERGENCY_WS_PATH = "/api/emergency/ws";
/** Open-alerts catch-up interval while the socket is not open. */
const OPEN_ALERTS_POLL_MS = 15_000;

function panicWebSocketUrl(): string {
  const url = new URL(EMERGENCY_WS_PATH, API_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function createMockOptions(): Promise<
  Pick<PanicRealtimeOptions, "socketFactory" | "apiFetch" | "apiGet">
> {
  const { createMockPanicSocket } = await import("./panic-mock-socket.ts");
  return {
    socketFactory: createMockPanicSocket(),
    apiFetch: async (path) => {
      const { mockPanicAck } = await import("./mock.ts");
      return mockPanicAck(path);
    },
    apiGet: async () => {
      const { mockPanicOpenAlerts } = await import("./mock.ts");
      return mockPanicOpenAlerts();
    },
  };
}

export function usePanicAlerts(): {
  state: PanicQueueState;
  ack(alertId: string): Promise<void>;
  dismiss(alertId: string): void;
} {
  const [state, dispatch] = useReducer(panicQueueReducer, initialPanicQueue);
  const clientRef = useRef<PanicRealtimeClient | null>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    // Catch-up with the server's open alerts (reload, reconnect). The socket
    // stays the main path, so a failed request is silent.
    const sync = () => {
      const current = client;
      if (!current || cancelled) return;
      const knownBefore = stateRef.current.items
        .filter(
          (item) =>
            item.ack === "idle" ||
            item.ack === "failed" ||
            item.ack === "session",
        )
        .map((item) => item.alertId);
      current.openAlerts().then(
        (alerts) => {
          if (cancelled) return;
          dispatch({ type: "sync", alerts, knownBefore });
        },
        () => {},
      );
    };
    let client: PanicRealtimeClient | null = null;
    let socketOpen = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    void (async () => {
      const transport = API_MOCK
        ? await createMockOptions()
        : {
            // The browser WebSocket's handlers take typed events; PanicSocket
            // takes unknown payloads, which the client narrows itself.
            socketFactory: (url: string, protocols: string[]) =>
              new WebSocket(url, protocols) as unknown as PanicSocket,
          };
      if (cancelled) return;
      client = createPanicRealtimeClient({
        url: panicWebSocketUrl(),
        ...transport,
        onAlert: (frame) => dispatch({ type: "alert", frame }),
        onAcknowledged: (frame) => dispatch({ type: "acknowledged", frame }),
        onStatus: (status) => {
          socketOpen = status === "open";
          if (status === "revoked" && poll !== null) clearInterval(poll);
          dispatch({ type: "status", status });
          if (status === "open") sync();
        },
      });
      clientRef.current = client;
      client.start();
      sync();
      // While the socket is down, plain HTTP may still work: keep asking for
      // open alerts so none waits for the socket to come back.
      poll = setInterval(() => {
        if (!socketOpen) sync();
      }, OPEN_ALERTS_POLL_MS);
    })();
    return () => {
      cancelled = true;
      if (poll !== null) clearInterval(poll);
      client?.stop();
      clientRef.current = null;
    };
  }, []);

  const ack = useCallback(async (alertId: string) => {
    const client = clientRef.current;
    if (!client) {
      dispatch({ type: "ack-failed", alertId });
      return;
    }
    dispatch({ type: "ack-start", alertId });
    try {
      await client.ack(alertId);
      dispatch({ type: "ack-ok", alertId });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        dispatch({
          type: "ack-taken",
          alertId,
          byName: error.acknowledgedBy?.displayName ?? null,
          at: error.acknowledgedAt ?? null,
        });
      } else if (error instanceof ApiError && error.status === 401) {
        dispatch({ type: "ack-session", alertId });
      } else {
        dispatch({ type: "ack-failed", alertId });
      }
    }
  }, []);

  const dismiss = useCallback(
    (alertId: string) => dispatch({ type: "dismiss", alertId }),
    [],
  );

  return { state, ack, dismiss };
}
