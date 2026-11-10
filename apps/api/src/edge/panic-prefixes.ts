// Edge route allowlist entries of the panic relay (bead legend-bod). Kept apart
// from edge/mode.ts, which the merge train owns: it appends these to
// EDGE_API_PREFIXES (the HTTP routes already sit under the served /api/edge
// prefix, so only the staff WebSocket path needs an entry).

/** Whole-segment prefixes the edge serves for the panic relay. */
export const EDGE_PANIC_API_PREFIXES = [
  "/api/edge/panic",
  "/api/outlets/:outletId/panic",
] as const;

/** The staff panic stream upgrade: /api/outlets/:outletId/panic/realtime. */
export const EDGE_PANIC_UPGRADE_PATTERN =
  /^\/api\/outlets\/[0-9a-f-]{36}\/panic\/realtime(\?.*)?$/;
