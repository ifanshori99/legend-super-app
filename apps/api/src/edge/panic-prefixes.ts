// Edge allowlist entry of the panic relay (beads legend-bod, legend-m47qh).
// The HTTP routes sit under the already served /api/edge prefix, so only the
// staff WebSocket upgrade needs an entry; edge/mode.ts `guardEdgeUpgrades`
// uses this pattern. No HTTP prefix under /api/outlets/:id/panic is added on
// purpose: it would open siblings that must stay refused on the edge.

/** The staff panic stream upgrade: /api/outlets/:outletId/panic/realtime. */
export const EDGE_PANIC_UPGRADE_PATTERN =
  /^\/api\/outlets\/[0-9a-f-]{36}\/panic\/realtime(\?.*)?$/;
