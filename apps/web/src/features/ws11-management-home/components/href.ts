import { useRouter } from "@tanstack/react-router";

// Dashboard and report paths are contract strings (`/reports/sales/per-hour`);
// the router types only know the routes generated today. The report viewer and
// audit beads (legend-j815/imfe/9fo4/max2, legend-tp3x) add them, so one
// documented cast keeps every call typed instead of a hand-written URL per card.
export function contractHref(path: string): "/kelola" {
  return path as "/kelola";
}

/**
 * Whether a contract path has a screen in this build. Until the report and
 * audit routes exist, a link to them would land on a 404, so callers render
 * the report name as plain text instead (Opus review legend-6na6). The links
 * light up by themselves once the route files are generated.
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
