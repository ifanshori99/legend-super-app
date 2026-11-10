// Page guard helpers of the profit-share screens (founder rule Q84). The API
// re-checks every permission; this only hides controls the visitor cannot use.
import { useRouteContext } from "@tanstack/react-router";
import type { AreaAccess } from "@/lib/areas/access";
import { canApproveShareAllocation, canChangeShareAllocation } from "./lib";

/** Whether the visitor may create, edit or submit a share allocation version. */
export function useCanChangeShareAllocation(): boolean {
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  return canChangeShareAllocation(context.access);
}

/** Whether the visitor may approve or reject a share allocation version. */
export function useCanApproveShareAllocation(): boolean {
  const context = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  return canApproveShareAllocation(context.access);
}
