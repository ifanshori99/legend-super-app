// One-shot/continuous geolocation for the attendance clock (PRD F25 geofence,
// Alur L step 1). The page sends raw coordinates; the server computes the
// distance to the outlet and never returns it — so this hook only reports
// whether the device produced a fix, and the accuracy it will send.
//
// watchPosition (not getCurrentPosition) keeps the fix live while the screen is
// open: an employee who walks closer to the outlet sees the accuracy improve.
// The watch is cleared after the first fix that the page can use.
import { useCallback, useEffect, useRef, useState } from "react";

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

function supportsGeolocation(): boolean {
  return typeof navigator !== "undefined" && "geolocation" in navigator;
}

export function useGeolocation(enabled: boolean) {
  const [state, setState] = useState<GeoState>(() =>
    supportsGeolocation()
      ? { status: enabled ? "locating" : "idle" }
      : { status: "unavailable" },
  );
  const watchId = useRef<number | null>(null);

  const clearWatch = useCallback(() => {
    if (watchId.current === null) return;
    navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
  }, []);

  const onPosition = useCallback(
    (position: GeolocationPosition) => {
      clearWatch();
      setState({
        status: "ready",
        location: {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyM: Number.isFinite(position.coords.accuracy)
            ? Math.round(position.coords.accuracy)
            : 0,
        },
      });
    },
    [clearWatch],
  );

  const onError = useCallback(
    (error: GeolocationPositionError) => {
      clearWatch();
      setState({
        status:
          error.code === error.PERMISSION_DENIED ? "denied" : "unavailable",
      });
    },
    [clearWatch],
  );

  useEffect(() => {
    if (!enabled || !supportsGeolocation()) return;
    watchId.current = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      timeout: 15_000,
      maximumAge: 0,
    });
    return clearWatch;
  }, [enabled, onPosition, onError, clearWatch]);

  /** A deliberate retry from the screen ("Periksa ulang"). */
  const request = useCallback(() => {
    if (!supportsGeolocation()) {
      setState({ status: "unavailable" });
      return;
    }
    setState({ status: "locating" });
    watchId.current = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      timeout: 15_000,
      maximumAge: 0,
    });
  }, [onPosition, onError]);

  return { state, request };
}
