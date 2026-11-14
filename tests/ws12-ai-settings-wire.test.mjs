// legend-nnufz source-level and mock-handler checks
// (docs/briefs/sub-ai-settings-wire.md). The mock transport records no
// requests, so the payload rules for the capability editor are read from its
// source, and the mock PATCH handler is called directly:
//  - CapabilityEditor saves through usePatchProviderCapabilities, never
//    useSaveProvider (PUT).
//  - `changed` is the diff of the form against the EFFECTIVE current values
//    (stored capabilities with overrides applied); reset sends null.
//  - An empty diff is a no-op: no request, form reads as saved.
//  - rangeOk is strict: output < context (equal is refused).
//  - The platform lock (docs/briefs/sub-ai-settings-v2.md) reaches every card
//    (`locked`/`disabled`); the page renders one PlatformLockBanner only when
//    provider.platformLocked is true; the ChatGPT card has no lock notice.
//  - Mock PATCH /api/ai/provider mirrors the backend: null resets every
//    override, an empty patch is a no-op, unsent fields are kept, and a merge
//    with output >= context is a 422.
// Assumptions: "changed" fields are sent without spreading the stored overrides
// (the server keeps unsent fields, see the PATCH contract comment); the 422 is
// raised by the mock handler (VALIDATION_ERROR) when the merged OVERRIDES break
// `maxOutputTokens < contextWindow` (like the backend merge, it checks the
// overrides only, not the detected values); a patch that carries both fields
// with output >= context is already refused by the request schema (400) before
// the handler runs, so the 422 case sends one field against a stored override.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, beforeEach, describe, test } from "node:test";

// LEGEND_AI_SETTINGS_DIR (absolute, trailing slash) points the source checks at
// another copy of the feature, e.g. a `git show HEAD:` export for a fail-first
// run. The mock-handler checks always load the real feature (they need the
// workspace imports).
const dir = process.env.LEGEND_AI_SETTINGS_DIR
  ? new URL(`file://${process.env.LEGEND_AI_SETTINGS_DIR}`)
  : new URL("../apps/web/src/features/ws12-ai-settings/", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, dir), "utf8");

const panel = read("components/custom-model-panel.tsx");
const page = read("components/ai-settings-page.tsx");
const chatgpt = read("components/chatgpt-panel.tsx");
const budget = read("components/budget-card.tsx");

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  return source.slice(from, to === -1 ? undefined : to);
}

/** Argument text of every `<name>(...)` call, balanced on parentheses. */
function callArgs(source, name) {
  const out = [];
  let at = source.indexOf(`${name}(`);
  while (at !== -1) {
    let depth = 0;
    let i = at + name.length;
    const begin = i + 1;
    for (; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")" && --depth === 0) break;
    }
    out.push(source.slice(begin, i).trim());
    at = source.indexOf(`${name}(`, i);
  }
  return out;
}

const editor = between(
  panel,
  "function CapabilityEditor",
  "function PanelSkeleton",
);

describe("legend-nnufz CapabilityEditor wire", () => {
  test("saves through the PATCH hook, not the PUT hook", () => {
    assert.match(editor, /usePatchProviderCapabilities\(\)/);
    assert.doesNotMatch(editor, /useSaveProvider\(\)/);
  });

  test("never sends address, model or key with a capability save", () => {
    const calls = callArgs(editor, "mutateAsync");
    assert.ok(calls.length >= 2, "save and reset both call the mutation");
    for (const args of calls) {
      assert.doesNotMatch(
        args,
        /baseUrl|defaultModel|connectionType|apiKey|\.\.\.base/,
      );
      assert.doesNotMatch(args, /capabilityOverrides\s*:/);
    }
  });

  test("save sends only the changed fields, reset sends null", () => {
    const calls = callArgs(editor, "mutateAsync");
    assert.ok(calls.includes("null"), "reset calls mutateAsync(null)");
    const save = calls.find((args) => args !== "null");
    assert.ok(save, "save call exists");
    assert.equal(save, "changed", "save sends the diff, nothing else");
    assert.doesNotMatch(
      save,
      /\.\.\.\s*config\.capabilityOverrides|\.\.\.\s*current\b|\.\.\.\s*next\b/,
      "the stored overrides or the whole form are not spread into the patch",
    );
  });
});

