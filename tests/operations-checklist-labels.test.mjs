// legend-8erc: the start-run dialog uses its visible FormField labels to
// name each Radix Select. Exercise the real dialog, FormField and Select
// renderer; only the portal shell and unrelated mutation/toast are replaced.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const webRequire = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const ts = rootRequire("typescript");
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const webRoot = new URL("../apps/web/src/", import.meta.url);
const dialogUrl = new URL(
  "features/operations-checklist/components/start-run-dialog.tsx",
  webRoot,
).href;
const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === dialogUrl) {
      if (specifier === "@/components/ui/dialog")
        return {
          url: stub(
            [
              "Dialog",
              "DialogContent",
              "DialogDescription",
              "DialogFooter",
              "DialogHeader",
              "DialogTitle",
            ]
              .map(
                (name) => `export const ${name} = (props) => props.children;`,
              )
              .join("\n"),
          ),
          shortCircuit: true,
        };
      if (specifier === "@/components/ui/toast")
        return {
          url: stub("export const useToast = () => () => {};"),
          shortCircuit: true,
        };
      if (specifier === "../hooks.ts")
        return {
          url: stub(
            "export const useCreateChecklistRun = () => ({isPending:false,mutate(){}});",
          ),
          shortCircuit: true,
        };
    }
    if (specifier.startsWith("@/")) {
      const target = new URL(specifier.slice(2), webRoot);
      const extension = [".tsx", ".ts"].find((suffix) =>
        existsSync(`${fileURLToPath(target)}${suffix}`),
      );
      if (extension) return nextResolve(`${target.href}${extension}`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
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

const { StartRunDialog } = await import(dialogUrl);
const { FormField } = await import(
  new URL("components/ui/form-field.tsx", webRoot).href
);
const { Select, SelectTrigger, SelectValue } = await import(
  new URL("components/ui/select.tsx", webRoot).href
);
const { cafeLegendOperationsFixtures: fixtures } =
  await import("../packages/shared/src/operations/index.ts");

function attribute(tag, name) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

function selectTriggers(markup) {
  return [...markup.matchAll(/<button\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => attribute(tag, "data-slot") === "select-trigger");
}

test("legend-8erc start-run Selects derive their names from the visible FormField labels", () => {
  const markup = renderToStaticMarkup(
    React.createElement(StartRunDialog, {
      open: true,
      onOpenChange() {},
      outletId: fixtures.checklistTemplates[0].outletId,
      templates: fixtures.checklistTemplates,
      defaultShiftDate: "2030-01-15",
      zoneName: () => null,
      onStarted() {},
    }),
  );
  const triggers = selectTriggers(markup);
  assert.equal(triggers.length, 2);
  const labels = [...markup.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)];
  for (const trigger of triggers) {
    const triggerId = attribute(trigger, "id");
    const labelId = attribute(trigger, "aria-labelledby");
    assert.ok(
      labelId,
      "Select must take its name from its visible field label",
    );
    const label = labels.find((match) => attribute(match[0], "id") === labelId);
    assert.ok(label, "aria-labelledby must resolve to a visible label");
    assert.equal(attribute(label[0], "for"), triggerId);
    assert.ok(label[2].trim(), "the accessible name must have visible text");
    assert.ok(
      attribute(trigger, "aria-describedby"),
      "the field hint remains linked",
    );
    assert.equal(attribute(trigger, "aria-required"), "true");
  }
});

test("legend-8erc real FormField Select links its hint and validation error to the named trigger", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      FormField,
      {
        id: "ops-template",
        label: "Template checklist",
        hint: "Pilih template untuk shift ini.",
        error: "Template wajib dipilih.",
        required: true,
      },
      React.createElement(
        Select,
        {},
        React.createElement(
          SelectTrigger,
          {},
          React.createElement(SelectValue, { placeholder: "Pilih template" }),
        ),
      ),
    ),
  );
  const [trigger] = selectTriggers(markup);
  assert.ok(trigger);
  assert.equal(attribute(trigger, "id"), "ops-template");
  assert.equal(attribute(trigger, "aria-labelledby"), "ops-template-label");
  assert.equal(
    attribute(trigger, "aria-describedby"),
    "ops-template-hint ops-template-error",
  );
  assert.equal(attribute(trigger, "aria-invalid"), "true");
  assert.equal(attribute(trigger, "aria-required"), "true");
  assert.match(
    markup,
    /id="ops-template-label"[^>]*>Template checklist<\/label>/,
  );
  assert.match(
    markup,
    /id="ops-template-hint"[^>]*>Pilih template untuk shift ini\.<\/p>/,
  );
  assert.match(markup, /id="ops-template-error" aria-live="polite"/);
  assert.match(markup, /Template wajib dipilih\./);
});
