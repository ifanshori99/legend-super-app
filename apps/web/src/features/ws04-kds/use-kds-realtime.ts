// Owns the KDS station realtime client for the lifetime of the component
// (WS-04). kds-page.tsx wires it next to the board polling, which stays as the
// fallback. Mock mode (VITE_API_MOCK) opens no socket.
import type { KitchenFeedEntry } from "@starter/shared/kitchen";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_MOCK } from "@/lib/api/mock-flag";
import { API_URL } from "@/lib/env";
import {
  createKdsRealtimeClient,
  type KdsRealtimeClient,
  type KdsRealtimeStatus,
  type KdsSocket,
} from "./kds-realtime.ts";

export function useKdsRealtime(options: {
  outletId: string;
  stationId: string;
  /** Snapshot cursor the socket resumes from; read when the socket opens. */
  after: number | null;
  enabled?: boolean;
  onTicket: (entry: KitchenFeedEntry) => void;
  /** Reload the snapshot, then call the returned `resume(snapshot.sequence)`. */
  onResync: () => void;
}): {
  status: KdsRealtimeStatus;
  resume(after: number): void;
  /** After "denied": read the tokens again and reconnect from the cursor. */
  reconnect(): void;
} {
  const { outletId, stationId, enabled = true } = options;
  const [status, setStatus] = useState<KdsRealtimeStatus>("stopped");
  const clientRef = useRef<KdsRealtimeClient | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    if (!enabled || API_MOCK || typeof WebSocket === "undefined") return;
    const client = createKdsRealtimeClient({
      apiOrigin: API_URL,
      outletId,
      stationId,
      after: latest.current.after,
      // The client narrows the unknown event payloads itself (same cast as
      // facility-staff/use-panic-alerts.ts).
      socketFactory: (url, protocols) =>
        new WebSocket(url, protocols) as unknown as KdsSocket,
      onTicket: (entry) => latest.current.onTicket(entry),
      onResync: () => latest.current.onResync(),
      onStatus: setStatus,
    });
    clientRef.current = client;
    client.start();
    return () => {
      client.stop();
      clientRef.current = null;
    };
  }, [enabled, outletId, stationId]);

  const resume = useCallback((after: number) => {
    clientRef.current?.resume(after);
  }, []);

  const reconnect = useCallback(() => {
    clientRef.current?.reconnect();
  }, []);

  return { status, resume, reconnect };
}
