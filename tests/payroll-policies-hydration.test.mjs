// legend-1iyup: the browser repairs a <div> nested in <p> before React can
// hydrate it. Render the real tab and Skeleton during the statutory query's
// pending state so this regression fails on the actual server markup.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const ts = rootRequire("typescript");
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const webRoot = new URL("../apps/web/src/", import.meta.url);
const tabUrl = new URL(
  "features/ws10-payroll-config/components/policies-tab.tsx",
  webRoot,
).href;
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === tabUrl) {
      if (specifier === "../hooks")
        return {
          url: stub(
            [
              "export const usePayrollPolicies = () => ({data:{data:[]},isSuccess:true,isPending:false,isError:false});",
              "export const useStatutoryTables = () => globalThis.__payrollPoliciesHydrationQuery;",
            ].join("\n"),
          ),
          shortCircuit: true,
        };
      // The closed edit dialog is unrelated to the tab's SSR markup.
      if (specifier === "./policy-dialog")
        return {
          url: stub("export const PolicyDialog = () => null;"),
          shortCircuit: true,
        };
    }
    let target;
    if (specifier.startsWith("@/"))
      target = new URL(specifier.slice(2), webRoot);
    else if (
      context.parentURL?.startsWith(webRoot.href) &&
      (specifier.startsWith("./") || specifier.startsWith("../"))
    )
      target = new URL(specifier, context.parentURL);
    if (target) {
      const suffix = ["", ".tsx", ".ts"].find((extension) =>
        existsSync(`${fileURLToPath(target)}${extension}`),
      );
      if (suffix !== undefined)
        return nextResolve(`${target.href}${suffix}`, context);
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

const { PoliciesTab } = await import(tabUrl);

after(() => {
  delete globalThis.__payrollPoliciesHydrationQuery;
});

function renderRules(query) {
  globalThis.__payrollPoliciesHydrationQuery = query;
  return renderToStaticMarkup(
    React.createElement(PoliciesTab, { canRun: true }),
  );
}

test("legend-1iyup PAYR-02 pending statutory rules render two skeletons without invalid paragraph nesting", () => {
  const markup = renderRules({
    isPending: true,
    isSuccess: false,
    isError: false,
  });
  assert.equal(
    [...markup.matchAll(/data-slot="skeleton"/g)].length,
    2,
    "Both statutory rules remain loading placeholders",
  );
  for (const paragraph of markup.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)) {
    assert.doesNotMatch(
      paragraph[1],
      /<div\b/,
      "A paragraph cannot contain the block Skeleton: the browser reparses it before hydration",
    );
  }
});

test("legend-1iyup PAYR-02 failed statutory rules retain their unavailable dash without skeletons", () => {
  const markup = renderRules({
    isPending: false,
    isSuccess: false,
    isError: true,
  });
  assert.doesNotMatch(markup, /data-slot="skeleton"/);
  assert.equal([...markup.matchAll(/>—<\//g)].length, 2);
});
