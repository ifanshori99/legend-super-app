// Server-only: validates DEPLOYMENT_MODE, EDGE_MODE, and DATA_CLASSIFICATION
// when the process loads, before the handler serves its first request. The
// import comes first so a bad deployment stops the server before anything else
// runs.
import "@/lib/env.server";
import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";

// TanStack Start's server entry. It mirrors the framework's default entry
// (createStartHandler + defaultStreamHandler, wrapped in createServerEntry) and
// exists so the deployment settings are enforced at startup: without a custom
// entry the app would read them inside request handlers, after the server is
// already accepting traffic. The worker and edge runtimes (not built yet)
// validate the same settings with assertDeploymentEnv from @starter/shared/env;
// see docs/deployment.md ("Startup validation").
const fetch = createStartHandler(defaultStreamHandler);

export default createServerEntry({ fetch });
