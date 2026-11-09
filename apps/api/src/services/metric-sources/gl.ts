// The ledger sources of the registry: the 12 money metrics read from posted
// journal lines (`GL_METRIC_SOURCES`, bead legend-cdta). This file only wraps
// that table into registry sources; the table itself stays in
// `../metrics-gl-sources.ts`.

import { GL_METRIC_SOURCES } from "../metrics-gl-sources";
import type { MetricSourceGlModule } from "./types";

export const glSources: MetricSourceGlModule = {
  family: "gl",
  sources: Object.entries(GL_METRIC_SOURCES).map(([code, gl]) => ({
    kind: "gl" as const,
    code,
    gl,
  })),
  splits: [],
};
