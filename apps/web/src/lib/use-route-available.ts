import { useRouter } from "@tanstack/react-router";

/**
 * Whether an app path has a screen in this build. Contract paths such as the
 * report viewer (`/reports/sales/per-hour`) and the audit log land with later
 * beads (legend-tp3x); until their route files exist a link would hit a 404,
 * so callers hide the link or show the name as plain text. Links light up by
 * themselves once the route is generated. Query string and hash are ignored.
 */
export function useRouteAvailable(): (path: string) => boolean {
  const router = useRouter();
  const routes = router.routesByPath as unknown as Record<string, unknown>;
  return (path) => {
    const pathname = path.split(/[?#]/, 1)[0] ?? path;
    const trimmed = pathname.replace(/\/+$/, "");
    return trimmed in routes || `${trimmed}/` in routes;
  };
}
