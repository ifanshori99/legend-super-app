import { createFileRoute, Outlet } from "@tanstack/react-router";
import { z } from "zod";
import { PanicAlertLayer } from "@/features/facility-staff/components/panic-alert-layer";
import { evaluateGuard } from "@/lib/areas/guard";

// Layout for every /fasilitas/* screen (bead legend-jztb7): the panic alert
// layer lives here, mounted once, so an alert survives moving between the
// board, cleaning, incidents and emergency screens. It only mounts for staff
// who may respond to emergencies; the child routes keep their own guards.
const searchSchema = z.object({
  facilityId: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/_ops/fasilitas")({
  validateSearch: searchSchema,
  component: FacilityLayout,
});

function FacilityLayout() {
  const { access } = Route.useRouteContext();
  const search = Route.useSearch();
  const gate = evaluateGuard(
    {
      kind: "permission",
      surface: "pos",
      anyOf: ["facility.emergency.respond"],
    },
    access,
  );
  return (
    <>
      {/* Above the screen so the connection status stays in the first
          viewport; the alert itself is a top-layer dialog either way. */}
      {gate.status === "allowed" && (
        <div className="mx-auto mb-4 w-full max-w-6xl">
          <PanicAlertLayer facilityId={search.facilityId} />
        </div>
      )}
      <Outlet />
    </>
  );
}
