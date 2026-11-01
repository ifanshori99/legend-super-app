import { definePlugin } from "nitro";
// Module scope: Nitro evaluates plugin modules before it accepts a request, so
// this import validates DEPLOYMENT_MODE, EDGE_MODE, and DATA_CLASSIFICATION
// (and exits) while the built server is still starting. src/server.ts covers
// `vite dev`, where Nitro is not part of the running server. Relative path:
// Nitro builds this file outside the app's tsconfig path aliases.
import "../../src/lib/env.server";

// The production web server boots through Nitro, whose default entry loads the
// app lazily on the first request; without a startup plugin the port would be
// open before the settings were checked. See docs/deployment.md
// ("Startup validation").
export default definePlugin(() => {});
