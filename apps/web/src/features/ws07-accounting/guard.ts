// Page-level guard for the accounting screens: the kelola area already
// requires dashboard.management.view + MFA; a page additionally needs its own
// accounting permission (docs/frontend.md "Page guard"). The API re-checks
// everything; this only avoids showing a screen the visitor cannot use.
import { notFound, useRouteContext } from "@tanstack/react-router";
import type { PermissionCode } from "@starter/shared/access";
import type { AreaAccess } from "@/lib/areas/access";
import { evaluateGuard, holdsAny } from "@/lib/areas/guard";
import { canOverridePeriodClose } from "../ws07-statements/lib";

/** Journal viewers need `accounting.journal.view`; posting adds `.post`. */
export const ACCOUNTING_VIEW: readonly PermissionCode[] = [
  "accounting.journal.view",
];
export const ACCOUNTING_POST: readonly PermissionCode[] = [
  "accounting.journal.post",
];

export function accountingGuard(anyOf: readonly PermissionCode[]) {
  return ({ context }: { context: { access: AreaAccess } }) => {
    const gate = evaluateGuard(
      { kind: "permission", surface: "dashboard", anyOf },
      context.access,
    );
    if (gate.status !== "allowed") throw notFound();
  };
}

/**
 * Whether the visitor may write (create/edit accounts, draft, submit, reverse,
 * manage recurring templates). Fails closed when the route context carries no
 * access, so a view-only finance user never sees a write action the API would
 * refuse anyway.
 */
export function useCanPostJournals(): boolean {
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  return context.access ? holdsAny(context.access, ACCOUNTING_POST) : false;
}

/**
 * Whether the visitor may close a period over incomplete production batches
 * with a written reason (card 1263): needs `accounting.period.close` and
 * `accounting.period.close_override`. Fails closed without route access.
 */
export function useCanOverridePeriodClose(): boolean {
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  return context.access
    ? canOverridePeriodClose(context.access.permissions)
    : false;
}

/**
 * Gate for journal source links (ACC-03): true when the visitor would pass the
 * destination screen's own guard. Same evaluateGuard the route's beforeLoad
 * uses; fails closed when the route context carries no access.
 */
export function useSourceGate(): (guard: {
  surface: "dashboard" | "pos";
  anyOf: readonly string[];
}) => boolean {
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  const access = context.access;
  return (guard) =>
    access !== undefined &&
    evaluateGuard(
      {
        kind: "permission",
        surface: guard.surface,
        anyOf: guard.anyOf as readonly PermissionCode[],
      },
      access,
    ).status === "allowed";
}
