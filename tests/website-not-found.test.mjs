// legend-uhp28: a missing tenant/site is an HTTP 404, not an SSR crash.
// Exercise the actual public route loaders and query functions. Only the
// endpoint transport and unrelated page components are replaced.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";

const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const ts = rootRequire("typescript");
const { QueryClient } = webRequire("@tanstack/react-query");
const { isNotFound } = webRequire("@tanstack/react-router");
const webRoot = new URL("../apps/web/src/", import.meta.url);
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

const componentStubs = {
  "@/features/ws08-website/components/home-page": "HomePage",
  "@/features/ws08-website/components/menu-page": "MenuPage",
  "@/features/ws08-website/components/reservation-page": "ReservationPage",
  "@/features/ws08-reservation-customer/components/reservasi-page":
    "ReservasiPage",
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/api/endpoint")
      return {
        url: stub(
          "export const callEndpoint = (...args) => globalThis.__websiteNotFoundTransport(...args);",
        ),
        shortCircuit: true,
      };
    if (specifier in componentStubs)
      return {
        url: stub(`export const ${componentStubs[specifier]} = () => null;`),
        shortCircuit: true,
      };
    if (specifier === "@/features/ws08-website/hooks")
      return {
        url: stub(
          "export const usePublicSite = () => null; export const usePublicMenuPage = () => null;",
        ),
        shortCircuit: true,
      };
    if (specifier === "@/features/ws08-website/components/states")
      return {
        url: stub(
          "export const WebsitePending = () => null; export const WebsiteError = () => null; export const WebsiteNotFound = () => null;",
        ),
        shortCircuit: true,
      };
    if (specifier.startsWith("@/")) {
      const target = new URL(specifier.slice(2), webRoot);
      const suffix = [".tsx", ".ts"].find((extension) =>
        existsSync(`${fileURLToPath(target)}${extension}`),
      );
      if (suffix) return nextResolve(`${target.href}${suffix}`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(webRoot.href) && url.endsWith(".tsx")) {
      const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routes = await Promise.all(
  ["index", "menu", "reservation", "reservasi"].map(async (name) => {
    const { Route } = await import(
      new URL(`routes/_public/${name}.tsx`, webRoot).href
    );
    return { name, loader: Route.options.loader };
  }),
);

after(() => {
  delete globalThis.__websiteNotFoundTransport;
});

async function load(loader, transport) {
  globalThis.__websiteNotFoundTransport = transport;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    return await loader({ context: { queryClient } });
  } finally {
    queryClient.clear();
  }
}

for (const { name, loader } of routes) {
  for (const code of ["TENANT_NOT_FOUND", "PUBLIC_SITE_NOT_PUBLISHED"]) {
    test(`legend-uhp28 ${name}: ${code} enters the router's 404 boundary`, async () => {
      const missing = new ApiError(404, code, "Situs tidak ditemukan.");
      await assert.rejects(
        load(loader, async () => {
          throw missing;
        }),
        (error) => isNotFound(error),
      );
    });
  }

  test(`legend-uhp28 ${name}: service failures retain their original error`, async () => {
    const unavailable = new ApiError(503, "UNAVAILABLE", "Coba lagi.");
    await assert.rejects(
      load(loader, async () => {
        throw unavailable;
      }),
      (error) => error === unavailable && !isNotFound(error),
    );
  });
}

test("legend-uhp28 home: a published site remains the loader result", async () => {
  const site = { brand: { name: "Kopi Uji" } };
  const { loader } = routes.find(({ name }) => name === "index");
  assert.equal(await load(loader, async () => ({ data: site })), site);
});
