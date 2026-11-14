import type { CallHeaders } from "../api/endpoint-core.ts";
import { API_MOCK } from "../api/mock-flag.ts";
import { installBrowserControl, setLatencyMs } from "./control.ts";
import { clearMocks } from "./registry.ts";
import { dispatchMock, resetMocks } from "./runtime.ts";

// Entry point apiFetch uses in mock mode. Every handler file is picked up by
// glob, so a feature adds `features/<name>/mock.ts` (calling registerMock) and
// never edits a shared file. A split feature may also keep a second file named
// `<part>-mock.ts` (squad invfe: hpp/recipe/supplier/receiving), so several
// beads build in parallel without editing one `mock.ts`; the duplicate guard in
// registry.ts still keeps one handler per endpoint.
const handlerModules = import.meta.glob(
  ["../../features/*/mock.ts", "../../features/*/*-mock.ts", "./handlers/*.ts"],
  { eager: true },
);

// Vite re-evaluates the eager handler graph on a hot update. Empty the registry
// first, or registerMock's duplicate guard would fire at the module that is
// simply reloading itself (bead legend-jzud).
import.meta.hot?.dispose(() => clearMocks());

const DEFAULT_LATENCY_MS = 250;
let ready = false;

function setup() {
  if (ready) return;
  ready = true;
  const configured = Number(import.meta.env.VITE_API_MOCK_LATENCY_MS);
  setLatencyMs(
    import.meta.env.VITE_API_MOCK_LATENCY_MS === undefined ||
      Number.isNaN(configured)
      ? DEFAULT_LATENCY_MS
      : configured,
  );
  installBrowserControl({ reset: resetMocks });
  if (import.meta.env.PROD && API_MOCK)
    console.warn(
      "[legend] VITE_API_MOCK is on in a production build: the app serves fixtures, not real data.",
    );
  if (import.meta.env.DEV)
    console.info(
      `[legend] API mock mode: ${Object.keys(handlerModules).length} handler files. Scenarios: ?mock=empty|slow|error|offline`,
    );
}

export async function mockFetch<T>(
  path: string,
  request: {
    method: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    signal?: AbortSignal;
    headers?: CallHeaders;
  },
): Promise<T> {
  setup();
  const url = new URL(path, "http://mock.invalid");
  const query: Record<string, string | number | boolean | undefined> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  for (const [key, value] of Object.entries(request.query ?? {}))
    if (value !== undefined) query[key] = String(value);
  return (await dispatchMock({
    method: request.method,
    path: url.pathname,
    query,
    body: request.body,
    signal: request.signal,
    headers: request.headers,
  })) as T;
}
