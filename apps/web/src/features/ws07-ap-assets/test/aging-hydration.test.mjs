import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";

const webRoot = fileURLToPath(new URL("../../../../", import.meta.url));

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
