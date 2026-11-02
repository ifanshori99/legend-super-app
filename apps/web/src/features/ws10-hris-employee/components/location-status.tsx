// GPS status of the attendance clock (PRD F25 geofence; Alur L step 2: when
// GPS is not accurate, the employee scans the rotating outlet QR instead).
// The screen never claims the employee is inside the fence — only the server
// knows the outlet point — it reports the fix it will send.
import { LoaderCircle, MapPin, TriangleAlert } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import type { GeoState } from "../geo.ts";

/** A city fix is usually 5–30 m; above this the QR fallback is the better path. */
const COARSE_ACCURACY_M = 100;

export function LocationStatus({
  state,
  onRetry,
}: {
  state: GeoState;
  onRetry: () => void;
}) {
  const t = useT();

  if (state.status === "ready") {
    const coarse = state.location.accuracyM > COARSE_ACCURACY_M;
    return (
      <div className="flex items-start gap-2 text-sm leading-5">
        <MapPin
          className={coarse ? "mt-0.5 size-4 shrink-0 text-warning" : "mt-0.5 size-4 shrink-0 text-info"}
          aria-hidden="true"
        />
        <p>
          {t(
            coarse
              ? "hris.attendance.locationCoarse"
              : "hris.attendance.locationFound",
            { accuracy: state.location.accuracyM },
          )}
        </p>
      </div>
    );
  }

  if (state.status === "denied" || state.status === "unavailable")
    return (
      <div className="grid gap-2">
        <div className="flex items-start gap-2 text-sm leading-5">
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0 text-danger"
            aria-hidden="true"
          />
          <p>
            {t(
              state.status === "denied"
                ? "hris.attendance.locationDenied"
                : "hris.attendance.locationUnavailable",
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={onRetry}
        >
          {t("hris.attendance.locationRetry")}
        </Button>
      </div>
    );

  return (
    <div className="flex items-start gap-2 text-sm leading-5 text-muted-foreground">
      {state.status === "locating" ? (
        <LoaderCircle
          className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      )}
      <p aria-live="polite">
        {t(
          state.status === "locating"
            ? "hris.attendance.locationChecking"
            : "hris.attendance.locationIdle",
        )}
      </p>
    </div>
  );
}
