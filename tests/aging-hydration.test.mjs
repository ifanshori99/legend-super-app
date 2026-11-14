import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = fileURLToPath(new URL("../apps/web/", import.meta.url));
const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { createElement } = webRequire("react");
const { renderToString } = webRequire("react-dom/server");
// The page loads the ESM build of react-query; the provider must come from the
// same build (require() would return the CJS copy and break the context).
const { QueryClient, QueryClientProvider } = await import(
  pathToFileURL(
    webRequire
      .resolve("@tanstack/react-query")
      .replace(/index\.cjs$/, "index.js"),
  ).href
);
const { createServer } = await import(
  pathToFileURL(webRequire.resolve("vite")).href
);

test("aging SSR output does not depend on the server's current date", async (t) => {
  const vite = await createServer({
    configFile: false,
    envFile: false,
    define: { __WEB_DEV_SERVER__: "true" },
    root: webRoot,
    resolve: { alias: { "@": `${webRoot}src` } },
    server: { middlewareMode: true },
    appType: "custom",
  });
  t.after(() => vite.close());
  const { AgingPage } = await vite.ssrLoadModule(
    "/src/features/ws07-ap-assets/components/aging-page.tsx",
  );
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-11-05T12:00:00Z"),
  });
  const render = () =>
    renderToString(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(AgingPage, { legalEntityId: "entity" }),
      ),
    );
  const first = render();
  t.mock.timers.setTime(new Date("2026-11-14T12:00:00Z").getTime());
  assert.equal(render(), first);
});
