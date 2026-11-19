import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Exercise the actual screenshot helper without registering the Playwright
// suite or starting a browser. Infinity.finish() follows the Web Animations
// API by throwing InvalidStateError, which used to abort every capture.
const source = readFileSync(
  new URL("../e2e/legend-kmndq.mock.spec.ts", import.meta.url),
  "utf8",
);
const file = ts.createSourceFile(
  "legend-kmndq.mock.spec.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
);
const capture = file.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "capture",
);
assert.ok(capture, "the kmndq screenshot helper exists");
const { outputText } = ts.transpileModule(capture.getText(file), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
});

async function captureAnimations(animations) {
  const screenshots = [];
  const document = { getAnimations: () => animations };
  const captureScreenshot = async (page, name) => {
    screenshots.push({ page, name });
  };
  const runCapture = new Function(
    "document",
    "captureScreenshot",
    `${outputText}\nreturn capture;`,
  )(document, captureScreenshot);
  const page = { evaluate: async (callback) => callback() };
  await runCapture(page, "kmndq/state.png");
  assert.deepEqual(screenshots, [{ page, name: "kmndq/state.png" }]);
}

function animation(iterations = 1) {
  let finishes = 0;
  return {
    effect: {
      getTiming: () => ({ iterations }),
      getComputedTiming: () => ({
        iterations,
        endTime: iterations * 100,
      }),
    },
    finish() {
      finishes += 1;
      if (iterations === Infinity)
        throw new DOMException(
          "Cannot finish an animation with an infinite end time",
          "InvalidStateError",
        );
    },
    get finishes() {
      return finishes;
    },
  };
}

test("legend-3g69v capture finishes finite transitions before taking the screenshot", async () => {
  const finite = animation();
  await captureAnimations([finite]);
  assert.equal(finite.finishes, 1);
});

test("legend-3g69v capture skips an infinite animation and still settles finite transitions", async () => {
  const infinite = animation(Infinity);
  const finite = animation(2);
  await captureAnimations([infinite, finite]);
  assert.equal(infinite.finishes, 0);
  assert.equal(finite.finishes, 1);
});

test("legend-3g69v capture tolerates an animation with no effect", async () => {
  await captureAnimations([{ effect: null, finish() {} }]);
});
