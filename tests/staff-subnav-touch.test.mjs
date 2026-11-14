// legend-7tuml: staff subnav tabs are 44px on every touch screen, not only
// below 640px. A touch tablet in portrait is wider than `sm` but still coarse.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL(
    "../apps/web/src/features/facility-staff/components/staff-chrome.tsx",
    import.meta.url,
  ),
  "utf8",
);
const classes = /const SUBNAV_TRIGGER = cn\(\s*tabsTriggerClass,\s*"([^"]+)"/
  .exec(source)?.[1]
  ?.split(/\s+/);

test("subnav tab is min-h-11 below sm", () => {
  assert.ok(classes?.includes("min-h-11"));
});

test("subnav tab stays 44px at sm and up on coarse pointers", () => {
  assert.ok(classes?.includes("sm:pointer-coarse:min-h-11"));
});

test("subnav tab keeps the compact height with a fine pointer", () => {
  assert.ok(
    classes?.some((c) => c.startsWith("sm:min-h-[calc(var(--control-h-sm)")),
  );
});
