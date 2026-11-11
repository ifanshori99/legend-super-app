// Control-plane event stream (legend-83ll / legend-fy5y, 488 items 4, 5, 9).
//
// Platform-level facts that must reach their consumer even when the subject
// tenant is suspended or archived (`tenant.status_changed`,
// `tenant.package_changed`) or that belong to no tenant (`session.revoked` of a
// platform session) are written to one reserved sentinel stream inside the
// ordinary domain_event_outbox. The worker relay sweeps that stream on its
// own, unconditionally, so it never depends on the tenant registry view
// (which hides every non-active tenant by design).
//
// The sentinel id is a valid UUID that never names a `tenants` row. Nothing in
// the outbox references `tenants`, and RLS is GUC-only, so the stream needs no
// schema change. The subject tenant of an event is its `aggregateId`, never
// its envelope `tenantId`.

/** Reserved tenant id of the control-plane stream. Never a real tenant. */
export const CONTROL_PLANE_TENANT_ID = "00000000-0000-4000-8000-000000000000";

/** Routed destination: the relay claims it and the worker has consumers. */
export const CONTROL_PLANE_DESTINATION = "control-plane";

/** Parked destination: no consumer exists, so the relay never claims it and
 * the row stays pending (fail closed) until a real consumer is registered. */
export const CONTROL_PLANE_PACKAGE_DESTINATION = "control-plane-package";

/** Destinations the relay sweeps for the control-plane stream. */
export const CONTROL_PLANE_RELAYED_DESTINATIONS = [
  CONTROL_PLANE_DESTINATION,
] as const;

const CONTROL_PLANE_DESTINATIONS: ReadonlySet<string> = new Set([
  CONTROL_PLANE_DESTINATION,
  CONTROL_PLANE_PACKAGE_DESTINATION,
]);

export function isControlPlaneDestination(destination: string): boolean {
  return CONTROL_PLANE_DESTINATIONS.has(destination);
}

/** Events written to the control-plane stream. */
export const CONTROL_PLANE_EVENT_NAMES = [
  "tenant.status_changed",
  "tenant.package_changed",
  "session.revoked",
] as const;
export type ControlPlaneEventName = (typeof CONTROL_PLANE_EVENT_NAMES)[number];
