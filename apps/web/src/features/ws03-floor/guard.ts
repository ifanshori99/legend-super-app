// Page-level guard for the floor board: the ops area already requires an
// operations permission; the board additionally needs floor.table.view
// (docs/frontend.md "Page guard"). The API re-checks every request.
import { notFound } from "@tanstack/react-router";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";

export function floorPageGuard() {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "pos", anyOf: ["floor.table.view"] },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}
