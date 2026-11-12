// Page guard for Tanya AI: each area layout already applies its own guard;
// this page additionally needs `ai.ask` (docs/frontend.md "Page guard"). The
// API re-checks every request; this only hides a screen the caller cannot use.
import { notFound } from "@tanstack/react-router";
import type { AppSurface } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard } from "@/lib/areas/guard";

export function aiChatGuard(surface: AppSurface) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface, anyOf: ["ai.ask"] },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}
