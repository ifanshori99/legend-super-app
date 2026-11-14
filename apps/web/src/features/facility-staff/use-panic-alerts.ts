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

function panicWebSocketUrl(): string {
  const url = new URL(EMERGENCY_WS_PATH, API_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function createMockOptions(): Promise<
  Pick<PanicRealtimeOptions, "socketFactory" | "apiFetch">
> {
  const { createMockPanicSocket } = await import("./panic-mock-socket.ts");
  return {
    socketFactory: createMockPanicSocket(),
    apiFetch: async (path) => {
      const { mockPanicAck } = await import("./mock.ts");
      return mockPanicAck(path);
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

  useEffect(() => {
    let cancelled = false;
    let client: PanicRealtimeClient | null = null;
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
        onStatus: (status) => dispatch({ type: "status", status }),
      });
      clientRef.current = client;
      client.start();
    })();
    return () => {
      cancelled = true;
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
        dispatch({ type: "ack-taken", alertId });
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
