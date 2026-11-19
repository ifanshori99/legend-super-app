import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

function parse(path) {
  return ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

const canonical = parse("../e2e/hydration.ts");

function declaration(file, name) {
  return file.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
}

// Resolve the spec's actual waiter. This exercises the old local implementation
// before the fix, then the imported canonical implementation after the fix.
function waiterFor(path) {
  const spec = parse(path);
  const local = declaration(spec, "waitForHydration");
  if (local) return { file: spec, waiter: local };
  const imported = spec.statements.some(
    (node) =>
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier.text === "./hydration.ts" &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some(
        (binding) => binding.name.text === "waitForHydration",
      ),
  );
  assert.ok(imported, `${path} imports the canonical hydration waiter`);
  const waiter = declaration(canonical, "waitForHydration");
  assert.ok(waiter);
  return { file: canonical, waiter };
}

function harness(path) {
  const { file, waiter } = waiterFor(path);
  const { outputText } = ts.transpileModule(waiter.getText(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  const control = { __reactFiber$ssr: {} };
  const root = { querySelectorAll: () => [control] };
  const document = {
    documentElement: { dataset: {} },
    body: root,
    querySelector: (selector) =>
      selector === "#main-content" ? root : control,
  };
  const waiting = [];
  const page = {
    async waitForFunction(predicate) {
      if (predicate()) return;
      await new Promise((resolve) => waiting.push({ predicate, resolve }));
    },
  };
  const run = new Function(
    "document",
    `${outputText.replace(/^export /m, "")}\nreturn waitForHydration;`,
  )(document);
  let finished = false;
  const completion = run(page).then(() => {
    finished = true;
  });
  return {
    control,
    document,
    completion,
    finished: () => finished,
    async poll() {
      for (const entry of waiting.splice(0)) {
        if (entry.predicate()) entry.resolve();
        else waiting.push(entry);
      }
      // Flush both waitForFunction and the outer waiter continuation.
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    },
  };
}

for (const path of [
  "../e2e/legend-kmndq.mock.spec.ts",
  "../e2e/legend-cz9g.mock.spec.ts",
]) {
  test(`legend-bz3hj ${path} waits for committed root and control hydration`, async () => {
    const state = harness(path);
    await state.poll();
    assert.equal(
      state.finished(),
      false,
      "a fiber on server-rendered HTML is not committed root hydration",
    );

    state.document.documentElement.dataset.hydrated = "true";
    await state.poll();
    assert.equal(
      state.finished(),
      false,
      "a committed root still waits for late control event props",
    );

    state.control.__reactProps$client = { onClick() {} };
    await state.poll();
    await state.completion;
    assert.equal(state.finished(), true);
  });
}
