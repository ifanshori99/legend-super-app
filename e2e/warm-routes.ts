/** Select explicitly warmed paths; unset preserves the full-suite default. */
export function selectWarmRoutes(
  configured: string | undefined,
  defaults: readonly string[],
): readonly string[] {
  if (configured === undefined) return defaults;
  if (configured === "none") return [];

  const routes = configured.split(",").map((route) => route.trim());
  if (
    routes.some(
      (route) =>
        !route.startsWith("/") ||
        route.startsWith("//") ||
        route.includes("\\") ||
        /[\s#]/.test(route),
    )
  ) {
    throw new Error(
      'LEGEND_MOCK_WARM_ROUTES must be "none" or a comma-separated list of local paths.',
    );
  }
  return [...new Set(routes)];
}
