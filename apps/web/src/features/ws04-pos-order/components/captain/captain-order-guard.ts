// Page guard for the captain order screens: taking a table's order needs
// `order.create` (the ops area already requires an operations permission).
// Presentation only, the API re-checks every request.
import { notFound } from "@tanstack/react-router";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";

export const captainOrderGuard =
  () =>
  ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "pos", anyOf: ["order.create"] },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
