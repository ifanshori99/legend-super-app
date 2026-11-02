// One-shot geolocation for the attendance clock (PRD F25 geofence, Alur L
// step 1). The page sends raw coordinates; the server computes the distance to
// the outlet and never returns it — so this hook only reports whether the
// device produced a fix, and the accuracy it will send.
import { useCallback, useEffect, useState } from "react";

export type GeoLocation = {
  latitude: number;
  longitude: number;
  accuracyM: number;
};

export type GeoState =
  | { status: "idle" }
  | { status: "locating" }
  | { status: "ready"; location: GeoLocation }
  | { status: "denied" }
  | { status: "unavailable" };

export function useGeolocation(enabled: boolean) {
  const [state, setState] = useState<GeoState>({ status: "idle" });

  const request = useCallback(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setState({ status: "unavailable" });
      return;
    }
    setState({ status: "locating" });
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setState({
          status: "ready",
          location: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyM: Number.isFinite(position.coords.accuracy)
              ? Math.round(position.coords.accuracy)
              : 0,
          },
        }),
      (error) =>
        setState({
          status:
            error.code === error.PERMISSION_DENIED ? "denied" : "unavailable",
        }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  }, []);

  useEffect(() => {
    if (enabled) request();
  }, [enabled, request]);

  return { state, request };
}
