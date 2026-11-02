// Dashboard and report paths are contract strings (`/reports/sales/per-hour`);
// the router types only know the routes generated today. The report viewer and
// audit beads (legend-j815/imfe/9fo4/max2) add them, so one documented cast
// keeps every call typed instead of a hand-written URL per card.
export function contractHref(path: string): "/kelola" {
  return path as "/kelola";
}