describe("legend-nnufz how `changed` is built", () => {
  // The effective current values: stored capabilities with overrides on top.
  const currentBlock = between(editor, "const current", ";\n");
  const changedBlock = between(editor, "const changed", "\n    };");

  test("current = detected capabilities with the overrides applied", () => {
    assert.match(currentBlock, /\.\.\.\s*config\.capabilities/);
    assert.match(currentBlock, /\.\.\.\s*config\.capabilityOverrides/);
    assert.ok(
      currentBlock.indexOf("config.capabilities") <
        currentBlock.indexOf("config.capabilityOverrides"),
      "overrides win over detected values",
    );
  });

  test("each field is included only when it differs from current", () => {
    for (const [form, field] of [
      ["contextWindow", "contextWindow"],
      ["maxOutputTokens", "maxOutputTokens"],
      ["supportsTools", "supportsTools"],
      ["supportsReasoning", "supportsReasoning"],
    ]) {
      const guard = new RegExp(
        `next\\.${form}\\s*!==\\s*current\\.${form}[\\s\\S]*?${field}\\s*:\\s*next\\.${form}`,
      );
      assert.match(changedBlock, guard, `${field} guarded by next !== current`);
    }
  });

  test("the diff is not taken against the stored overrides or detection", () => {
    assert.doesNotMatch(changedBlock, /config\./);
    assert.doesNotMatch(changedBlock, /capabilityOverrides/);
  });

  test("an empty diff returns before any request", () => {
    const empty = editor.indexOf("Object.keys(changed).length === 0");
    assert.notEqual(empty, -1, "empty-diff guard exists");
    const guarded = between(editor.slice(empty), "{", "\n    }");
    assert.match(guarded, /return;/, "the guard returns");
    assert.doesNotMatch(guarded, /mutateAsync|mutate\(/, "no request in it");
    assert.match(guarded, /setSaved\(\s*"saved"\s*\)/, "reads as saved");
    assert.ok(
      empty < editor.indexOf("mutateAsync(changed)"),
      "the guard comes before the request",
    );
  });
});

describe("legend-nnufz rangeOk is strict", () => {
  const rangeOk = between(panel, "function rangeOk", "function draftFrom");

  test("output must be strictly below context", () => {
    assert.match(rangeOk, /output\s*<\s*context/);
    assert.doesNotMatch(rangeOk, /output\s*<=\s*context/);
    assert.doesNotMatch(rangeOk, /context\s*>=\s*output/);
  });

  test("submit and blur both use it, and an invalid draft sends nothing", () => {
    assert.ok(callArgs(editor, "rangeOk").length >= 2);
    const submit = between(editor, "const submit", "const restore");
    const guard = submit.indexOf("!rangeOk(draft)");
    assert.notEqual(guard, -1, "submit checks rangeOk");
    assert.match(
      submit.slice(guard, submit.indexOf("mutateAsync")),
      /return;/,
      "an invalid draft returns before the request",
    );
  });
});

describe("legend-nnufz platform lock scope", () => {
  const banner = read("components/platform-lock-banner.tsx");
  const order = read("components/order-card.tsx");

  test("every card receives the lock", () => {
    const chatgptProp = page.match(/<ChatgptPanel\s+disabled=\{([^}]*)\}/);
    assert.ok(chatgptProp, "ChatgptPanel receives a disabled prop");
    assert.match(chatgptProp[1], /locked/i);
    assert.match(page, /<CustomModelPanel\s+locked=\{[^}]*\}/);
    assert.match(page, /<BudgetCard\s+locked=\{[^}]*\}/);
    assert.match(page, /<OrderCard\s+locked=\{[^}]*\}/);
    assert.match(panel, /export function CustomModelPanel\(\{\s*locked/);
    assert.match(budget, /export function BudgetCard\(\{\s*locked/);
    assert.match(order, /locked\?: boolean/);
  });

  test("the banner is an alert rendered by the page only when platformLocked is true", () => {
    assert.match(banner, /export function PlatformLockBanner/);
    assert.match(banner, /role="alert"/);
    const shown = page.indexOf("<PlatformLockBanner");
    assert.notEqual(shown, -1, "page renders the banner");
    assert.match(
      page.slice(Math.max(0, shown - 120), shown),
      /provider\.data\?\.data\.platformLocked\s*===\s*true/,
    );
    assert.doesNotMatch(page, /role="alert"/);
  });

  test("the ChatGPT card carries no tenant lock notice", () => {
    // The tenant lock is explained once by the page banner. The card only
    // explains the global ChatGPT switch (env AI_CHATGPT_ENABLED).
    assert.doesNotMatch(chatgpt, /aiSettings\.platform(Off|Lock)/);
    assert.match(chatgpt, /aiSettingsChatgpt\.platformOff/);
  });
});

describe("legend-nnufz mock PATCH /api/ai/provider", () => {
  let dispatchMock;
  let resetMockStores;
  const patch = (capabilityOverrides) =>
    dispatchMock({
      method: "PATCH",
      path: "/api/ai/provider",
      body: { capabilityOverrides },
    });
  const read = () => dispatchMock({ method: "GET", path: "/api/ai/provider" });

  before(async () => {
    // The mock seeds from the page URL: ?state=detected = saved model, ctx
    // 128000 and output 16384, no overrides.
    globalThis.location = { search: "?state=detected" };
    const base = "../apps/web/src/";
    ({ dispatchMock } = await import(`${base}lib/mock/runtime.ts`));
    ({ resetMockStores } = await import(`${base}lib/mock/store.ts`));
    const { setLatencyMs } = await import(`${base}lib/mock/control.ts`);
    setLatencyMs(0);
    await import(`${base}features/ws12-ai-settings/mock.ts`);
  });
  beforeEach(() => resetMockStores());

  test("starts without overrides", async () => {
    const { data } = await read();
    assert.equal(data.config.capabilityOverrides, null);
    assert.equal(data.config.capabilities.contextWindow, 128_000);
    assert.equal(data.config.capabilities.maxOutputTokens, 16_384);
  });

  test("a patch stores only the sent fields and keeps the others", async () => {
    await patch({ contextWindow: 64_000 });
    const second = await patch({ maxOutputTokens: 8_000 });
    assert.deepEqual(second.data.config.capabilityOverrides, {
      contextWindow: 64_000,
      maxOutputTokens: 8_000,
    });
    // Detected values are untouched.
    assert.equal(second.data.config.capabilities.contextWindow, 128_000);
  });

  test("null resets every override", async () => {
    await patch({ contextWindow: 64_000, supportsTools: false });
    const reset = await patch(null);
    assert.equal(reset.data.config.capabilityOverrides, null);
    const { data } = await read();
    assert.equal(data.config.capabilityOverrides, null);
  });

  test("an empty patch is a no-op: nothing changes, updatedAt included", async () => {
    const before = (await read()).data.config;
    const after = (await patch({})).data.config;
    assert.equal(after.capabilityOverrides, null);
    assert.equal(after.updatedAt, before.updatedAt);

    await patch({ contextWindow: 64_000 });
    const stored = (await read()).data.config;
    const same = (await patch({})).data.config;
    assert.deepEqual(same.capabilityOverrides, stored.capabilityOverrides);
    assert.equal(same.updatedAt, stored.updatedAt);
  });

  test("output equal to the stored context override is a 422 and stores nothing", async () => {
    await patch({ contextWindow: 64_000 });
    await assert.rejects(
      patch({ maxOutputTokens: 64_000 }),
      (error) => error.status === 422 && error.code === "VALIDATION_ERROR",
    );
    // The failed patch left the earlier override untouched.
    assert.deepEqual((await read()).data.config.capabilityOverrides, {
      contextWindow: 64_000,
    });
  });

  test("output above the stored context override is a 422", async () => {
    await patch({ contextWindow: 64_000 });
    await assert.rejects(
      patch({ maxOutputTokens: 100_000 }),
      (error) => error.status === 422,
    );
  });

  test("context below the stored output override is a 422", async () => {
    await patch({ maxOutputTokens: 16_000 });
    await assert.rejects(
      patch({ contextWindow: 8_000 }),
      (error) => error.status === 422,
    );
    assert.deepEqual((await read()).data.config.capabilityOverrides, {
      maxOutputTokens: 16_000,
    });
  });

  test("output one below context is accepted", async () => {
    await patch({ contextWindow: 64_000 });
    const { data } = await patch({ maxOutputTokens: 63_999 });
    assert.deepEqual(data.config.capabilityOverrides, {
      contextWindow: 64_000,
      maxOutputTokens: 63_999,
    });
  });
});
